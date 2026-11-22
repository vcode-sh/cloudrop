// createCloudropClient's options and how they are read: a wrong one throws INVALID_CONFIG when the client is created
// (S17, M3-U41, M3-U42, M3-U79, M8-L5), since it needs a code change, not a retry.

import { configError } from "../errors.ts";
import { type Account, encodeAccount } from "./account.ts";
import type { ClientFetch, ServerHeaders } from "./endpoints.ts";

export interface ClientOptions {
  /** Where the server's handler is mounted: a path on this page's origin or an absolute URL. Default "/api/cloudrop". */
  basePath?: string;
  /**
   * Headers for the requests to the upload server (/upload, /sign, /complete and /abort), never for bucket PUTs: an
   * object, or a function, possibly async, called before each request, such as one that returns a fresh bearer token.
   */
  headers?: ServerHeaders;
  /**
   * The signed-in user this page shows, as the route's `owner` returns it (at most 255 characters; "" for nobody), sent
   * with /upload only. On a route with a store and `owner`, the server refuses an upload whose session names someone
   * else, as after a sign-in in another tab, with ACCOUNT_CHANGED. A function, possibly async, is called before each
   * /upload; null or undefined from it sends nothing, and the upload is checked as without the option.
   */
  account?: Account;
  /** Replaces the global fetch, for tests and runtimes that bring their own. Bucket PUTs then go through it too. */
  fetch?: ClientFetch;
  /**
   * How many bucket PUTs this client sends at once, across all its uploads: 1 to 16, or "auto" (the default), which
   * starts at 4, adds one while the bytes sent keep rising, up to 8, and halves on a network error or a busy bucket.
   */
  concurrency?: number | "auto";
  /** Which PUTs go first when they wait for a connection: "added" (the default) or "smallest-first" by file size. */
  order?: "added" | "smallest-first";
  /**
   * Keeps each unfinished multipart upload in the browser's IndexedDB, with its upload token, until the file ends, so
   * that it can resume after a reload. Default true; false keeps nothing on disk.
   */
  persist?: boolean;
  /**
   * Keeps one signed-in user's unfinished uploads apart from another's in the same browser: pass the user's id. At most
   * 256 characters. Default: `account` when it is a string, otherwise "".
   */
  namespace?: string;
}

/** A path such as /api/cloudrop, or an absolute http(s) URL ending in one; no trailing slash, query or fragment (S17). */
const BASE_PATH = /^(?:https?:\/\/[^/?#\s]+)?(?:\/[^/?#\s]+)+$/;

/** Undefined, a function, or an object `new Headers()` takes: a static header a browser refuses fails here, not later. */
function isHeaders(headers: unknown): boolean {
  if (headers === undefined || typeof headers === "function") return true;
  // An object only: Headers would read a string as a list of pairs and fail with less to say.
  if (typeof headers !== "object" || headers === null) return false;
  try {
    new Headers(headers as HeadersInit);
    return true;
  } catch {
    return false;
  }
}

type Connection = Required<Pick<ClientOptions, "basePath">> & Pick<ClientOptions, "headers" | "account" | "fetch">;

/** Where and how the client reaches the upload server. */
function readConnection({ basePath = "/api/cloudrop", headers, account, fetch }: ClientOptions): Connection {
  if (typeof basePath !== "string" || !BASE_PATH.test(basePath)) {
    throw configError(
      'basePath must be where the cloudrop handler is mounted, such as "/api/cloudrop" or "https://api.example.com/api/cloudrop": no trailing slash, query or fragment.',
    );
  }
  if (!isHeaders(headers)) {
    throw configError(
      'headers must be the headers for the upload server, such as { authorization: "Bearer …" }, or a function that returns them.',
    );
  }
  if (account !== undefined && typeof account !== "function" && encodeAccount(account) === null) {
    throw configError(
      "account must be the signed-in user's id as the route's owner returns it, at most 255 characters, or a function that returns it.",
    );
  }
  if (fetch !== undefined && typeof fetch !== "function") throw configError("The fetch option must be a function.");
  if (typeof (fetch ?? globalThis.fetch) !== "function") {
    throw configError("No fetch is available here. Pass createCloudropClient({ fetch }).");
  }
  return { basePath, headers, account, fetch };
}

/** The options with their defaults; a wrong one throws its configuration error. */
export function readOptions(
  options: ClientOptions | null,
): Connection & Required<Omit<ClientOptions, keyof Connection>> {
  // null counts as no options, as createCloudrop reads its own (readConfig in server/config.ts).
  const given = options ?? {};
  // A signed-in user's id given as account keeps their records apart without saying it twice (M12-A4). A function's
  // value is known only at /upload, after records were listed, so it keeps the shared default.
  const { concurrency = "auto", order = "added", persist = true, account } = given;
  const { namespace = typeof account === "string" ? account : "" } = given;
  const connection = readConnection(given);
  if (concurrency !== "auto" && !(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16)) {
    throw configError('concurrency must be "auto" or a whole number from 1 to 16.');
  }
  if (order !== "added" && order !== "smallest-first") {
    throw configError('order must be "added" or "smallest-first".');
  }
  if (typeof persist !== "boolean") throw configError("persist must be true or false.");
  if (typeof namespace !== "string" || namespace.length > 256) {
    throw configError("namespace must be a string of at most 256 characters, such as the signed-in user's id.");
  }
  return { ...connection, concurrency, order, persist, namespace };
}
