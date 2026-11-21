import { describe, expect, it } from "vitest";
import {
  bodyProblem,
  checksumProblem,
  cursorProblem,
  expiryProblem,
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
    ["U+009F", "c1\u009Fhere", "The object key contains control characters. Remove them."],
    ["DEL", "del\u007fhere", "The object key contains control characters. Remove them."],
    ["undefined", undefined, "The object key must be a string. Pass the key as text."],
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
      'The content type must be printable ASCII, such as "text/plain; charset=utf-8".',
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
    { name: "the 7-day expiry", problem: expiryProblem(604_800, 604_800), expected: null },
    { name: "a one-second expiry", problem: expiryProblem(1, 604_800), expected: null },
    { name: "one second over 7 days", problem: expiryProblem(604_801, 604_800), expected: expiryMessage },
    { name: "a zero expiry", problem: expiryProblem(0, 604_800), expected: expiryMessage },
    { name: "a NaN expiry", problem: expiryProblem(Number.NaN, 604_800), expected: expiryMessage },
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
    { name: "an opaque upload ID", problem: uploadIdProblem("fake/upload+1=="), expected: null },
    { name: "an empty upload ID", problem: uploadIdProblem(""), expected: uploadIdMessage },
    { name: "an upload ID with a space", problem: uploadIdProblem("a b"), expected: uploadIdMessage },
    { name: "a non-ASCII upload ID", problem: uploadIdProblem("é"), expected: uploadIdMessage },
    { name: "an opaque cursor", problem: cursorProblem("1/a+b=="), expected: null },
    { name: "an empty cursor", problem: cursorProblem(""), expected: cursorMessage },
    { name: "a cursor with a space", problem: cursorProblem("a b"), expected: cursorMessage },
    { name: "an empty prefix", problem: prefixProblem(""), expected: null },
    { name: "a prefix with a space and a plus", problem: prefixProblem("a b+c/"), expected: null },
    { name: "a prefix with a lone surrogate", problem: prefixProblem("a\uDC00"), expected: prefixMessage },
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
    { name: "1001 keys", problem: keyListProblem(Array.from({ length: 1001 }, () => "k")), expected: null },
  ])("checks $name", ({ problem, expected }) => {
    expect(problem).toBe(expected);
  });
});

// A JavaScript caller can pass anything: each check answers its message, never a TypeError and never "no problem".
describe("values of the wrong type", () => {
  const checksum = { toString: () => "4waSgw==" };
  const notText = [5, ["4waSgw=="], checksum, null, true];
  const notNumber = ["5", [5], { valueOf: () => 5 }, null, true];
  const notList = ["a", 5, { length: 1 }, null];
  const printable = (field: string) => (value: never) => objectOptionsProblem({ [field]: value });
  const typeMessage = 'The content type must be printable ASCII, such as "text/plain; charset=utf-8".';
  const dispositionMessage =
    "The content disposition must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.";
  const metadataMessage = 'Metadata must be an object of names and text values, such as { "cloudrop-id": "f1" }.';
  const partsMessage =
    "Pass at least one part, each with a part number between 1 and 10 and the ETag the storage returned for it.";

  it.each<[string, (value: never) => string | null, unknown[], string]>([
    ["a key", keyProblem, notText, "The object key must be a string. Pass the key as text."],
    [
      "a checksum",
      checksumProblem,
      notText,
      'The CRC32C checksum must be the base64 of 4 bytes, such as "4waSgw==". Compute it from the exact bytes you send.',
    ],
    [
      "an upload ID",
      uploadIdProblem,
      notText,
      "The upload ID is empty or malformed. Pass the uploadId that createMultipart returned.",
    ],
    [
      "a cursor",
      cursorProblem,
      notText,
      "The list cursor is empty or malformed. Pass the nextCursor of the previous page.",
    ],
    ["a prefix", prefixProblem, notText, 'The list prefix must be a string. Pass "" to list every object.'],
    ["a content type", printable("type"), notText, typeMessage],
    ["a content disposition", printable("disposition"), notText, dispositionMessage],
    ["metadata", printable("metadata"), [5, "ab", ["x"], null, new Map([["a", "x"]])], metadataMessage],
    [
      "a body",
      bodyProblem,
      [5, ["x"], { length: 1 }, null, undefined],
      "The body must be a Uint8Array, an ArrayBuffer, a string or a Blob.",
    ],
    ["a page size", limitProblem, notNumber, "The page size must be between 1 and 1000."],
    ["a size", (value) => sizeProblem(value, 10), notNumber, "Size must be a whole number of bytes, zero or more."],
    [
      "an expiry",
      (value) => expiryProblem(value, 10),
      notNumber,
      "Expiry must be a whole number of seconds between 1 and 10.",
    ],
    ["a part number", (value) => partNumberProblem(value, 10), notNumber, "Part number must be between 1 and 10."],
    ["a range start", (value) => rangeProblem(value, 9), notNumber, "The byte range must satisfy 0 <= start <= end."],
    ["a range end", (value) => rangeProblem(0, value), notNumber, "The byte range must satisfy 0 <= start <= end."],
    ["a part list", (value) => partsProblem(value, 10), notList, partsMessage],
    ["a part", (value) => partsProblem([value], 10), [5, "a", ["a"], null], partsMessage],
    ["a key list", keyListProblem, notList, "deleteMany takes an array of keys. Wrap a single key in an array."],
  ])("answers the message for %s of any other type", (_name, check, values, message) => {
    expect(values.map((value) => check(value as never))).toEqual(values.map(() => message));
  });
});
