// createCloudrop's options, checked once at construction. Every mistake here throws INVALID_CONFIG with the option's
// name and the fix, so a misconfigured server fails at startup instead of on a user's first upload.

import { fromEnv } from "../env.ts";
import { configError } from "../errors.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { formatBytes } from "../storage/validate.ts";
import { isAcceptEntry } from "./accept.ts";
import type { CloudropPlugin, Logger } from "./plugins.ts";
import type { Route, RouteDefinition } from "./route.ts";
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
const MAX_FILES_LIMIT = 100;
const DEFAULT_MAX_FILES = 10;

const PLUGIN_HOOKS = ["beforeUpload", "afterVerify", "onAbort", "extendRoute"] as const;

const isFunction = (value: unknown): boolean => typeof value === "function";

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

function readRoute(name: string, route: Route, storage: StorageDriver): RouteConfig {
  const where = `Route "${name}"`;
  const definition = (route as Partial<Route> | null)?.definition;
  if (typeof definition !== "object" || definition === null) {
    throw configError(`${where} is not a route. Wrap its options in route({ ... }).`);
  }
  if (!isFunction(definition.authorize)) {
    throw configError(`${where} needs authorize. Use authorize: allowAnyone for a route anyone may upload to.`);
  }
  const accept = [definition.accept].flat();
  if (accept.length === 0 || !accept.every((entry) => typeof entry === "string" && isAcceptEntry(entry))) {
    throw configError(`${where}: accept takes MIME types in lower case, such as "image/png", "image/*" or "*/*".`);
  }
  const maxSize = parseSize(definition.maxSize);
  const limit = storage.rules.maxObjectSize;
  if (maxSize === null || maxSize < 1 || maxSize > limit) {
    throw configError(`${where}: maxSize must be between 1 byte and ${formatBytes(limit)}, such as 5242880 or "5MB".`);
  }
  const maxFiles = definition.maxFiles ?? DEFAULT_MAX_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES_LIMIT) {
    throw configError(`${where}: maxFiles must be a whole number from 1 to ${MAX_FILES_LIMIT}.`);
  }
  if (definition.metadata !== undefined && !isFunction(definition.metadata?.["~standard"]?.validate)) {
    throw configError(`${where}: metadata must be a Standard Schema, such as a zod, valibot or arktype schema.`);
  }
  for (const option of ["prefix", "key", "onComplete"] as const) {
    if (definition[option] !== undefined && !isFunction(definition[option])) {
      throw configError(`${where}: ${option} must be a function.`);
    }
  }
  if (definition.prefix && definition.key) {
    throw configError(`${where}: pass prefix or key, not both. key builds the whole key; prefix only its folder.`);
  }
  const visibility = definition.visibility ?? (storage.publicUrl ? "public" : "private");
  if (visibility !== "public" && visibility !== "private") {
    throw configError(`${where}: visibility must be "public" or "private".`);
  }
  if (visibility === "public" && !storage.publicUrl) {
    throw configError(
      `${where} is public, but the storage has no publicUrl. Pass publicUrl to the storage preset, or make the route private.`,
    );
  }
  return { name, definition, accept, maxSize, maxFiles, visibility };
}

export function readConfig<TRoutes extends Record<string, Route>>(given: CloudropOptions<TRoutes>): ServerConfig {
  const options: Partial<CloudropOptions<TRoutes>> = given ?? {};
  const { storage, routes: givenRoutes } = options;
  if (!storage || !isFunction(storage.presignPut) || !Number.isSafeInteger(storage.rules?.maxObjectSize)) {
    throw configError("Pass storage to createCloudrop: r2({ bucket }) or s3({ ... }).");
  }
  const entries =
    typeof givenRoutes === "object" && !Array.isArray(givenRoutes) ? Object.entries(givenRoutes ?? {}) : [];
  if (entries.length === 0) throw configError("Pass at least one route: routes: { avatar: route({ ... }) }.");
  const badName = entries.find(([name]) => !ROUTE_NAME.test(name));
  if (badName) {
    throw configError(
      `Route name ${JSON.stringify(badName[0].slice(0, 64))} may use only letters, digits, - and _ (at most 64), such as avatar or post-image.`,
    );
  }
  const basePath = options.basePath ?? "/api/cloudrop";
  if (typeof basePath !== "string" || !BASE_PATH.test(basePath)) {
    throw configError('basePath must be a path such as "/api/cloudrop": a leading slash, no trailing slash, no query.');
  }
  const multipartThreshold =
    options.multipartThreshold === undefined ? undefined : parseSize(options.multipartThreshold);
  if (multipartThreshold === null) {
    throw configError('multipartThreshold must be a whole number of bytes or a size such as "64MB".');
  }
  const plugins = options.plugins ?? [];
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
  const logger = options.logger ?? console;
  // The handler reports every failure through the logger; a missing method would make it throw instead of answering.
  if (typeof logger?.error !== "function" || typeof logger.warn !== "function") {
    throw configError(
      "logger needs error(message, error) and warn(message) methods, such as console or a pino logger.",
    );
  }
  const tokenKeys = importTokenKeys(readSecrets(options.secret));
  const trustedOrigins = readOrigins(options.trustedOrigins);
  const routes = new Map(entries.map(([name, route]) => [name, readRoute(name, route, storage)]));
  // Plugins and the logger hear about a configuration only once every check above has passed.
  for (const route of routes.values()) {
    for (const plugin of plugins) plugin.server?.extendRoute?.({ name: route.name, definition: route.definition });
    if (route.visibility === "private" && storage.publicUrl) {
      logger.warn(
        `cloudrop: route "${route.name}" is private, but the storage has a publicUrl, so anyone who learns a key can read the file. Serve private files from a bucket without a public domain.`,
      );
    }
  }
  return {
    storage,
    routes,
    tokenKeys,
    basePath,
    trustedOrigins,
    multipartThreshold,
    plugins,
    logger,
  };
}

/** What every endpoint receives: the request (for authorize and hooks), its parsed JSON body and the configuration. */
export interface EndpointInput {
  request: Request;
  body: unknown;
  config: ServerConfig;
}
