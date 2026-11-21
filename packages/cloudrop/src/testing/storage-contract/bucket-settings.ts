// Writing the bucket's CORS and lifecycle rules: what `cloudrop setup --apply` relies on. Both writes replace the whole
// configuration, so the cases also prove that rules read from the bucket survive being written back.

import { expect, it } from "vitest";
import type { BucketCorsRule, BucketLifecycleRule, StorageDriver } from "../../storage/driver.ts";
import type { ContractSuite } from "./suite.ts";

function writesOf(driver: StorageDriver) {
  const { putBucketCors, putBucketLifecycle } = driver;
  if (!putBucketCors || !putBucketLifecycle) throw new Error("The contract driver cannot write bucket settings.");
  return { putBucketCors, putBucketLifecycle };
}

const uploads: BucketCorsRule = {
  id: "cloudrop-uploads",
  allowedOrigins: ["https://app.example.com", "http://localhost:5173"],
  allowedMethods: ["PUT"],
  allowedHeaders: ["content-type", "x-amz-meta-cloudrop-id"],
  exposeHeaders: ["ETag"],
  maxAgeSeconds: 3600,
};
const reads: BucketCorsRule = {
  id: "public-reads",
  allowedOrigins: ["*"],
  allowedMethods: ["GET", "HEAD"],
  allowedHeaders: [],
  exposeHeaders: [],
};
const abortRule: BucketLifecycleRule = {
  id: "cloudrop-abort-incomplete",
  enabled: true,
  prefix: "",
  abortIncompleteMultipartUploadDays: 1,
};
// A rule cloudrop does not model: only its own XML can carry the expiration through a write.
const expireLogs: BucketLifecycleRule = {
  id: "expire-logs",
  enabled: true,
  prefix: "logs/",
  sourceXml:
    "<ID>expire-logs</ID><Filter><Prefix>logs/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration>",
};
const EXPIRES_AFTER_30_DAYS = /<Expiration>\s*<Days>30<\/Days>\s*<\/Expiration>/;

const fields = ({ sourceXml: _, ...rule }: BucketLifecycleRule) => rule;

export function bucketSettingsCases(suite: ContractSuite): void {
  it("writes CORS rules that read back as written, and a write replaces the whole configuration", async (ctx) => {
    suite.skipWithout(ctx, "bucketSettingsWrites");
    const { driver } = suite;
    const { putBucketCors } = writesOf(driver);
    expect((await putBucketCors([uploads, reads])).error).toBeNull();
    expect((await driver.getBucketCors()).data).toEqual([uploads, reads]);
    expect((await putBucketCors([reads])).error).toBeNull();
    expect((await driver.getBucketCors()).data).toEqual([reads]);
  });

  it("writes a lifecycle rule from its fields and keeps another rule's expiration when written back", async (ctx) => {
    suite.skipWithout(ctx, "bucketSettingsWrites");
    const { driver } = suite;
    const { putBucketLifecycle } = writesOf(driver);
    expect((await putBucketLifecycle([expireLogs, abortRule])).error).toBeNull();
    const first = await driver.getBucketLifecycle();
    expect(first.data?.map(fields)).toEqual([fields(expireLogs), abortRule]);
    // Written back exactly as read, the way `cloudrop setup` merges: the expiration must survive.
    expect((await putBucketLifecycle(first.data ?? [])).error).toBeNull();
    const second = await driver.getBucketLifecycle();
    expect(second.data?.map(fields)).toEqual([fields(expireLogs), abortRule]);
    expect(second.data?.[0]?.sourceXml).toMatch(EXPIRES_AFTER_30_DAYS);
  });
}
