import { CloudropError } from "../errors.ts";
import { R2_RULES, S3_RULES } from "../rules.ts";
import type { FetchLike, StorageDriver } from "./driver.ts";
import { createS3Driver } from "./s3-driver.ts";

export interface R2Options {
  bucket: string;
  /** Default: env CLOUDROP_R2_ACCOUNT_ID. */
  accountId?: string;
  /** Default: env CLOUDROP_R2_ACCESS_KEY_ID. */
  accessKeyId?: string;
  /** Default: env CLOUDROP_R2_SECRET_ACCESS_KEY. */
  secretAccessKey?: string;
  jurisdiction?: "eu" | "fedramp";
  publicUrl?: string;
  fetch?: FetchLike;
}

export interface S3Options {
  /** An http or https origin without a path, such as "https://s3.us-east-1.amazonaws.com". */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl?: string;
  fetch?: FetchLike;
}

// Workers and browsers have no `process`; a guarded read through globalThis keeps the preset portable.
function fromEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name] || undefined;
}

function configError(message: string): CloudropError {
  return new CloudropError("INVALID_CONFIG", message);
}

function required(value: string | undefined, what: string, hint: string): string {
  if (value) return value;
  throw configError(`The ${what} is missing. ${hint}`);
}

// R2: 3 to 63 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen.
// https://developers.cloudflare.com/r2/buckets/create-buckets/#bucket-naming-rules
const R2_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
// S3 also allows dots, but not two in a row and not an IPv4 address.
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
const S3_BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_ADDRESS = /^\d{1,3}(\.\d{1,3}){3}$/;

function checkBucket(bucket: unknown, service: "R2" | "S3"): string {
  const valid =
    typeof bucket === "string" &&
    (service === "R2"
      ? R2_BUCKET_NAME.test(bucket)
      : S3_BUCKET_NAME.test(bucket) && !bucket.includes("..") && !IPV4_ADDRESS.test(bucket));
  if (!valid) {
    const allowed =
      service === "R2" ? "lowercase letters, digits and hyphens" : "lowercase letters, digits, hyphens and dots";
    throw configError(
      `The ${service} bucket name must be 3 to 63 characters of ${allowed}, starting and ending with a letter or digit. Copy the exact name from your ${service} bucket list.`,
    );
  }
  return bucket;
}

export function r2(options: R2Options): StorageDriver {
  const bucket = checkBucket(options.bucket, "R2");
  const accountId = required(
    options.accountId ?? fromEnv("CLOUDROP_R2_ACCOUNT_ID"),
    "R2 account ID",
    "Pass it to r2() or set CLOUDROP_R2_ACCOUNT_ID.",
  );
  if (!/^[0-9a-f]{32}$/.test(accountId)) {
    throw configError(
      "The R2 account ID must be 32 hexadecimal characters. Copy it from the R2 overview page in the Cloudflare dashboard.",
    );
  }
  const accessKeyId = required(
    options.accessKeyId ?? fromEnv("CLOUDROP_R2_ACCESS_KEY_ID"),
    "R2 access key ID",
    "Pass it to r2() or set CLOUDROP_R2_ACCESS_KEY_ID.",
  );
  const secretAccessKey = required(
    options.secretAccessKey ?? fromEnv("CLOUDROP_R2_SECRET_ACCESS_KEY"),
    "R2 secret access key",
    "Pass it to r2() or set CLOUDROP_R2_SECRET_ACCESS_KEY.",
  );
  const host = options.jurisdiction
    ? `${accountId}.${options.jurisdiction}.r2.cloudflarestorage.com`
    : `${accountId}.r2.cloudflarestorage.com`;
  return createS3Driver({
    endpoint: `https://${host}`,
    region: "auto",
    bucket,
    credentials: { accessKeyId, secretAccessKey },
    rules: R2_RULES,
    publicUrl: options.publicUrl,
    fetch: options.fetch,
  });
}

// The endpoint is validated by createS3Driver, which rejects a relative URL, a path, a query and bad escapes.
export function s3(options: S3Options): StorageDriver {
  const bucket = checkBucket(options.bucket, "S3");
  const region = required(options.region, "S3 region", "Pass the bucket's region, such as us-east-1.");
  const accessKeyId = required(options.accessKeyId, "S3 access key ID", "Pass it to s3().");
  const secretAccessKey = required(options.secretAccessKey, "S3 secret access key", "Pass it to s3().");
  return createS3Driver({
    endpoint: options.endpoint,
    region,
    bucket,
    credentials: { accessKeyId, secretAccessKey },
    rules: S3_RULES,
    publicUrl: options.publicUrl,
    fetch: options.fetch,
  });
}
