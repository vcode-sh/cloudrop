import { fromEnv } from "../env.ts";
import { CloudropError, configError, type Result } from "../errors.ts";
import { R2_RULES, S3_RULES } from "../rules.ts";
import type { FetchLike, StorageDriver } from "./driver.ts";
import { lazyDriver, readSetting } from "./lazy-driver.ts";
import { createS3Driver, createS3DriverWithWrites, type S3Driver, type S3DriverConfig } from "./s3-driver.ts";

export interface R2Options {
  /** Default: env CLOUDROP_R2_BUCKET. */
  bucket?: string;
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
   * prefix of every request, for a service behind a proxy path. Default: env CLOUDROP_S3_ENDPOINT.
   */
  endpoint?: string;
  /** Default: env CLOUDROP_S3_REGION. */
  region?: string;
  /** Default: env CLOUDROP_S3_BUCKET. */
  bucket?: string;
  /** Default: env CLOUDROP_S3_ACCESS_KEY_ID. */
  accessKeyId?: string;
  /** Default: env CLOUDROP_S3_SECRET_ACCESS_KEY. */
  secretAccessKey?: string;
  publicUrl?: string;
  fetch?: FetchLike;
}

export const R2_VARIABLES = {
  bucket: "CLOUDROP_R2_BUCKET",
  accountId: "CLOUDROP_R2_ACCOUNT_ID",
  accessKeyId: "CLOUDROP_R2_ACCESS_KEY_ID",
  secretAccessKey: "CLOUDROP_R2_SECRET_ACCESS_KEY",
} as const;

export const S3_VARIABLES = {
  endpoint: "CLOUDROP_S3_ENDPOINT",
  region: "CLOUDROP_S3_REGION",
  bucket: "CLOUDROP_S3_BUCKET",
  accessKeyId: "CLOUDROP_S3_ACCESS_KEY_ID",
  secretAccessKey: "CLOUDROP_S3_SECRET_ACCESS_KEY",
} as const;

type Setting = keyof typeof R2_VARIABLES | keyof typeof S3_VARIABLES;
type ReadSetting = (variable: string, setting: Setting) => string | undefined;

/** Valid values for settings the environment will supply, so that a check at construction fails only on an option. */
const STAND_INS = {
  bucket: "bucket",
  accountId: "0".repeat(32),
  accessKeyId: "key",
  secretAccessKey: "secret",
  endpoint: "https://s3.example.com",
  region: "auto",
} satisfies Record<Setting, string>;

/**
 * Each setting's option or, when the option is unset or empty, its environment variable. One message names everything
 * missing, so a first-time setup is not a series of throw-fix-retry rounds.
 */
function readSettings<TSetting extends Setting>(
  service: "R2" | "S3",
  options: NoInfer<Partial<Record<TSetting, string>>>,
  variables: Record<TSetting, string>,
  read: ReadSetting,
): Record<TSetting, string> {
  const settings = {} as Record<TSetting, string>;
  const missing: string[] = [];
  for (const setting of Object.keys(variables) as TSetting[]) {
    const value = options[setting] || read(variables[setting], setting);
    if (value) settings[setting] = value;
    else missing.push(`${setting} (${variables[setting]})`);
  }
  if (missing.length > 0) {
    throw configError(
      `Missing ${service} settings: ${missing.join(", ")}. Pass them to ${service.toLowerCase()}() or set the environment variables in parentheses.`,
    );
  }
  return settings;
}

/**
 * Settings from the environment are read on first use (M4-F16), so a build with no secrets can import the server.
 * Options are checked now, as every passed option is; in development the environment is too, so a dev server fails at
 * start.
 */
function preset(build: (read: ReadSetting) => StorageDriver): StorageDriver {
  if (fromEnv("NODE_ENV") === "development") return buildFromEnvironment(build);
  let readsEnvironment = false;
  const checked = build((_variable, setting) => {
    readsEnvironment = true;
    return STAND_INS[setting];
  });
  return readsEnvironment ? lazyDriver(checked, () => buildFromEnvironment(build)) : checked;
}

