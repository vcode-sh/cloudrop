import { describe, expect, it } from "vitest";
import { CloudropError } from "../errors.ts";
import {
  checksumProblem,
  cursorProblem,
  expiryProblem,
  invalidInput,
  keyListProblem,
  keyProblem,
  limitProblem,
  objectOptionsProblem,
  partNumberProblem,
  partsProblem,
  prefixProblem,
  rangeProblem,
  sizeProblem,
  uploadIdProblem,
} from "./validate.ts";

describe("invalidInput", () => {
  it("builds a non-retryable INVALID_INPUT error with the message", () => {
    const error = invalidInput("Pass a key.");
    expect(error).toBeInstanceOf(CloudropError);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("Pass a key.");
    expect(error.retryable).toBe(false);
  });
});

describe("keyProblem", () => {
  it.each([
    ["an ordinary key", "users/42/avatars/01JD3K.png"],
    ["Unicode", "zdjęcia/łódź.jpg"],
    ["an emoji", "emoji/\u{1F600}.png"],
    ["a space", "my file.png"],
    ["dots inside a segment", "a..b"],
    ["a hidden file", ".hidden"],
    ["the last C1 neighbour, U+00A0", "nbsp\u00A0here"],
  ])("accepts %s", (_name, key) => {
    expect(keyProblem(key)).toBeNull();
  });

  it.each([
    ["empty", "", "The object key is empty. Pass a non-empty key."],
    ["a leading slash", "/leading", "The object key starts with a slash. Remove the leading slash."],
    ["a '..' in the middle", "a/../b", "The object key contains a '.' or '..' segment. Use plain path segments."],
    ["a '.' in the middle", "a/./b", "The object key contains a '.' or '..' segment. Use plain path segments."],
    ["a bare '..'", "..", "The object key contains a '.' or '..' segment. Use plain path segments."],
    ["a tab", "tab\there", "The object key contains control characters. Remove them."],
    ["U+0085", "c1\u0085here", "The object key contains control characters. Remove them."],
    ["U+009F", "c1\u009Fhere", "The object key contains control characters. Remove them."],
    ["DEL", "del\u007fhere", "The object key contains control characters. Remove them."],
    ["undefined", undefined, "The object key must be a string. Pass the key as text."],
    ["null", null, "The object key must be a string. Pass the key as text."],
    ["a number", 42, "The object key must be a string. Pass the key as text."],
  ])("rejects %s", (_name, key, message) => {
    expect(keyProblem(key as string)).toBe(message);
  });

  it("measures the key in UTF-8 bytes: 512 two-byte characters fit, 513 do not", () => {
    expect(keyProblem("é".repeat(512))).toBeNull();
    expect(keyProblem("é".repeat(513))).toBe("The object key is longer than 1024 bytes. Use a shorter key.");
  });

  it.each([
    ["a lone high surrogate", "a\uD800b"],
    ["a lone low surrogate", "a\uDC00b"],
  ])("rejects %s, which cannot be encoded into a URL", (_name, key) => {
    expect(keyProblem(key)).toBe(
      "The object key is not valid Unicode (it has a lone surrogate). Remove or replace that character.",
    );
  });
});

describe("objectOptionsProblem", () => {
  it.each([
    ["a printable ASCII type", { type: "text/plain; charset=utf-8" }, null],
    ["an RFC 8187 encoded filename", { disposition: "attachment; filename*=UTF-8''%C5%82%C3%B3d%C5%BA.txt" }, null],
    [
      "a non-ASCII content type",
      { type: "text/plain; name=é" },
      "The content type must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.",
    ],
    [
      "a line feed in the disposition",
      { disposition: "inline\nx-forged: 1" },
      "The content disposition must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.",
    ],
  ])("checks %s", (_name, options, expected) => {
    expect(objectOptionsProblem(options)).toBe(expected);
  });
});

