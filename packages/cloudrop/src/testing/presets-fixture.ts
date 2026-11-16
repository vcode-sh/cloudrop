// Setup shared by the r2() and s3() unit tests: complete valid options and a reader for the error a preset throws at
// construction. It builds inputs only; every expected value stays in the tests.

import { CloudropError } from "../errors.ts";
import type { R2Options, S3Options } from "../storage/presets.ts";

export const ACCOUNT = "0123456789abcdef0123456789abcdef";

export function thrownBy(run: () => unknown): CloudropError {
  try {
    run();
  } catch (error) {
    if (error instanceof CloudropError) return error;
    throw error;
  }
  throw new Error("Expected the call to throw a CloudropError.");
}

export const goodR2: R2Options = { bucket: "media", accountId: ACCOUNT, accessKeyId: "k", secretAccessKey: "s" };
export const goodS3: S3Options = {
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  bucket: "media",
  accessKeyId: "k",
  secretAccessKey: "s",
};
