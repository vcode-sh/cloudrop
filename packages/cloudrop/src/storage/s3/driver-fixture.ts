// Setup shared by the S3 driver's unit tests: a driver over the in-process fake R2 or over a stubbed fetch. It builds
// inputs only; every expected value stays in the tests.

import { R2_RULES } from "../../rules.ts";
import { createFakeR2, type FakeR2 } from "../../testing/fake-r2.ts";
import type { FetchLike, StorageDriver } from "../driver.ts";
import { createS3Driver } from "../s3-driver.ts";

export const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };
export const endpoint = "https://account.r2.cloudflarestorage.com";
export const signedAt: Date = new Date("2026-11-15T12:00:00Z");
export const now = (): Date => signedAt;
export const lastModified = "Sun, 15 Nov 2026 12:00:00 GMT";

export function setup(): { fake: FakeR2; driver: StorageDriver } {
  const fake = createFakeR2({ bucket: "test", credentials, now });
  const driver = createS3Driver({
    endpoint,
    region: "auto",
    bucket: "test",
    credentials,
    rules: R2_RULES,
    fetch: fake.fetch,
    now,
  });
  return { fake, driver };
}

export function driverWith(fetch: FetchLike): StorageDriver {
  return createS3Driver({ endpoint, region: "auto", bucket: "test", credentials, rules: R2_RULES, fetch, now });
}

export const stubbed =
  (respond: () => Promise<Response>): FetchLike =>
  () =>
    respond();
export const neverCalled: FetchLike = stubbed(() => Promise.reject(new Error("must not be called")));

/** Answers a copy: HEAD with the given source size, create and abort as R2 does, and the copy itself with `onCopy`. */
export function copyStub(size: number, onCopy: FetchLike, aborted: string[] = []): FetchLike {
  return async (input, init) => {
    if (init?.method === "HEAD") {
      return new Response(null, {
        headers: { "content-length": String(size), etag: '"src"', "last-modified": lastModified },
      });
    }
    if (init?.method === "POST") {
      return new Response("<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>");
    }
    if (init?.method === "DELETE") {
      aborted.push(new URL(String(input)).searchParams.get("uploadId") ?? "");
      return new Response(null, { status: 204 });
    }
    return onCopy(input, init);
  };
}

// The stub times out only requests that carry a signal, so a request sent without a timeout fails the message check.
export const timesOut: FetchLike = async (_input, init) => {
  if (!(init?.signal instanceof AbortSignal)) throw new TypeError("sent without a timeout");
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};
