// createCloudrop's options, checked once at construction. Every mistake here throws INVALID_CONFIG with the option's
// name and the fix, so a misconfigured server fails at startup instead of on a user's first upload.

import { fromEnv } from "../env.ts";
import { CloudropError, configError } from "../errors.ts";
import type { StorageDriver } from "../storage/driver.ts";
import type { CloudropPlugin, Logger } from "./plugins.ts";
import type { Route, RouteDefinition } from "./route.ts";
import { isFunction, readRoute } from "./route-config.ts";
import { parseSize, type Size } from "./size.ts";
import { importTokenKeys, type TokenKeys } from "./token.ts";

export interface CloudropOptions<TRoutes extends Record<string, Route>> {
  /** `r2({ bucket })` or `s3({ ... })`. */
  storage: StorageDriver;
  routes: TRoutes;
  /**
   * HMAC secrets for upload tokens, each at least 32 characters. The first signs; every one verifies, so put a new
   * secret first and keep the old one until its tokens expire (24 hours). Use a different secret for every deployment:
   * a token verifies wherever its secret is configured. Default: env CLOUDROP_SECRET.
   */
  secret?: string | readonly string[];
  /** Where the handler is mounted. Default "/api/cloudrop". */
  basePath?: string;
  /**
   * Exact origins, such as "https://app.example.com", allowed to call the handler cross-origin with credentials. Behind
   * a proxy that terminates TLS or rewrites Host, list the app's own public origin too: no forwarded header is trusted.
   */
  trustedOrigins?: readonly string[];
  /** Files larger than this use multipart. Default 64 MiB. */
  multipartThreshold?: Size;
  plugins?: readonly CloudropPlugin[];
  /** Where failures inside the handler and configuration warnings go. Default: console. */
  logger?: Logger;
}

export interface RouteConfig {
  name: string;
  definition: RouteDefinition;
  accept: readonly string[];
  maxSize: number;
  maxFiles: number;
  visibility: "public" | "private";
}

export interface ServerConfig {
  storage: StorageDriver;
  routes: ReadonlyMap<string, RouteConfig>;
  tokenKeys: Promise<TokenKeys>;
  basePath: string;
  trustedOrigins: ReadonlySet<string>;
  multipartThreshold: number | undefined;
  plugins: readonly CloudropPlugin[];
  logger: Logger;
}

export const ROUTE_NAME: RegExp = /^[A-Za-z0-9_-]{1,64}$/;
// No "." or ".." segment: the URL parser resolves them away, so the handler would never match a request.
const BASE_PATH = /^(\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)+$/;
const MIN_SECRET_LENGTH = 32;

const PLUGIN_HOOKS = ["beforeUpload", "afterVerify", "onAbort", "extendRoute"] as const;

