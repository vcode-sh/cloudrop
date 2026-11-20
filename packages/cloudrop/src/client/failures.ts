// Every message the client writes. Each is a fixed sentence, at most with an HTTP status: never a URL, a token or what
// the storage service answered (spec §7.7).

import { CloudropError } from "../errors.ts";

/** Failures that a new attempt with the same ticket cannot fix (ruling M3-U31), so neither can a resume (M4-F1). */
export const NEEDS_NEW_TICKET: Set<string | undefined> = new Set([
  "UPLOAD_EXPIRED",
  "INVALID_TOKEN",
  "UPLOAD_REJECTED",
  "VERIFICATION_FAILED",
  // The upload is gone and nothing of it was stored (M3-U74): its ticket can never finish it.
  "NO_SUCH_UPLOAD",
]);

/** `error` as the error of one file of a job: the same answer, with `file` set and the original as its cause. */
export const withFile = (error: CloudropError, { id, file }: { id: string; file: File }): CloudropError =>
  // The spread copies the error's own fields (retryable, status, storageCode, parts), never its message or cause.
  new CloudropError(error.code, error.message, { ...error, file: { id, name: file.name }, cause: error });

export const aborted = (): CloudropError =>
  new CloudropError("ABORTED", "The upload was cancelled. Start it again to upload the file.");

/** start(), upload() and resume() after close(), before any request (M8-L1). */
export const clientClosed = (): CloudropError =>
  new CloudropError(
    "CLIENT_CLOSED",
    "This upload client was closed, so it starts no more uploads. Use a new client, such as the one of the user who is signed in now.",
  );

// The next three end a resume() before any request (resume design §2.1); storageUnavailable, below, answers
// resumable(), discard() and forget() when the browser's storage fails, never an upload.
export const uploadInUse = (): CloudropError =>
  new CloudropError(
    "UPLOAD_IN_USE",
    "This upload is being sent in this browser, in this tab or another. Finish or cancel it there, then try again.",
  );

export const notResumable = (): CloudropError =>
  new CloudropError(
    "NOT_FOUND",
    "This upload can no longer be resumed: it finished, was cancelled or expired. Start it again.",
  );

export const notSameFile = (): CloudropError =>
  new CloudropError(
    "INVALID_INPUT",
    "This is not the file the upload started with. Pick the same file again to resume it.",
  );

// The next two end a discard() before any request (M3-U93); uploadInUse above does too.
export const notListed = (): CloudropError =>
  new CloudropError(
    "NOT_FOUND",
    "This upload is no longer in this browser's list: it finished, or was cancelled or discarded. Read the list again.",
  );

export const lockRefused = (): CloudropError =>
  new CloudropError(
    "STORAGE_ERROR",
    "The browser did not let this page lock the upload, so it was left as it was. Reload the page, then try again.",
  );

export const storageUnavailable = (): CloudropError =>
  new CloudropError(
    "STORAGE_ERROR",
    "The browser's storage for unfinished uploads could not be read or written. Uploads still work; resuming after a reload may not.",
  );

export const serverUnreachable = (): CloudropError =>
  new CloudropError("NETWORK_ERROR", "The upload server could not be reached. Check the connection, then try again.", {
    retryable: true,
  });

/** The headers option threw, rejected, gave what Headers refuses, or took longer than the request may (M8-L6). */
export const headersFailed = (cause: unknown): CloudropError =>
  new CloudropError(
    "NETWORK_ERROR",
    "The headers option gave no headers for a request to the upload server, so it was not sent. Check the function passed as headers, then try again.",
    { retryable: true, cause },
  );

// A page cannot tell a network failure from R2 refusing the URL itself (a bad signature, an expired URL): those answers
// carry no CORS headers (docs/research/r2-spike-findings.md, "Browser refusals and checksums, 2026-11-16"). A bucket
// CORS rule that misses the page's origin or a signed header looks the same, so for a developer this error usually
// means: check that rule first (docs/guide/troubleshooting.md).
export const bucketUnreachable = (): CloudropError =>
  new CloudropError(
    "NETWORK_ERROR",
    "The file could not reach the storage service, or the storage service refused it. Try again, and contact the site owner if it keeps failing.",
    { retryable: true },
  );

/** A proxy's rate-limit page in front of the app: it passes, so it is retried (rulings S-4, S-7). */
export const serverBusy = (): CloudropError =>
  new CloudropError("RATE_LIMITED", "The upload server is busy. Try again in a moment.", { retryable: true });

/**
 * A non-JSON answer or one of the wrong shape: a wrong basePath, a proxy's page, or another cloudrop version. Worth
 * retrying from 500 on.
 */
export const unreadableAnswer = (status: number): CloudropError =>
  new CloudropError(
    "SERVER_ERROR",
    `The upload server sent an answer this client cannot read (HTTP ${status}). Check that basePath points at the cloudrop handler and that the server runs the same cloudrop version.`,
    { retryable: status >= 500 },
  );

export const signatureMismatch = (): CloudropError =>
  new CloudropError(
    "UPLOAD_REJECTED",
    "The storage service refused the file because its bytes do not match what the server signed. Pick the file again and start a new upload.",
  );

export const linkRefused = (): CloudropError =>
  new CloudropError(
    "UPLOAD_REJECTED",
    "The storage service refused the upload link, also after it was renewed. Check the server's clock and the storage credentials' permissions, then start the upload again.",
  );

export const uploadRejected = (status: number): CloudropError =>
  new CloudropError(
    "UPLOAD_REJECTED",
    `The storage service refused the file (HTTP ${status}). Start the upload again, and contact the site owner if it keeps failing.`,
  );

// The next two repeat the server's wording for the same conditions (storageFailure in server/http.ts), which the
// client cannot import.
export const storageBusy = (): CloudropError =>
  new CloudropError("RATE_LIMITED", "The storage service is busy. Try again in a moment.", { retryable: true });

export const storageDown = (): CloudropError =>
  new CloudropError("STORAGE_ERROR", "The storage service failed. Try again in a moment.", { retryable: true });
