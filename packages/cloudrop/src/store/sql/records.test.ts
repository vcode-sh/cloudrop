// The decoder every driver's numbers and times pass through. The database lane covers what node-postgres, postgres.js
// and node:sqlite return; these rows cover the shapes only other drivers produce (Prisma's BigInt and Decimal, ISO
// text) and the values that must be refused rather than rounded.

import { describe, expect, test } from "vitest";
import { toDate, toSafeInteger } from "./records.ts";

describe("toSafeInteger", () => {
  test.each([
    { name: "a number", value: 42, expected: 42 },
    { name: "decimal text at 2^53 - 1", value: "9007199254740991", expected: 9007199254740991 },
    { name: "a bigint at 2^53 - 1", value: 9007199254740991n, expected: 9007199254740991 },
    { name: "a decimal-like object", value: { toString: () => "1024" }, expected: 1024 },
    { name: "negative text", value: "-3", expected: -3 },
  ])("reads $name", ({ value, expected }) => {
    expect(toSafeInteger(value, "size")).toBe(expected);
  });

  test.each([
    { name: "decimal text past 2^53", value: "9007199254740993", returned: '"9007199254740993"' },
    { name: "a bigint past 2^53", value: 9007199254740992n, returned: "bigint 9007199254740992" },
    { name: "a fraction", value: 1.5, returned: "number 1.5" },
    { name: "fractional text", value: "1.5", returned: '"1.5"' },
    { name: "a decimal-like fraction", value: { toString: () => "2.50" }, returned: "object 2.50" },
    { name: "null", value: null, returned: "object null" },
  ])("refuses $name, naming the value and the column", ({ value, returned }) => {
    expect(() => toSafeInteger(value, "reserved_bytes")).toThrow(
      new Error(`The database returned ${returned} for reserved_bytes; expected a whole number up to 2^53.`),
    );
  });
});

describe("toDate", () => {
  const time = new Date("2026-11-17T10:20:30.123Z");

  test.each([
    { name: "a Date", value: new Date(time) },
    { name: "ISO text", value: "2026-11-17T10:20:30.123Z" },
    { name: "milliseconds", value: time.getTime() },
    { name: "milliseconds as text", value: String(time.getTime()) },
  ])("reads $name", ({ value }) => {
    expect(toDate(value, "created_at")).toEqual(time);
  });

  test("refuses text that is not a time", () => {
    expect(() => toDate("yesterday", "created_at")).toThrow(
      new Error('The database returned "yesterday" for created_at; expected a time.'),
    );
  });
});
