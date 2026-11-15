import { CloudropError } from "../errors.ts";
import { xmlText } from "./xml.ts";

const INVALID_PART_CODES = new Set(["InvalidPart", "InvalidPartOrder", "EntityTooSmall"]);

/**
 * Turns a failed S3 response into a CloudropError. Mapping keys on the HTTP status first: real R2 answered a
 * same-key write burst with HTTP 429 and S3 code "ServiceUnavailable" (docs/research/r2-spike-findings.md, Q9).
 */
export function storageError(status: number, body: string): CloudropError {
  const storageCode = xmlText(body, "Code") || undefined;
  const options = { status, storageCode };
  if (status === 404 && storageCode === "NoSuchUpload") {
    return new CloudropError("NO_SUCH_UPLOAD", "The multipart upload no longer exists. Start a new upload.", options);
  }
  if (status === 404) return new CloudropError("NOT_FOUND", "The object does not exist. Check the key.", options);
  if (status === 412) return new CloudropError("ALREADY_EXISTS", "An object with this key already exists.", options);
  if (storageCode && INVALID_PART_CODES.has(storageCode)) {
    return new CloudropError(
      "INVALID_PART",
      "One or more parts are missing or have the wrong size. Upload them again, then complete the upload.",
      options,
    );
  }
  if (storageCode === "BadDigest") {
    return new CloudropError(
      "CHECKSUM_MISMATCH",
      "The uploaded bytes do not match their checksum. Upload them again.",
      options,
    );
  }
  if (storageCode === "RequestTimeTooSkewed") {
    return new CloudropError(
      "STORAGE_DENIED",
      "This server's clock is more than 15 minutes off from the storage service's clock. Sync the clock (NTP), then retry.",
      options,
    );
  }
  if (status === 403) {
    return new CloudropError(
      "STORAGE_DENIED",
      "The storage service refused the request. Check the access key, its permissions and the bucket name.",
      options,
    );
  }
  if (status === 429 || status === 503) {
    return new CloudropError("RATE_LIMITED", "The storage service is throttling requests. Retry after a short delay.", {
      ...options,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new CloudropError("STORAGE_ERROR", "The storage service failed. Retry the request.", {
      ...options,
      retryable: true,
    });
  }
  return new CloudropError(
    "STORAGE_ERROR",
    `The storage service rejected the request (HTTP ${status}). Check the key, size and headers you passed, then retry.`,
    options,
  );
}
