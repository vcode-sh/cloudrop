import { describe, expect, it } from "vitest";
import { parseSize, type Size } from "./size.ts";

describe("parseSize", () => {
  it.for<{ size: Size; bytes: number }>([
    { size: "5MB", bytes: 5_242_880 },
    { size: "5MiB", bytes: 5_242_880 },
    // A fraction that lands on whole bytes is fine.
    { size: "1.5KB", bytes: 1536 },
    { size: "0.0009765625KB", bytes: 1 },
    { size: "1GB", bytes: 1_073_741_824 },
    { size: "1TB", bytes: 1_099_511_627_776 },
    { size: "7B", bytes: 7 },
    { size: "1KiB", bytes: 1024 },
    { size: "1GiB", bytes: 1_073_741_824 },
    { size: "1TiB", bytes: 1_099_511_627_776 },
    { size: "8191.5TB", bytes: 9_006_649_498_927_104 },
    { size: "0B", bytes: 0 },
    { size: 1, bytes: 1 },
    // toBe compares with Object.is, so a negative zero would fail here.
    { size: -0, bytes: 0 },
  ])("reads $size as $bytes bytes", ({ size, bytes }) => {
    expect(parseSize(size)).toBe(bytes);
  });

  it.for<{ name: string; size: unknown }>([
    // 0.1 KB is 102.4 bytes: rounding it either way would silently change the limit.
    { name: "a fraction of a byte", size: "0.1KB" },
    // A double cannot hold these decimals, so multiplying floats would round them to whole bytes.
    // Exact values: 1536.0000000000001024 bytes and 4503709578533273.6 bytes.
    { name: "a fraction a double cannot see", size: "1.5000000000000001KB" },
    { name: "a fraction past the double's resolution", size: "4096.1TB" },
    { name: "a space before the unit", size: "5 MB" },
    { name: "a lowercase unit", size: "5mb" },
    { name: "a unit alone", size: "MB" },
    { name: "a negative number", size: -1 },
    { name: "a fractional number", size: 1.5 },
    { name: "NaN", size: Number.NaN },
    { name: "a size at 2^53 bytes", size: "9007199254740992B" },
    { name: "exponent notation", size: "1e3KB" },
    { name: "null from plain JavaScript", size: null },
  ])("rejects $name", ({ size }) => {
    expect(parseSize(size as Size)).toBeNull();
  });
});
