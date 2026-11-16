// The cloudrop/client entry: createCloudropClient and the types a browser app annotates with (decision S4).

import { isList } from "./client/arguments.ts";
import { type ClientFetch, createEndpoints } from "./client/endpoints.ts";
import { startJob } from "./client/job.ts";
import { createLeftovers } from "./client/lifecycle.ts";
import { createPool } from "./client/pool.ts";
import { createPut } from "./client/transport.ts";
import type { FileOutcome, UploadJob, UploadResult } from "./client/types.ts";
import type { UploadContext } from "./client/upload.ts";
import { configError, fail, ok, type Result } from "./errors.ts";
import type { CompleteResponse, InferableCloudrop, RouteMetadata, RouteName, RouteResult } from "./protocol/types.ts";

export type {
  FileHandle,
  FileOutcome,
  FileSnapshot,
  FileStatus,
  JobSnapshot,
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

export function createCloudropClient<TCloudrop extends InferableCloudrop = InferableCloudrop>(
  options: ClientOptions = {},
): CloudropClient<TCloudrop> {
  // null counts as no options, as createCloudrop reads its own (readConfig in server/config.ts).
  const { basePath = "/api/cloudrop", fetch, concurrency = "auto", order = "added" } = options ?? {};
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
  if (typeof (fetch ?? globalThis.fetch) !== "function") {
    throw configError("No fetch is available here. Pass createCloudropClient({ fetch }).");
  }
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
    leftovers: createLeftovers(endpoints.abort),
    keepFailed: true,
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
  };
}
