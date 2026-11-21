import { describe, expect, it } from "vitest";
import type { FetchLike } from "../storage/driver.ts";
import { APP_ENV, APP_S3_ENV, APP_VARS, bucket, ENV, ORIGIN, run, runRenamed } from "./command-fixture.ts";

// runRenamed fails a run whose output names a CLOUDROP_* setting, so every test through it also proves that.
const doctor = (options?: Parameters<typeof run>[1], ...argv: string[]) =>
  runRenamed(["doctor", "--origin", ORIGIN, ...argv], options);
const setup = (options?: Parameters<typeof run>[1], ...argv: string[]) =>
  runRenamed(["setup", "--origin", ORIGIN, ...argv], options);

const unreachable = () => Promise.reject(new TypeError("fetch failed"));
const answers =
  (status: number, code = "") =>
  () =>
    Promise.resolve(new Response(code && `<Error><Code>${code}</Code></Error>`, { status }));
const EMPTY = {
  cors: "<CORSConfiguration></CORSConfiguration>",
  lifecycle: "<LifecycleConfiguration></LifecycleConfiguration>",
};
const BUCKET_ONLY = ["--var", "CLOUDROP_R2_BUCKET=R2_BUCKET"];
const { CLOUDROP_R2_BUCKET, ...withoutBucket } = ENV;
const bucketRenamed = { ...withoutBucket, R2_BUCKET: CLOUDROP_R2_BUCKET };

