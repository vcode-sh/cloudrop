// Objects: stores, reads byte ranges, reports missing keys and handles awkward key spellings.

import { expect, it } from "vitest";
import { type ContractSuite, offsetBytes, text } from "./suite.ts";

export function objectCases(suite: ContractSuite): void {
  const { key, signedPut } = suite;

  it("stores an object with type, disposition and metadata and reads byte ranges", async () => {
    const { driver } = suite;
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

  it("reports the stored size of an object R2 would compress", async () => {
    const { driver } = suite;
    const k = key("notes.md");
    // R2 gzips the HEAD answer for compressible types from 50 bytes up and then sends no content-length (M7-P1).
    expect((await driver.put(k, "#".repeat(56), { type: "text/markdown" })).error).toBeNull();
    expect((await driver.head(k)).data).toMatchObject({ size: 56, type: "text/markdown" });
  });

  it("streams a Blob body through put", async () => {
    const { driver } = suite;
    const k = key("blob.bin");
    expect((await driver.put(k, new Blob([offsetBytes(1024)]))).error).toBeNull();
    // 1020 = 0x000003fc.
    expect((await driver.getRange(k, 1020, 1023)).data).toEqual(new Uint8Array([0x00, 0x00, 0x03, 0xfc]));
  });

  it("reports a missing object as null and deletes idempotently", async () => {
    const { driver } = suite;
    expect((await driver.head(key("missing.txt"))).data).toBeNull();
    expect((await driver.delete(key("missing.txt"))).error).toBeNull();
  });

  it("handles keys and prefixes with spaces, plus signs, percent signs and Unicode", async () => {
    const { driver } = suite;
    const dir = key("odd dir+%/");
    const k = `${dir}zdjęcie (1)*!'.txt`;
    const send = await signedPut(k, { size: 5, expiresIn: 300, type: "text/plain" });
    expect((await send(new TextEncoder().encode("hello"))).status).toBe(200);
    expect((await driver.head(k)).data?.size).toBe(5);
    expect((await driver.list(dir)).data?.items.map((item) => item.key)).toEqual([k]);
    expect((await driver.delete(k)).error).toBeNull();
    expect((await driver.head(k)).data).toBeNull();
  });
}
