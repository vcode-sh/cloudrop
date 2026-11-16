// The public types of a job: several files sent through one /upload (spec §2, §2.2), exported from cloudrop/client.

import type { CloudropError } from "../errors.ts";
import type { CompleteResponse } from "../protocol/types.ts";

/** Where one file of a job stands. `done`, `failed` and `aborted` are final. */
export type FileStatus = "queued" | "uploading" | "paused" | "completing" | "done" | "failed" | "aborted";

/** How one file of a job ended. */
export type FileOutcome<R> =
  | { id: string; name: string; status: "done"; result: CompleteResponse<R> }
  | { id: string; name: string; status: "failed" | "aborted"; error: CloudropError };

/**
 * A job's result. Unlike `Result`, `data` stays when some files failed, so the files that succeeded are not hidden;
 * `error` is then the error of the first file, in the order passed, that did not end done. `data` is null only when
 * nothing started: the server refused the whole job, or the arguments were wrong.
 */
export type UploadResult<R> =
  | { data: { files: FileOutcome<R>[] }; error: null }
  | { data: { files: FileOutcome<R>[] }; error: CloudropError }
  | { data: null; error: CloudropError };

/** One file of a job. */
export interface FileHandle {
  /** The client's sequence number as text ("1", "2", …): unique per client, stable for the job's life. */
  readonly id: string;
  readonly name: string;
  /** Cancels this file only: its requests stop, the server is told, and it ends aborted. */
  abort(): void;
}

/** Several files sent through one /upload and one connection pool. */
export interface UploadJob<R> {
  /** The files in the order they were passed. */
  readonly files: readonly FileHandle[];
  /** Settles once, when every file has settled. Never rejects. */
  readonly done: Promise<UploadResult<R>>;
  /** Cancels every file, as the signal does. */
  abort(): void;
}
