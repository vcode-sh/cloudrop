import { describe, expect, it } from "vitest";
import { credentials, driverWith, now, stubbed } from "../../testing/driver-fixture.ts";
import { createFakeR2 } from "../../testing/fake-r2.ts";
import type { StorageDriver } from "../driver.ts";

describe("bucket configuration", () => {
  const cors =
    "<CORSConfiguration><CORSRule><AllowedOrigin>http://localhost:5173</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>x-amz-meta-*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>";
  // R2's default multipart rule, plus a prefix-scoped expiry such as the test bucket's.
  const lifecycle =
    "<LifecycleConfiguration><Rule><ID>Default Multipart Abort Rule</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule><Rule><ID>live-test</ID><Status>Disabled</Status><Filter><Prefix>live-test/</Prefix></Filter><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>";

  function configured(bucketConfig?: { cors?: string; lifecycle?: string }): StorageDriver {
    return driverWith(createFakeR2({ bucket: "test", credentials, now, bucketConfig }).fetch);
  }

  it("reads the CORS rules", async () => {
    expect((await configured({ cors }).getBucketCors()).data).toEqual([
      {
        allowedOrigins: ["http://localhost:5173"],
        allowedMethods: ["PUT", "GET"],
        allowedHeaders: ["content-type", "x-amz-meta-*"],
        exposeHeaders: ["ETag"],
      },
    ]);
  });

  it("reads the lifecycle rules with their abort days and prefixes", async () => {
    expect((await configured({ lifecycle }).getBucketLifecycle()).data).toEqual([
      { id: "Default Multipart Abort Rule", enabled: true, prefix: "", abortIncompleteMultipartUploadDays: 7 },
      { id: "live-test", enabled: false, prefix: "live-test/" },
    ]);
  });

  it("answers no rules for a bucket without configuration", async () => {
    const driver = configured({});
    expect([(await driver.getBucketCors()).data, (await driver.getBucketLifecycle()).data]).toEqual([[], []]);
  });

  it.each([
    ["CORS", (driver: StorageDriver) => driver.getBucketCors(), "CORS configuration"],
    ["lifecycle", (driver: StorageDriver) => driver.getBucketLifecycle(), "lifecycle configuration"],
  ])(
    "reports a %s answer without its configuration element as a retryable storage error",
    async (_name, read, missing) => {
      // An HTML error page from a proxy is not "no rules": checkBucket would report rules the bucket may have.
      const html = stubbed(async () => new Response("<html><body>Bad gateway</body></html>"));
      expect((await read(driverWith(html))).error).toMatchObject({
        code: "STORAGE_ERROR",
        retryable: true,
        message: `The storage service's response had no ${missing}. Retry the request.`,
      });
    },
  );

  it.each([
    ["CORS", (driver: StorageDriver) => driver.getBucketCors(), "CORS"],
    ["lifecycle", (driver: StorageDriver) => driver.getBucketLifecycle(), "lifecycle"],
  ])(
    "reports a %s 404 without the missing-configuration code as a non-retryable storage error",
    async (_name, read, setting) => {
      // A proxy or a wrong endpoint path also answers 404; only the storage's own code means "no configuration".
      // Retrying the same path cannot fix a wrong endpoint (ruling R40).
      const proxy = stubbed(async () => new Response("<html><body>Not found</body></html>", { status: 404 }));
      expect((await read(driverWith(proxy))).error).toMatchObject({
        code: "STORAGE_ERROR",
        retryable: false,
        message: `The storage service answered 404 without saying that the bucket has no ${setting} configuration. Check the endpoint, then retry.`,
      });
    },
  );

  it("reports malformed abort days as a retryable storage error, never as NaN", async () => {
    const malformed = lifecycle.replace("<DaysAfterInitiation>7<", "<DaysAfterInitiation>seven<");
    expect((await configured({ lifecycle: malformed }).getBucketLifecycle()).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no valid multipart abort days. Retry the request.",
    });
  });

  it("reports a refused read as STORAGE_DENIED, never as no rules", async () => {
    const driver = configured();
    expect([(await driver.getBucketCors()).error?.code, (await driver.getBucketLifecycle()).error?.code]).toEqual([
      "STORAGE_DENIED",
      "STORAGE_DENIED",
    ]);
  });
});
