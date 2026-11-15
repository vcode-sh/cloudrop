import { describe, expect, it } from "vitest";
import { CloudropError } from "../errors.ts";
import {
  expiryProblem,
  invalidInput,
  keyProblem,
  metadataProblem,
  partNumberProblem,
  rangeProblem,
  sizeProblem,
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
  it("accepts ordinary keys, including Unicode", () => {
    expect(keyProblem("users/42/avatars/01JD3K.png")).toBeNull();
    expect(keyProblem("zdjęcia/łódź.jpg")).toBeNull();
    expect(keyProblem("emoji/\u{1F600}.png")).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["/leading", "slash"],
    ["a/../b", "segment"],
    ["a/./b", "segment"],
    ["..", "segment"],
    ["tab\there", "control"],
    ["c1\u0085here", "control"],
    ["del\u007fhere", "control"],
  ])("rejects %j", (key, fragment) => {
    expect(keyProblem(key)).toContain(fragment);
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

describe("metadataProblem", () => {
  it("accepts lowercase names and printable ASCII values", () => {
    expect(metadataProblem({ "cloudrop-id": "01JD3K" })).toBeNull();
    expect(metadataProblem(undefined)).toBeNull();
  });

  it("rejects uppercase names and non-ASCII values", () => {
    expect(metadataProblem({ Owner: "x" })).toContain("lowercase");
    expect(metadataProblem({ owner: "Łukasz" })).toContain("ASCII");
  });

  it("counts name plus value bytes against the 2 KiB limit", () => {
    expect(metadataProblem({ a: "x".repeat(2047) })).toBeNull();
    expect(metadataProblem({ a: "x".repeat(2048) })).toBe(
      "Metadata exceeds 2 KiB. Store large values in your database instead.",
    );
  });
});

describe("numeric checks", () => {
  const sizeMessage = "Size must be a whole number of bytes between 0 and 10.";
  const expiryMessage = "Expiry must be a whole number of seconds between 1 and 604800.";
  const partMessage = "Part number must be between 1 and 10000.";
  const rangeMessage = "The byte range must satisfy 0 <= start <= end.";

  it.each([
    { name: "a size at the limit", problem: sizeProblem(10, 10), expected: null },
    { name: "a size one byte over", problem: sizeProblem(11, 10), expected: sizeMessage },
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
