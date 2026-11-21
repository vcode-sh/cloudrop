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
    // AWS sends RequestTimeout with 400, and its SDKs retry it as a transient error.
    [400, xml("RequestTimeout"), "STORAGE_ERROR", true, "RequestTimeout"],
    // A PutObject may be sent again, a multipart upload must be started again: not the same request, so not retryable.
    [409, xml("ConditionalRequestConflict"), "STORAGE_ERROR", false, "ConditionalRequestConflict"],
    [416, xml("InvalidRange"), "STORAGE_ERROR", false, "InvalidRange"],
    [301, xml("PermanentRedirect"), "STORAGE_ERROR", false, "PermanentRedirect"],
    [400, xml("AuthorizationHeaderMalformed"), "STORAGE_ERROR", false, "AuthorizationHeaderMalformed"],
    [307, xml("TemporaryRedirect"), "STORAGE_ERROR", false, "TemporaryRedirect"],
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

  const wrongEndpoint =
    "The storage endpoint redirected the request, or the bucket is in another region. Check the endpoint and region settings.";
  it.each([
    [
      "a range of an empty object or past the end",
      416,
      xml("InvalidRange"),
      "The byte range starts at or past the object's end. Ask for a range inside its size.",
    ],
    ["an endpoint of another region", 301, xml("PermanentRedirect"), wrongEndpoint],
    ["a signature for another region", 400, xml("AuthorizationHeaderMalformed"), wrongEndpoint],
    // AWS answers HEAD without a body, and any proxy may redirect (http to https, say).
    ["a redirect without a code", 301, "", wrongEndpoint],
    ["a temporary redirect", 307, xml("TemporaryRedirect"), wrongEndpoint],
    [
      "a signing clock that is off",
      403,
      xml("RequestTimeTooSkewed"),
      "This server's clock is more than 15 minutes off from the storage service's clock. Sync the clock (NTP), then retry.",
    ],
    [
      "a signed request that expired",
      403,
      xml("ExpiredRequest"),
      "The signed request expired. Sign it again and retry.",
    ],
    [
      "an access key the storage does not know",
      401,
      "",
      "The storage service did not accept these credentials. Check the access key ID and the secret access key.",
    ],
    [
      "a bucket that does not exist",
      404,
      xml("NoSuchBucket"),
      "The bucket does not exist. Check the bucket name in your configuration.",
    ],
    // Wrangler's local R2 answers ListParts with 501: a retry can never succeed there.
    [
      "a feature the storage lacks",
      501,
      xml("NotImplemented"),
      "The storage service does not support this request. Use R2 or another backend that implements it.",
    ],
    [
      "a conditional write that lost to another request",
      409,
      xml("ConditionalRequestConflict"),
      "Another request changed this key at the same moment. Write the object again, or start a new multipart upload.",
    ],
  ])("says what to change for %s", (_name, status, body, message) => {
    expect(storageError(status, body).message).toBe(message);
  });
});
