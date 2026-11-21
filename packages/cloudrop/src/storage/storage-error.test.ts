import { describe, expect, it } from "vitest";
import { storageError } from "./storage-error.ts";

const xml = (code: string) => `<?xml version="1.0"?><Error><Code>${code}</Code><Message>raw text</Message></Error>`;

describe("storageError", () => {
  it.each([
    [404, xml("NoSuchUpload"), "NO_SUCH_UPLOAD", false, "NoSuchUpload"],
    [404, xml("NoSuchKey"), "NOT_FOUND", false, "NoSuchKey"],
    [404, "", "NOT_FOUND", false, undefined],
    [404, xml("NoSuchBucket"), "STORAGE_ERROR", false, "NoSuchBucket"],
    [412, xml("PreconditionFailed"), "ALREADY_EXISTS", false, "PreconditionFailed"],
    [400, xml("InvalidPart"), "INVALID_PART", false, "InvalidPart"],
    [400, xml("EntityTooSmall"), "INVALID_PART", false, "EntityTooSmall"],
    [400, xml("BadDigest"), "CHECKSUM_MISMATCH", false, "BadDigest"],
    [403, xml("SignatureDoesNotMatch"), "STORAGE_DENIED", false, "SignatureDoesNotMatch"],
    [403, xml("RequestTimeTooSkewed"), "STORAGE_DENIED", false, "RequestTimeTooSkewed"],
    [403, xml("ExpiredRequest"), "STORAGE_DENIED", false, "ExpiredRequest"],
    // R2 answers an unknown access key with 401: a bare one to HEAD, "Unauthorized" in the body otherwise (M9-H5).
    [401, xml("Unauthorized"), "STORAGE_DENIED", false, "Unauthorized"],
    [401, "", "STORAGE_DENIED", false, undefined],
    [429, xml("ServiceUnavailable"), "RATE_LIMITED", true, "ServiceUnavailable"],
    [503, xml("SlowDown"), "RATE_LIMITED", true, "SlowDown"],
    [503, "", "RATE_LIMITED", true, undefined],
    [500, xml("InternalError"), "STORAGE_ERROR", true, "InternalError"],
    [501, xml("NotImplemented"), "STORAGE_ERROR", false, "NotImplemented"],
    [502, "", "STORAGE_ERROR", true, undefined],
    [504, "<html><body>Gateway Timeout</body></html>", "STORAGE_ERROR", true, undefined],
    [408, xml("RequestTimeout"), "STORAGE_ERROR", true, "RequestTimeout"],
    [409, xml("OperationAborted"), "STORAGE_ERROR", true, "OperationAborted"],
    [400, xml("InvalidArgument"), "STORAGE_ERROR", false, "InvalidArgument"],
    [400, "<Error><Code></Code></Error>", "STORAGE_ERROR", false, undefined],
    [400, `<Error><Code>${"A".repeat(65)}</Code></Error>`, "STORAGE_ERROR", false, undefined],
    [400, "<Error><Code>Bad\nCode</Code></Error>", "STORAGE_ERROR", false, undefined],
    [500, "<Error><Code>&#x110000;</Code></Error>", "STORAGE_ERROR", true, undefined],
  ] as const)("maps HTTP %i %s to %s", (status, body, expected, retryable, storageCode) => {
    const error = storageError(status, body);
    expect(error.code).toBe(expected);
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBe(status);
    expect(error.storageCode).toBe(storageCode);
  });

  it("never copies the storage service's message or code into the error message", () => {
    const { message } = storageError(400, xml("InvalidArgument"));
    expect(message).not.toContain("raw text");
    expect(message).not.toContain("InvalidArgument");
  });

  it("points a 401 at the access key ID and secret, not at the request", () => {
    expect(storageError(401, "").message).toBe(
      "The storage service did not accept these credentials. Check the access key ID and the secret access key.",
    );
  });

  it("tells the person to fix the clock when the request time is skewed", () => {
    expect(storageError(403, xml("RequestTimeTooSkewed")).message).toContain("clock");
  });

  it("tells the person to sign again when the signed request expired", () => {
    expect(storageError(403, xml("ExpiredRequest")).message).toContain("expired");
  });

  // Wrangler's local R2 answers ListParts with 501: a retry can never succeed there.
  it("tells the person a 501 means the storage service lacks the feature, not that it failed", () => {
    expect(storageError(501, xml("NotImplemented")).message).toBe(
      "The storage service does not support this request. Use R2 or another backend that implements it.",
    );
  });

  it("points a missing bucket at the bucket name, not the object key", () => {
    expect(storageError(404, xml("NoSuchBucket")).message).toContain("bucket name");
  });
});
