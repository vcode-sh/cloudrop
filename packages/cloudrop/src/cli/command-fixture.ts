// Runs the cloudrop command in-process for its tests: an injected environment, files, output streams and a fetch that
// reaches the fake R2. Every run also checks that no setting's value reached the output. It builds inputs only; every
// expected value stays in the tests.

import { R2_RULES } from "../rules.ts";
import type { BucketCorsRule, BucketLifecycleRule, FetchLike } from "../storage/driver.ts";
import { createS3Driver } from "../storage/s3-driver.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import { runCommand } from "./run.ts";

export const ENV = {
  CLOUDROP_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDROP_R2_BUCKET: "acme-uploads-7f3",
  CLOUDROP_R2_ACCESS_KEY_ID: "AKIDcloudropfixture",
  CLOUDROP_R2_SECRET_ACCESS_KEY: "s3cr3t-cloudrop-fixture-value",
  CLOUDROP_SECRET: "token-secret-cloudrop-fixture-0123456789",
} as const;

export const ORIGIN = "https://app.example.com";

export interface Bucket {
  fetch: FetchLike;
  /** Bucket-settings writes that reached the bucket, such as "PUT ?cors=". */
  writes: string[];
  cors(): Promise<BucketCorsRule[] | null>;
  lifecycle(): Promise<BucketLifecycleRule[] | null>;
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
  return {
    fetch,
    writes,
    cors: async () => (await reader.getBucketCors()).data,
    lifecycle: async () => (await reader.getBucketLifecycle()).data,
  };
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  files?: Record<string, string>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout split into lines, without the trailing empty one. */
  lines: string[];
}

export async function run(argv: string[], { env = ENV, fetch, files = {} }: RunOptions = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCommand({
    argv,
    env,
    fetch: fetch ?? (() => Promise.reject(new Error("This test's command must not reach the network."))),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
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
  const values = [...Object.values(ENV), ...Object.values(env)].filter(
    (value): value is string => typeof value === "string" && value.length >= 8,
  );
  const leaked = values.filter((value) => stdout.includes(value) || stderr.includes(value));
  if (leaked.length > 0) throw new Error(`The command printed a setting's value (${leaked.length} of them).`);
  return { code, stdout, stderr, lines: stdout.split("\n").slice(0, -1) };
}
