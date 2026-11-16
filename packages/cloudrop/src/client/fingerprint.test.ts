// Contract: spec §3.3 of the resume design. The fingerprint is the hex SHA-256 of the file's first 64 KiB followed by
// its last 64 KiB, or of the whole file up to 128 KiB, and "" where crypto.subtle is missing; a picked file is the
// record's file only when its name, size, lastModified, type and fingerprint all equal the record's.
// Oracle: SHA-256 from node:crypto (not WebCrypto, which the code uses) over byte ranges written as literal offsets.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { offsetBytes } from "../testing/storage-contract.ts";
import { fingerprintOf, isSameFile } from "./fingerprint.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const sha256 = (...ranges: Uint8Array[]) => {
  const hash = createHash("sha256");
  for (const range of ranges) hash.update(range);
  return hash.digest("hex");
};

const fileOf = (bytes: Uint8Array<ArrayBuffer>) =>
  new File([bytes], "report.pdf", { type: "application/pdf", lastModified: 1_763_251_200_000 });

/** offsetBytes(length) with the byte at `offset` changed. */
function changedAt(length: number, offset: number) {
  const bytes = offsetBytes(length);
  bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;
  return bytes;
}

describe("fingerprintOf", () => {
  it("hashes bytes 0-65535 then 139264-204799 of a 200 KiB file", async () => {
    const bytes = offsetBytes(204_800);

    expect(await fingerprintOf(fileOf(bytes))).toBe(sha256(bytes.subarray(0, 65_536), bytes.subarray(139_264)));
  });

  it.each([
    { name: "1 byte", length: 1 },
    { name: "exactly 128 KiB", length: 131_072 },
  ])("hashes the whole file of $name", async ({ length }) => {
    const bytes = offsetBytes(length);

    expect(await fingerprintOf(fileOf(bytes))).toBe(sha256(bytes));
  });

  it("hashes only the edges of a file one byte over 128 KiB, leaving out byte 65536", async () => {
    const bytes = offsetBytes(131_073);

    expect(await fingerprintOf(fileOf(bytes))).toBe(sha256(bytes.subarray(0, 65_536), bytes.subarray(65_537)));
  });

  it("hashes nothing for an empty file", async () => {
    expect(await fingerprintOf(fileOf(new Uint8Array(0)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  // The heuristic the spec accepts: an edit between the edges is not seen.
  it.each([
    { name: "the last byte of the head (65535)", offset: 65_535, same: false },
    { name: "the last byte of the file", offset: 204_799, same: false },
    { name: "a byte between the edges (100000)", offset: 100_000, same: true },
  ])("tells two 200 KiB files apart by $name: same is $same", async ({ offset, same }) => {
    const original = await fingerprintOf(fileOf(offsetBytes(204_800)));
    const edited = await fingerprintOf(fileOf(changedAt(204_800, offset)));

    expect(edited === original).toBe(same);
  });

  it("is empty where crypto.subtle is missing, and the match then rests on the other facts", async () => {
    vi.stubGlobal("crypto", {});
    const file = fileOf(offsetBytes(1000));
    const record = { name: file.name, size: 1000, type: file.type, lastModified: file.lastModified, fingerprint: "" };

    expect({ fingerprint: await fingerprintOf(file), same: await isSameFile(record, file) }).toEqual({
      fingerprint: "",
      same: true,
    });
  });
});

describe("isSameFile", () => {
  const bytes = offsetBytes(204_800);
  const record = {
    name: "report.pdf",
    size: 204_800,
    type: "application/pdf",
    lastModified: 1_763_251_200_000,
    fingerprint: sha256(bytes.subarray(0, 65_536), bytes.subarray(139_264)),
  };

  it("accepts the file the record describes", async () => {
    expect(await isSameFile(record, fileOf(bytes))).toBe(true);
  });

  it.each([
    { name: "name", changed: { name: "Report.pdf" } },
    { name: "size", changed: { size: 204_801 } },
    { name: "type", changed: { type: "application/octet-stream" } },
    { name: "lastModified", changed: { lastModified: 1_763_251_200_001 } },
  ])("refuses a file whose $name differs from the record's", async ({ changed }) => {
    expect(await isSameFile({ ...record, ...changed }, fileOf(bytes))).toBe(false);
  });

  it("refuses a file whose first byte differs, every other fact equal", async () => {
    expect(await isSameFile(record, fileOf(changedAt(204_800, 0)))).toBe(false);
  });

  // A browser refuses to read a picked file that changed on disk since (NotReadableError).
  it("refuses, without rejecting, a file the browser can no longer read", async () => {
    class Unreadable extends File {
      override arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.reject(new DOMException("The file changed on disk.", "NotReadableError"));
      }
    }
    const bytes = offsetBytes(1000);
    const file = new Unreadable([bytes], "note.txt", { type: "text/plain", lastModified: 1 });
    // Every fact matches, so only the failed read can make the answer false.
    const facts = { name: "note.txt", size: 1000, type: "text/plain", lastModified: 1, fingerprint: sha256(bytes) };

    expect(await isSameFile(facts, file)).toBe(false);
  });
});