/**
 * A value from a variable fails the same check an option would, but nothing in the app's code passed it, so the message
 * names the variable. Each variable read is tried alone, with stand-ins for the rest, to find the ones at fault.
 */
function buildFromEnvironment<T>(build: (read: ReadSetting) => T, env = fromEnv): T {
  const read: string[] = [];
  try {
    return build((variable) => {
      const value = env(variable);
      if (value) read.push(variable);
      return value;
    });
  } catch (error) {
    if (!(error instanceof CloudropError)) throw error;
    const invalid = read.filter(
      (variable) =>
        readSetting(() => build((name, setting) => (name === variable ? env(name) : STAND_INS[setting]))).error,
    );
    if (invalid.length === 0) throw error;
    throw configError(`${error.message} Environment variables with an invalid value: ${invalid.join(", ")}.`);
  }
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

function checkAccountId(accountId: unknown): string {
  // Cloudflare shows the ID in lower case; pasted values may not be.
  const account = typeof accountId === "string" ? accountId.toLowerCase() : undefined;
  if (account === undefined || !/^[0-9a-f]{32}$/.test(account)) {
    const given = account === undefined ? "is not text" : `has ${account.length} characters`;
    throw configError(
      `The R2 account ID must be 32 hexadecimal characters (0-9, a-f); this one ${given}. Copy it from the R2 overview page in the Cloudflare dashboard.`,
    );
  }
  return account;
}

type Create<T> = (config: S3DriverConfig) => T;

function buildR2<T>(options: R2Options, create: Create<T>): (read: ReadSetting) => T {
  const { jurisdiction } = options;
  if (jurisdiction !== undefined && jurisdiction !== "eu" && jurisdiction !== "fedramp") {
    throw configError('The R2 jurisdiction must be "eu" or "fedramp". Omit it for the default location.');
  }
  return (read) => {
    const settings = readSettings("R2", options, R2_VARIABLES, read);
    const bucket = checkBucket(settings.bucket, "R2");
    const account = checkAccountId(settings.accountId);
    return create({
      endpoint: `https://${jurisdiction ? `${account}.${jurisdiction}` : account}.r2.cloudflarestorage.com`,
      region: "auto",
      bucket,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      rules: R2_RULES,
      publicUrl: options.publicUrl,
      fetch: options.fetch,
    });
  };
}

// createS3Driver checks the endpoint, the publicUrl, the credentials, the region and fetch.
function buildS3<T>(options: S3Options, create: Create<T>): (read: ReadSetting) => T {
  return (read) => {
    const { endpoint, region, bucket, accessKeyId, secretAccessKey } = readSettings("S3", options, S3_VARIABLES, read);
    return create({
      endpoint,
      region,
      bucket: checkBucket(bucket, "S3"),
      credentials: { accessKeyId, secretAccessKey },
      rules: S3_RULES,
      publicUrl: options.publicUrl,
      fetch: options.fetch,
    });
  };
}

export function r2(given?: R2Options): StorageDriver {
  return preset(buildR2(given ?? {}, createS3Driver));
}

export function s3(given?: S3Options): StorageDriver {
  return preset(buildS3(given ?? {}, createS3Driver));
}

/**
 * For the cloudrop command: the preset's driver, with the bucket-settings writes, built from `variables` alone, read as
 * the environment would be, so an invalid value is named by its variable. Never reads the process environment.
 */
export function storageFromVariables(
  service: "R2" | "S3",
  variables: (name: string) => string | undefined,
  options: { jurisdiction?: "eu" | "fedramp"; fetch?: FetchLike },
): Result<S3Driver> {
  return readSetting(() => {
    const build =
      service === "R2"
        ? buildR2(options, createS3DriverWithWrites)
        : buildS3({ fetch: options.fetch }, createS3DriverWithWrites);
    return buildFromEnvironment(build, variables);
  });
}
