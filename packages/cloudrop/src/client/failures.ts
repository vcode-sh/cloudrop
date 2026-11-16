// Every message the client writes. Each is a fixed sentence, at most with an HTTP status: never a URL, a token or what
// the storage service answered (spec §7.7).

import { CloudropError } from "../errors.ts";

export const aborted = (): CloudropError =>
  new CloudropError("ABORTED", "The upload was cancelled. Start it again to upload the file.");

export const serverUnreachable = (): CloudropError =>
  new CloudropError("NETWORK_ERROR", "The upload server could not be reached. Check the connection, then try again.", {
    retryable: true,
  });

export const bucketUnreachable = (): CloudropError =>
  new CloudropError(
    "NETWORK_ERROR",
    "The file could not be sent to the storage service. Check the connection, then try again.",
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
