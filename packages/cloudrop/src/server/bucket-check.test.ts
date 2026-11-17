import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError, fail } from "../errors.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { storageError } from "../storage/storage-error.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { allowAnyone, route } from "./route.ts";

const files = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:34:56Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/** A server whose storage is the fake with some methods replaced. */
function withStorage(changes: Partial<StorageDriver>) {
  return serverFixture({ files }, { storage: { ...serverFixture({ files }).storage, ...changes } });
}

describe("api.checkBucket", () => {
  const uploadRule = (expose: string) =>
    `<CORSRule><AllowedOrigin>https://app.example.com</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>content-disposition</AllowedHeader><AllowedHeader>if-none-match</AllowedHeader><AllowedHeader>x-amz-meta-*</AllowedHeader>${expose}</CORSRule>`;
  const abortRule =
    "<Rule><ID>abort</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>";

  it("reports a bucket that is ready for browser uploads", async () => {
    const fixture = serverFixture(
      { files },
      {
        trustedOrigins: ["https://app.example.com"],
        bucketConfig: {
          cors: `<CORSConfiguration>${uploadRule("<ExposeHeader>ETag</ExposeHeader>")}</CORSConfiguration>`,
          lifecycle: `<LifecycleConfiguration>${abortRule}</LifecycleConfiguration>`,
        },
      },
    );
    expect((await fixture.cloudrop.api.checkBucket()).data).toEqual({
      cors: { status: "ok", message: "Browsers on https://app.example.com can upload and read ETag." },
      lifecycle: { status: "ok", message: "Incomplete multipart uploads are aborted after 7 days." },
      publicAccess: { status: "ok", message: "No private route stores files on a public bucket." },
    });
  });

  it("counts a one-day abort rule as one day", async () => {
    const fixture = serverFixture(
      { files },
      {
        bucketConfig: {
          lifecycle: `<LifecycleConfiguration>${abortRule.replace(">7<", ">1<")}</LifecycleConfiguration>`,
        },
      },
    );
    expect((await fixture.cloudrop.api.checkBucket()).data?.lifecycle).toEqual({
      status: "ok",
      message: "Incomplete multipart uploads are aborted after 1 day.",
    });
  });

  it("finds a rule that does not expose ETag, a missing abort rule and a private route on a public bucket", async () => {
    const privateFiles = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone, visibility: "private" });
    const fixture = serverFixture(
      { privateFiles },
      {
        publicUrl: true,
        bucketConfig: {
          cors: `<CORSConfiguration>${uploadRule("")}</CORSConfiguration>`,
          lifecycle: "<LifecycleConfiguration></LifecycleConfiguration>",
        },
      },
    );
    expect((await fixture.cloudrop.api.checkBucket({ origins: ["https://app.example.com"] })).data).toEqual({
      cors: {
        status: "problem",
        message:
          "The bucket's CORS rules do not let https://app.example.com upload. Add a rule that allows PUT from there with the headers content-type, content-disposition, if-none-match, x-amz-meta-cloudrop-id and exposes ETag.",
      },
      lifecycle: {
        status: "problem",
        message:
          "No enabled lifecycle rule aborts incomplete multipart uploads across the bucket, so abandoned uploads keep their parts stored. Add one (R2 creates a 7-day rule by default).",
      },
      publicAccess: {
        status: "problem",
        message:
          "Private routes (privateFiles) store files on a bucket with a public URL: anyone who learns a key can read the file.",
      },
    });
  });

  it("reports unknown, never missing, when the credentials may not read the settings", async () => {
    const { cloudrop } = serverFixture({ files });
    const report = await cloudrop.api.checkBucket({ origins: ["https://app.example.com"] });
    expect([report.data?.cors.status, report.data?.lifecycle.status]).toEqual(["unknown", "unknown"]);
  });

  // Wrangler's local R2 answers both reads with 501 NotImplemented (measured 2026-11-16, wrangler 4.162.0).
  it("reports unknown when the storage does not implement the settings reads", async () => {
    const notImplemented = (request: string) =>
      fail(
        storageError(501, `<Error><Code>NotImplemented</Code><Message>${request} not implemented</Message></Error>`),
      );
    const fixture = withStorage({
      getBucketCors: async () => notImplemented("GetBucketCors"),
      getBucketLifecycle: async () => notImplemented("GetBucketLifecycleConfiguration"),
    });
    const report = await fixture.cloudrop.api.checkBucket({ origins: ["https://app.example.com"] });
    expect([report.data?.cors, report.data?.lifecycle]).toEqual([
      {
        status: "unknown",
        message:
          "This storage service cannot report the bucket's CORS rules. Check them where the bucket is configured (for R2, the dashboard).",
      },
      {
        status: "unknown",
        message:
          "This storage service cannot report the bucket's lifecycle rules. Check them where the bucket is configured (for R2, the dashboard).",
      },
    ]);
  });

  it.for<{ name: string; error: CloudropError }>([
    {
      name: "the storage is unreachable",
      error: new CloudropError("STORAGE_UNREACHABLE", "Could not reach the storage service.", { retryable: true }),
    },
    { name: "the storage fails with 500", error: storageError(500, "<Error><Code>InternalError</Code></Error>") },
  ])("fails, instead of reporting unknown, when $name", async ({ error }) => {
    const fixture = withStorage({ getBucketCors: async () => fail(error) });
    expect(await fixture.cloudrop.api.checkBucket({ origins: ["https://app.example.com"] })).toEqual({
      data: null,
      error,
    });
  });

  it("asks for origins when it has none to check", async () => {
    const { cloudrop } = serverFixture({ files }, { bucketConfig: {} });
    expect((await cloudrop.api.checkBucket()).data?.cors).toEqual({
      status: "unknown",
      message: 'Name the origins your pages upload from: api.checkBucket({ origins: ["https://app.example.com"] }).',
    });
  });

  // Origins are echoed in the report, so only exact origins may reach it: no path, header or credential text.
  it.for<{ name: string; options: unknown }>([
    { name: "options that are not an object", options: "https://app.example.com" },
    { name: "origins that are not a list", options: { origins: "https://app.example.com" } },
    { name: "an origin that is not text", options: { origins: [42] } },
    { name: "an origin with a path", options: { origins: ["https://app.example.com/upload"] } },
    { name: "an origin with a line break", options: { origins: ["https://app.example.com\r\nx-forged: 1"] } },
    { name: "an origin with credentials", options: { origins: ["https://user:secret@app.example.com"] } },
    { name: "a wildcard", options: { origins: ["*"] } },
  ])("refuses $name", async ({ options }) => {
    const { cloudrop } = serverFixture({ files }, { bucketConfig: {} });
    expect(await cloudrop.api.checkBucket(options as never)).toMatchObject({
      data: null,
      error: {
        code: "INVALID_INPUT",
        message:
          'checkBucket takes { origins } with exact origins such as "https://app.example.com": scheme and host, no path or trailing slash.',
      },
    });
  });
});

