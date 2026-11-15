export const MiB: number = 1024 * 1024;
export const GiB: number = 1024 * MiB;
const TiB: number = 1024 * GiB;

/** Limits of a storage backend, in bytes and seconds. */
export interface StorageRules {
  minPartSize: number;
  maxPartSize: number;
  maxParts: number;
  maxSinglePutSize: number;
  maxObjectSize: number;
  maxPresignSeconds: number;
}

export const R2_RULES: StorageRules = {
  // Every limit below: https://developers.cloudflare.com/r2/platform/limits/ unless noted.
  // Minimum part size, except for the last part. Spike Q4 confirmed EntityTooSmall below it.
  minPartSize: 5 * MiB,
  // Docs: 5 GiB per part, capped at 4.995 GiB by the upload limit (research doc section C.1).
  maxPartSize: 5 * GiB - 5 * MiB,
  // Maximum parts in one multipart upload.
  maxParts: 10_000,
  // Single PUT: "5 MiB less than 5 GiB, so 4.995 GiB".
  maxSinglePutSize: 5 * GiB - 5 * MiB,
  // Multipart object: 4.995 TiB (5 TiB minus 5 GiB).
  maxObjectSize: 5 * TiB - 5 * GiB,
  // Presigned URL expiry: 604,800 s accepted, 604,801 rejected (spike finding Q7).
  maxPresignSeconds: 604_800,
};

export const S3_RULES: StorageRules = {
  // https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
  minPartSize: 5 * MiB,
  maxPartSize: 5 * GiB,
  maxParts: 10_000,
  // Largest single PUT.
  maxSinglePutSize: 5 * GiB,
  // "Maximum object size: 48.8 TiB" = 10,000 parts x 5 GiB (https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html).
  maxObjectSize: 10_000 * 5 * GiB,
  // SigV4 presigned URLs live at most 7 days.
  maxPresignSeconds: 604_800,
};
