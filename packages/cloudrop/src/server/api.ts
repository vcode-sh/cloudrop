// cloudrop.api (spec §9): server-side file operations on the configured storage, all returning { data, error }.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import type { ObjectOptions, StorageDriver } from "../storage/driver.ts";
import { encodeKeyPath } from "../storage/sigv4.ts";
import { invalidInput, isPlainObject, keyProblem, prefixProblem } from "../storage/validate.ts";
import { type BucketReport, checkBucket } from "./bucket-check.ts";
import { isExactOrigin, type ServerConfig } from "./config.ts";
import { contentDisposition } from "./key.ts";
import { nowSeconds } from "./presign.ts";

export interface FileApi extends Pick<StorageDriver, "head" | "delete" | "deleteMany" | "copy"> {
  /**
   * A URL to read the object. With the storage's publicUrl and no options: the plain public URL. Otherwise a presigned
   * GET signed at the start of an `expiresIn` window (default 3600 s) and valid for two windows, so every viewer in a
   * window gets the same cacheable URL, valid for at least `expiresIn` more seconds. `download` names the saved file.
   */
  getUrl(
    key: string,
    options?: { expiresIn?: number; download?: string },
  ): Promise<Result<{ url: string; expiresAt: Date | null }>>;
  /** A small server-side upload, up to the storage's single-PUT limit. */
  put(
    key: string,
    body: Uint8Array<ArrayBuffer> | ArrayBuffer | string | Blob,
    options?: ObjectOptions,
  ): Promise<Result<{ etag: string }>>;
  /**
   * Deletes everything under a folder prefix ending in "/", page by page, then lists it again: `verifiedAt` is when the
   * listing came back empty. For erasure requests.
   */
  deletePrefix(prefix: string): Promise<Result<{ deleted: number; verifiedAt: Date }>>;
  /** CORS for `origins` (default: trustedOrigins), the abort-incomplete lifecycle rule, and public-domain conflicts. */
  checkBucket(options?: { origins?: readonly string[] }): Promise<Result<BucketReport>>;
}

const DEFAULT_URL_WINDOW_SECONDS = 3600;
/** 10,000 pages of 1,000 keys: far beyond any one prefix, and a bound if writers keep adding keys while it deletes. */
const MAX_DELETE_PAGES = 10_000;

async function getUrl(
  storage: StorageDriver,
  key: string,
  given: unknown,
): Promise<Result<{ url: string; expiresAt: Date | null }>> {
  const options = given ?? {};
  if (!isPlainObject(options))
    return fail(invalidInput("getUrl options must be an object, such as { expiresIn: 3600 }."));
  const { expiresIn, download } = options;
  if (storage.publicUrl && expiresIn === undefined && download === undefined) {
    const problem = keyProblem(key);
    return problem
      ? fail(invalidInput(problem))
      : ok({ url: `${storage.publicUrl}/${encodeKeyPath(key)}`, expiresAt: null });
  }
  const window = expiresIn ?? DEFAULT_URL_WINDOW_SECONDS;
  const maxWindow = Math.floor(storage.rules.maxPresignSeconds / 2);
  if (typeof window !== "number" || !Number.isInteger(window) || window < 1 || window > maxWindow) {
    return fail(invalidInput(`expiresIn must be a whole number of seconds from 1 to ${maxWindow}.`));
  }
  // A lone surrogate cannot be percent-encoded into filename*: contentDisposition would throw a URIError.
  if (download !== undefined && (typeof download !== "string" || download === "" || !download.isWellFormed())) {
    return fail(invalidInput('download must be a file name, such as "report.pdf".'));
  }
  const windowStart = Math.floor(nowSeconds() / window) * window;
  return storage.presignGet(key, {
    expiresIn: 2 * window,
    signedAt: new Date(windowStart * 1000),
    disposition: download === undefined ? undefined : contentDisposition("application/octet-stream", download),
  });
}

/** Why a listed page must not be deleted, or undefined when it may. */
function pageProblem(keys: string[], prefix: string, previous: ReadonlySet<string>): CloudropError | undefined {
  // A listing that strays outside the prefix is a storage or encoding fault: deleting it could erase other data.
  if (keys.some((key) => !key.startsWith(prefix))) {
    return new CloudropError(
      "STORAGE_ERROR",
      "The storage listed keys outside the prefix, so nothing more was deleted.",
    );
  }
  if (keys.some((key) => previous.has(key))) {
    return new CloudropError(
      "STORAGE_ERROR",
      "Some keys were still listed after they were deleted. Retry deletePrefix.",
      {
        retryable: true,
      },
    );
  }
  return undefined;
}

async function deletePrefix(
  storage: StorageDriver,
  prefix: string,
): Promise<Result<{ deleted: number; verifiedAt: Date }>> {
  // Without the trailing slash, "users/4" would also delete "users/42/".
  if (typeof prefix !== "string" || !prefix.endsWith("/") || prefix === "/") {
    return fail(invalidInput('deletePrefix takes a folder prefix ending in "/", such as "users/42/".'));
  }
  const problem = prefixProblem(prefix);
  if (problem) return fail(invalidInput(problem));
  let deleted = 0;
  let previous = new Set<string>();
  for (let page = 0; page < MAX_DELETE_PAGES; page++) {
    const listed = await storage.list(prefix);
    if (listed.error) return listed;
    const keys = listed.data.items.map((item) => item.key);
    if (keys.length === 0) return ok({ deleted, verifiedAt: new Date() });
    const problem = pageProblem(keys, prefix, previous);
    if (problem) return fail(problem);
    const removed = await storage.deleteMany(keys);
    if (removed.error) return removed;
    const [first] = removed.data.failed;
    if (first) {
      return fail(
        new CloudropError(
          "STORAGE_ERROR",
          `Could not delete ${removed.data.failed.length} of ${keys.length} keys, such as ${first.key}: ${first.error.message}`,
          { retryable: first.error.retryable, cause: first.error },
        ),
      );
    }
    deleted += keys.length;
    previous = new Set(keys);
  }
  return fail(
    new CloudropError(
      "STORAGE_ERROR",
      `Objects kept appearing under ${prefix} after ${MAX_DELETE_PAGES} pages were deleted. Stop writing there, then retry.`,
    ),
  );
}

export function createFileApi(config: ServerConfig): FileApi {
  const { storage } = config;
  // Arrow wrappers, not storage.head and friends: an unbound driver method would lose a `this` it relies on.
  return {
    getUrl: (key, options) => getUrl(storage, key, options),
    head: (key) => storage.head(key),
    put: (key, body, options) => storage.put(key, body, options),
    delete: (key) => storage.delete(key),
    deleteMany: (keys) => storage.deleteMany(keys),
    copy: (from, to) => storage.copy(from, to),
    deletePrefix: (prefix) => deletePrefix(storage, prefix),
    checkBucket: async (given) => {
      const options = given ?? {};
      const origins = isPlainObject(options) ? (options.origins ?? [...config.trustedOrigins]) : null;
      // The origins are echoed in the report, so only exact origins may reach it.
      if (!Array.isArray(origins) || !origins.every(isExactOrigin)) {
        return fail(
          invalidInput(
            'checkBucket takes { origins } with exact origins such as "https://app.example.com": scheme and host, no path or trailing slash.',
          ),
        );
      }
      return checkBucket(config, origins);
    },
  };
}
