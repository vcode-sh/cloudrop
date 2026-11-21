// Runs the cloudrop command in-process for its tests: an injected environment, files, output streams and a fetch that
// reaches the fake R2. Every run also checks that no setting's value reached the output. It builds inputs only; every
// expected value stays in the tests.

import { R2_RULES } from "../rules.ts";
import type { BucketCorsRule, BucketLifecycleRule, FetchLike } from "../storage/driver.ts";
import { createS3Driver } from "../storage/s3-driver.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import { parseEnvFile } from "./env-file.ts";
import { runCommand } from "./run.ts";

export const ENV = {
  CLOUDROP_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDROP_R2_BUCKET: "acme-uploads-7f3",
  CLOUDROP_R2_ACCESS_KEY_ID: "AKIDcloudropfixture",
  CLOUDROP_R2_SECRET_ACCESS_KEY: "s3cr3t-cloudrop-fixture-value",
  CLOUDROP_SECRET: "token-secret-cloudrop-fixture-0123456789",
} as const;

export const ORIGIN = "https://app.example.com";

/** ENV's settings under an app's own names, as --var reads them (M11-C1). */
export const APP_ENV: Record<
  "R2_ACCOUNT_ID" | "R2_BUCKET" | "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "UPLOAD_TOKEN_SECRET",
  string
> = {
  R2_ACCOUNT_ID: ENV.CLOUDROP_R2_ACCOUNT_ID,
  R2_BUCKET: ENV.CLOUDROP_R2_BUCKET,
  R2_ACCESS_KEY_ID: ENV.CLOUDROP_R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: ENV.CLOUDROP_R2_SECRET_ACCESS_KEY,
  UPLOAD_TOKEN_SECRET: ENV.CLOUDROP_SECRET,
};

/** Settings for an S3 service under an app's own names. */
export const APP_S3_ENV: Record<string, string> = {
  STORAGE_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
  STORAGE_S3_REGION: "us-east-1",
  STORAGE_S3_BUCKET: "acme-s3-uploads",
  STORAGE_S3_ACCESS_KEY_ID: "AKIDs3fixture",
  STORAGE_S3_SECRET_ACCESS_KEY: "s3-secret-fixture-value",
  UPLOAD_TOKEN_SECRET: ENV.CLOUDROP_SECRET,
};

/** A --var for every setting the command reads, naming the variables of APP_ENV and APP_S3_ENV. */
export const APP_VARS: string[] = [
  "CLOUDROP_R2_ACCOUNT_ID=R2_ACCOUNT_ID",
  "CLOUDROP_R2_BUCKET=R2_BUCKET",
  "CLOUDROP_R2_ACCESS_KEY_ID=R2_ACCESS_KEY_ID",
  "CLOUDROP_R2_SECRET_ACCESS_KEY=R2_SECRET_ACCESS_KEY",
  "CLOUDROP_S3_ENDPOINT=STORAGE_S3_ENDPOINT",
  "CLOUDROP_S3_REGION=STORAGE_S3_REGION",
  "CLOUDROP_S3_BUCKET=STORAGE_S3_BUCKET",
  "CLOUDROP_S3_ACCESS_KEY_ID=STORAGE_S3_ACCESS_KEY_ID",
  "CLOUDROP_S3_SECRET_ACCESS_KEY=STORAGE_S3_SECRET_ACCESS_KEY",
  "CLOUDROP_SECRET=UPLOAD_TOKEN_SECRET",
].flatMap((pair) => ["--var", pair]);

export interface Bucket {
  fetch: FetchLike;
  /** Bucket-settings writes that reached the bucket, such as "PUT ?cors=". */
  writes: string[];
  cors(): Promise<BucketCorsRule[] | null>;
  lifecycle(): Promise<BucketLifecycleRule[] | null>;
  /**
   * What a page on `origin` gets when it sends a file as cloudrop's client does: the status of the preflight a browser
   * sends first, then the PUT's status and the headers its answer exposes, both null when the preflight is refused.
   */
  upload(origin: string): Promise<{ preflight: number; put: number | null; exposed: string | null }>;
}

