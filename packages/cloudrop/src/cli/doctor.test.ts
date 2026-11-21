import { describe, expect, it } from "vitest";
import { bucket, ENV, ORIGIN, run } from "./command-fixture.ts";

// A rule that lets ORIGIN upload, and R2's default 7-day multipart rule.
const READY = {
  cors: `<CORSConfiguration><CORSRule><AllowedOrigin>${ORIGIN}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>content-disposition</AllowedHeader><AllowedHeader>if-none-match</AllowedHeader><AllowedHeader>x-amz-meta-cloudrop-id</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule></CORSConfiguration>`,
  lifecycle:
    "<LifecycleConfiguration><Rule><ID>Default Multipart Abort Rule</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>",
};

const doctor = (options?: Parameters<typeof run>[1]) => run(["doctor", "--origin", ORIGIN], options);
const without = (name: keyof typeof ENV) => ({ ...ENV, [name]: undefined });

describe("cloudrop doctor", () => {
  it("reports every check as ok and exits 0 for a ready setup", async () => {
    const result = await doctor({ fetch: bucket(READY).fetch });
    expect(result.lines).toEqual([
      `cloudrop doctor: checking R2 settings, the bucket and its rules for ${ORIGIN}.`,
      "ok           R2 settings are present and valid (CLOUDROP_R2_*).",
      "ok           CLOUDROP_SECRET is set.",
      "ok           The bucket answers, and these credentials may list it.",
      `ok           CORS: Browsers on ${ORIGIN} can upload and read ETag.`,
      "ok           Lifecycle: Incomplete multipart uploads are aborted after 7 days.",
      "No problems found.",
    ]);
    expect([result.code, result.stderr]).toEqual([0, ""]);
  });

  it("names a missing variable, checks no bucket and exits 1", async () => {
    const result = await doctor({ env: without("CLOUDROP_R2_BUCKET") });
    expect(result.code).toBe(1);
    expect(result.lines).toContain("PROBLEM      CLOUDROP_R2_BUCKET is not set. Set it to the bucket's name.");
    expect(result.lines).toContain("NOT CHECKED  The bucket and its rules: fix the settings above first.");
    expect(result.lines.at(-1)).toBe("1 problem found. Fix it, then run cloudrop doctor again.");
  });

  it("says where to start when no storage variable is set", async () => {
    const result = await doctor({ env: { CLOUDROP_SECRET: ENV.CLOUDROP_SECRET } });
    expect(result.code).toBe(1);
    expect(result.lines[1]).toBe(
      "PROBLEM      No storage settings found. Set CLOUDROP_R2_ACCOUNT_ID, CLOUDROP_R2_BUCKET, CLOUDROP_R2_ACCESS_KEY_ID and CLOUDROP_R2_SECRET_ACCESS_KEY for R2, or the CLOUDROP_S3_* settings for another service; --env-file reads them from a file.",
    );
  });

  it("checks S3 settings when only CLOUDROP_S3_* are set", async () => {
    const env = {
      CLOUDROP_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
      CLOUDROP_S3_BUCKET: "acme-s3-uploads",
      CLOUDROP_S3_ACCESS_KEY_ID: "AKIDs3fixture",
      CLOUDROP_S3_SECRET_ACCESS_KEY: "s3-secret-fixture-value",
      CLOUDROP_SECRET: ENV.CLOUDROP_SECRET,
    };
    const result = await doctor({ env });
    expect(result.lines.slice(0, 2)).toEqual([
      `cloudrop doctor: checking S3 settings, the bucket and its rules for ${ORIGIN}.`,
      "PROBLEM      CLOUDROP_S3_REGION is not set. Set it to the bucket's region, such as us-east-1.",
    ]);
  });

  it("names the variable whose value is invalid", async () => {
    const result = await doctor({ env: { ...ENV, CLOUDROP_R2_ACCOUNT_ID: "not-an-account-id" } });
    expect(result.code).toBe(1);
    expect(result.lines[1]).toMatch(
      /^PROBLEM {6}The R2 account ID must be 32 hexadecimal characters .*CLOUDROP_R2_ACCOUNT_ID\.$/,
    );
  });

  it.each([
    {
      name: "a short secret",
      env: { ...ENV, CLOUDROP_SECRET: "too-short-secret" },
      line: "PROBLEM      CLOUDROP_SECRET has fewer than 32 characters. Generate one with `openssl rand -base64 32`.",
    },
    {
      name: "no secret",
      env: without("CLOUDROP_SECRET"),
      line: "PROBLEM      CLOUDROP_SECRET is not set. Generate one with `openssl rand -base64 32` and set it, unless your code passes secret to createCloudrop().",
    },
  ])("reports $name as a problem", async ({ env, line }) => {
    const result = await doctor({ env, fetch: bucket(READY).fetch });
    expect([result.code, result.lines[2]]).toEqual([1, line]);
  });

  // A HEAD of a missing key answers 404 with no body whether or not the bucket exists, so it cannot prove the bucket.
  it("reports a bucket that does not exist", async () => {
    const result = await doctor({
      env: { ...ENV, CLOUDROP_R2_BUCKET: "another-bucket-name" },
      fetch: bucket(READY).fetch,
    });
    expect(result.code).toBe(1);
    expect(result.lines[3]).toBe(
      "PROBLEM      Bucket: The bucket does not exist. Check the bucket name in your configuration.",
    );
    expect(result.lines[4]).toBe("NOT CHECKED  CORS and lifecycle rules: the bucket did not answer.");
  });

  it("reports an unreachable storage service", async () => {
    const result = await doctor({ fetch: () => Promise.reject(new TypeError("fetch failed")) });
    expect(result.code).toBe(1);
    expect(result.lines[3]).toBe(
      "PROBLEM      Bucket: Could not reach the storage service. Check the endpoint and the network connection, then retry.",
    );
  });

  it("reports rules an object token cannot read as not checked, with how to check them, and exits 0", async () => {
    const result = await doctor({ fetch: bucket().fetch });
    expect(result.code).toBe(0);
    expect(result.lines.slice(4)).toEqual([
      'NOT CHECKED  CORS: These storage credentials may not read the bucket\'s CORS rules (R2 object tokens cannot). Check it with an admin read token or in the dashboard. By hand: wrangler r2 bucket cors list "$CLOUDROP_R2_BUCKET"',
      'NOT CHECKED  Lifecycle: These storage credentials may not read the bucket\'s lifecycle rules (R2 object tokens cannot). Check it with an admin read token or in the dashboard. By hand: wrangler r2 bucket lifecycle list "$CLOUDROP_R2_BUCKET"',
      "No problems found. 2 checks could not run; see above.",
    ]);
  });

  it("reports a CORS rule that blocks an origin, with the setup command that fixes it", async () => {
    const result = await run(["doctor", "--origin", ORIGIN, "--origin", "http://localhost:5173"], {
      fetch: bucket(READY).fetch,
    });
    expect(result.code).toBe(1);
    expect(result.lines[4]).toBe(
      "PROBLEM      CORS: The bucket's CORS rules do not let http://localhost:5173 upload. Add a rule that allows PUT from there with the headers content-type, content-disposition, if-none-match, x-amz-meta-cloudrop-id and exposes ETag. Run: cloudrop setup --origin https://app.example.com --origin http://localhost:5173 --apply",
    );
  });

  it("reads settings from --env-file, and the environment wins over the file", async () => {
    const { CLOUDROP_R2_BUCKET, ...rest } = ENV;
    const file = `# cloudrop\nexport CLOUDROP_R2_BUCKET="${CLOUDROP_R2_BUCKET}"\nCLOUDROP_SECRET='${"x".repeat(40)}' # overridden\n`;
    const result = await run(["doctor", "--origin", ORIGIN, "--env-file", ".env.local"], {
      env: rest,
      files: { ".env.local": file },
      fetch: bucket(READY).fetch,
    });
    expect(result.code).toBe(0);
    expect(result.lines[1]).toBe(
      "note         CLOUDROP_SECRET is set in the environment and in .env.local; the environment's value is used.",
    );
  });
});
