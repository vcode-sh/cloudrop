// The cloudrop/client entry: createCloudropClient and the types a browser app annotates with (decision S4).

import { isList } from "./client/arguments.ts";
import { type Discarded, discard } from "./client/discard.ts";
import { type ClientFetch, createEndpoints } from "./client/endpoints.ts";
import { giveUp } from "./client/file-run.ts";
import { startJob } from "./client/job.ts";
import { createLeftovers } from "./client/lifecycle.ts";
import { createPool } from "./client/pool.ts";
import { createRecords } from "./client/records.ts";
import { forget, resumable, resumeJob } from "./client/resume.ts";
import { createPut } from "./client/transport.ts";
import type { FileOutcome, ResumableUpload, UploadJob, UploadResult } from "./client/types.ts";
import type { UploadContext } from "./client/upload.ts";
import { configError, fail, ok, type Result } from "./errors.ts";
import type { CompleteResponse, InferableCloudrop, RouteMetadata, RouteName, RouteResult } from "./protocol/types.ts";

export type { Discarded } from "./client/discard.ts";
export type {
  FileHandle,
  FileOutcome,
  FileSnapshot,
  FileStatus,
  JobSnapshot,
  ResumableUpload,
  UploadJob,
  UploadResult,
} from "./client/types.ts";
export { CloudropError, type CloudropErrorCode, type Result } from "./errors.ts";
// The wire types of the four endpoints, and the route inference types a client user annotates with (InferableCloudrop,
// RouteMetadata, RouteName, RouteResult; S4, ruling M3-H13), which the root entry exports too.
export type {
  AbortRequest,
  AbortResponse,
  CompleteRequest,
  CompleteResponse,
  Endpoint,
  ErrorBody,
  ErrorResponse,
  FileDescriptor,
  FileTicket,
  InferableCloudrop,
  MultipartTicket,
  RejectedFile,
  RouteMetadata,
  RouteName,
  RouteResult,
  SignedPart,
  SignedRequest,
  SignRequest,
  SignResponse,
  SingleTicket,
  UploadedFile,
  UploadRequest,
  UploadResponse,
} from "./protocol/types.ts";

export interface ClientOptions {
  /** Where the server's handler is mounted: a path on this page's origin or an absolute URL. Default "/api/cloudrop". */
  basePath?: string;
  /** Replaces the global fetch, for tests and runtimes that bring their own. */
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
   * 256 characters; default "".
   */
  namespace?: string;
}

export interface UploadOptions<TMetadata = unknown> {
  /** Validated by the route's schema on the server. */
  metadata?: TMetadata;
  /** Cancels the upload: requests stop, the server is told, and the result is ABORTED. */
  signal?: AbortSignal;
}

/** The options argument is required when the route's metadata is. */
export type UploadArguments<TMetadata> = undefined extends TMetadata
  ? [options?: UploadOptions<TMetadata>]
  : [options: UploadOptions<TMetadata> & { metadata: TMetadata }];

export interface CloudropClient<TCloudrop extends InferableCloudrop = InferableCloudrop> {
  /** Sends one file or several through one /upload; each file then runs on its own through the client's pool. */
  start<TName extends RouteName<TCloudrop>>(
    route: TName,
    files: File | ArrayLike<File>,
    ...options: UploadArguments<RouteMetadata<TCloudrop, TName>>
  ): UploadJob<RouteResult<TCloudrop, TName>>;
  // The list overload comes first: ReturnType and Parameters read the last one, the single file of earlier versions.
  /** Uploads several files, such as input.files, and resolves with an outcome per file once all have settled. */
  upload<TName extends RouteName<TCloudrop>>(
    route: TName,
    files: ArrayLike<File>,
    ...options: UploadArguments<RouteMetadata<TCloudrop, TName>>
  ): Promise<UploadResult<RouteResult<TCloudrop, TName>>>;
  /** Uploads one file and resolves with the route's result or the error. */
  upload<TName extends RouteName<TCloudrop>>(
    route: TName,
    file: File,
    ...options: UploadArguments<RouteMetadata<TCloudrop, TName>>
  ): Promise<Result<CompleteResponse<RouteResult<TCloudrop, TName>>>>;
  /** The unfinished uploads this browser keeps for the client's namespace, newest first: of `route`, or of all. */
  resumable<TName extends RouteName<TCloudrop> = RouteName<TCloudrop>>(
    route?: TName,
  ): Promise<Result<ResumableUpload<TName>[]>>;
  /**
   * Continues an unfinished upload with the file the user picked again: the server is asked first which parts the
   * bucket lacks, and only those are sent. The route and the metadata are the upload's own.
   */
  resume<TName extends RouteName<TCloudrop>>(
    upload: ResumableUpload<TName>,
    file: File,
    options?: { signal?: AbortSignal },
  ): UploadJob<RouteResult<TCloudrop, TName>>;
  /**
   * Drops one unfinished upload from resumable() without its file: the server is told to abort it, and its record is
   * deleted. `aborted` is false when its token could no longer abort anything; the bucket's lifecycle rule cleans up.
   */
  discard(upload: ResumableUpload<RouteName<TCloudrop>>): Promise<Result<Discarded>>;
  /** Deletes the namespace's unfinished uploads, which sign-out should do, or every one in this browser with `all`. */
  forget(options?: { all: true }): Promise<Result<{ forgotten: number }>>;
}

