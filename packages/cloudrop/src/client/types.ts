// The public types of a job: several files sent through one /upload (spec §2, §2.2), exported from cloudrop/client.

import type { CloudropError } from "../errors.ts";
import type { CompleteResponse } from "../protocol/types.ts";

/** Where one file of a job stands. `done`, `failed` and `aborted` are final. */
export type FileStatus = "queued" | "uploading" | "paused" | "completing" | "done" | "failed" | "aborted";

/** One file as a page renders it (spec §2.1). */
export interface FileSnapshot<R> {
  /** The same id as the file's handle. */
  id: string;
  name: string;
  size: number;
  type: string;
  status: FileStatus;
  /** Bytes sent, never decreasing: a re-sent part counts once it passes its earlier attempt (spec §4.2). */
  bytes: number;
  /** `bytes / size`; for an empty file, 1 once done and 0 before. */
  progress: number;
  /** Bytes per second, averaged over about 3 s (spec §4.3); 0 unless uploading. */
  speed: number;
  /** Seconds left at the current speed; null while the speed is 0. */
  eta: number | null;
  error: CloudropError | null;
  result: CompleteResponse<R> | null;
}

/** The whole job as a page renders it. A new object only when something changed (spec §2.1). */
export interface JobSnapshot<R> {
  /** In the order the files were passed. */
  files: readonly FileSnapshot<R>[];
  /**
   * `bytes`, `size`, `progress`, `speed` and `eta` count only the files that did not fail or abort, so a failed file
   * never holds the job below 1; `done`, `failed` and `aborted` count files, and `count` is every file of the job.
   */
  totals: {
    bytes: number;
    size: number;
    progress: number;
    speed: number;
    eta: number | null;
    done: number;
    failed: number;
    aborted: number;
    count: number;
  };
}

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
  /**
   * Calls `listener` when the snapshot changes: at once on a status change, at most every 100 ms while bytes flow, and
   * every second while a file uploads. Returns the unsubscribe. Needs no `this`, as `useSyncExternalStore` calls it.
   */
  subscribe(listener: () => void): () => void;
  /** The current snapshot: the same object until something changes. */
  getSnapshot(): JobSnapshot<R>;
}
