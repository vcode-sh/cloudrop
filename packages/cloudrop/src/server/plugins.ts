// The server half of the plugin contract (spec §8): the hooks plugins can use and the order and failure rules the
// handler applies to them. The plugins cloudrop ships are in cloudrop/plugins (src/plugins.ts).

import { CloudropError } from "../errors.ts";
import type { UploadedFile } from "../protocol/types.ts";
import type { StorageDriver } from "../storage/driver.ts";
import type { Awaitable, RouteDefinition } from "./route.ts";

/** A file the server has accepted and given a key, before any byte is uploaded. */
export interface PluginFile {
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
}

export interface BeforeUploadContext {
  request: Request;
  route: string;
  files: readonly PluginFile[];
  metadata: unknown;
  auth: unknown;
}

export interface AfterVerifyContext {
  request: Request;
  route: string;
  /** The route's `accept`, as the server checked the declared type against it: ["image/*", "application/pdf"]. */
  accept: readonly string[];
  file: UploadedFile;
  metadata: unknown;
  auth: unknown;
  storage: StorageDriver;
}

export interface AbortContext {
  route: string;
  file: PluginFile;
  metadata: unknown;
  auth: unknown;
  /** "aborted": the client called /abort. "rejected": a check refused the file. "failed": the server could not start it. */
  reason: "aborted" | "rejected" | "failed";
}

export interface ServerHooks {
  /** Runs in `/upload` after authorization and policy, before anything is signed. Return an error to refuse every file. */
  beforeUpload?(context: BeforeUploadContext): Awaitable<CloudropError | undefined>;
  /** Runs in `/complete` after verification, before `onComplete`. An error deletes the object and reaches the client. */
  afterVerify?(context: AfterVerifyContext): Awaitable<CloudropError | undefined>;
  /**
   * Runs when a file this plugin's `beforeUpload` accepted is refused, cannot be started, is rejected at `/complete` or
   * is ended through an `/abort` that keeps nothing: after a cancel, or after a failure no `/complete` may have
   * finished, which the client cleans up at once. Release a reservation here. Nothing runs when an abandoned upload's
   * token expires, so a reservation also needs its own expiry. It can run more than once for one file; make it
   * idempotent by `file.id`.
   */
  onAbort?(context: AbortContext): Awaitable<void>;
  /** Runs once per route in `createCloudrop`; throw a CloudropError with INVALID_CONFIG to refuse the route. */
  extendRoute?(route: { name: string; definition: RouteDefinition }): void;
}

export interface CloudropPlugin {
  id: string;
  server?: ServerHooks;
}

export interface Logger {
  error(message: string, error?: unknown): void;
  warn(message: string): void;
}

function refusal(plugin: CloudropPlugin, hook: string, value: unknown): CloudropError | undefined {
  if (value === undefined || value instanceof CloudropError) return value;
  // A CloudropError from a second installed copy of cloudrop fails this check too, so the message names that cause.
  throw new TypeError(
    `Plugin "${plugin.id}": ${hook} must return nothing or a CloudropError from the same cloudrop the server uses. Install cloudrop once, so the plugin and the server share it.`,
  );
}

/** The onAbort context of each file, all from one request: one route, one metadata, one auth. */
export function abortContexts(
  shared: { route: string; metadata: unknown; auth: unknown },
  files: readonly PluginFile[],
  reason: AbortContext["reason"],
): AbortContext[] {
  const { route, metadata, auth } = shared;
  return files.map((file) => ({ route, file, metadata, auth, reason }));
}

/** onAbort for each file on each plugin, in plugin order. A failing onAbort is logged and never stops the others. */
export async function runOnAbort(
  plugins: readonly CloudropPlugin[],
  contexts: readonly AbortContext[],
  logger: Logger,
): Promise<void> {
  for (const plugin of plugins) {
    for (const context of contexts) {
      try {
        await plugin.server?.onAbort?.(context);
      } catch (error) {
        logger.error(`cloudrop: plugin "${plugin.id}" failed in onAbort for file ${context.file.id}.`, error);
      }
    }
  }
}

/**
 * beforeUpload on each plugin in order. The first refusal, or the first throw, stops the rest; the plugins that had
 * already accepted get onAbort, so a reservation made by an earlier plugin is released.
 */
export async function runBeforeUpload(
  plugins: readonly CloudropPlugin[],
  context: BeforeUploadContext,
  logger: Logger,
): Promise<CloudropError | undefined> {
  for (const [index, plugin] of plugins.entries()) {
    const release = (reason: AbortContext["reason"]) =>
      runOnAbort(plugins.slice(0, index), abortContexts(context, context.files, reason), logger);
    let refused: CloudropError | undefined;
    try {
      refused = refusal(plugin, "beforeUpload", await plugin.server?.beforeUpload?.(context));
    } catch (error) {
      await release("failed");
      throw error;
    }
    if (refused) {
      await release("rejected");
      return refused;
    }
  }
  return undefined;
}

/** afterVerify on each plugin in order; the first refusal stops the rest. A throw escapes to the handler. */
export async function runAfterVerify(
  plugins: readonly CloudropPlugin[],
  context: AfterVerifyContext,
): Promise<CloudropError | undefined> {
  for (const plugin of plugins) {
    const refused = refusal(plugin, "afterVerify", await plugin.server?.afterVerify?.(context));
    if (refused) return refused;
  }
  return undefined;
}
