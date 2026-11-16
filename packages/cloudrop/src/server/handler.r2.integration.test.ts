// The upload protocol against a real R2 bucket: cloudrop.handler signs, the test sends the bytes to R2 over real HTTP,
// as a browser would. Run it with `bun run test:live`, which loads the credentials and redacts them from the output.
// Everything is written under a fresh live-test/cloudrop-<32 hex>/ prefix and deleted by the contract teardown.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CompleteResponse,
  ErrorResponse,
  MultipartTicket,
  SignedPart,
  SingleTicket,
  UploadResponse,
} from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { r2 } from "../storage/presets.ts";
import { toHex } from "../storage/sigv4.ts";
import { tokenPayload } from "../testing/server-fixture.ts";
import { offsetBytes, randomPrefix, tearDownRun } from "../testing/storage-contract.ts";
import { type Cloudrop, createCloudrop } from "./cloudrop.ts";
import { allowAnyone, route } from "./route.ts";

const SETTINGS = [
  "CLOUDROP_R2_ACCOUNT_ID",
  "CLOUDROP_R2_BUCKET",
  "CLOUDROP_R2_ACCESS_KEY_ID",
  "CLOUDROP_R2_SECRET_ACCESS_KEY",
] as const;
const ORIGIN = "https://app.example.com";

describe("upload protocol on live R2", () => {
  const prefix = randomPrefix("live-test/");
  const openUploads: { key: string; uploadId: string }[] = [];
  let storage: StorageDriver | undefined;
  let cloudrop: Cloudrop;

  beforeAll(() => {
    const missing = SETTINGS.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(
        `Live R2 settings are missing: ${missing.join(", ")}. Run \`bun run test:live\` with CLOUDROP_R2_ENV_FILE naming a file that sets them, or export them.`,
      );
    }
    // Printed once, so a run stopped before its teardown can name what to delete.
    console.log(`Live R2 upload protocol: writing under ${prefix}`);
    storage = r2({ bucket: process.env.CLOUDROP_R2_BUCKET as string });
    cloudrop = createCloudrop({
      storage,
      // A fresh secret per run: no token from this run is valid anywhere else.
      secret: toHex(crypto.getRandomValues(new Uint8Array(32))),
      // Every key lands under the run prefix, which teardown deletes.
      routes: { live: route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone, prefix: () => prefix }) },
      multipartThreshold: "8MB",
    });
  });

  afterAll(() => tearDownRun(storage && { driver: storage, prefix, openUploads }, []));

  async function call<T>(
    endpoint: string,
    body: unknown,
  ): Promise<{ status: number; body: T & Partial<ErrorResponse> }> {
    const response = await cloudrop.handler(
      new Request(`${ORIGIN}/api/cloudrop/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as T & Partial<ErrorResponse> };
  }

  async function put(signed: { url: string; headers: Record<string, string> }, bytes: Uint8Array<ArrayBuffer>) {
    const response = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });
    await response.arrayBuffer();
    return response.status;
  }

  it("uploads a single file with the signed headers R2 stores, and serves it through a signed download URL", async () => {
    const upload = await call<UploadResponse>("upload", {
      route: "live",
      files: [{ name: "zdjęcie 1.png", size: 1000, type: "image/png" }],
    });
    const ticket = upload.body.files[0] as SingleTicket;
    expect(await put(ticket.put, offsetBytes(1000))).toBe(200);
    expect((await call<CompleteResponse>("complete", { token: ticket.token })).status).toBe(200);
    expect((await cloudrop.api.head(ticket.key)).data).toMatchObject({
      size: 1000,
      type: "image/png",
      disposition: "inline; filename=\"zdj_cie 1.png\"; filename*=UTF-8''zdj%C4%99cie%201.png",
      metadata: { "cloudrop-id": ticket.id },
    });
    const link = await cloudrop.api.getUrl(ticket.key, { expiresIn: 300, download: "photo.png" });
    expect(link.error).toBeNull();
    const response = await fetch(link.data?.url ?? "");
    expect({
      status: response.status,
      disposition: response.headers.get("content-disposition"),
      bytes: new Uint8Array(await response.arrayBuffer()),
    }).toEqual({
      status: 200,
      disposition: "attachment; filename=\"photo.png\"; filename*=UTF-8''photo.png",
      bytes: offsetBytes(1000),
    });
  });

  it("resumes a multipart upload: complete names the missing part, sign renews it, complete succeeds", async () => {
    const size = 8 * MiB + 5;
    const bytes = offsetBytes(size);
    const upload = await call<UploadResponse>("upload", {
      route: "live",
      files: [{ name: "video.bin", size, type: "application/octet-stream" }],
    });
    const ticket = upload.body.files[0] as MultipartTicket;
    const [, second] = ticket.parts as [SignedPart, SignedPart];
    openUploads.push({ key: ticket.key, uploadId: tokenPayload(ticket.token).uploadId as string });
    expect(await put(second, bytes.slice(8 * MiB))).toBe(200);
    const incomplete = await call<CompleteResponse>("complete", { token: ticket.token });
    expect({ status: incomplete.status, parts: incomplete.body.error?.parts }).toEqual({ status: 409, parts: [1] });
    const renewed = await call<{ parts: SignedPart[] }>("sign", { token: ticket.token, parts: [1] });
    const [first] = renewed.body.parts;
    expect(await put(first as SignedPart, bytes.slice(0, 8 * MiB))).toBe(200);
    const done = await call<CompleteResponse>("complete", { token: ticket.token });
    expect(done.status).toBe(200);
    expect((await cloudrop.api.head(ticket.key)).data?.size).toBe(size);
    // A retried completion after R2 forgot the upload succeeds by checking the stored object (spec §5.4).
    expect((await call<CompleteResponse>("complete", { token: ticket.token })).status).toBe(200);
  });

  it("aborts a multipart upload on R2", async () => {
    const upload = await call<UploadResponse>("upload", {
      route: "live",
      files: [{ name: "big.bin", size: 9 * MiB, type: "application/octet-stream" }],
    });
    const ticket = upload.body.files[0] as MultipartTicket;
    const uploadId = tokenPayload(ticket.token).uploadId as string;
    openUploads.push({ key: ticket.key, uploadId });
    expect((await call("abort", { token: ticket.token })).status).toBe(200);
    expect((await storage?.listParts(ticket.key, uploadId))?.error?.code).toBe("NO_SUCH_UPLOAD");
  });

  it("erases a folder with deletePrefix and proves it empty", async () => {
    const folder = `${prefix}erase/`;
    const stored = await Promise.all(["a.txt", "b.txt"].map((name) => cloudrop.api.put(`${folder}${name}`, "x")));
    expect(stored.map((result) => result.error)).toEqual([null, null]);
    expect((await cloudrop.api.deletePrefix(folder)).data?.deleted).toBe(2);
    expect((await storage?.list(folder))?.data?.items).toEqual([]);
  });

  it("reports bucket settings an object token may not read as unknown", async () => {
    // Measured for CORS in the spike (Q8: GetBucketCors answers 403 to an Object Read & Write token).
    const report = await cloudrop.api.checkBucket({ origins: ["http://localhost:5173"] });
    expect([report.data?.cors.status, report.data?.lifecycle.status]).toEqual(["unknown", "unknown"]);
  });
});
