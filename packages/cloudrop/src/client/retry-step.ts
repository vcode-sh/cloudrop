// What a failure leaves of its upload's ticket (M11-R80): the one place that says whether a new attempt can use it.
// retry() follows it (retry-file.ts), and so do the callers that ask whether a ticket is over (file-run.ts,
// discard.ts).

import type { CloudropError } from "../errors.ts";

/**
 * "same": the ticket is as good as before, so what has not landed is sent, then /complete. "resend": the ticket is
 * good, but the server found bytes missing that the bucket had acknowledged, so they are sent again first. "new": the
 * server ended the upload or the bucket refused it, so only a ticket from /upload can store the file.
 */
export type RetryStep = "same" | "resend" | "new";

/**
 * The answers that are not retryable and still leave the ticket good: the request was refused or failed, not the
 * upload. A request the handler turned away before reading the token (the first six) may pass once a proxy, basePath
 * or trustedOrigins is fixed; a SERVER_ERROR or STORAGE_ERROR for good is the server's own failure, which its owner
 * fixes; a BUCKET_BLOCKED PUT passes once the bucket's CORS rule lets the page through (M12-E7).
 */
const KEEPS_TICKET: ReadonlySet<string> = new Set([
  "INVALID_INPUT",
  "ORIGIN_NOT_ALLOWED",
  "METHOD_NOT_ALLOWED",
  "UNSUPPORTED_MEDIA_TYPE",
  "BODY_TOO_LARGE",
  "NOT_FOUND",
  "SERVER_ERROR",
  "STORAGE_ERROR",
  "BUCKET_BLOCKED",
]);

/** What a new attempt after `error` does with the upload's ticket. Any other refusal for good ends the ticket. */
export function retryStep({ code, retryable }: CloudropError): RetryStep {
  // /complete looked in the bucket and found the object, or some parts, missing: nothing else is wrong.
  if (code === "NOT_UPLOADED" || code === "PARTS_MISSING") return "resend";
  // A retryable answer says itself that the same request may pass later.
  return retryable || KEEPS_TICKET.has(code) ? "same" : "new";
}
