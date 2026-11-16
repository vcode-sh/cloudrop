// Multipart uploads through presigned parts, their completion rules, and the checksums parts and objects carry.

import { expect, it } from "vitest";
import { crc32cBase64 } from "../../checksum.ts";
import { type ContractSuite, etagOf, offsetBytes, outcome, text } from "./suite.ts";

export function multipartCases(suite: ContractSuite): void {
  const { key, partSize, skipWithout, uploadAfterCompletion, startUpload, sendPart } = suite;

  it("uploads equal parts through presigned URLs, completes once, and reports a retried completion", async () => {
    const { driver } = suite;
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
    expect((await driver.getRange(k, 2 * size - 2, 2 * size + 1)).data).toEqual(body.slice(2 * size - 2, 2 * size + 2));
    expect((await driver.completeMultipart(k, uploadId, parts)).error?.code).toBe(uploadAfterCompletion());
  });

  it("lists uploaded parts with their numbers, sizes and ETags", async (ctx) => {
    const { driver } = suite;
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

  it("refuses a conditional completion onto an existing key and discards the upload", async (ctx) => {
    const { driver } = suite;
    skipWithout(ctx, "conditionalCompletion");
    const { k, uploadId } = await startUpload("taken.bin");
    // Written after the upload started, so only the completion's If-None-Match can see it.
    expect((await driver.put(k, "first")).error).toBeNull();
    const part = await sendPart(k, uploadId, 1, offsetBytes(1024));
    const parts = [{ partNumber: 1, etag: etagOf(part) }];
    expect((await driver.completeMultipart(k, uploadId, parts, { ifNoneMatch: true })).error?.code).toBe(
      "ALREADY_EXISTS",
    );
    expect(text((await driver.getRange(k, 0, 4)).data)).toBe("first");
    // R2 discards the upload, proven without ListParts; a backend that declares the gap keeps it and completes again.
    expect((await driver.completeMultipart(k, uploadId, parts)).error?.code).toBe(uploadAfterCompletion());
  });

  it("rejects a larger last part at completion and accepts the repaired upload", async (ctx) => {
    const { driver, target } = suite;
    skipWithout(ctx, "unequalParts");
    const { k, uploadId } = await startUpload("unequal.bin");
    const size = partSize();
    const first = etagOf(await sendPart(k, uploadId, 1, offsetBytes(size)));
    const tooLarge = etagOf(await sendPart(k, uploadId, 2, offsetBytes(size + 4)));
    const rejected = await driver.completeMultipart(k, uploadId, [
      { partNumber: 1, etag: first },
      { partNumber: 2, etag: tooLarge },
    ]);
    expect(rejected.error?.code).toBe(target.unequalPartsCode ?? "INVALID_PART");
    const repaired = etagOf(await sendPart(k, uploadId, 2, offsetBytes(4)));
    const completed = await driver.completeMultipart(k, uploadId, [
      { partNumber: 1, etag: first },
      { partNumber: 2, etag: repaired },
    ]);
    expect(completed.error).toBeNull();
    expect((await driver.head(k)).data?.size).toBe(size + 4);
  });

  it("aborts a multipart upload idempotently", async () => {
    const { driver } = suite;
    const { k, uploadId } = await startUpload("aborted.bin");
    expect((await driver.abortMultipart(k, uploadId)).error).toBeNull();
    expect((await driver.abortMultipart(k, uploadId)).error).toBeNull();
  });

  it("reports an aborted upload as NO_SUCH_UPLOAD to ListParts", async (ctx) => {
    const { driver } = suite;
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
    const { driver } = suite;
    skipWithout(ctx, "checksums", "listParts", "listPartChecksums");
    const { k, uploadId } = await startUpload("checksum-listed.bin");
    const body = offsetBytes(1024);
    expect((await sendPart(k, uploadId, 1, body, crc32cBase64(body))).status).toBe(200);
    expect((await driver.listParts(k, uploadId)).data?.[0]?.checksumCrc32c).toBe(crc32cBase64(body));
  });

  it("reports the CRC64NVME the storage computed", async (ctx) => {
    const { driver } = suite;
    skipWithout(ctx, "crc64nvme");
    const k = key("crc64.txt");
    expect((await driver.put(k, "123456789")).error).toBeNull();
    // CRC64NVME check value 0xae8b14860a799888, base64.
    expect((await driver.head(k)).data?.checksumCrc64nvme).toBe("rosUhgp5mIg=");
  });
}
