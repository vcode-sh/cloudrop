// The storage contract against Wrangler's local R2 S3 endpoint (experimental). Run it with `scripts/test-wrangler.sh`,
// which starts Wrangler, sets CLOUDROP_WRANGLER_ENDPOINT and stops Wrangler.
import { R2_RULES } from "../rules.ts";
import { type ContractTarget, describeStorageContract, randomPrefix } from "../testing/storage-contract.ts";
import { createS3Driver } from "./s3-driver.ts";

const credentials = { accessKeyId: "cloudrop-local", secretAccessKey: "cloudrop-local-secret" };

describeStorageContract("Wrangler local R2", async () => {
  const endpoint = process.env.CLOUDROP_WRANGLER_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      "CLOUDROP_WRANGLER_ENDPOINT is not set. Run scripts/test-wrangler.sh, which starts Wrangler and sets it.",
    );
  }
  const driverWith: ContractTarget["driverWith"] = ({
    secondsAgo = 0,
    maxSinglePutSize = R2_RULES.maxSinglePutSize,
    fetch,
  }) =>
    createS3Driver({
      endpoint,
      region: "auto",
      bucket: "contract",
      credentials,
      rules: { ...R2_RULES, maxSinglePutSize },
      fetch,
      now: () => new Date(Date.now() - secondsAgo * 1000),
    });
  return {
    driver: driverWith({}),
    driverWith,
    prefix: randomPrefix(""),
    http: fetch,
    // Each reason below was measured against wrangler 4.162.0 on 2026-11-15 (docs/research/test-backends.md).
    gaps: {
      listParts: "Wrangler local R2 does not implement ListParts: it answers 501 NotImplemented.",
      checksums:
        "Wrangler local R2 ignores x-amz-checksum-* headers: a part with a wrong CRC32C is accepted with 200, where R2 answers BadDigest.",
      crc64nvme: "Wrangler local R2 does not compute CRC64NVME: HEAD returns no x-amz-checksum-crc64nvme.",
      copyPartPrecondition:
        "Wrangler local R2 answers 501 NotImplemented to an UploadPartCopy carrying x-amz-copy-source-if-match (the same copy without it succeeds), so the driver's guarded multipart copy cannot run there; R2 honours the header.",
      conditionalCompletion:
        "Wrangler local R2 ignores If-None-Match on CompleteMultipartUpload: it overwrites the existing key, where R2 answers 412.",
      responseOverrides:
        "Wrangler local R2 ignores response-content-disposition on a presigned GET: it answers 200 without Content-Disposition, where R2 applies it.",
      // Measured against wrangler 4.166.0 on 2026-11-21 (M9-C4).
      bucketSettingsWrites:
        "Wrangler local R2 answers 501 NotImplemented to PutBucketCors and PutBucketLifecycleConfiguration, as it does to their reads.",
    },
    // Measured: the last part larger than the others is refused, but as 404 NoSuchUpload (the upload survives and
    // completes once the part is replaced); R2 answers InvalidPart.
    unequalPartsCode: "NO_SUCH_UPLOAD",
    // Measured: 200, and the extra header is stored as object metadata (R2 answers 403 SignatureDoesNotMatch).
    unsignedMetaOnPresignedPut: "stored",
  };
});
