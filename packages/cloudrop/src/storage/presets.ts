import { fromEnv } from "../env.ts";
import { configError } from "../errors.ts";
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
  /** The bucket's jurisdiction, which selects its endpoint. Omit it for a bucket in the default location. */
  jurisdiction?: "eu" | "fedramp";
  /**
   * Where the bucket is served publicly (a custom domain or r2.dev URL, a path allowed), such as
   * "https://cdn.example.com/files"; no query or fragment. Trailing slashes are dropped.
   */
  publicUrl?: string;
  fetch?: FetchLike;
}

export interface S3Options {
  /**
   * An http or https URL with no query or fragment, such as "https://s3.us-east-1.amazonaws.com". A path is kept as a
   * prefix of every request, for a service behind a proxy path.
   */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl?: string;
  fetch?: FetchLike;
}

/** One message for everything missing, so a first-time setup is not a series of throw-fix-retry rounds. */
function throwIfMissing(service: "R2" | "S3", missing: string[], hint: string): void {
  if (missing.length > 0) throw configError(`Missing ${service} settings: ${missing.join(", ")}. ${hint}`);
}

// Deliberately lax: names with a reserved prefix or suffix (xn--, sthree-, -s3alias, --ol-s3) pass here and fail at the
// service, which owns that list. Deliberately strict: legacy us-east-1 buckets with upper case or underscores are rejected,
// because no other region accepts them and R2 never did.
// R2: 3 to 63 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen.
// https://developers.cloudflare.com/r2/buckets/create-buckets/#bucket-naming-rules
const R2_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
// S3 also allows dots, but not two in a row and not an IPv4 address.
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
const S3_BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_ADDRESS = /^\d{1,3}(\.\d{1,3}){3}$/;

function checkBucket(bucket: string, service: "R2" | "S3"): string {
  const valid =
    typeof bucket === "string" &&
    (service === "R2"
      ? R2_BUCKET_NAME.test(bucket)
      : S3_BUCKET_NAME.test(bucket) && !bucket.includes("..") && !IPV4_ADDRESS.test(bucket));
  if (!valid) {
    const rules =
      service === "R2"
        ? "lowercase letters, digits and hyphens, starting and ending with a letter or digit"
        : "lowercase letters, digits, hyphens and dots, starting and ending with a letter or digit, with no two dots in a row, and not formatted like an IP address";
    throw configError(
      `The ${service} bucket name must be 3 to 63 characters: ${rules}. Copy the exact name from your ${service} bucket list.`,
    );
  }
  return bucket;
}

export function r2(given: R2Options): StorageDriver {
  // Plain-JavaScript callers can pass nothing; the environment may still hold everything but the bucket.
  const options: Partial<R2Options> = given ?? {};
  const accountId = options.accountId || fromEnv("CLOUDROP_R2_ACCOUNT_ID");
  const accessKeyId = options.accessKeyId || fromEnv("CLOUDROP_R2_ACCESS_KEY_ID");
  const secretAccessKey = options.secretAccessKey || fromEnv("CLOUDROP_R2_SECRET_ACCESS_KEY");
  throwIfMissing(
    "R2",
    [
      options.bucket ? "" : "bucket",
      accountId ? "" : "accountId (CLOUDROP_R2_ACCOUNT_ID)",
      accessKeyId ? "" : "accessKeyId (CLOUDROP_R2_ACCESS_KEY_ID)",
      secretAccessKey ? "" : "secretAccessKey (CLOUDROP_R2_SECRET_ACCESS_KEY)",
    ].filter(Boolean),
    "Pass them to r2(); a setting with a variable name in parentheses can also come from the environment.",
  );
  const bucket = checkBucket(options.bucket as string, "R2");
  // Cloudflare shows the ID in lower case; pasted values may not be.
  const account = typeof accountId === "string" ? accountId.toLowerCase() : undefined;
  if (account === undefined || !/^[0-9a-f]{32}$/.test(account)) {
    const given = account === undefined ? "is not text" : `has ${account.length} characters`;
    throw configError(
      `The R2 account ID must be 32 hexadecimal characters (0-9, a-f); the one given ${given}. Copy it from the R2 overview page in the Cloudflare dashboard.`,
    );
  }
  const { jurisdiction } = options;
  if (jurisdiction !== undefined && jurisdiction !== "eu" && jurisdiction !== "fedramp") {
    throw configError('The R2 jurisdiction must be "eu" or "fedramp". Omit it for the default location.');
  }
  return createS3Driver({
    endpoint: `https://${jurisdiction ? `${account}.${jurisdiction}` : account}.r2.cloudflarestorage.com`,
    region: "auto",
    bucket,
    credentials: { accessKeyId: accessKeyId as string, secretAccessKey: secretAccessKey as string },
    rules: R2_RULES,
    publicUrl: options.publicUrl,
    fetch: options.fetch,
  });
}

// createS3Driver checks the endpoint, the publicUrl, the credentials, the region and fetch.
export function s3(given: S3Options): StorageDriver {
  const options: Partial<S3Options> = given ?? {};
  throwIfMissing(
    "S3",
    (["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"] as const).filter((name) => !options[name]),
    "Pass them to s3().",
  );
  const { endpoint, region, accessKeyId, secretAccessKey } = options as S3Options;
  return createS3Driver({
    endpoint,
    region,
    bucket: checkBucket(options.bucket as string, "S3"),
    credentials: { accessKeyId, secretAccessKey },
    rules: S3_RULES,
    publicUrl: options.publicUrl,
    fetch: options.fetch,
  });
}