describe("cloudrop doctor with --var", () => {
  it("reads every setting from the app's variable and names it in each finding and command", async () => {
    const result = await doctor({ fetch: bucket().fetch });
    expect(result.lines).toEqual([
      `cloudrop doctor: checking R2 settings, the bucket and its rules for ${ORIGIN}.`,
      "ok           R2 settings are present and valid (R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).",
      "ok           UPLOAD_TOKEN_SECRET is set.",
      "ok           The bucket answers, and these credentials may list it.",
      'NOT CHECKED  CORS: These storage credentials may not read the bucket\'s CORS rules (R2 object tokens cannot). Check it with an admin read token or in the dashboard. By hand: wrangler r2 bucket cors list "$R2_BUCKET"',
      'NOT CHECKED  Lifecycle: These storage credentials may not read the bucket\'s lifecycle rules (R2 object tokens cannot). Check it with an admin read token or in the dashboard. By hand: wrangler r2 bucket lifecycle list "$R2_BUCKET"',
      "No problems found. 2 checks could not run; see above.",
    ]);
    expect(result.code).toBe(0);
  });

  it.each([
    {
      name: "a variable that is not set",
      env: { ...APP_ENV, R2_BUCKET: undefined },
      line: "PROBLEM      R2_BUCKET is not set. Set it to the bucket's name.",
    },
    {
      name: "no storage variable at all",
      env: { UPLOAD_TOKEN_SECRET: APP_ENV.UPLOAD_TOKEN_SECRET },
      line: "PROBLEM      No storage settings found. Set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY for R2, or STORAGE_S3_ENDPOINT, STORAGE_S3_REGION, STORAGE_S3_BUCKET, STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY for another service; --env-file reads them from a file.",
    },
    {
      name: "a variable whose value is invalid",
      env: { ...APP_ENV, R2_ACCOUNT_ID: "not-an-account-id" },
      line: "PROBLEM      The R2 account ID must be 32 hexadecimal characters (0-9, a-f); this one has 17 characters. Copy it from the R2 overview page in the Cloudflare dashboard. Environment variables with an invalid value: R2_ACCOUNT_ID.",
    },
    {
      name: "a short secret",
      env: { ...APP_ENV, UPLOAD_TOKEN_SECRET: "too-short-secret" },
      line: "PROBLEM      UPLOAD_TOKEN_SECRET has fewer than 32 characters. Generate one with `openssl rand -base64 32`.",
    },
    {
      name: "no secret",
      env: { ...APP_ENV, UPLOAD_TOKEN_SECRET: undefined },
      line: "PROBLEM      UPLOAD_TOKEN_SECRET is not set. Generate one with `openssl rand -base64 32` and set it, unless your code passes secret to createCloudrop().",
    },
    {
      name: "an unreachable R2 endpoint",
      fetch: unreachable,
      line: "PROBLEM      Bucket: Could not reach the storage service. Check the endpoint and the network connection, then retry. The R2 endpoint is built from R2_ACCOUNT_ID: check that it is your account ID.",
    },
    {
      name: "an unreachable R2 endpoint in a jurisdiction",
      argv: ["--jurisdiction", "eu"],
      fetch: unreachable,
      line: "PROBLEM      Bucket: Could not reach the storage service. Check the endpoint and the network connection, then retry. The R2 endpoint is built from R2_ACCOUNT_ID and --jurisdiction eu: check that it is your account ID and the bucket's jurisdiction.",
    },
    {
      name: "R2 credentials the service refuses",
      fetch: answers(401),
      line: "PROBLEM      Bucket: The storage service refused these credentials (HTTP 401). Check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, that the token may read and write objects in the bucket named by R2_BUCKET, and that the bucket exists. A bucket in a jurisdiction also needs --jurisdiction.",
    },
    {
      name: "an S3 variable that is not set",
      env: { ...APP_S3_ENV, STORAGE_S3_REGION: undefined },
      line: "PROBLEM      STORAGE_S3_REGION is not set. Set it to the bucket's region, such as us-east-1.",
    },
    {
      name: "S3 credentials the service refuses",
      env: APP_S3_ENV,
      fetch: answers(403),
      line: "PROBLEM      Bucket: The storage service refused these credentials (HTTP 403). Check STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY, that they may read and write objects in the bucket named by STORAGE_S3_BUCKET, and STORAGE_S3_REGION.",
    },
    {
      name: "an unreachable S3 endpoint",
      env: APP_S3_ENV,
      fetch: unreachable,
      line: "PROBLEM      Bucket: Could not reach the storage service. Check the endpoint and the network connection, then retry. The endpoint is STORAGE_S3_ENDPOINT.",
    },
    {
      name: "an S3 bucket in another region",
      env: APP_S3_ENV,
      fetch: answers(400, "AuthorizationHeaderMalformed"),
      line: "PROBLEM      Bucket: The bucket is in another region (AuthorizationHeaderMalformed). Check STORAGE_S3_REGION, and that STORAGE_S3_ENDPOINT serves that region.",
    },
  ])("names the app's variable for $name", async ({ env, fetch = bucket().fetch, argv = [], line }) => {
    const result = await doctor({ env, fetch }, ...argv);
    expect(result.lines.filter((each) => each.startsWith("PROBLEM"))).toEqual([line]);
    expect(result.code).toBe(1);
  });

  it("prints the AWS CLI commands with the app's bucket and endpoint variables", async () => {
    const fetch: FetchLike = (input) =>
      /\?(cors|lifecycle)=$/.test(String(input))
        ? answers(403, "AccessDenied")()
        : Promise.resolve(new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"));
    const result = await doctor({ env: APP_S3_ENV, fetch });
    expect(result.lines.slice(4, 6).map((line) => line.slice(line.indexOf("By hand:")))).toEqual([
      'By hand: aws s3api get-bucket-cors --bucket "$STORAGE_S3_BUCKET" --endpoint-url "$STORAGE_S3_ENDPOINT"',
      'By hand: aws s3api get-bucket-lifecycle-configuration --bucket "$STORAGE_S3_BUCKET" --endpoint-url "$STORAGE_S3_ENDPOINT"',
    ]);
  });

  it("says which variables to unset when settings for both services are set", async () => {
    const env = { ...APP_ENV, STORAGE_S3_ENDPOINT: APP_S3_ENV.STORAGE_S3_ENDPOINT };
    const result = await doctor({ env, fetch: bucket().fetch });
    expect(result.lines[1]).toBe(
      "note         Settings for R2 and for S3 are both set; the command checks R2. To check S3, unset R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.",
    );
  });

  it("reads the app's variables from --env-file, and the environment wins over the file", async () => {
    const { R2_BUCKET, ...rest } = APP_ENV;
    const file = `R2_BUCKET=${R2_BUCKET}\nUPLOAD_TOKEN_SECRET='${"x".repeat(40)}'\n`;
    const result = await doctor({ env: rest, files: { ".env": file }, fetch: bucket().fetch }, "--env-file", ".env");
    expect([result.code, result.lines[1]]).toEqual([
      0,
      "note         UPLOAD_TOKEN_SECRET is set in the environment and in .env; the environment's value is used.",
    ]);
  });

  // ENV sets every setting under its cloudrop name: none of them may be read once --var names another variable.
  it("reads a renamed setting only from its variable, and says so when its cloudrop name is set", async () => {
    const result = await run(["doctor", "--origin", ORIGIN, ...BUCKET_ONLY], { env: ENV });
    expect(result.lines.slice(1, 3)).toEqual([
      "note         CLOUDROP_R2_BUCKET is set, but --var reads that setting from R2_BUCKET, so it is not read.",
      "PROBLEM      R2_BUCKET is not set. Set it to the bucket's name.",
    ]);
    const s3 = await run(["doctor", "--origin", ORIGIN, ...APP_VARS], {
      env: { ...ENV, ...APP_S3_ENV },
      fetch: answers(403),
    });
    expect(s3.lines[0]).toBe(`cloudrop doctor: checking S3 settings, the bucket and its rules for ${ORIGIN}.`);
  });

  it("repeats the --var pairs in the setup command it suggests, and keeps the other settings' own names", async () => {
    const result = await run(["doctor", "--origin", ORIGIN, ...BUCKET_ONLY], {
      env: bucketRenamed,
      fetch: bucket(EMPTY).fetch,
    });
    expect(result.lines[1]).toBe(
      "ok           R2 settings are present and valid (R2_BUCKET, CLOUDROP_R2_ACCOUNT_ID, CLOUDROP_R2_ACCESS_KEY_ID, CLOUDROP_R2_SECRET_ACCESS_KEY).",
    );
    expect(result.lines[4]).toBe(
      `PROBLEM      CORS: The bucket's CORS rules do not let ${ORIGIN} upload. Add a rule that allows PUT from there with the headers content-type, content-disposition, if-none-match, x-amz-meta-cloudrop-id and exposes ETag. Run: cloudrop setup --origin ${ORIGIN} --var CLOUDROP_R2_BUCKET=R2_BUCKET --apply`,
    );
  });
});

describe("cloudrop setup with --var", () => {
  it("prints the commands with the app's variables", async () => {
    const result = await setup({ env: {} });
    expect(result.lines).toEqual(
      expect.arrayContaining([
        '  wrangler r2 bucket cors list "$R2_BUCKET"',
        '  wrangler r2 bucket cors set "$R2_BUCKET" --file cors.json',
        '  wrangler r2 bucket lifecycle add "$R2_BUCKET" cloudrop-abort-incomplete --abort-multipart-days 1',
        '  aws s3api put-bucket-cors --bucket "$STORAGE_S3_BUCKET" --cors-configuration file://cors-s3.json --endpoint-url "$STORAGE_S3_ENDPOINT"',
        '  aws s3api put-bucket-lifecycle-configuration --bucket "$STORAGE_S3_BUCKET" --lifecycle-configuration file://lifecycle.json --endpoint-url "$STORAGE_S3_ENDPOINT"',
      ]),
    );
    expect(result.lines.at(-1)).toMatch(
      /^The commands read the bucket from R2_BUCKET or STORAGE_S3_BUCKET in your shell\. /,
    );
  });

  it("with --dry-run writes nothing, and with --apply writes both rules", async () => {
    const storage = bucket(EMPTY);
    const dryRun = await setup({ fetch: storage.fetch }, "--dry-run");
    expect([dryRun.code, dryRun.lines.at(-1), storage.writes]).toEqual([
      0,
      "Dry run: nothing was written. To write, run it with --apply and without --dry-run.",
      [],
    ]);
    const applied = await setup({ fetch: storage.fetch }, "--apply");
    expect([applied.code, storage.writes]).toEqual([0, ["PUT ?cors=", "PUT ?lifecycle="]]);
    expect((await storage.cors())?.map((rule) => rule.id)).toEqual(["cloudrop-uploads"]);
  });

  it("repeats the --var pairs in the doctor command it suggests", async () => {
    const result = await run(["setup", "--origin", ORIGIN, "--apply", ...BUCKET_ONLY], {
      env: bucketRenamed,
      fetch: bucket(EMPTY).fetch,
    });
    expect(result.lines.at(-1)).toBe(
      `Done. Check the bucket with cloudrop doctor --origin ${ORIGIN} --var CLOUDROP_R2_BUCKET=R2_BUCKET; R2 can take up to 30 seconds to apply a change.`,
    );
  });

  it("with --replace, writes cloudrop's rules alone when the reads are refused", async () => {
    const storage = bucket(EMPTY);
    const readsRefused: FetchLike = (input, init) =>
      /\?(cors|lifecycle)=$/.test(String(input)) && (init?.method ?? "GET") === "GET"
        ? answers(403, "AccessDenied")()
        : storage.fetch(input, init);
    const refused = await setup({ fetch: readsRefused }, "--apply");
    expect([refused.code, refused.lines.at(-1), storage.writes]).toEqual([1, "Nothing was written.", []]);
    const replaced = await setup({ fetch: readsRefused }, "--apply", "--replace");
    expect([replaced.code, storage.writes]).toEqual([0, ["PUT ?cors=", "PUT ?lifecycle="]]);
  });

  it.each([
    {
      name: "a variable that is not set",
      env: { ...APP_ENV, R2_SECRET_ACCESS_KEY: undefined },
      lines: [
        "PROBLEM      R2_SECRET_ACCESS_KEY is not set. Set it to the secret access key of an R2 API token.",
        "Nothing was written. Fix the settings above, then run the command again.",
      ],
    },
    {
      name: "credentials the service refuses",
      env: APP_ENV,
      fetch: answers(403),
      lines: [
        "PROBLEM      Bucket: The storage service refused these credentials (HTTP 403). Check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, that the token may read and write objects in the bucket named by R2_BUCKET, and that the bucket exists. A bucket in a jurisdiction also needs --jurisdiction.",
        "Nothing was written.",
      ],
    },
  ])("names the app's variable and writes nothing for $name", async ({ env, fetch, lines }) => {
    const result = await setup({ env, fetch }, "--apply");
    expect([result.code, result.lines.slice(1)]).toEqual([1, lines]);
  });
});