describe("development start-up warnings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("checks the bucket once, on the first request in development, and logs each problem", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fixture = serverFixture(
      { files },
      {
        trustedOrigins: ["https://app.example.com"],
        bucketConfig: { cors: "<CORSConfiguration></CORSConfiguration>" },
      },
    );
    // A check starts both reads before its first await, so a second check would have called them by the time the
    // second request is answered: counting the calls needs no wait.
    const corsReads = vi.spyOn(fixture.storage, "getBucketCors");
    const lifecycleReads = vi.spyOn(fixture.storage, "getBucketLifecycle");
    await fixture.post("upload", { route: "files", files: [{ name: "a.txt", size: 1, type: "text/plain" }] });
    await fixture.post("upload", { route: "files", files: [{ name: "b.txt", size: 1, type: "text/plain" }] });
    expect([corsReads.mock.calls.length, lifecycleReads.mock.calls.length]).toEqual([1, 1]);
    await vi.waitFor(() =>
      expect(fixture.logger.warnings).toEqual([
        "cloudrop: The bucket's CORS rules do not let https://app.example.com upload. Add a rule that allows PUT from there with the headers content-type, content-disposition, if-none-match, x-amz-meta-cloudrop-id and exposes ETag.",
        "cloudrop: No enabled lifecycle rule aborts incomplete multipart uploads across the bucket, so abandoned uploads keep their parts stored. Add one (R2 creates a 7-day rule by default).",
      ]),
    );
  });

  it("checks the origin of the first request's page when there are no trustedOrigins", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fixture = serverFixture(
      { files },
      {
        bucketConfig: {
          cors: "<CORSConfiguration></CORSConfiguration>",
          lifecycle:
            "<LifecycleConfiguration><Rule><ID>abort</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>",
        },
      },
    );
    await fixture.post("upload", { route: "files", files: [{ name: "a.txt", size: 1, type: "text/plain" }] });
    await vi.waitFor(() =>
      expect(fixture.logger.warnings).toEqual([
        "cloudrop: The bucket's CORS rules do not let https://app.example.com upload. Add a rule that allows PUT from there with the headers content-type, content-disposition, if-none-match, x-amz-meta-cloudrop-id and exposes ETag.",
      ]),
    );
  });

  // An unhandled rejection would stop a Node development server.
  it("logs a check that throws instead of leaving its rejection unhandled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const broken = new Error("custom driver bug");
    const fixture = withStorage({
      getBucketCors: () => {
        throw broken;
      },
    });
    const response = await fixture.post("upload", {
      route: "files",
      files: [{ name: "a.txt", size: 1, type: "text/plain" }],
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() =>
      expect(fixture.logger.errors).toEqual([
        { message: "cloudrop: the development bucket check failed.", error: broken },
      ]),
    );
  });

  it("does not check the bucket outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fixture = serverFixture({ files });
    await fixture.post("upload", { route: "files", files: [{ name: "a.txt", size: 1, type: "text/plain" }] });
    expect(fixture.storageCalls).toEqual([]);
  });
});
