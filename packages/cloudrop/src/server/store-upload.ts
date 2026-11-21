// POST /upload with a store (M5 spec §5.2): a row per accepted file is written, its bytes reserved against the owner's
// quota, before any URL is signed or multipart upload created. A file whose row cannot be written is not started.

import { CloudropError, fail, ok, quotaExceeded, type Result } from "../errors.ts";
import type { RouteConfig, ServerConfig } from "./config.ts";
import { abortContexts, type PluginFile, runOnAbort } from "./plugins.ts";
import type { OwnerContext } from "./route-context.ts";
import type { CloudropStore } from "./store.ts";
import { cancelled, storeCall } from "./store-calls.ts";
import type { UploadTokenPayload } from "./token.ts";

/** The longest owner, in characters; the file API holds the ids it is given to the same bound. */
export const MAX_OWNER_LENGTH = 255;

/** The route's owner for this upload: who its files count against. A bad value is the route's bug. */
export async function readOwner(route: RouteConfig, context: OwnerContext<object, unknown>): Promise<string | null> {
  if (!route.definition.owner) return null;
  const owner: unknown = await route.definition.owner(context);
  if (owner === null) return null;
  // The file API takes the same owners (isOwnerOrId): Postgres text cannot hold NUL, and a database stores a lone
  // surrogate as U+FFFD, which would make one owner of two.
  if (
    typeof owner !== "string" ||
    owner.length < 1 ||
    owner.length > MAX_OWNER_LENGTH ||
    owner.includes("\u0000") ||
    !owner.isWellFormed()
  ) {
    throw new TypeError(
      `Route "${route.name}": owner must return null or a string of 1 to ${MAX_OWNER_LENGTH} characters without NUL (U+0000) or a lone surrogate.`,
    );
  }
  return owner;
}

const quotaUnavailable = (): CloudropError =>
  new CloudropError("SERVER_ERROR", "The server could not check your storage limit. Try again in a moment.", {
    retryable: true,
  });

/** The owner's limit in bytes, or null for none. A lookup that fails refuses the upload: a quota fails closed. */
async function readLimit(
  config: ServerConfig,
  route: RouteConfig,
  owner: string | null,
): Promise<Result<number | null>> {
  if (owner === null || !config.quota) return ok(null);
  try {
    const limit = await config.quota(owner);
    if (limit === null || (Number.isSafeInteger(limit) && limit >= 0)) return ok(limit);
    throw new TypeError(`quota must return null or a whole number of bytes, got ${String(limit)}.`);
  } catch (error) {
    config.logger.error(`cloudrop: the quota lookup failed for an upload on route "${route.name}".`, error);
    return fail(quotaUnavailable());
  }
}

/**
 * With a store, writes the accepted files' rows in one call. Answers the files that must not start, by id: each file
 * over the quota, or every file when the limit or the rows could not be read or written. Without a store, none.
 */
export async function reserveFiles(
  config: ServerConfig,
  input: {
    route: RouteConfig;
    owner: string | null;
    files: readonly PluginFile[];
    metadataJson: string | undefined;
    exp: number;
    /** The request's idempotency key: a retry supersedes the owner's rows of an attempt whose answer was lost. */
    requestKey: string | null;
  },
): Promise<ReadonlyMap<string, CloudropError>> {
  const { store } = config;
  const { route, owner, files } = input;
  if (!store || files.length === 0) return new Map();
  const everyFile = (error: CloudropError) => new Map(files.map((file) => [file.id, error]));
  const limit = await readLimit(config, route, owner);
  if (limit.error) return everyFile(limit.error);
  const metadata = input.metadataJson ?? null;
  const rows = files.map(({ id, key, name, type, size }) => ({
    id,
    route: route.name,
    key,
    name,
    type,
    size,
    metadata,
  }));
  const expiresAt = new Date(input.exp * 1000);
  // Only owned rows are superseded (M5-T105): owner-less rows hold no quota, and on a route without owner a reused key
  // would otherwise end other users' uploads.
  const requestKey = owner === null ? null : input.requestKey;
  const reserved = await storeCall(config.logger, `reserve the files of an upload on route "${route.name}"`, () =>
    store.reserve({ owner, limit: limit.data, expiresAt, requestKey, files: rows }, new Date()),
  );
  if (reserved.error) return everyFile(reserved.error);
  const refused = files.filter((_, index) => reserved.data[index] !== "reserved");
  return new Map(refused.map((file) => [file.id, quotaExceeded()]));
}

/** Stores a new multipart upload's id on its row. An error means the upload must be aborted and the file not started. */
export async function attachUpload(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  token: UploadTokenPayload & { uploadId: string },
): Promise<CloudropError | null> {
  const attached = await storeCall(
    config.logger,
    `attach the upload of file ${token.id} on route "${token.route}"`,
    () => store.attach(token.id, token.uploadId, new Date()),
  );
  if (attached.error) return attached.error;
  // Only a row that is no longer pending refuses: a sign-out revoked it after the reserve.
  return attached.data ? null : cancelled();
}

/**
 * Releases what was reserved for accepted files that were not started. Their plugins hear "rejected" for a file over
 * its quota and "failed" otherwise; a reserved row whose upload could not start ends as failed, best effort.
 */
export async function releaseUnstarted(
  config: ServerConfig,
  shared: { route: string; metadata: unknown; auth: unknown },
  unstarted: readonly PluginFile[],
  refusals: ReadonlyMap<string, CloudropError>,
): Promise<void> {
  const { store, plugins, logger } = config;
  const overQuota = unstarted.filter((file) => refusals.get(file.id)?.code === "QUOTA_EXCEEDED");
  const failed = unstarted.filter((file) => !overQuota.includes(file));
  if (store) {
    const reserved = failed.filter(({ id }) => !refusals.has(id));
    await Promise.all(
      reserved.map((file) =>
        storeCall(logger, `end the unstarted file ${file.id}`, () =>
          store.end(file.id, "pending", "failed", new Date()),
        ),
      ),
    );
  }
  await runOnAbort(plugins, abortContexts(shared, overQuota, "rejected"), logger);
  await runOnAbort(plugins, abortContexts(shared, failed, "failed"), logger);
}
