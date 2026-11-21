// contentChecks() on a real R2 bucket: the handler reads the first bytes of each stored file with a ranged GET and
// deletes a refused one. Run it with `bun run test:live`, which loads the credentials and redacts them from the output.
// Everything is written under a fresh live-test/cloudrop-<32 hex>/ prefix and deleted by the teardown.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { CompleteResponse, ErrorResponse, SingleTicket, UploadResponse } from "../protocol/types.ts";
import { type Cloudrop, createCloudrop } from "../server/cloudrop.ts";
import { allowAnyone, route } from "../server/route.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { r2 } from "../storage/presets.ts";
import { toHex } from "../storage/sigv4.ts";
import { bytes, HTML, PNG } from "../testing/file-samples.ts";
import { randomPrefix, tearDownRun } from "../testing/storage-contract.ts";
import { contentChecks } from "./content-checks.ts";

const ORIGIN = "https://app.example.com";
const prefix = randomPrefix("live-test/");
let storage: StorageDriver | undefined;
let cloudrop: Cloudrop;

beforeAll(() => {
  const bucket = process.env.CLOUDROP_R2_BUCKET;
  if (!bucket) {
    throw new Error(
      "Live R2 settings are missing. Run `bun run test:live` with CLOUDROP_R2_ENV_FILE naming a file that sets them.",
    );
  }
  // Printed once, so a run stopped before its teardown can name what to delete.
  console.log(`Live R2 content checks: writing under ${prefix}`);
  storage = r2({ bucket });
  cloudrop = createCloudrop({
    storage,
    secret: toHex(crypto.getRandomValues(new Uint8Array(32))),
    routes: { live: route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone }, { prefix: () => prefix }) },
    plugins: [contentChecks()],
  });
});

afterAll(() => tearDownRun(storage && { driver: storage, prefix, openUploads: [] }, []));

async function call<T>(endpoint: string, body: unknown): Promise<{ status: number; body: T & Partial<ErrorResponse> }> {
  const response = await cloudrop.handler(
    new Request(`${ORIGIN}/api/cloudrop/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as T & Partial<ErrorResponse> };
}

/** Uploads `body` as `file` straight to R2, completes it, and says what /complete answered and what R2 kept. */
async function uploadAndComplete(file: { name: string; type: string }, body: Uint8Array<ArrayBuffer>) {
  const upload = await call<UploadResponse>("upload", { route: "live", files: [{ ...file, size: body.length }] });
  const ticket = upload.body.files[0] as SingleTicket;
  const put = await fetch(ticket.put.url, { method: "PUT", headers: ticket.put.headers, body });
  await put.arrayBuffer();
  expect(put.status).toBe(200);
  const completed = await call<CompleteResponse>("complete", { token: ticket.token });
  const kept = (await cloudrop.api.head(ticket.key)).data?.size ?? null;
  const { code = null, content = null } = completed.body.error ?? {};
  return { status: completed.status, code, content, kept };
}

it.for([
  // R2 answers any range of an empty object with 416, so nothing is read (measured 2026-11-21).
  { name: "an empty file", file: { name: "empty.txt", type: "text/plain" }, body: bytes() },
  { name: "a one-byte file", file: { name: "one.txt", type: "text/plain" }, body: bytes("a") },
  // Larger than the 4 KiB read: R2 answers the range with its first 4,096 bytes.
  { name: "a PNG over 4 KiB", file: { name: "big.png", type: "image/png" }, body: bytes(PNG, new Uint8Array(5000)) },
])("keeps $name whose content agrees with its type", async ({ file, body }) => {
  expect(await uploadAndComplete(file, body)).toEqual({ status: 200, code: null, content: null, kept: body.length });
});

it("refuses a web page sent as a PNG, says what it found and deletes it from the bucket", async () => {
  expect(await uploadAndComplete({ name: "photo.png", type: "image/png" }, HTML)).toEqual({
    status: 400,
    code: "FILE_TYPE_NOT_ALLOWED",
    // Read from the bytes R2 served for the ranged GET (M11-K1).
    content: { declared: "image/png", detected: "text/html", reason: "refused" },
    kept: null,
  });
});