function readSecrets(secret: unknown): [string, ...string[]] {
  const secrets = secret === undefined ? [fromEnv("CLOUDROP_SECRET")].filter(Boolean) : [secret].flat();
  if (secrets.length === 0) {
    throw configError(
      "Missing the upload token secret. Set CLOUDROP_SECRET or pass secret to createCloudrop(); generate one with `openssl rand -base64 32`.",
    );
  }
  // The secret itself is never quoted: messages end up in logs.
  if (!secrets.every((value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH)) {
    throw configError(
      "Each upload token secret must be text of at least 32 characters. Generate one with `openssl rand -base64 32`.",
    );
  }
  return secrets as [string, ...string[]];
}

/**
 * Only a scheme and host survive URL's own serialization unchanged: a path, credentials, "*", "null" and the line
 * breaks the parser strips all fail.
 */
export const isExactOrigin = (origin: unknown): origin is string =>
  typeof origin === "string" && URL.canParse(origin) && new URL(origin).origin === origin;

function readOrigins(origins: unknown): Set<string> {
  const list = origins ?? [];
  const valid = Array.isArray(list) && list.every(isExactOrigin);
  if (!valid) {
    throw configError(
      'trustedOrigins must list exact origins such as "https://app.example.com": scheme and host, no path or trailing slash, and never "*".',
    );
  }
  return new Set(list);
}

function readStorage(storage: StorageDriver | undefined): StorageDriver {
  if (!storage || !isFunction(storage.presignPut) || !Number.isSafeInteger(storage.rules?.maxObjectSize)) {
    throw configError("Pass storage to createCloudrop: r2({ bucket }) or s3({ ... }).");
  }
  return storage;
}

function readRouteEntries(routes: unknown): [string, Route][] {
  const entries = typeof routes === "object" && !Array.isArray(routes) ? Object.entries(routes ?? {}) : [];
  if (entries.length === 0) throw configError("Pass at least one route: routes: { avatar: route({ ... }) }.");
  const badName = entries.find(([name]) => !ROUTE_NAME.test(name));
  if (badName) {
    throw configError(
      `Route name ${JSON.stringify(badName[0].slice(0, 64))} may use only letters, digits, - and _ (at most 64), such as avatar or post-image.`,
    );
  }
  return entries;
}

function readBasePath(given: unknown): string {
  const basePath = given ?? "/api/cloudrop";
  if (typeof basePath !== "string" || !BASE_PATH.test(basePath)) {
    throw configError('basePath must be a path such as "/api/cloudrop": a leading slash, no trailing slash, no query.');
  }
  return basePath;
}

function readThreshold(threshold: Size | undefined): number | undefined {
  const multipartThreshold = threshold === undefined ? undefined : parseSize(threshold);
  if (multipartThreshold === null) {
    throw configError('multipartThreshold must be a whole number of bytes or a size such as "64MB".');
  }
  return multipartThreshold;
}

function readPlugins(given: readonly CloudropPlugin[] | undefined): readonly CloudropPlugin[] {
  const plugins = given ?? [];
  if (!Array.isArray(plugins)) throw configError("plugins must be a list, such as plugins: [limits()].");
  const ids = plugins.map((plugin) => plugin?.id);
  if (!ids.every((id) => typeof id === "string" && id !== "") || new Set(ids).size !== ids.length) {
    throw configError("Every plugin needs its own id. Pass each plugin once.");
  }
  for (const { id, server } of plugins) {
    const hooks: Record<string, unknown> = server ?? {};
    if (
      typeof hooks !== "object" ||
      !PLUGIN_HOOKS.every((hook) => hooks[hook] === undefined || isFunction(hooks[hook]))
    ) {
      throw configError(
        `Plugin "${id}": server takes only functions for beforeUpload, afterVerify, onAbort and extendRoute.`,
      );
    }
  }
  return plugins;
}

function readLogger(given: Logger | undefined): Logger {
  const logger = given ?? console;
  // The handler reports every failure through the logger; a missing method would make it throw instead of answering.
  if (typeof logger?.error !== "function" || typeof logger.warn !== "function") {
    throw configError(
      "logger needs error(message, error) and warn(message) methods, such as console or a pino logger.",
    );
  }
  return logger;
}

/** A plugin may refuse a route by throwing; anything but a CloudropError becomes INVALID_CONFIG, with it as the cause. */
function extendRoute(plugin: CloudropPlugin, route: RouteConfig): void {
  try {
    plugin.server?.extendRoute?.({ name: route.name, definition: route.definition });
  } catch (error) {
    if (error instanceof CloudropError) throw error;
    throw new CloudropError(
      "INVALID_CONFIG",
      `Plugin "${plugin.id}": extendRoute failed for route "${route.name}". Its cause says why; fix the plugin or the route.`,
      { cause: error },
    );
  }
}

/** Plugins and the logger hear about a configuration only once every check has passed. */
function announce(config: ServerConfig): void {
  const { routes, plugins, storage, logger } = config;
  for (const route of routes.values()) {
    for (const plugin of plugins) extendRoute(plugin, route);
    if (route.visibility === "private" && storage.publicUrl) {
      logger.warn(
        `cloudrop: route "${route.name}" is private, but the storage has a publicUrl, so anyone who learns a key can read the file. Serve private files from a bucket without a public domain.`,
      );
    }
  }
}

export function readConfig<TRoutes extends Record<string, Route>>(given: CloudropOptions<TRoutes>): ServerConfig {
  const options: Partial<CloudropOptions<TRoutes>> = given ?? {};
  // Each reader throws on its own option's mistake, in this order; announce runs only once all of them have passed.
  const storage = readStorage(options.storage);
  const entries = readRouteEntries(options.routes);
  const basePath = readBasePath(options.basePath);
  const multipartThreshold = readThreshold(options.multipartThreshold);
  const plugins = readPlugins(options.plugins);
  const logger = readLogger(options.logger);
  const tokenKeys = importTokenKeys(readSecrets(options.secret));
  const trustedOrigins = readOrigins(options.trustedOrigins);
  const routes = new Map(entries.map(([name, route]) => [name, readRoute(name, route, storage)]));
  const config = { storage, routes, tokenKeys, basePath, trustedOrigins, multipartThreshold, plugins, logger };
  announce(config);
  return config;
}

/** What every endpoint receives: the request (for authorize and hooks), its parsed JSON body and the configuration. */
export interface EndpointInput {
  request: Request;
  body: unknown;
  config: ServerConfig;
}
