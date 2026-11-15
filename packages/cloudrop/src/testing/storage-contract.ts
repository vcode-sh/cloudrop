// The storage contract: one set of cases every backend runs unchanged (the in-process fake in the unit lane; RustFS,
// Wrangler local R2 and real R2 in their integration lanes), so the driver is proven to behave the same everywhere.

import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { crc32cBase64 } from "../checksum.ts";
import type { FetchLike, StorageDriver } from "../storage/driver.ts";
import { toHex } from "../storage/sigv4.ts";

/** Test bytes in which each 4-byte word holds its own offset, big-endian: no two words repeat within 4 GiB. */
export function offsetBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  for (let offset = 0; offset + 4 <= length; offset += 4) view.setUint32(offset, offset);
  return out;
}

/** A feature some backend lacks; the cases that need it skip on that backend with the recorded reason. */
type Gap = "signedHeaders" | "unequalParts" | "checksums" | "listParts" | "crc64nvme";

export interface ContractTarget {
  /** The driver every case uses, built the way an application builds it (the public preset where there is one). */
  driver: StorageDriver;
  /** A variant driver: `secondsAgo` moves its signing clock back, `maxSinglePutSize` lowers that rule. */
  driverWith(options: { secondsAgo?: number; maxSinglePutSize?: number }): StorageDriver;
  /** Made by randomPrefix, which the suite checks: teardown deletes everything under it and nothing else. */
  prefix: string;
  /** Sends presigned requests the way a browser would. */
  http: FetchLike;
  /** Backend gaps: each present entry names what the backend does instead, and skips the cases that need it. */
  gaps: Partial<Record<Gap, string>>;
  /**
   * What the backend does with an extra `x-amz-meta-*` header that a presigned PUT did not sign. Each lane records its
   * backend's measured answer and the contract checks it. Real R2 rejects it (live lane, 2026-11-15).
   */
  unsignedMetaOnPresignedPut: "stored" | "ignored" | "rejected";
}

/**
 * Connects to a backend. Register each cleanup with `onCleanup` the moment its resource exists: cleanups run after
 * the suite (last registered first), also when `connect` itself throws halfway. A lane whose service is started and
 * removed by its shell script's trap (RustFS, Wrangler) has nothing to register.
 */
export type ConnectTarget = (onCleanup: (cleanup: () => Promise<void>) => void) => Promise<ContractTarget>;

export function randomPrefix(root: string): string {
  return `${root}cloudrop-${toHex(crypto.getRandomValues(new Uint8Array(16)))}/`;
}

// Exactly what randomPrefix appends, so a lane cannot point teardown at "" or a shared root such as "live-test/".
const RUN_PREFIX = /(^|\/)cloudrop-[0-9a-f]{32}\/$/;

function checkRunPrefix(prefix: string): void {
  if (!RUN_PREFIX.test(prefix)) {
    throw new Error(
      `The contract prefix "${prefix}" was not made by randomPrefix(); refusing to delete anything under it.`,
    );
  }
}

/**
 * Deletes every object under a run prefix. It refuses a prefix randomPrefix did not make, deletes nothing when the
 * listing returns a key outside the prefix, and fails instead of looping when a deleted key is listed again.
 */
export async function clearRunPrefix(driver: StorageDriver, prefix: string): Promise<void> {
  checkRunPrefix(prefix);
  const sent = new Set<string>();
  for (;;) {
    const page = await driver.list(prefix);
    if (page.error) throw page.error;
    const keys = page.data.items.map((item) => item.key);
    if (keys.length === 0) return;
    const outside = keys.filter((key) => !key.startsWith(prefix));
    if (outside.length > 0) {
      throw new Error(
        `The listing for ${prefix} returned keys outside it; refusing to delete anything: ${outside.join(", ")}`,
      );
    }
    const survived = keys.filter((key) => sent.has(key));
    if (survived.length > 0) throw new Error(`These keys survived deletion: ${survived.join(", ")}`);
    const removed = await driver.deleteMany(keys);
    if (removed.error) throw removed.error;
    if (removed.data.failed.length > 0) {
      const failed = removed.data.failed.map(({ key, error }) => `${key} (${error.code})`);
      throw new Error(`Could not delete: ${failed.join(", ")}`);
    }
    for (const key of keys) sent.add(key);
  }
}

