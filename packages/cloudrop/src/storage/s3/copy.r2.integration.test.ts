// A copy in parts of an object whose stored disposition holds UTF-8 bytes, on a real R2 bucket (M11-R25, M11-R252).
// Run it with `bun run test:live`, which loads the credentials and redacts them from the output. Everything is
// written under a fresh live-test/cloudrop-<32 hex>/ prefix and deleted by the teardown.

import { afterAll, beforeAll, expect, it } from "vitest";
import { R2_RULES } from "../../rules.ts";
import { offsetBytes, randomPrefix, tearDownRun } from "../../testing/storage-contract.ts";
import type { StorageDriver } from "../driver.ts";
import { createS3Driver } from "../s3-driver.ts";
import { sha256Hex, signRequest } from "../sigv4.ts";

const SETTINGS = [
  "CLOUDROP_R2_ACCOUNT_ID",
  "CLOUDROP_R2_BUCKET",
  "CLOUDROP_R2_ACCESS_KEY_ID",
  "CLOUDROP_R2_SECRET_ACCESS_KEY",
] as const;
const env = process.env as Record<(typeof SETTINGS)[number], string>;
const prefix = randomPrefix("live-test/");
let endpoint = "";
let credentials = { accessKeyId: "", secretAccessKey: "" };
let driver: StorageDriver | undefined;

beforeAll(() => {
  const missing = SETTINGS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Live R2 settings are missing: ${missing.join(", ")}. Run \`bun run test:live\` with CLOUDROP_R2_ENV_FILE naming a file that sets them, or export them.`,
    );
  }
  // Printed once, so a run stopped before its teardown can name what to delete.
  console.log(`Live R2 copy in parts: writing under ${prefix}`);
  endpoint = `https://${env.CLOUDROP_R2_ACCOUNT_ID.toLowerCase()}.r2.cloudflarestorage.com`;
  credentials = { accessKeyId: env.CLOUDROP_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDROP_R2_SECRET_ACCESS_KEY };
  // A single-PUT limit of one minimum part: the smallest source a copy takes in parts, without a 5 GiB object.
  driver = createS3Driver({
    endpoint,
    region: "auto",
    bucket: env.CLOUDROP_R2_BUCKET,
    credentials,
    rules: { ...R2_RULES, maxSinglePutSize: R2_RULES.minPartSize },
  });
});

afterAll(() => tearDownRun(driver && { driver, prefix, openUploads: [] }, []));

it("copies in parts an object whose stored disposition holds the byte A0 and a no-break space", async () => {
  const copier = driver as StorageDriver;
  // As HEAD returns it, one character per byte: "voilà" (C3 A0), a no-break space (C2 A0), then "你" (E4 BD A0) at
  // the end. cloudrop refuses such a value as input, so the source is stored the way another tool would store it.
  const disposition = "attachment; filename=voilÃ Â ä½ ";
  const body = offsetBytes(R2_RULES.minPartSize + 1024);
  const url = new URL(`${endpoint}/${env.CLOUDROP_R2_BUCKET}/${prefix}source.bin`);
  const headers = await signRequest({
    method: "PUT",
    url,
    headers: { "content-disposition": disposition },
    credentials,
    region: "auto",
    date: new Date(),
    payloadHash: await sha256Hex(body),
  });
  const stored = await fetch(url, { method: "PUT", headers, body });
  await stored.arrayBuffer();
  expect(stored.status).toBe(200);

  expect((await copier.copy(`${prefix}source.bin`, `${prefix}copy.bin`)).error).toBeNull();

  expect((await copier.head(`${prefix}copy.bin`)).data).toMatchObject({ size: body.length, disposition });
});
