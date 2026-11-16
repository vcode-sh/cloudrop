// Contract: decision S10, what the client does with each answer of the bucket to a presigned PUT. Oracle: spec §6.2's
// table and the answers measured on R2 (docs/research/r2-spike-findings.md), RustFS and Wrangler
// (docs/research/2026-11-16-m3-slice-measurements.md).

import { describe, expect, it, vi } from "vitest";
import type { CloudropErrorCode } from "../errors.ts";
import type { SignedRequest } from "../protocol/types.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { files } from "../testing/upload-fixture.ts";
import { classifyAnswer, putObject } from "./bucket.ts";
import type { ClientFetch } from "./endpoints.ts";

const SIGNATURE_MISMATCH =
  "The storage service refused the file because its bytes do not match what the server signed. Pick the file again and start a new upload.";
const LINK_REFUSED =
  "The storage service refused the upload link, also after it was renewed. Check the server's clock and the storage credentials' permissions, then start the upload again.";
const BUSY = "The storage service is busy. Try again in a moment.";
const FAILED = "The storage service failed. Try again in a moment.";
const refused = (status: number) =>
  `The storage service refused the file (HTTP ${status}). Start the upload again, and contact the site owner if it keeps failing.`;

const error = (code: CloudropErrorCode, message: string, retryable: boolean) =>
  expect.objectContaining({ code, message, retryable });

const target: SignedRequest = {
  url: "https://uploads.example.com/a.txt?X-Amz-Signature=0000",
  headers: { "content-type": "text/plain", "if-none-match": "*" },
  expiresAt: "2026-11-15T12:15:00.000Z",
};
const body = new Blob(["hello"]);

describe("classifyAnswer", () => {
  it.each([
    {
      name: "never retries a signature mismatch",
      status: 403,
      code: "SignatureDoesNotMatch",
      retryAfterMs: 0,
      expected: { kind: "rejected", error: error("UPLOAD_REJECTED", SIGNATURE_MISMATCH, false) },
    },
    {
      name: "renews an expired URL",
      status: 403,
      code: "ExpiredRequest",
      retryAfterMs: 0,
      expected: { kind: "expired", error: error("UPLOAD_REJECTED", LINK_REFUSED, false), retryAfterMs: 0 },
    },
    {
      name: "renews a RustFS expiry",
      status: 403,
      code: "AccessDenied",
      retryAfterMs: 0,
      expected: { kind: "expired", error: error("UPLOAD_REJECTED", LINK_REFUSED, false), retryAfterMs: 0 },
    },
    {
      name: "renews a 403 without a readable code",
      status: 403,
      code: undefined,
      retryAfterMs: 0,
      expected: { kind: "expired", error: error("UPLOAD_REJECTED", LINK_REFUSED, false), retryAfterMs: 0 },
    },
    {
      name: "retries throttling by status, whatever the S3 code says",
      status: 429,
      code: "ServiceUnavailable",
      retryAfterMs: 2000,
      expected: { kind: "retry", error: error("RATE_LIMITED", BUSY, true), retryAfterMs: 2000 },
    },
    {
      name: "retries 503",
      status: 503,
      code: undefined,
      retryAfterMs: 0,
      expected: { kind: "retry", error: error("RATE_LIMITED", BUSY, true), retryAfterMs: 0 },
    },
    {
      name: "fails a request the storage does not implement",
      status: 501,
      code: "NotImplemented",
      retryAfterMs: 0,
      expected: { kind: "rejected", error: error("UPLOAD_REJECTED", refused(501), false) },
    },
    {
      name: "retries a server error",
      status: 500,
      code: undefined,
      retryAfterMs: 0,
      expected: { kind: "retry", error: error("STORAGE_ERROR", FAILED, true), retryAfterMs: 0 },
    },
    {
      name: "retries a timeout",
      status: 408,
      code: undefined,
      retryAfterMs: 0,
      expected: { kind: "retry", error: error("STORAGE_ERROR", FAILED, true), retryAfterMs: 0 },
    },
    {
      name: "fails a corrupted body",
      status: 400,
      code: "BadDigest",
      retryAfterMs: 0,
      expected: { kind: "rejected", error: error("UPLOAD_REJECTED", refused(400), false) },
    },
    {
      name: "fails a part of an aborted upload",
      status: 404,
      code: "NoSuchUpload",
      retryAfterMs: 0,
      expected: { kind: "rejected", error: error("UPLOAD_REJECTED", refused(404), false) },
    },
  ])("$name", ({ status, code, retryAfterMs, expected }) => {
    expect(classifyAnswer(status, code, retryAfterMs)).toEqual(expected);
  });
});

describe("putObject", () => {
  it("counts a second create-only PUT as stored", async () => {
    const fixture = serverFixture({ files });
    const ticket = await fixture.single("files", { name: "a.txt", size: 5, type: "text/plain" });
    const statuses: number[] = [];
    const recording: ClientFetch = async (url, init) => {
      const response = await fixture.fake.fetch(url, init);
      statuses.push(response.status);
      return response;
    };
    const { signal } = new AbortController();
    const first = await putObject(recording, ticket.put, body, signal);
    const second = await putObject(recording, ticket.put, body, signal);
    // The second PUT is refused by If-None-Match (spike Q2): its first attempt already stored the object.
    expect({ outcomes: [first, second], statuses }).toEqual({
      outcomes: [{ kind: "stored" }, { kind: "stored" }],
      statuses: [200, 412],
    });
  });

  it("reports a network failure as opaque", async () => {
    const offline: ClientFetch = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await putObject(offline, target, body, new AbortController().signal)).toEqual({
      kind: "opaque",
      error: error(
        "NETWORK_ERROR",
        "The file could not reach the storage service, or the storage service refused it. Try again, and contact the site owner if it keeps failing.",
        true,
      ),
      retryAfterMs: 0,
    });
  });

  it("reports a cancelled PUT as aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled: ClientFetch = () => Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    expect(await putObject(cancelled, target, body, controller.signal)).toEqual({
      kind: "aborted",
      error: error("ABORTED", "The upload was cancelled. Start it again to upload the file.", false),
    });
  });

  it("passes the bucket's Retry-After on", async () => {
    const busyBucket: ClientFetch = async () =>
      new Response("<Error><Code>ServiceUnavailable</Code></Error>", { status: 429, headers: { "retry-after": "2" } });
    expect(await putObject(busyBucket, target, body, new AbortController().signal)).toEqual({
      kind: "retry",
      error: error("RATE_LIMITED", BUSY, true),
      retryAfterMs: 2000,
    });
  });

  it("sends the signed headers, the body and the caller's signal, and no credentials, to the bucket", async () => {
    const bucket = vi.fn<ClientFetch>(async () => new Response(null, { status: 200 }));
    const controller = new AbortController();
    await putObject(bucket, target, body, controller.signal);
    const [url, init] = bucket.mock.calls[0] ?? [];
    expect({
      url,
      method: init?.method,
      headers: init?.headers,
      credentials: init?.credentials,
      signal: init?.signal,
      body: init?.body,
    }).toEqual({
      url: target.url,
      method: "PUT",
      headers: { "content-type": "text/plain", "if-none-match": "*" },
      credentials: "omit",
      signal: controller.signal,
      body,
    });
  });
});
