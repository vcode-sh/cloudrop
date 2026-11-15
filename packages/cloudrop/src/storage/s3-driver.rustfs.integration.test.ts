// The storage contract against a disposable RustFS container (S3-compatible, Apache-2.0). Run it with
// `scripts/test-rustfs.sh`, which starts the container, sets CLOUDROP_RUSTFS_ENDPOINT and removes the container.
import { S3_RULES } from "../rules.ts";
import { describeStorageContract, randomPrefix } from "../testing/storage-contract.ts";
import { createS3Driver } from "./s3-driver.ts";
import { EMPTY_SHA256, signRequest } from "./sigv4.ts";

const credentials = { accessKeyId: "cloudrop-test", secretAccessKey: "cloudrop-test-secret" };
const region = "us-east-1";
const bucket = "contract";

async function ensureBucket(endpoint: string): Promise<void> {
  const url = new URL(`${endpoint}/${bucket}`);
  const headers = await signRequest({
    method: "PUT",
    url,
    credentials,
    region,
    date: new Date(),
    payloadHash: EMPTY_SHA256,
  });
  const response = await fetch(url, { method: "PUT", headers });
  // 409 BucketAlreadyOwnedByYou: the container is reused by a second run.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Creating the RustFS bucket failed with HTTP ${response.status}. Check the container logs.`);
  }
}

describeStorageContract("RustFS", async () => {
  const endpoint = process.env.CLOUDROP_RUSTFS_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      "CLOUDROP_RUSTFS_ENDPOINT is not set. Run scripts/test-rustfs.sh, which starts RustFS and sets it.",
    );
  }
  await ensureBucket(endpoint);
  const driverWith = ({ secondsAgo = 0, maxSinglePutSize = S3_RULES.maxSinglePutSize }) =>
    createS3Driver({
      endpoint,
      region,
      bucket,
      credentials,
      rules: { ...S3_RULES, maxSinglePutSize },
      now: () => new Date(Date.now() - secondsAgo * 1000),
    });
  return {
    driver: driverWith({}),
    driverWith,
    prefix: randomPrefix(""),
    http: fetch,
    // Each reason below was measured against rustfs/rustfs:1.0.5 on 2026-11-15 (docs/research/test-backends.md).
    gaps: {
      unequalParts:
        "RustFS completes an upload whose last part is larger than the first (AWS S3 semantics); R2 answers InvalidPart.",
      listPartChecksums:
        "RustFS accepts and verifies a part's CRC32C but its ListParts XML carries no ChecksumCRC32C element.",
      crc64nvme: "RustFS does not compute CRC64NVME: HEAD with x-amz-checksum-mode ENABLED returns only the ETag.",
      finishedUploadsLinger:
        "RustFS keeps an upload after it completes and after a failed If-None-Match completion, so completing again succeeds; R2 answers NoSuchUpload.",
    },
    unsignedMetaOnPresignedPut: "rejected",
    // Measured: 403 AccessDenied "There were headers present in the request which were not signed", nothing stored.
    unsignedMetaCode: "AccessDenied",
    // Measured: 403 AccessDenied "Request has expired", nothing stored; R2 says ExpiredRequest.
    expiredUrlCode: "AccessDenied",
  };
});
