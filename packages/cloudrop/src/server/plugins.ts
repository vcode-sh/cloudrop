// The server half of the plugin contract (spec §8): the hooks plugins can use and the order and failure rules the
// handler applies to them. The plugins cloudrop ships are in cloudrop/plugins (src/plugins.ts).

import { CloudropError } from "../errors.ts";
import type { Jsonified, UploadedFile } from "../protocol/types.ts";
import type { StorageDriver } from "../storage/driver.ts";
import type { Awaitable, RouteDefinition } from "./route.ts";

/**
 * A file the server has accepted and given a key, before any byte is uploaded.
 *
 * Experimental, outside semver: a minor release may change the plugin API (docs/stability.md in this package).
 *
 * @beta
 */
export interface PluginFile {
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
}

/**
 * What `beforeUpload` receives.
 *
 * Experimental, outside semver: a minor release may change the plugin API (docs/stability.md in this package).
 *
 * @beta
 */
export interface BeforeUploadContext<TAuth = unknown> {
  /** The `/upload` request, for its headers and `url`. Its body is already read: `request.json()` throws. */
  request: Request;
  route: string;
  /** The route's `accept`, which every file in `files` has passed: ["image/*", "application/pdf"]. */
  accept: readonly string[];
  files: readonly PluginFile[];
  metadata: unknown;
  /** The JSON snapshot of `authorize`'s result that the upload token carries: a Date is its ISO string here. */
  auth: Jsonified<TAuth>;
}

/**
 * What `afterVerify` receives.
 *
 * Experimental, outside semver: a minor release may change the plugin API (docs/stability.md in this package).
 *
 * @beta
 */
export interface AfterVerifyContext<TAuth = unknown> {
  /** The `/complete` request, for its headers and `url`. Its body is already read: `request.json()` throws. */
  request: Request;
  route: string;
  /** The route's `accept`, as the server checked the declared type against it: ["image/*", "application/pdf"]. */
  accept: readonly string[];
  file: UploadedFile;
  metadata: unknown;
  /** The JSON snapshot of `authorize`'s result that the upload token carries: a Date is its ISO string here. */
  auth: Jsonified<TAuth>;
  storage: StorageDriver;
}

/**
 * What `onAbort` receives.
 *
 * Experimental, outside semver: a minor release may change the plugin API (docs/stability.md in this package).
 *
 * @beta
 */
export interface AbortContext<TAuth = unknown> {
  route: string;
  file: PluginFile;
  metadata: unknown;
  /** The JSON snapshot of `authorize`'s result that the upload token carries: a Date is its ISO string here. */
  auth: Jsonified<TAuth>;
  /** "aborted": the client called /abort. "rejected": a check refused the file. "failed": the server could not start it. */
  reason: "aborted" | "rejected" | "failed";
}

/**
 * The server hooks a plugin can use.
 *
 * Experimental, outside semver: a minor release may change the plugin API (docs/stability.md in this package).
 *
 * @beta
 */
export interface ServerHooks<TAuth = unknown> {
  /** Runs in `/upload` after authorization and policy, before anything is signed. Return an error to refuse every file. */
  beforeUpload?(context: BeforeUploadContext<TAuth>): Awaitable<CloudropError | null | undefined>;
  /** Runs in `/complete` after verification, before `onComplete`. An error deletes the object and reaches the client. */
  afterVerify?(context: AfterVerifyContext<TAuth>): Awaitable<CloudropError | null | undefined>;
  /**
   * Runs when a file this plugin's `beforeUpload` accepted is refused, cannot be started, is rejected at `/complete` or
   * is ended through an `/abort` that keeps nothing: after a cancel, or after a failure no `/complete` may have
   * finished, which the client cleans up at once. Release a reservation here. Nothing runs when an abandoned upload's
   * token expires, so a reservation also needs its own expiry. It can run more than once for one file; make it
   * idempotent by `file.id`. Without a store the server keeps no record of an upload it ended, so every `/complete` of
   * a multipart upload the bucket no longer has runs it again with "rejected", also after an `/abort` that ran it.
   */
  onAbort?(context: AbortContext<TAuth>): Awaitable<void>;
  /**
   * Runs once per route in `createCloudrop`; throw a CloudropError with INVALID_CONFIG to refuse the route.
   *
   * Experimental, outside semver, with the rest of the plugin API.
   *
   * @beta
   */
  extendRoute?(route: { name: string; definition: RouteDefinition }): void;
}

/**
 * A plugin typed for the authorize result it reads, such as `CloudropPlugin<{ userId: string }>`: createCloudrop
 * refuses it beside a route whose `authorize` can answer without that shape. `CloudropPlugin` alone reads
 * `auth` as unknown and fits every server.
 *
 * Experimental, outside semver: a minor release may change the plugin API (docs/stability.md in this package).
 *
 * @beta
 */
export interface CloudropPlugin<TAuth = unknown> {
  id: string;
  server?: ServerHooks<TAuth>;
  /**
   * Type-only, never set: a function property, not a method, so it is checked contravariantly and a plugin for
   * `{ userId: string }` does not fit a server whose routes may authorize without one.
   */
  readonly "~auth"?: (auth: Jsonified<TAuth>) => void;
}

export interface Logger {
  error(message: string, error?: unknown): void;
  warn(message: string): void;
}

function refusal(plugin: CloudropPlugin, hook: string, given: unknown): CloudropError | undefined {
  // null is nothing too: plain JavaScript returns it as easily as undefined.
  const value = given ?? undefined;
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
