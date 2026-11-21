import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { crc32c, crc32cBase64 } from "./checksum.ts";

const text = (value: string) => new TextEncoder().encode(value);

// Independent oracle: the bit-at-a-time definition of CRC32C (reflected polynomial 0x82f63b78), no tables.
function bitwiseCrc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return ~crc >>> 0;
}

describe("crc32c", () => {
  it.each([
    { name: "123456789", bytes: text("123456789"), crc: 0xe3069283, base64: "4waSgw==" },
    { name: "32 zero bytes", bytes: new Uint8Array(32), crc: 0x8a9136aa, base64: "ipE2qg==" },
    { name: "32 bytes of 0xFF", bytes: new Uint8Array(32).fill(0xff), crc: 0x62a8ab43, base64: "YqirQw==" },
    {
      name: "bytes 0 to 31",
      bytes: Uint8Array.from({ length: 32 }, (_, index) => index),
      crc: 0x46dd794e,
      base64: "Rt15Tg==",
    },
    {
      name: "bytes 31 to 0",
      bytes: Uint8Array.from({ length: 32 }, (_, index) => 31 - index),
      crc: 0x113fdb5c,
      base64: "ET/bXA==",
    },
  ])("matches the published check value for $name", ({ bytes, crc, base64 }) => {
    expect(crc32c(bytes)).toBe(crc);
    expect(crc32cBase64(bytes)).toBe(base64);
  });

  it("is zero for empty input", () => {
    expect(crc32c(new Uint8Array())).toBe(0);
    expect(crc32cBase64(new Uint8Array())).toBe("AAAAAA==");
  });

  it("continues across chunks", () => {
    expect(crc32c(text("6789"), crc32c(text("12345")))).toBe(0xe3069283);
  });

  it("matches the bitwise definition for every length around the 8-byte block size", () => {
    const bytes = Uint8Array.from({ length: 40 }, (_, index) => (index * 37 + 11) & 0xff);
    const lengths = Array.from({ length: bytes.length + 1 }, (_, length) => length);
    const wrong = lengths.filter((length) => {
      const prefix = bytes.subarray(0, length);
      return crc32c(prefix) !== bitwiseCrc32c(prefix);
    });
    expect(wrong).toEqual([]);
  });

  it("matches the bitwise definition and is split-invariant for arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), fc.nat(300), (bytes, rawSplit) => {
        const split = Math.min(rawSplit, bytes.length);
        const expected = bitwiseCrc32c(bytes);
        expect(crc32c(bytes)).toBe(expected);
        expect(crc32c(bytes.subarray(split), crc32c(bytes.subarray(0, split)))).toBe(expected);
      }),
    );
  });

  it("reads only the viewed window of a larger buffer", () => {
    const backing = new Uint8Array(32).fill(0xaa);
    backing.set(text("123456789"), 11);
    expect(crc32c(backing.subarray(11, 20))).toBe(0xe3069283);
  });
});