describe("objectOptionsProblem metadata", () => {
  it.each([
    ["a lowercase name with a hyphen", { "cloudrop-id": "01JD3K" }],
    ["no metadata", undefined],
    ["an empty value", { a: "" }],
    ["the lowest printable value, a space inside", { a: "x y" }],
    ["the highest printable value, a tilde", { a: "~" }],
  ])("accepts %s", (_name, metadata) => {
    expect(objectOptionsProblem({ metadata })).toBeNull();
  });

  const ascii = 'Metadata value for "a" must be printable ASCII. Encode other text first.';
  it.each([
    ["a Latin-1 character, which Headers would send as one byte", "é"],
    ["a non-Latin-1 character", "Łukasz"],
    ["a carriage return", "a\rb"],
    ["a line feed", "a\nb"],
    ["a tab", "a\tb"],
    ["a leading tab", "\tb"],
    ["U+001F", "a\u001fb"],
    ["DEL", "a\u007fb"],
  ])("rejects a value with %s", (_name, value) => {
    expect(objectOptionsProblem({ metadata: { a: value } })).toBe(ascii);
  });

  it.each([
    ["a leading space", " x"],
    ["a trailing space", "x "],
    ["only a space", " "],
  ])("rejects a value with %s, which Headers would trim", (_name, value) => {
    expect(objectOptionsProblem({ metadata: { a: value } })).toBe(
      'Metadata value for "a" must not start or end with a space. Trim it.',
    );
  });

  it("rejects a value that is not a string", () => {
    expect(objectOptionsProblem({ metadata: { a: 5 as unknown as string } })).toBe(
      'Metadata value for "a" must be a string. Convert it first.',
    );
    expect(objectOptionsProblem({ metadata: { a: undefined as unknown as string } })).toBe(
      'Metadata value for "a" must be a string. Convert it first.',
    );
  });

  it("rejects an invalid name without echoing it", () => {
    expect(objectOptionsProblem({ metadata: { "Owner\nforged log line": "x" } })).toBe(
      "A metadata name may contain only lowercase letters, digits and hyphens. Rename it.",
    );
    expect(objectOptionsProblem({ metadata: { Owner: "x" } })).toBe(
      "A metadata name may contain only lowercase letters, digits and hyphens. Rename it.",
    );
  });

  it("counts name plus value bytes against the 2 KiB limit", () => {
    const message = "Metadata exceeds 2 KiB. Store large values in your database instead.";
    expect(objectOptionsProblem({ metadata: { a: "x".repeat(2047) } })).toBeNull();
    expect(objectOptionsProblem({ metadata: { a: "x".repeat(2048) } })).toBe(message);
  });

  it("adds up all entries, not just the largest", () => {
    expect(objectOptionsProblem({ metadata: { a: "x".repeat(1500), b: "x".repeat(1500) } })).toBe(
      "Metadata exceeds 2 KiB. Store large values in your database instead.",
    );
  });
});

describe("numeric checks", () => {
  const sizeMessage = "Size must be a whole number of bytes, zero or more.";
  const overMessage = "Size is over the limit of 10 bytes. Upload a smaller file or split it.";
  const expiryMessage = "Expiry must be a whole number of seconds between 1 and 604800.";
  const partMessage = "Part number must be between 1 and 10000.";
  const rangeMessage = "The byte range must satisfy 0 <= start <= end.";

  it.each([
    { name: "a size at the limit", problem: sizeProblem(10, 10), expected: null },
    { name: "a zero-byte size", problem: sizeProblem(0, 10), expected: null },
    { name: "a size one byte over", problem: sizeProblem(11, 10), expected: overMessage },
    {
      name: "a size over a GiB-scale limit",
      problem: sizeProblem(5 * 1024 ** 3 + 1, 5 * 1024 ** 3),
      expected: "Size is over the limit of 5 GiB. Upload a smaller file or split it.",
    },
    {
      name: "a size over a fractional limit",
      problem: sizeProblem(5 * 1024 ** 3, 5 * 1024 ** 3 - 5 * 1024 ** 2),
      expected: "Size is over the limit of 4.995 GiB. Upload a smaller file or split it.",
    },
    {
      name: "a size over a MiB-scale limit",
      problem: sizeProblem(6 * 1024 ** 2, 5 * 1024 ** 2),
      expected: "Size is over the limit of 5 MiB. Upload a smaller file or split it.",
    },
    {
      name: "a size over a KiB-scale limit",
      problem: sizeProblem(2049, 2048),
      expected: "Size is over the limit of 2 KiB. Upload a smaller file or split it.",
    },
    { name: "a fractional size", problem: sizeProblem(1.5, 10), expected: sizeMessage },
    { name: "a negative size", problem: sizeProblem(-1, 10), expected: sizeMessage },
    { name: "a NaN size", problem: sizeProblem(Number.NaN, 10), expected: sizeMessage },
    { name: "the 7-day expiry", problem: expiryProblem(604_800, 604_800), expected: null },
    { name: "a one-second expiry", problem: expiryProblem(1, 604_800), expected: null },
    { name: "one second over 7 days", problem: expiryProblem(604_801, 604_800), expected: expiryMessage },
    { name: "a zero expiry", problem: expiryProblem(0, 604_800), expected: expiryMessage },
    { name: "a NaN expiry", problem: expiryProblem(Number.NaN, 604_800), expected: expiryMessage },
    { name: "an infinite expiry", problem: expiryProblem(Number.POSITIVE_INFINITY, 604_800), expected: expiryMessage },
    { name: "a fractional expiry", problem: expiryProblem(1.5, 604_800), expected: expiryMessage },
    { name: "an expiry that prints as 1e+21", problem: expiryProblem(1e21, 604_800), expected: expiryMessage },
    { name: "part 10,000", problem: partNumberProblem(10_000, 10_000), expected: null },
    { name: "part 1", problem: partNumberProblem(1, 10_000), expected: null },
    { name: "part 10,001", problem: partNumberProblem(10_001, 10_000), expected: partMessage },
    { name: "part 0", problem: partNumberProblem(0, 10_000), expected: partMessage },
    { name: "a fractional part", problem: partNumberProblem(1.5, 10_000), expected: partMessage },
    { name: "a one-byte range", problem: rangeProblem(0, 0), expected: null },
    { name: "a reversed range", problem: rangeProblem(5, 4), expected: rangeMessage },
    { name: "a negative start", problem: rangeProblem(-1, 4), expected: rangeMessage },
    { name: "a fractional end", problem: rangeProblem(0, 1.5), expected: rangeMessage },
  ])("checks $name", ({ problem, expected }) => {
    expect(problem).toBe(expected);
  });
});

