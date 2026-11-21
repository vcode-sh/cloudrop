import { CloudropError, type CloudropErrorCode } from "../errors.ts";
import { xmlValue } from "./xml.ts";

const INVALID_PART_CODES = new Set(["InvalidPart", "InvalidPartOrder", "EntityTooSmall"]);

interface Rule {
  matches: (status: number, storageCode: string | undefined) => boolean;
  code: CloudropErrorCode;
  message: string;
  retryable?: true;
}

/**
 * R2 refuses a request signed more than 15 minutes away from its own clock, either way (measured 2026-11-21). A Date
 * header has whole seconds, so an offset read from it may fall short of the real one by up to a second.
 */
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000 - 1000;

const CLOCK_SKEWED: Rule = {
  matches: (_status, storageCode) => storageCode === "RequestTimeTooSkewed",
  code: "STORAGE_DENIED",
  message:
    "This server's clock is more than 15 minutes off from the storage service's clock. Sync the clock (NTP), then retry.",
};

/** Checked in order; the first rule that matches decides. */
const RULES: readonly Rule[] = [
  {
    matches: (status, storageCode) => status === 404 && storageCode === "NoSuchUpload",
    code: "NO_SUCH_UPLOAD",
    message: "The multipart upload no longer exists. Start a new upload.",
  },
  {
    matches: (status, storageCode) => status === 404 && storageCode === "NoSuchBucket",
    code: "STORAGE_ERROR",
    message: "The bucket does not exist. Check the bucket name in your configuration.",
  },
  { matches: (status) => status === 404, code: "NOT_FOUND", message: "The object does not exist. Check the key." },
  {
    matches: (status) => status === 412,
    code: "ALREADY_EXISTS",
    message: "An object with this key already exists. Choose a different key.",
  },
  {
    matches: (_status, storageCode) => storageCode !== undefined && INVALID_PART_CODES.has(storageCode),
    code: "INVALID_PART",
    message: "One or more parts are missing or have the wrong size. Upload them again, then complete the upload.",
  },
  {
    matches: (_status, storageCode) => storageCode === "BadDigest",
    code: "CHECKSUM_MISMATCH",
    message: "The uploaded bytes do not match their checksum. Upload them again.",
  },
  CLOCK_SKEWED,
  {
    matches: (_status, storageCode) => storageCode === "ExpiredRequest",
    code: "STORAGE_DENIED",
    message: "The signed request expired. Sign it again and retry.",
  },
  {
    // R2 answers an unknown access key with 401, bare to HEAD and "Unauthorized" otherwise (measured 2026-11-21, M9-H5).
    matches: (status) => status === 401,
    code: "STORAGE_DENIED",
    message: "The storage service did not accept these credentials. Check the access key ID and the secret access key.",
  },
  {
    matches: (status) => status === 403,
    code: "STORAGE_DENIED",
    message: "The storage service refused the request. Check the access key, its permissions and the bucket name.",
  },
  {
    matches: (status) => status === 429 || status === 503,
    code: "RATE_LIMITED",
    message: "The storage service is throttling requests. Retry after a short delay.",
    retryable: true,
  },
  {
    // 501 Not Implemented: the backend lacks the feature (Wrangler's ListParts), so a retry can never succeed.
    matches: (status) => status === 501,
    code: "STORAGE_ERROR",
    message: "The storage service does not support this request. Use a storage service that implements it.",
  },
  {
    // Never followed: a request is signed for one host. AWS redirects a request sent to another region than the
    // bucket's, and names this code for one signed for another region (its error list; unmeasured).
    matches: (status, storageCode) => (status >= 300 && status < 400) || storageCode === "AuthorizationHeaderMalformed",
    code: "STORAGE_ERROR",
    message:
      "The storage endpoint redirected the request, or the bucket is in another region. Check the endpoint and region settings.",
  },
  {
    // R2 and RustFS answer 416 to any range of an empty object and to one that starts past the end (measured).
    matches: (status) => status === 416,
    code: "STORAGE_ERROR",
    message: "The byte range starts at or past the object's end. Ask for a range inside its size.",
  },
  {
    // S3 lets a PutObject be sent again but wants a multipart upload started again: never the same request (M11-R23).
    matches: (_status, storageCode) => storageCode === "ConditionalRequestConflict",
    code: "STORAGE_ERROR",
    message:
      "Another request changed this key at the same moment. Write the object again, or start a new multipart upload.",
  },
  {
    // AWS sends RequestTimeout with 400, and its SDKs retry it as a transient error.
    matches: (status, storageCode) =>
      status >= 500 || status === 408 || storageCode === "OperationAborted" || storageCode === "RequestTimeout",
    code: "STORAGE_ERROR",
    message: "The storage service failed. Retry the request.",
    retryable: true,
  },
];

/**
 * Turns a failed S3 response into a CloudropError. 429 and 503 are matched by status, never by S3 code: real R2
 * answered a same-key write burst with HTTP 429 and S3 code "ServiceUnavailable" (docs/research/r2-spike-findings.md, Q9).
 * `clockOffsetMs` is the answer's Date header minus the request's signing time: an answer to HEAD has no body, so a
 * bare 403 that far off is the clock, not the credentials (M9-H2).
 */
export function storageError(status: number, body: string, clockOffsetMs = 0): CloudropError {
  const rawCode = xmlValue(body, "Code");
  // The code comes from the response body and goes to logs, so accept only what an S3 code looks like.
  const storageCode = rawCode && /^[A-Za-z0-9]{1,64}$/.test(rawCode) ? rawCode : undefined;
  const skewed = status === 403 && storageCode === undefined && Math.abs(clockOffsetMs) > MAX_CLOCK_SKEW_MS;
  const rule = skewed ? CLOCK_SKEWED : RULES.find((candidate) => candidate.matches(status, storageCode));
  if (rule) return new CloudropError(rule.code, rule.message, { status, storageCode, retryable: rule.retryable });
  return new CloudropError(
    "STORAGE_ERROR",
    `The storage service rejected the request (HTTP ${status}). Check the key, size and headers you passed, then retry.`,
    { status, storageCode },
  );
}
