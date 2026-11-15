import { describe, expect, it } from "vitest";
import { contentDisposition, generatedKey, newFileId, normalizeKey, ulid } from "./key.ts";

describe("ulid", () => {
  // Expected values computed with Python from the ULID spec (128-bit integer, 26 base32 digits). The first time part
  // is the spec README's own example, 01ARYZ6S41 for 1469918176385.
  it.for([
    { nowMs: 1_469_918_176_385, random: new Uint8Array(10), id: "01ARYZ6S410000000000000000" },
    {
      nowMs: 1_763_251_200_000,
      random: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      id: "01KA4ZC800041061050R3GG28A",
    },
    // The largest time a ULID holds, 2^48 - 1, with every random bit set.
    { nowMs: 281_474_976_710_655, random: new Uint8Array(10).fill(0xff), id: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ" },
  ])("encodes $nowMs as $id", ({ nowMs, random, id }) => {
    expect(ulid(nowMs, random)).toBe(id);
  });

  it("makes ids that sort by creation time", () => {
    expect(ulid(1000, new Uint8Array(10).fill(0xff)) < ulid(1001, new Uint8Array(10))).toBe(true);
  });

  it("draws fresh randomness for every id", () => {
    expect(newFileId()).not.toBe(newFileId());
  });
});

describe("generatedKey", () => {
  it.for([
    { prefix: "users/42/avatars", key: "users/42/avatars/01ARYZ6S410000000000000000.png" },
    { prefix: "users/42/avatars//", key: "users/42/avatars/01ARYZ6S410000000000000000.png" },
    { prefix: "", key: "01ARYZ6S410000000000000000.png" },
  ])("joins the prefix $prefix and the id", ({ prefix, key }) => {
    expect(generatedKey(prefix, "01ARYZ6S410000000000000000", ".png")).toBe(key);
  });
});

describe("normalizeKey", () => {
  it("normalizes to NFC, so the same visible name always maps to the same key", () => {
    // "e" + U+0301 COMBINING ACUTE ACCENT becomes U+00E9.
    expect(normalizeKey("café/a.txt")).toEqual({ key: "café/a.txt" });
  });

  it.for<{ name: string; key: unknown; problem: string }>([
    {
      name: "a .. segment",
      key: "users/../admin/a.png",
      problem: "The object key contains a '.' or '..' segment. Use plain path segments.",
    },
    {
      name: "a . segment",
      key: "users/./a.png",
      problem: "The object key contains a '.' or '..' segment. Use plain path segments.",
    },
    {
      name: "a leading slash",
      key: "/users/a.png",
      problem: "The object key starts with a slash. Remove the leading slash.",
    },
    {
      name: "a doubled slash",
      key: "users//a.png",
      problem: "The object key has an empty segment (a doubled or trailing slash). Remove it.",
    },
    {
      name: "a trailing slash",
      key: "users/",
      problem: "The object key has an empty segment (a doubled or trailing slash). Remove it.",
    },
    { name: "a newline", key: "users/a\n.png", problem: "The object key contains control characters. Remove them." },
    {
      name: "a C1 control character",
      key: "users/a\u0085.png",
      problem: "The object key contains control characters. Remove them.",
    },
    // 512 two-byte characters plus one byte: 1025 bytes, although only 513 UTF-16 code units.
    {
      name: "1025 UTF-8 bytes",
      key: `${"é".repeat(512)}a`,
      problem: "The object key is longer than 1024 bytes. Use a shorter key.",
    },
    {
      name: "a lone surrogate",
      key: "a\ud800",
      problem: "The object key is not valid Unicode (it has a lone surrogate). Remove or replace that character.",
    },
    { name: "a number", key: 42, problem: "The object key must be a string." },
  ])("refuses $name", ({ key, problem }) => {
    expect(normalizeKey(key)).toEqual({ problem });
  });

  it("accepts exactly 1024 UTF-8 bytes", () => {
    const key = "é".repeat(512);
    expect(normalizeKey(key)).toEqual({ key });
  });
});

describe("contentDisposition", () => {
  it.for([
    { type: "image/png", disposition: "inline" },
    { type: "video/mp4", disposition: "inline" },
    { type: "audio/mpeg", disposition: "inline" },
    // Each of these runs script when a browser opens it from the bucket's domain.
    { type: "image/svg+xml", disposition: "attachment" },
    { type: "text/html", disposition: "attachment" },
    { type: "application/xml", disposition: "attachment" },
    { type: "application/pdf", disposition: "attachment" },
  ])("serves $type as $disposition", ({ type, disposition }) => {
    expect(contentDisposition(type, "f.bin")).toBe(`${disposition}; filename="f.bin"; filename*=UTF-8''f.bin`);
  });

  it("percent-encodes the name in filename* and replaces what the quoted fallback cannot carry", () => {
    expect(contentDisposition("image/png", 'zdjęcie "1"\\.png')).toBe(
      `inline; filename="zdj_cie _1__.png"; filename*=UTF-8''zdj%C4%99cie%20%221%22%5C.png`,
    );
  });

  it("percent-encodes ' ( ) *, which RFC 5987 does not allow raw, and ! as encodeURIComponent's other survivor", () => {
    expect(contentDisposition("text/plain", "it's (final)*!.txt")).toBe(
      `attachment; filename="it's (final)*!.txt"; filename*=UTF-8''it%27s%20%28final%29%2A%21.txt`,
    );
  });
});