describe("request token checks", () => {
  const checksumMessage =
    'The CRC32C checksum must be the base64 of 4 bytes, such as "4waSgw==". Compute it from the exact bytes you send.';
  const uploadIdMessage = "The upload ID is empty or malformed. Pass the uploadId that createMultipart returned.";
  const cursorMessage = "The list cursor is empty or malformed. Pass the nextCursor of the previous page.";
  const prefixMessage =
    "The list prefix is not valid Unicode (it has a lone surrogate). Remove or replace that character.";
  const limitMessage = "The page size must be between 1 and 1000.";
  const partsMessage =
    "Pass at least one part, each with a part number between 1 and 10000 and the ETag the storage returned for it.";
  const keysMessage = "deleteMany takes an array of at most 1000 keys. Split longer lists into batches.";
  const parts = (...items: unknown[]) => items as { partNumber: number; etag: string }[];

  it.each([
    // CRC32C of "123456789" is 0xE3069283 (the published check value).
    { name: "the CRC32C check value", problem: checksumProblem("4waSgw=="), expected: null },
    { name: "no checksum", problem: checksumProblem(undefined), expected: null },
    { name: "a checksum without padding", problem: checksumProblem("4waSgw"), expected: checksumMessage },
    { name: "base64 of 6 bytes", problem: checksumProblem("4waSgwAA"), expected: checksumMessage },
    // A sixth character with set low bits encodes data that 4 bytes cannot hold.
    { name: "a non-canonical sixth character", problem: checksumProblem("4waSgx=="), expected: checksumMessage },
    { name: "a hex checksum", problem: checksumProblem("e3069283"), expected: checksumMessage },
    {
      name: "a numeric checksum",
      problem: checksumProblem(0xe3069283 as unknown as string),
      expected: checksumMessage,
    },
    { name: "an opaque upload ID", problem: uploadIdProblem("fake/upload+1=="), expected: null },
    { name: "an empty upload ID", problem: uploadIdProblem(""), expected: uploadIdMessage },
    { name: "an upload ID with a space", problem: uploadIdProblem("a b"), expected: uploadIdMessage },
    { name: "an upload ID with a line feed", problem: uploadIdProblem("a\nb"), expected: uploadIdMessage },
    { name: "a non-ASCII upload ID", problem: uploadIdProblem("é"), expected: uploadIdMessage },
    {
      name: "a missing upload ID",
      problem: uploadIdProblem(undefined as unknown as string),
      expected: uploadIdMessage,
    },
    { name: "an opaque cursor", problem: cursorProblem("1/a+b=="), expected: null },
    { name: "an empty cursor", problem: cursorProblem(""), expected: cursorMessage },
    { name: "a cursor with a space", problem: cursorProblem("a b"), expected: cursorMessage },
    { name: "an empty prefix", problem: prefixProblem(""), expected: null },
    { name: "a prefix with a space and a plus", problem: prefixProblem("a b+c/"), expected: null },
    { name: "a prefix with a lone surrogate", problem: prefixProblem("a\uDC00"), expected: prefixMessage },
    { name: "a numeric prefix", problem: prefixProblem(5 as unknown as string), expected: prefixMessage },
    { name: "a page of 1", problem: limitProblem(1), expected: null },
    { name: "a page of 1000", problem: limitProblem(1000), expected: null },
    { name: "a page of 0", problem: limitProblem(0), expected: limitMessage },
    { name: "a page of 1001", problem: limitProblem(1001), expected: limitMessage },
    { name: "a fractional page", problem: limitProblem(1.5), expected: limitMessage },
    { name: "one part", problem: partsProblem(parts({ partNumber: 1, etag: "a" }), 10_000), expected: null },
    { name: "no parts", problem: partsProblem([], 10_000), expected: partsMessage },
    { name: "part 0", problem: partsProblem(parts({ partNumber: 0, etag: "a" }), 10_000), expected: partsMessage },
    {
      name: "a part without an ETag",
      problem: partsProblem(parts({ partNumber: 1, etag: "" }), 10_000),
      expected: partsMessage,
    },
    { name: "a null part", problem: partsProblem(parts(null), 10_000), expected: partsMessage },
    { name: "parts that are not a list", problem: partsProblem(parts as never, 10_000), expected: partsMessage },
    { name: "1000 keys", problem: keyListProblem(Array.from({ length: 1000 }, () => "k")), expected: null },
    { name: "1001 keys", problem: keyListProblem(Array.from({ length: 1001 }, () => "k")), expected: keysMessage },
    { name: "one key as a string", problem: keyListProblem("a.txt" as unknown as string[]), expected: keysMessage },
  ])("checks $name", ({ problem, expected }) => {
    expect(problem).toBe(expected);
  });
});
