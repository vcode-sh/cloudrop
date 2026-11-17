// The chaos lane's own access to RustFS, past the proxy: creating the bucket, reading objects back, listing open
// multipart uploads and clearing a run's prefix. None of it may reach the proxy, or it would show in the log the rows
// assert and move the counters of their rules (plan audit I2). The driver has no ListMultipartUploads, so that one is
// signed here, as the RustFS contract lane signs its bucket creation (audit I1); the library does not change for it.

import { expect } from "vitest";
import type { StorageDriver } from "../storage/driver.ts";
import { s3 } from "../storage/presets.ts";
import { EMPTY_SHA256, sha256Hex, signRequest } from "../storage/sigv4.ts";
import { xmlBlocks, xmlText } from "../storage/xml.ts";

const BUCKET = "chaos";
// The disposable container's keys from scripts/rustfs.sh: test-only, never a real account.
const credentials = { accessKeyId: "cloudrop-test", secretAccessKey: "cloudrop-test-secret" };
const region = "us-east-1";

/** An open multipart upload, as ListMultipartUploads names it. */
export interface OpenUpload {
  key: string;
  uploadId: string;
}

const RUN_THE_LANE = "Run `bun run test:chaos` (scripts/test-chaos.sh), which starts RustFS in Docker and sets it.";

/** RustFS's own address, which scripts/test-chaos.sh exports. */
export function rustfsEndpoint(): string {
  const endpoint = process.env.CLOUDROP_RUSTFS_ENDPOINT;
  if (!endpoint) throw new Error(`CLOUDROP_RUSTFS_ENDPOINT is not set. ${RUN_THE_LANE}`);
  return endpoint;
}

/** An s3() driver on the lane's bucket at `endpoint`: the proxy for the server, RustFS itself for the oracle. */
export function chaosStorage(endpoint: string): StorageDriver {
  return s3({ endpoint, region, bucket: BUCKET, ...credentials });
}

async function signedFetch(method: "PUT" | "GET", url: URL): Promise<Response> {
  const headers = await signRequest({ method, url, credentials, region, date: new Date(), payloadHash: EMPTY_SHA256 });
  return fetch(url, { method, headers });
}

/** Creates the lane's bucket, or finds it; a fresh RustFS has none. Fails with what to run when RustFS is not there. */
export async function createBucket(endpoint: string): Promise<void> {
  let response: Response;
  try {
    response = await signedFetch("PUT", new URL(`${endpoint}/${BUCKET}`));
  } catch {
    throw new Error(`RustFS does not answer at ${endpoint}. ${RUN_THE_LANE}`);
  }
  // 409 BucketAlreadyOwnedByYou: an earlier fixture in this run created it.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Creating the RustFS bucket failed with HTTP ${response.status}. Check the container's logs.`);
  }
}

/** The multipart uploads open under `prefix`, signed straight to RustFS. */
export async function openUploads(endpoint: string, prefix: string): Promise<OpenUpload[]> {
  const url = new URL(`${endpoint}/${BUCKET}`);
  url.searchParams.set("uploads", "");
  url.searchParams.set("prefix", prefix);
  const response = await signedFetch("GET", url);
  if (!response.ok) throw new Error(`ListMultipartUploads on RustFS failed with HTTP ${response.status}.`);
  return xmlBlocks(await response.text(), "Upload").map((upload) => ({
    key: xmlText(upload, "Key") ?? "",
    uploadId: xmlText(upload, "UploadId") ?? "",
  }));
}

/** Aborts every upload and deletes every object under `prefix`. */
export async function clearPrefix(storage: StorageDriver, endpoint: string, prefix: string): Promise<void> {
  for (const { key, uploadId } of await openUploads(endpoint, prefix)) {
    const aborted = await storage.abortMultipart(key, uploadId);
    if (aborted.error) throw aborted.error;
  }
  for (let cursor: string | null | undefined; cursor !== null; ) {
    const listed = await storage.list(prefix, { cursor });
    if (listed.error) throw listed.error;
    const removed = await storage.deleteMany(listed.data.items.map((item) => item.key));
    if (removed.error) throw removed.error;
    expect(removed.data.failed, "objects the cleanup could not delete").toEqual([]);
    cursor = listed.data.nextCursor;
  }
}

/** The object under `key` has exactly the file's bytes: its size, then the SHA-256 of what RustFS gives back. */
export async function expectStoredFile(storage: StorageDriver, key: string, file: Blob): Promise<void> {
  const head = await storage.head(key);
  expect(head.error).toBeNull();
  expect(head.data?.size, `the size stored under ${key}`).toBe(file.size);
  // An empty object has no byte range to read; its size is all it holds.
  if (file.size === 0) return;
  const read = await storage.getRange(key, 0, file.size - 1);
  expect(read.error).toBeNull();
  const stored = read.data ?? new Uint8Array();
  expect(await sha256Hex(new Uint8Array(stored)), `the SHA-256 of ${key}`).toBe(
    await sha256Hex(new Uint8Array(await file.arrayBuffer())),
  );
}