/** A one-file job's result as that file's Result (ruling M3-U5). */
function oneFile(result: UploadResult<unknown>): Result<CompleteResponse<unknown>> {
  if (result.error) return fail(result.error);
  // No error: the job's one file ended done.
  const [outcome] = result.data.files as [FileOutcome<unknown> & { status: "done" }];
  return ok(outcome.result);
}

/** A path such as /api/cloudrop, or an absolute http(s) URL ending in one; no trailing slash, query or fragment (S17). */
const BASE_PATH = /^(?:https?:\/\/[^/?#\s]+)?(?:\/[^/?#\s]+)+$/;

/** The options with their defaults; a wrong one throws its configuration error (S17, M3-U41, M3-U42, M3-U79). */
function readOptions(
  options: ClientOptions | null,
): Required<Omit<ClientOptions, "fetch">> & Pick<ClientOptions, "fetch"> {
  // null counts as no options, as createCloudrop reads its own (readConfig in server/config.ts).
  const {
    basePath = "/api/cloudrop",
    fetch,
    concurrency = "auto",
    order = "added",
    persist = true,
    namespace = "",
  } = options ?? {};
  if (typeof basePath !== "string" || !BASE_PATH.test(basePath)) {
    throw configError(
      'basePath must be where the cloudrop handler is mounted, such as "/api/cloudrop" or "https://api.example.com/api/cloudrop": no trailing slash, query or fragment.',
    );
  }
  if (fetch !== undefined && typeof fetch !== "function") throw configError("The fetch option must be a function.");
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
  if (typeof (fetch ?? globalThis.fetch) !== "function") {
    throw configError("No fetch is available here. Pass createCloudropClient({ fetch }).");
  }
  return { basePath, fetch, concurrency, order, persist, namespace };
}

export function createCloudropClient<TCloudrop extends InferableCloudrop = InferableCloudrop>(
  options: ClientOptions = {},
): CloudropClient<TCloudrop> {
  const { basePath, fetch, concurrency, order, persist, namespace } = readOptions(options);
  // Looked up on every request, so a fetch patched later is used, and called on globalThis: a browser throws "Illegal
  // invocation" when fetch runs as a method of another object (S18).
  const send: ClientFetch = fetch ?? ((url, init) => globalThis.fetch(url, init));
  // Bucket PUTs go through XMLHttpRequest in a browser unless a fetch option was passed (spec §4.1, ruling M3-U6).
  let rank = 0;
  const endpoints = createEndpoints(basePath, send);
  const context: UploadContext = {
    endpoints,
    put: createPut(fetch, send),
    pool: createPool(concurrency),
    order,
    nextRank: () => ++rank,
    // Called only when the page hides, after `context` below exists.
    leftovers: createLeftovers((held) => giveUp(context, held)),
    keepFailed: true,
    records: createRecords(persist),
    namespace,
    claims: new Set(),
  };
  // The server's types reach the client through `import type` only, so the wire answer cannot be checked against them
  // at run time: the casts below give the route's result type to what the server sent.
  function upload(
    route: unknown,
    files: unknown,
    options?: unknown,
  ): Promise<UploadResult<unknown> | Result<CompleteResponse<unknown>>> {
    // No handle to retry with: a failed file tells the server at once (ruling M3-U29).
    const { done } = startJob({ ...context, keepFailed: false }, route, files, options);
    // Anything that is not a list goes the one-file way, so a wrong argument keeps the message it had.
    return isList(files) ? done : done.then(oneFile);
  }
  // No `this`: `const { upload } = createCloudropClient()` works (S2).
  return {
    start: (route, files, ...rest) =>
      startJob(context, route, files, rest[0]) as UploadJob<RouteResult<TCloudrop, typeof route>>,
    upload: upload as CloudropClient<TCloudrop>["upload"],
    resumable: (route) => resumable(context, route) as Promise<Result<ResumableUpload<typeof route & string>[]>>,
    resume: (upload, file, options) =>
      resumeJob(context, upload, file, options) as UploadJob<RouteResult<TCloudrop, typeof upload.route>>,
    discard: (upload) => discard(context, upload),
    forget: (options) => forget(context, options),
  };
}
