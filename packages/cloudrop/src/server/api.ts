// cloudrop.api (spec §9): server-side file operations on the configured storage, all returning { data, error }.

import { CloudropError, configError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, optionsOf } from "../input.ts";
import type { ObjectOptions, StorageDriver } from "../storage/driver.ts";
import { encodeKeyPath } from "../storage/sigv4.ts";
import { keyProblem } from "../storage/validate.ts";
import { type BucketReport, checkBucket } from "./bucket-check.ts";
import type { ServerConfig } from "./config.ts";
import { contentDisposition } from "./key.ts";
import { readOrigins } from "./origins.ts";
import { nowSeconds } from "./presign.ts";
import type { StoreFileApi } from "./store-api.ts";

/**
 * Every key and prefix is read in NFC, the Unicode form `/upload` stores keys in. An object another tool wrote under a
 * key in another form is out of reach here on a store that compares keys byte for byte (S3; R2 keeps the forms as one
 * object): reach it through the storage driver, which sends a key as it is.
 */
export interface FileApi extends Pick<StorageDriver, "head" | "delete" | "deleteMany" | "copy">, StoreFileApi {
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
  /**
   * CORS for `origins` (default: trustedOrigins), the abort-incomplete lifecycle rule, and public-domain conflicts. An
   * origin is the text a browser sends, as in trustedOrigins: never a pattern, even where the bucket's rule holds one.
   */
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
  const options = optionsOf(given);
  if (!options) return fail(invalidInput("getUrl options must be an object, such as { expiresIn: 3600 }."));
  const { expiresIn, download } = options;
  if (storage.publicUrl && expiresIn === undefined && download === undefined) {
    const problem = keyProblem(key);
    return problem
      ? fail(invalidInput(problem))
      : ok({ url: `${storage.publicUrl}/${encodeKeyPath(key)}`, expiresAt: null });
  }
  const window = expiresIn === undefined ? DEFAULT_URL_WINDOW_SECONDS : expiresIn;
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
  // A listing that strays outside the prefix is a storage or encoding fault: deleting it could erase other data. R2
  // stores the NFC and NFD forms of a key as one object and lists it in the form last written, so each key is compared
  // in NFC, the prefix's form (M9-H6); a byte-exact store only ever lists keys that start with the prefix's own bytes.
  if (keys.some((key) => !key.normalize("NFC").startsWith(prefix))) {
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
  // A prefix no key can have (a leading slash, a ".." segment, a control character) lists nothing, which would report
  // a verified, empty folder while the files stay stored.
  if (keyProblem(prefix) !== null) {
    return fail(
      invalidInput(
        'No key can start with this prefix. Write it the way keys are written, such as "users/42/": no leading slash, no "." or ".." segment, no control characters, at most 1024 bytes.',
      ),
    );
  }
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

/**
 * A key or prefix in NFC, the form `/upload` stores every key in, so the same text names the same object in every call
 * on a store that compares keys byte for byte (M11-R44). Anything but text goes on to the storage's own check.
 */
const nfc = (key: string): string => (typeof key === "string" ? key.normalize("NFC") : key);

/** The store's api calls on a server without a store: each answers INVALID_CONFIG once the environment is read. */
function withoutStore(whenReady: <T>(call: () => Promise<Result<T>>) => Promise<Result<T>>): StoreFileApi {
  const refuse =
    (name: keyof StoreFileApi) =>
    <T>(): Promise<Result<T>> =>
      whenReady<T>(async () => fail(configError(`api.${name} needs a database store. Pass store to createCloudrop.`)));
  return {
    file: refuse("file"),
    files: refuse("files"),
    allFiles: refuse("allFiles"),
    usage: refuse("usage"),
    revokeUploads: refuse("revokeUploads"),
    deleteFile: refuse("deleteFile"),
    eraseOwner: refuse("eraseOwner"),
    reconcile: refuse("reconcile"),
    sweep: refuse("sweep"),
  };
}

export function createFileApi(config: ServerConfig): FileApi {
  const { storage } = config;
  // Every call waits for the environment's settings, so a server missing one answers INVALID_CONFIG everywhere.
  const whenReady = async <T>(call: () => Promise<Result<T>>): Promise<Result<T>> => {
    const ready = await config.ready();
    return ready.error ? fail(ready.error) : call();
  };
  // Arrow wrappers, not storage.head and friends: an unbound driver method would lose a `this` it relies on.
  return {
    ...(config.store && config.paths
      ? config.paths.api.storeApi(config, config.store, whenReady)
      : withoutStore(whenReady)),
    getUrl: (key, options) => whenReady(() => getUrl(storage, nfc(key), options)),
    head: (key) => whenReady(() => storage.head(nfc(key))),
    put: (key, body, options) =>
      whenReady(async () =>
        optionsOf(options)
          ? storage.put(nfc(key), body, options)
          : fail(invalidInput('put options must be an object, such as { type: "text/plain" }.')),
      ),
    delete: (key) => whenReady(() => storage.delete(nfc(key))),
    deleteMany: (keys) => whenReady(() => storage.deleteMany(Array.isArray(keys) ? keys.map(nfc) : keys)),
    copy: (from, to) => whenReady(() => storage.copy(nfc(from), nfc(to))),
    deletePrefix: (prefix) => whenReady(() => deletePrefix(storage, nfc(prefix))),
    checkBucket: async (given) => {
      const options = optionsOf(given);
      // The origins are echoed in the report, so only exact origins may reach it.
      const read = readOrigins(options ? (options.origins ?? [...config.trustedOrigins]) : null);
      if ("problem" in read) return fail(invalidInput(`checkBucket: ${read.problem}`));
      return whenReady(() => checkBucket(config, read.origins));
    },
  };
}
