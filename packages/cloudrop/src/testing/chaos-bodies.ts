// The S3 error bodies the chaos lanes answer with in a bucket's place, one copy each: the proxy's random 503s, the
// Node rows and the browser rows (examples/next/app). The client reads the code, so each body carries the code its
// bucket sends; where a message was measured, it is the measured one.

const xml = (code: string, message: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

/** R2's 429: the code ServiceUnavailable, not TooManyRequests (docs/research/r2-spike-findings.md, Q9). */
export const R2_THROTTLED: string = xml(
  "ServiceUnavailable",
  "Reduce your concurrent request rate for the same object.",
);

/** R2's expired presigned URL: 403 ExpiredRequest (r2-spike-findings.md, Q7 and Browser U2). */
export const R2_EXPIRED: string = xml("ExpiredRequest", "Request has expired");

/** RustFS's expired presigned URL: 403 AccessDenied (src/storage/s3-driver.rustfs.integration.test.ts). */
export const RUSTFS_EXPIRED: string = xml("AccessDenied", "Request has expired");

/**
 * A 403 for a request that does not match its signature, as R2 answers one (r2-spike-findings.md, Q1 and Q18); the
 * message is S3's standard one.
 */
export const BAD_SIGNATURE: string = xml(
  "SignatureDoesNotMatch",
  "The request signature we calculated does not match the signature you provided.",
);

/** S3's 503 for a busy bucket, with its standard message; the server's own storage calls get it too. */
export const SLOW_DOWN: string = xml("SlowDown", "Please reduce your request rate.");

/** S3's 500, with its standard message. */
export const INTERNAL_ERROR: string = xml("InternalError", "We encountered an internal error. Please try again.");
