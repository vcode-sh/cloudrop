import { describe, expect, it } from "vitest";
import { storageError } from "./storage-error.ts";

const body = (code: string) => `<?xml version="1.0"?><Error><Code>${code}</Code><Message>raw text</Message></Error>`;

describe("storageError", () => {
  it.each([
    [404, "NoSuchUpload", "NO_SUCH_UPLOAD", false],
    [404, "NoSuchKey", "NOT_FOUND", false],
    [404, "", "NOT_FOUND", false],
    [412, "PreconditionFailed", "ALREADY_EXISTS", false],
    [400, "InvalidPart", "INVALID_PART", false],
    [400, "EntityTooSmall", "INVALID_PART", false],
    [400, "BadDigest", "CHECKSUM_MISMATCH", false],
    [403, "SignatureDoesNotMatch", "STORAGE_DENIED", false],
    [403, "RequestTimeTooSkewed", "STORAGE_DENIED", false],
    [429, "ServiceUnavailable", "RATE_LIMITED", true],
    [503, "SlowDown", "RATE_LIMITED", true],
    [500, "InternalError", "STORAGE_ERROR", true],
    [400, "InvalidArgument", "STORAGE_ERROR", false],
  ] as const)("maps HTTP %i %s to %s", (status, code, expected, retryable) => {
    const error = storageError(status, code ? body(code) : "");
    expect(error.code).toBe(expected);
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBe(status);
    expect(error.storageCode).toBe(code || undefined);
  });

  it("never copies the storage service's message or code into the error message", () => {
    const { message } = storageError(400, body("InvalidArgument"));
    expect(message).not.toContain("raw text");
    expect(message).not.toContain("InvalidArgument");
  });

  it("tells the person to fix the clock when the request time is skewed", () => {
    expect(storageError(403, body("RequestTimeTooSkewed")).message).toContain("clock");
  });
});