/** The fake R2 behind the settings in ENV. Without `bucketConfig` it answers as for an R2 object token. */
export function bucket(bucketConfig?: { cors?: string; lifecycle?: string }): Bucket {
  const credentials = {
    accessKeyId: ENV.CLOUDROP_R2_ACCESS_KEY_ID,
    secretAccessKey: ENV.CLOUDROP_R2_SECRET_ACCESS_KEY,
  };
  const fake = createFakeR2({ bucket: ENV.CLOUDROP_R2_BUCKET, credentials, bucketConfig });
  const writes: string[] = [];
  const fetch: FetchLike = (input, init) => {
    const request = new Request(input, init);
    const { pathname, search } = new URL(request.url);
    if (request.method === "PUT" && pathname === `/${ENV.CLOUDROP_R2_BUCKET}`) writes.push(`PUT ${search}`);
    return fake.fetch(request);
  };
  const reader = createS3Driver({
    endpoint: `https://${ENV.CLOUDROP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: "auto",
    bucket: ENV.CLOUDROP_R2_BUCKET,
    credentials,
    rules: R2_RULES,
    fetch: fake.fetch,
  });
  let uploads = 0;
  return {
    fetch,
    writes,
    cors: async () => (await reader.getBucketCors()).data,
    lifecycle: async () => (await reader.getBucketLifecycle()).data,
    async upload(origin) {
      // The single PUT as the server signs it (presign.ts); a browser lists every one of its headers for image/png.
      const signed = await reader.presignPut(`browser/${++uploads}.png`, {
        type: "image/png",
        disposition: 'attachment; filename="a.png"',
        metadata: { "cloudrop-id": "fixture" },
        ifNoneMatch: true,
        size: 2,
        expiresIn: 60,
      });
      if (signed.error) throw signed.error;
      const { url, headers } = signed.data;
      const asked = Object.keys(headers).sort().join(",");
      const preflight = await fake.fetch(url, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "PUT", "access-control-request-headers": asked },
      });
      if (preflight.status !== 204) return { preflight: preflight.status, put: null, exposed: null };
      const put = await fake.fetch(url, { method: "PUT", headers: { ...headers, origin }, body: "hi" });
      return { preflight: 204, put: put.status, exposed: put.headers.get("access-control-expose-headers") };
    },
  };
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  /** Files by path: their text, or the error code reading them fails with. A path not listed fails with ENOENT. */
  files?: Record<string, string | { error: string }>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout split into lines, without the trailing empty one. */
  lines: string[];
}

/**
 * Whether `output` holds `value`. A value under 8 characters counts only as a word of its own: "auto" is not printed
 * by "automatic".
 */
function prints(output: string, value: string): boolean {
  if (value.length >= 8) return output.includes(value);
  const literal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${literal}(?![A-Za-z0-9])`).test(output);
}

export async function run(argv: string[], { env = ENV, fetch, files = {} }: RunOptions = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCommand({
    argv,
    env,
    version: "1.2.3",
    fetch: fetch ?? (() => Promise.reject(new Error("This test's command must not reach the network."))),
    readFile: (path) => {
      const file = files[path] ?? { error: "ENOENT" };
      if (typeof file !== "string") throw Object.assign(new Error(`${file.error}: ${path}`), { code: file.error });
      return file;
    },
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
  });
  const texts = Object.values(files).filter((file) => typeof file === "string");
  const fromFiles = texts.flatMap((text) => [...parseEnvFile(text).values()]);
  const values = [...Object.values(ENV), ...Object.values(env), ...fromFiles].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  // A Wrangler or AWS CLI command names the bucket and the endpoint, which are not secrets (M11-R110): everything
  // outside those commands is checked for them too.
  const checked = `${stdout}\n${stderr}`.replaceAll(/\b(wrangler r2 bucket|aws s3api) .*$/gm, "");
  const leaked = values.filter((value) => prints(checked, value));
  if (leaked.length > 0) throw new Error(`The command printed a setting's value (${leaked.length} of them).`);
  return { code, stdout, stderr, lines: stdout.split("\n").slice(0, -1) };
}

/**
 * Runs the command with APP_VARS, so no setting keeps its cloudrop name, on APP_ENV unless `env` is given. Every such
 * run also checks that the output names no CLOUDROP_* setting, except in the --var pairs of a command it suggests.
 */
export async function runRenamed(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await run([...argv, ...APP_VARS], { ...options, env: options.env ?? APP_ENV });
  const named = result.stdout.replaceAll(/--var \S+/g, "").match(/CLOUDROP_\w+/g);
  if (named) throw new Error(`The output names settings that --var renamed: ${[...new Set(named)].join(", ")}.`);
  return result;
}
