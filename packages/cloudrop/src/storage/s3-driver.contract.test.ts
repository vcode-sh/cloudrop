import { R2_RULES } from "../rules.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import { describeStorageContract, randomPrefix } from "../testing/storage-contract.ts";
import { createS3Driver } from "./s3-driver.ts";

const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };

describeStorageContract("in-process fake R2", async (onCleanup) => {
  const fake = createFakeR2({ bucket: "contract", credentials });
  // Runs after the suite has removed its objects and aborted its uploads, so it proves the suite leaves none behind.
  onCleanup(async () => {
    if (fake.pendingUploads() > 0) throw new Error(`The suite left ${fake.pendingUploads()} multipart uploads open.`);
  });
  return {
    driverWith: ({ secondsAgo = 0, maxSinglePutSize = R2_RULES.maxSinglePutSize } = {}) =>
      createS3Driver({
        endpoint: "https://account.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "contract",
        credentials,
        rules: { ...R2_RULES, maxSinglePutSize },
        fetch: fake.fetch,
        now: () => new Date(Date.now() - secondsAgo * 1000),
      }),
    prefix: randomPrefix("contract/"),
    http: fake.fetch,
    gaps: { crc64nvme: "the fake does not compute CRC64NVME" },
    // The fake checks only the headers a URL signs, so an extra x-amz-meta-* header passes (and is stored).
    acceptsUnsignedMetaOnPresignedPut: true,
  };
});