interface OpenUpload {
  key: string;
  uploadId: string;
}

/**
 * The suite's teardown: aborts the uploads the suite opened, deletes the run prefix, then runs the lane's cleanups,
 * last registered first. `run` is undefined when connecting failed. Uploads the driver starts itself (a multipart
 * copy) are not tracked: if the process dies mid-copy, teardown cannot find them; R2's default lifecycle rule aborts
 * incomplete multipart uploads after 7 days.
 * Every step runs even when an earlier one fails, and every failure is reported: a throwing cleanup must neither hide
 * why teardown failed nor skip the cleanups registered before it.
 */
export async function tearDownRun(
  run: { driver: StorageDriver; prefix: string; openUploads: OpenUpload[] } | undefined,
  cleanups: (() => Promise<void>)[],
): Promise<void> {
  const errors: unknown[] = [];
  // Inside the promise chain, so a step that throws before returning a promise is caught too.
  const attempt = (step: () => Promise<void>) =>
    Promise.resolve()
      .then(step)
      .catch((error: unknown) => errors.push(error));
  if (run) {
    const { driver, prefix, openUploads } = run;
    await attempt(async () => {
      const outcomes = await Promise.all(
        openUploads.map(async ({ key, uploadId }) => {
          const { error } = await driver.abortMultipart(key, uploadId);
          return error ? `${key} (${error.code})` : "";
        }),
      );
      const failed = outcomes.filter(Boolean);
      if (failed.length > 0) throw new Error(`Could not abort: ${failed.join(", ")}`);
    });
    await attempt(() => clearRunPrefix(driver, prefix));
  }
  for (const cleanup of cleanups.toReversed()) await attempt(cleanup);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Teardown failed in ${errors.length} steps.`);
}

const etagOf = (response: Response): string => (response.headers.get("etag") ?? "").replaceAll('"', "");

/** Status and S3 error code of a raw response; reading the body also releases the connection. */
async function outcome(response: Response): Promise<{ status: number; code: string }> {
  const code = /<Code>([^<]*)<\/Code>/.exec(await response.text())?.[1] ?? "";
  return { status: response.status, code };
}

const text = (bytes: Uint8Array | null): string => new TextDecoder().decode(bytes ?? new Uint8Array());

export function describeStorageContract(name: string, connect: ConnectTarget): void {
  describe(`storage contract: ${name}`, () => {
    let target: ContractTarget;
    let driver: StorageDriver;
    const cleanups: (() => Promise<void>)[] = [];
    const openUploads: OpenUpload[] = [];
    const key = (suffix: string): string => `${target.prefix}${suffix}`;
    // Every size derives from the backend's own minimum part size: the smallest multipart upload it accepts.
    const partSize = (): number => driver.rules.minPartSize;

    function skipWithout(ctx: TestContext, ...needed: Gap[]): void {
      const reason = needed.map((gap) => target.gaps[gap]).find((entry) => entry !== undefined);
      ctx.skip(reason !== undefined, reason);
    }

    async function startUpload(suffix: string, metadata?: Record<string, string>) {
      const k = key(suffix);
      const created = await driver.createMultipart(k, { type: "application/octet-stream", metadata });
      if (created.error) throw created.error;
      openUploads.push({ key: k, uploadId: created.data.uploadId });
      return { k, uploadId: created.data.uploadId };
    }

    // Signing a part with the upload ID the backend returned also proves that ID passes the driver's validation.
    async function sendPart(
      k: string,
      uploadId: string,
      partNumber: number,
      body: Uint8Array<ArrayBuffer>,
      checksumCrc32c?: string,
    ) {
      const signed = await driver.presignPart(k, uploadId, partNumber, {
        size: body.length,
        expiresIn: 300,
        checksumCrc32c,
      });
      if (signed.error) throw signed.error;
      return target.http(signed.data.url, { method: "PUT", headers: signed.data.headers, body });
    }

    /** Presigns a PUT and returns a sender for that one URL, optionally with headers it did not sign. */
    async function signedPut(k: string, options: Parameters<StorageDriver["presignPut"]>[1], via = driver) {
      const signed = await via.presignPut(k, options);
      if (signed.error) throw signed.error;
      const { url, headers } = signed.data;
      return (body: Uint8Array<ArrayBuffer>, extraHeaders: Record<string, string> = {}) =>
        target.http(url, { method: "PUT", headers: { ...headers, ...extraHeaders }, body });
    }

    beforeAll(async () => {
      const connected = await connect((cleanup) => cleanups.push(cleanup));
      checkRunPrefix(connected.prefix);
      target = connected;
      driver = target.driver;
    });

    afterAll(() => tearDownRun(target && { driver, prefix: target.prefix, openUploads }, cleanups));

    it("stores an object with type, disposition and metadata and reads byte ranges", async () => {
      const k = key("plain.txt");
      const put = await driver.put(k, "hello world", {
        type: "text/plain",
        disposition: 'attachment; filename="plain.txt"',
        metadata: { "cloudrop-id": "f1" },
      });
      expect(put.error).toBeNull();
      expect((await driver.head(k)).data).toMatchObject({
        size: 11,
        type: "text/plain",
        disposition: 'attachment; filename="plain.txt"',
        metadata: { "cloudrop-id": "f1" },
      });
      expect(text((await driver.getRange(k, 0, 4)).data)).toBe("hello");
      // A range past the end is clamped (RFC 9110 §14.1.2): the content sniff asks for bytes 0-4095 of any file.
      expect(text((await driver.getRange(k, 6, 4095)).data)).toBe("world");
    });

    it("streams a Blob body through put", async () => {
      const k = key("blob.bin");
      expect((await driver.put(k, new Blob([offsetBytes(1024)]))).error).toBeNull();
      // 1020 = 0x000003fc.
      expect((await driver.getRange(k, 1020, 1023)).data).toEqual(new Uint8Array([0x00, 0x00, 0x03, 0xfc]));
    });

    it("reports a missing object as null and deletes idempotently", async () => {
      expect((await driver.head(key("missing.txt"))).data).toBeNull();
      expect((await driver.delete(key("missing.txt"))).error).toBeNull();
    });

    it("handles keys and prefixes with spaces, plus signs, percent signs and Unicode", async () => {
      const dir = key("odd dir+%/");
      const k = `${dir}zdjęcie (1)*!'.txt`;
      const send = await signedPut(k, { size: 5, expiresIn: 300, type: "text/plain" });
      expect((await send(new TextEncoder().encode("hello"))).status).toBe(200);
      expect((await driver.head(k)).data?.size).toBe(5);
      expect((await driver.list(dir)).data?.items.map((item) => item.key)).toEqual([k]);
      expect((await driver.delete(k)).error).toBeNull();
      expect((await driver.head(k)).data).toBeNull();
    });

    it("accepts a presigned PUT whose body matches the signed size and headers", async () => {
      const k = key("presigned.bin");
      const send = await signedPut(k, {
        size: 1024,
        expiresIn: 300,
        type: "application/octet-stream",
        metadata: { "cloudrop-id": "f2" },
        ifNoneMatch: true,
      });
      expect((await send(offsetBytes(1024))).status).toBe(200);
      expect((await driver.head(k)).data).toMatchObject({ size: 1024, metadata: { "cloudrop-id": "f2" } });
    });

    it("stores an empty file through a presigned PUT", async () => {
      const k = key("empty.txt");
      const send = await signedPut(k, { size: 0, expiresIn: 300, type: "text/plain", ifNoneMatch: true });
      expect((await send(new Uint8Array())).status).toBe(200);
      expect((await driver.head(k)).data).toMatchObject({ size: 0, type: "text/plain" });
    });

    it("rejects presigned PUTs with a different size or content type", async (ctx) => {
      skipWithout(ctx, "signedHeaders");
      const k = key("wrong.bin");
      const send = await signedPut(k, { size: 1024, expiresIn: 300, type: "image/png" });
      const rejected = { status: 403, code: "SignatureDoesNotMatch" };
      expect(await outcome(await send(offsetBytes(1023)))).toEqual(rejected);
      expect(await outcome(await send(offsetBytes(1025)))).toEqual(rejected);
      expect(await outcome(await send(offsetBytes(1024), { "content-type": "text/html" }))).toEqual(rejected);
      expect((await driver.head(k)).data).toBeNull();
      expect((await send(offsetBytes(1024))).status).toBe(200);
    });

    it("answers a presigned PUT carrying an unsigned metadata header as recorded for the backend", async () => {
      const k = key("unsigned-meta.bin");
      const send = await signedPut(k, { size: 16, expiresIn: 300, metadata: { "cloudrop-id": "f6" } });
      const response = await send(offsetBytes(16), { "x-amz-meta-injected": "yes" });
      const expected = {
        stored: { status: 200, code: "", metadata: { "cloudrop-id": "f6", injected: "yes" } },
        ignored: { status: 200, code: "", metadata: { "cloudrop-id": "f6" } },
        // Real R2's answer, measured by the live lane on 2026-11-15: nothing is stored. AWS S3 documents AccessDenied
        // instead ("There were headers present in the request which were not signed"), unmeasured here.
        rejected: { status: 403, code: "SignatureDoesNotMatch", metadata: undefined },
      }[target.unsignedMetaOnPresignedPut];
      expect({ ...(await outcome(response)), metadata: (await driver.head(k)).data?.metadata }).toEqual(expected);
    });

    it("refuses to overwrite through a create-only URL", async () => {
      const k = key("create-only.bin");
      const send = await signedPut(k, { size: 16, expiresIn: 300, ifNoneMatch: true });
      expect((await send(offsetBytes(16))).status).toBe(200);
      expect(await outcome(await send(new Uint8Array(16)))).toEqual({ status: 412, code: "PreconditionFailed" });
      // The first body survives: the word at offset 4 holds 4.
      expect((await driver.getRange(k, 4, 7)).data).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x04]));
    });

    it("rejects an expired presigned URL", async () => {
      const k = key("expired.bin");
      const send = await signedPut(k, { size: 16, expiresIn: 60 }, target.driverWith({ secondsAgo: 120 }));
      expect(await outcome(await send(offsetBytes(16)))).toEqual({ status: 403, code: "ExpiredRequest" });
      expect((await driver.head(k)).data).toBeNull();
    });

    it("uploads equal parts through presigned URLs, completes once, and reports a retried completion", async () => {
      const { k, uploadId } = await startUpload("multipart.bin", { "cloudrop-id": "f3" });
      const size = partSize();
      const body = offsetBytes(2 * size + 1024);
      const first = await sendPart(k, uploadId, 1, body.subarray(0, size));
      const second = await sendPart(k, uploadId, 2, body.subarray(size, 2 * size));
      const third = await sendPart(k, uploadId, 3, body.subarray(2 * size));
      expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
      const parts = [first, second, third].map((response, index) => ({
        partNumber: index + 1,
        etag: etagOf(response),
      }));
      expect((await driver.completeMultipart(k, uploadId, parts, { ifNoneMatch: true })).error).toBeNull();
      expect((await driver.head(k)).data).toMatchObject({ size: body.length, metadata: { "cloudrop-id": "f3" } });
      // Bytes that cross from part 1 into part 2, and from part 2 into part 3: joined in order, each part in its place.
      // For 5 MiB parts the first four are ff fc 00 50, the tail of word 0x004ffffc and the head of 0x00500000.
      expect((await driver.getRange(k, size - 2, size + 1)).data).toEqual(body.slice(size - 2, size + 2));
      expect((await driver.getRange(k, 2 * size - 2, 2 * size + 1)).data).toEqual(
        body.slice(2 * size - 2, 2 * size + 2),
      );
      expect((await driver.completeMultipart(k, uploadId, parts)).error?.code).toBe("NO_SUCH_UPLOAD");
    });

    it("lists uploaded parts with their numbers, sizes and ETags", async (ctx) => {
      skipWithout(ctx, "listParts");
      const { k, uploadId } = await startUpload("listed.bin");
      const size = partSize();
      const body = offsetBytes(size + 1);
      const first = await sendPart(k, uploadId, 1, body.subarray(0, size));
      const second = await sendPart(k, uploadId, 2, body.subarray(size));
      const listed = await driver.listParts(k, uploadId);
      expect(listed.data?.map(({ partNumber, size, etag }) => ({ partNumber, size, etag }))).toEqual([
        { partNumber: 1, size, etag: etagOf(first) },
        { partNumber: 2, size: 1, etag: etagOf(second) },
      ]);
    });

    it("refuses a conditional completion onto an existing key and discards the upload", async () => {
      const { k, uploadId } = await startUpload("taken.bin");
      // Written after the upload started, so only the completion's If-None-Match can see it.
      expect((await driver.put(k, "first")).error).toBeNull();
      const part = await sendPart(k, uploadId, 1, offsetBytes(1024));
      const parts = [{ partNumber: 1, etag: etagOf(part) }];
      expect((await driver.completeMultipart(k, uploadId, parts, { ifNoneMatch: true })).error?.code).toBe(
        "ALREADY_EXISTS",
      );
      expect(text((await driver.getRange(k, 0, 4)).data)).toBe("first");
      // The upload is gone, proven without ListParts.
      expect((await driver.completeMultipart(k, uploadId, parts)).error?.code).toBe("NO_SUCH_UPLOAD");
    });

    it("rejects a larger last part at completion and accepts the repaired upload", async (ctx) => {
      skipWithout(ctx, "unequalParts");
      const { k, uploadId } = await startUpload("unequal.bin");
      const size = partSize();
      const first = etagOf(await sendPart(k, uploadId, 1, offsetBytes(size)));
      const tooLarge = etagOf(await sendPart(k, uploadId, 2, offsetBytes(size + 4)));
      const rejected = await driver.completeMultipart(k, uploadId, [
        { partNumber: 1, etag: first },
        { partNumber: 2, etag: tooLarge },
      ]);
      expect(rejected.error?.code).toBe("INVALID_PART");
      const repaired = etagOf(await sendPart(k, uploadId, 2, offsetBytes(4)));
      const completed = await driver.completeMultipart(k, uploadId, [
        { partNumber: 1, etag: first },
        { partNumber: 2, etag: repaired },
      ]);
      expect(completed.error).toBeNull();
      expect((await driver.head(k)).data?.size).toBe(size + 4);
    });

    it("aborts a multipart upload idempotently", async () => {
      const { k, uploadId } = await startUpload("aborted.bin");
      expect((await driver.abortMultipart(k, uploadId)).error).toBeNull();
      expect((await driver.abortMultipart(k, uploadId)).error).toBeNull();
    });

    it("reports an aborted upload as NO_SUCH_UPLOAD to ListParts", async (ctx) => {
      skipWithout(ctx, "listParts");
      const { k, uploadId } = await startUpload("aborted-listed.bin");
      expect((await driver.abortMultipart(k, uploadId)).error).toBeNull();
      expect((await driver.listParts(k, uploadId)).error?.code).toBe("NO_SUCH_UPLOAD");
    });

    it("rejects a part whose bytes do not match the signed CRC32C", async (ctx) => {
      skipWithout(ctx, "checksums");
      const { k, uploadId } = await startUpload("checksum.bin");
      const body = offsetBytes(1024);
      const rejected = await sendPart(k, uploadId, 1, body, crc32cBase64(offsetBytes(16)));
      expect(await outcome(rejected)).toEqual({ status: 400, code: "BadDigest" });
      expect((await sendPart(k, uploadId, 1, body, crc32cBase64(body))).status).toBe(200);
    });

    it("reports the CRC32C a part was uploaded with in ListParts", async (ctx) => {
      skipWithout(ctx, "checksums", "listParts");
      const { k, uploadId } = await startUpload("checksum-listed.bin");
      const body = offsetBytes(1024);
      expect((await sendPart(k, uploadId, 1, body, crc32cBase64(body))).status).toBe(200);
      expect((await driver.listParts(k, uploadId)).data?.[0]?.checksumCrc32c).toBe(crc32cBase64(body));
    });

    it("reports the CRC64NVME the storage computed", async (ctx) => {
      skipWithout(ctx, "crc64nvme");
      const k = key("crc64.txt");
      expect((await driver.put(k, "123456789")).error).toBeNull();
      // CRC64NVME check value 0xae8b14860a799888, base64.
      expect((await driver.head(k)).data?.checksumCrc64nvme).toBe("rosUhgp5mIg=");
    });

    it("copies an object with its type and metadata", async () => {
      expect(
        (await driver.put(key("copy-source.txt"), "copy me", { type: "text/plain", metadata: { "cloudrop-id": "f4" } }))
          .error,
      ).toBeNull();
      expect((await driver.copy(key("copy-source.txt"), key("copy-target.txt"))).error).toBeNull();
      expect((await driver.head(key("copy-target.txt"))).data).toMatchObject({
        size: 7,
        type: "text/plain",
        metadata: { "cloudrop-id": "f4" },
      });
      expect(text((await driver.getRange(key("copy-target.txt"), 0, 6)).data)).toBe("copy me");
    });

    it("copies a larger object in ranged parts with its type and metadata", async () => {
      const size = partSize();
      const body = offsetBytes(size + 1024);
      const options = { type: "application/octet-stream", metadata: { "cloudrop-id": "f5" } };
      expect((await driver.put(key("big-source.bin"), body, options)).error).toBeNull();
      // A single-PUT limit of one part forces UploadPartCopy with x-amz-copy-source-range, without a 5 GiB source.
      const small = target.driverWith({ maxSinglePutSize: size });
      expect((await small.copy(key("big-source.bin"), key("big-copy.bin"))).error).toBeNull();
      expect((await driver.head(key("big-copy.bin"))).data).toMatchObject({ size: body.length, ...options });
      expect((await driver.getRange(key("big-copy.bin"), size - 2, size + 1)).data).toEqual(
        body.slice(size - 2, size + 2),
      );
    });

    it("lists by prefix in pages and deletes many keys with per-key results", async () => {
      const keys = ["list/a", "list/b", "list/c"].map(key);
      const stored = await Promise.all(keys.map((k) => driver.put(k, "x")));
      expect(stored.map((result) => result.error)).toEqual([null, null, null]);
      const first = await driver.list(key("list/"), { limit: 2 });
      expect(first.data?.items.map((item) => item.key)).toEqual(keys.slice(0, 2));
      // Passing the backend's continuation token back also proves it passes the driver's cursor validation.
      const second = await driver.list(key("list/"), { limit: 2, cursor: first.data?.nextCursor ?? "" });
      expect(second.error).toBeNull();
      expect(second.data?.items.map((item) => item.key)).toEqual(keys.slice(2));
      expect(second.data?.nextCursor).toBeNull();
      const everything = [...keys, key("list/never-existed")];
      const removed = await driver.deleteMany(everything);
      expect(removed.data?.failed).toEqual([]);
      expect(removed.data?.deleted.toSorted()).toEqual(everything.toSorted());
      expect((await driver.list(key("list/"))).data?.items).toEqual([]);
    });
  });
}
