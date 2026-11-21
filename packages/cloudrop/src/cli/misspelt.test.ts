import { describe, expect, it } from "vitest";
import { APP_ENV, APP_VARS, bucket, ENV, ORIGIN, run, runRenamed } from "./command-fixture.ts";

const notes = (lines: string[]) => lines.filter((line) => line.startsWith("note"));

describe("notes on names --var gives", () => {
  it("suggests the app's variable a name is one slip or another case away from, when that variable is not set", async () => {
    const { R2_BUCKET, UPLOAD_TOKEN_SECRET, ...rest } = APP_ENV;
    const env = {
      ...rest,
      R2_BUCKT: R2_BUCKET,
      upload_token_secret: UPLOAD_TOKEN_SECRET,
      R2_ACCESS_KEY_IDS: "other", // one slip from a variable that is set: nothing to suggest
      S3_BUCKET: "another-bucket", // two edits from R2_BUCKET: one of the environment's own names
    };
    const result = await runRenamed(["doctor", "--origin", ORIGIN], { env });
    expect(notes(result.lines)).toEqual([
      "note         R2_BUCKT is not a variable the command reads. Did you mean R2_BUCKET?",
      "note         upload_token_secret is not a variable the command reads. Did you mean UPLOAD_TOKEN_SECRET?",
    ]);
  });

  // An app that reaches R2 through s3() may well name its endpoint CLOUDROP_R2_ENDPOINT.
  it("has no note for an app's variable that resembles a cloudrop name once --var names it", async () => {
    const env = {
      CLOUDROP_R2_ENDPOINT: "https://s3.eu-west-2.amazonaws.com",
      CLOUDROP_R2_REGION: "eu-west-2",
      cloudrop_s3_bucket: "acme-s3-uploads",
      CLOUDROP_S3_ACCESS_KEY_ID: "AKIDs3fixture",
      CLOUDROP_S3_SECRET_ACCESS_KEY: "s3-secret-fixture-value",
      CLOUDROP_SECRETS: ENV.CLOUDROP_SECRET,
    };
    const pairs = [
      "CLOUDROP_S3_ENDPOINT=CLOUDROP_R2_ENDPOINT",
      "CLOUDROP_S3_REGION=CLOUDROP_R2_REGION",
      "CLOUDROP_S3_BUCKET=cloudrop_s3_bucket",
      "CLOUDROP_SECRET=CLOUDROP_SECRETS",
    ];
    const refuses = () => Promise.resolve(new Response("", { status: 403 }));
    const unnamed = await run(["doctor", "--origin", ORIGIN], { env });
    expect(notes(unnamed.lines)).toEqual([
      "note         CLOUDROP_R2_ENDPOINT is not a cloudrop setting. R2's endpoint is built from CLOUDROP_R2_ACCOUNT_ID.",
      "note         CLOUDROP_R2_REGION is not a cloudrop setting. R2 needs no region.",
      "note         cloudrop_s3_bucket is not a cloudrop setting. Did you mean CLOUDROP_S3_BUCKET?",
      "note         CLOUDROP_SECRETS is not a cloudrop setting. Did you mean CLOUDROP_SECRET?",
    ]);
    const named = await run(["doctor", "--origin", ORIGIN, ...pairs.flatMap((pair) => ["--var", pair])], {
      env,
      fetch: refuses,
    });
    expect(notes(named.lines)).toEqual([]);
    expect(named.lines[1]).toBe(
      "ok           S3 settings are present and valid (CLOUDROP_R2_ENDPOINT, CLOUDROP_R2_REGION, cloudrop_s3_bucket, CLOUDROP_S3_ACCESS_KEY_ID, CLOUDROP_S3_SECRET_ACCESS_KEY).",
    );
  });

  it("names the app's variable in the note on a setting R2 does not need", async () => {
    const result = await run(["doctor", "--origin", ORIGIN, ...APP_VARS], {
      env: { ...APP_ENV, CLOUDROP_R2_ENDPOINT: "https://r2.example.com" },
      fetch: bucket().fetch,
    });
    expect(notes(result.lines)).toEqual([
      "note         CLOUDROP_R2_ENDPOINT is not a cloudrop setting. R2's endpoint is built from R2_ACCOUNT_ID.",
    ]);
  });

  it("does not suggest a cloudrop name that --var keeps from being read", async () => {
    const { R2_BUCKET, ...rest } = APP_ENV;
    const result = await run(["doctor", "--origin", ORIGIN, ...APP_VARS], {
      env: { ...rest, CLOUDROP_R2_BUCKT: R2_BUCKET },
    });
    expect(notes(result.lines)).toEqual([]);
    expect(result.lines).toContain("PROBLEM      R2_BUCKET is not set. Set it to the bucket's name.");
  });
});
