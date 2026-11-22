// createCloudrop's options, checked once at construction. Every mistake here throws INVALID_CONFIG with the option's
// name and the fix, so a misconfigured server fails at startup instead of on a user's first upload. Settings from the
// environment are the exception: environment.ts reads them on the first request.

import { CloudropError, configError, fail, type Result } from "../errors.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { r2 } from "../storage/presets.ts";
import { environmentReader } from "./environment.ts";
import { readOrigins } from "./origins.ts";
import type { CloudropPlugin, Logger } from "./plugins.ts";
import type { Route, RouteDefinition } from "./route.ts";
import { isFunction, readRoute } from "./route-config.ts";
import { parseSize, type Size } from "./size.ts";
import { readStoreConfig, readStorePaths, type StoreConfig, type StoreOptions, unownedRoutes } from "./store-config.ts";
import type { StorePaths } from "./store-paths.ts";
import type { TokenKeys } from "./token.ts";

export interface CloudropOptions<TRoutes extends Record<string, Route>> extends StoreOptions {
  /**
   * `r2({ bucket })` or `s3({ ... })`. Default: `r2()`, which reads CLOUDROP_R2_BUCKET, CLOUDROP_R2_ACCOUNT_ID,
   * CLOUDROP_R2_ACCESS_KEY_ID and CLOUDROP_R2_SECRET_ACCESS_KEY on the first request (in development, at start).
   */
  storage?: StorageDriver;
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
   * Exact origins, such as "https://app.example.com", allowed to call the handler cross-origin with credentials: the
   * text a browser sends as `Origin`, so never a pattern, and for a webview or an extension page its own scheme, such
   * as "capacitor://localhost". Behind a proxy that terminates TLS or rewrites Host, list the app's own public origin
   * too: no forwarded header is trusted.
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
  /** Each completion deletes the owner's previous files on the route. */
  replace: boolean;
}

export interface ServerConfig extends StoreConfig {
  /**
   * The store's code, carried by the store object (M12-S1): set with a store, so the endpoints call it, never import
   * it. A store without it makes `ready` fail.
   */
  paths: StorePaths | undefined;
  storage: StorageDriver;
  routes: ReadonlyMap<string, RouteConfig>;
  /**
   * Reads the settings that come from the environment, again on each call until they are complete: the token keys, or
   * INVALID_CONFIG naming what is missing. Awaited before every endpoint and api call.
   */
  ready: () => Promise<Result<TokenKeys>>;
  basePath: string;
  trustedOrigins: ReadonlySet<string>;
  multipartThreshold: number | undefined;
  plugins: readonly CloudropPlugin[];
  logger: Logger;
}

export const ROUTE_NAME: RegExp = /^[A-Za-z0-9_-]{1,64}$/;
// No "." or ".." segment: the URL parser resolves them away, so the handler would never match a request.
const BASE_PATH = /^(\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)+$/;
const PLUGIN_HOOKS = ["beforeUpload", "afterVerify", "onAbort", "extendRoute"] as const;

function readTrustedOrigins(given: unknown): Set<string> {
  const read = readOrigins(given ?? []);
  if ("problem" in read) throw configError(`trustedOrigins: ${read.problem}`);
  return new Set(read.origins);
}

function readStorage(given: StorageDriver | undefined): StorageDriver {
  // r2() reads its settings lazily (M4-F17), so a build without secrets can still construct the server (M12-A9).
  const storage = given ?? r2();
  if (!isFunction(storage.presignPut) || !Number.isSafeInteger(storage.rules?.maxObjectSize)) {
    throw configError(
      "storage must be a storage driver, such as r2({ bucket }) or s3({ ... }). Leave it out to use r2() with the CLOUDROP_R2_* variables.",
    );
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
  if (!Array.isArray(plugins)) throw configError("plugins must be a list, such as plugins: [contentChecks()].");
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

/**
 * Plugins and the logger hear about a configuration only once every check has passed. A store without its code is
 * logged here, at start, as well as on the first request that fails because of it (M12-S2).
 */
function announce(config: ServerConfig, storeProblem: CloudropError | null): void {
  const { routes, plugins, storage, logger } = config;
  if (storeProblem) {
    logger.error(
      `cloudrop: every request and api call fails until this is fixed. ${storeProblem.message}`,
      storeProblem,
    );
  }
  const unowned = unownedRoutes(config);
  if (unowned.length > 0) {
    logger.warn(
      `cloudrop: quota is set, but routes ${unowned.join(", ")} define no owner, so their uploads count against no limit. Add owner to those routes.`,
    );
  }
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
  const environment = environmentReader(options.secret, storage);
  const trustedOrigins = readTrustedOrigins(options.trustedOrigins);
  const routes = new Map(entries.map(([name, route]) => [name, readRoute(name, route, storage)]));
  const store = readStoreConfig(options, [...routes.values()]);
  const paths = readStorePaths(store.store);
  // A store without its code fails like a missing setting: every request and api call answers it (M12-S2).
  const ready = paths.error ? async () => fail(paths.error) : environment;
  const config = {
    storage,
    routes,
    ready,
    basePath,
    trustedOrigins,
    multipartThreshold,
    plugins,
    logger,
    ...store,
    paths: paths.data ?? undefined,
  };
  announce(config, paths.error);
  return config;
}

/** The configuration an endpoint runs with: the environment has been read, so the token keys are known. */
export interface EndpointConfig extends ServerConfig {
  tokenKeys: TokenKeys;
}

/** What every endpoint receives: the request (for authorize and hooks), its parsed JSON body and the configuration. */
export interface EndpointInput {
  request: Request;
  body: unknown;
  config: EndpointConfig;
}
