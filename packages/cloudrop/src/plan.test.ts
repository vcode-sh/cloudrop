import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { countParts, planParts, planUpload, sizeOfPart } from "./plan.ts";
import { GiB, MiB, R2_RULES, S3_RULES } from "./rules.ts";

const TiB = 1024 * GiB;

describe("countParts and sizeOfPart", () => {
  it("give every part but the last the part size and the last part the rest", () => {
    // 64 MiB + 1 byte in 8 MiB parts: eight full parts and a ninth of one byte.
    expect(countParts(64 * MiB + 1, 8 * MiB)).toBe(9);
    expect(sizeOfPart(64 * MiB + 1, 8 * MiB, 8)).toBe(8 * MiB);
    expect(sizeOfPart(64 * MiB + 1, 8 * MiB, 9)).toBe(1);
  });

  it("give a full last part when the size is a whole number of parts", () => {
    expect(countParts(80 * MiB, 8 * MiB)).toBe(10);
    expect(sizeOfPart(80 * MiB, 8 * MiB, 10)).toBe(8 * MiB);
  });

  it("find the part count and last part of any file built from full parts and a non-empty rest", () => {
    // The file is built from its answer: count - 1 full parts, then a last part of 1 to partSize bytes.
    const files = fc.integer({ min: 1, max: 5 * GiB }).chain((partSize) =>
      fc.record({
        partSize: fc.constant(partSize),
        count: fc.integer({ min: 1, max: 10_000 }),
        last: fc.integer({ min: 1, max: partSize }),
      }),
    );
    fc.assert(
      fc.property(files, ({ partSize, count, last }) => {
        const size = (count - 1) * partSize + last;
        return (
          countParts(size, partSize) === count &&
          sizeOfPart(size, partSize, count) === last &&
          sizeOfPart(size, partSize, 1) === Math.min(size, partSize)
        );
      }),
    );
  });
});

describe("planUpload", () => {
  it("uses one PUT up to the multipart threshold", () => {
    expect(planUpload(64 * MiB, R2_RULES)).toEqual({ kind: "single", size: 64 * MiB });
    expect(planUpload(0, R2_RULES)).toEqual({ kind: "single", size: 0 });
  });

  it("splits larger files into 8 MiB parts with a smaller last part", () => {
    expect(planUpload(64 * MiB + 1, R2_RULES)).toEqual({
      kind: "multipart",
      size: 64 * MiB + 1,
      partSize: 8 * MiB,
      partCount: 9,
      lastPartSize: 1,
    });
  });

  // Files of 256 MiB or more start at 16 MiB parts: measured faster on live R2 (r2-spike-findings.md, "Part size,
  // 2026-11-16"). Below that they keep 8 MiB.
  it("keeps 8 MiB parts one byte below 256 MiB and starts at 16 MiB parts from exactly 256 MiB", () => {
    expect(planUpload(256 * MiB - 1, R2_RULES)).toEqual({
      kind: "multipart",
      size: 256 * MiB - 1,
      partSize: 8 * MiB,
      partCount: 32,
      lastPartSize: 8 * MiB - 1,
    });
    expect(planUpload(256 * MiB, R2_RULES)).toEqual({
      kind: "multipart",
      size: 256 * MiB,
      partSize: 16 * MiB,
      partCount: 16,
      lastPartSize: 16 * MiB,
    });
  });

  it("keeps 16 MiB parts up to exactly 10,000 parts (156.25 GiB) and doubles one byte later", () => {
    expect(planUpload(160_000 * MiB, R2_RULES)).toEqual({
      kind: "multipart",
      size: 160_000 * MiB,
      partSize: 16 * MiB,
      partCount: 10_000,
      lastPartSize: 16 * MiB,
    });
    expect(planUpload(160_000 * MiB + 1, R2_RULES)).toEqual({
      kind: "multipart",
      size: 160_000 * MiB + 1,
      partSize: 32 * MiB,
      partCount: 5001,
      lastPartSize: 1,
    });
  });

  it("doubles up to 1 GiB parts for R2's largest object, well under its 4.995 GiB part limit", () => {
    // 5 TiB - 5 GiB = 5,237,760 MiB: 512 MiB parts would need 10,230 parts, 1 GiB parts need exactly 5,115.
    expect(planUpload(R2_RULES.maxObjectSize, R2_RULES)).toEqual({
      kind: "multipart",
      size: R2_RULES.maxObjectSize,
      partSize: GiB,
      partCount: 5115,
      lastPartSize: GiB,
    });
  });

  it("honours a custom threshold", () => {
    expect(planUpload(10 * MiB, R2_RULES, { multipartThreshold: 0 })).toEqual({
      kind: "multipart",
      size: 10 * MiB,
      partSize: 8 * MiB,
      partCount: 2,
      lastPartSize: 2 * MiB,
    });
    expect(planUpload(0, R2_RULES, { multipartThreshold: 0 })).toEqual({ kind: "single", size: 0 });
  });

  it("never lets a threshold above the single-PUT limit send a file the storage cannot take in one request", () => {
    const size = R2_RULES.maxSinglePutSize + 1;
    expect(planUpload(size, R2_RULES, { multipartThreshold: size * 2 })).toMatchObject({ kind: "multipart" });
    expect(planUpload(R2_RULES.maxSinglePutSize, R2_RULES, { multipartThreshold: size * 2 })).toEqual({
      kind: "single",
      size: R2_RULES.maxSinglePutSize,
    });
  });

  it("plans the S3 maximum object as 10,000 parts of exactly 5 GiB", () => {
    expect(S3_RULES.maxObjectSize).toBe(10_000 * 5 * GiB);
    expect(planUpload(S3_RULES.maxObjectSize, S3_RULES)).toEqual({
      kind: "multipart",
      size: S3_RULES.maxObjectSize,
      partSize: 5 * GiB,
      partCount: 10_000,
      lastPartSize: 5 * GiB,
    });
    expect(() => planUpload(S3_RULES.maxObjectSize + 1, S3_RULES)).toThrow(
      expect.objectContaining({ name: "RangeError", message: expect.stringContaining("exceeds the storage limit") }),
    );
  });

  it("caps S3 parts at 5 GiB once doubling would pass it (above 4 GiB x 10,000 = 40,000 GiB)", () => {
    // 40 TiB = 40,960 GiB = exactly 8,192 parts of 5 GiB; one byte more adds a 1-byte part.
    expect(planUpload(40 * TiB + 1, S3_RULES)).toEqual({
      kind: "multipart",
      size: 40 * TiB + 1,
      partSize: 5 * GiB,
      partCount: 8193,
      lastPartSize: 1,
    });
    // 4 GiB parts still fit 40,000 GiB exactly: no cap yet.
    expect(planUpload(40_000 * GiB, S3_RULES)).toMatchObject({ partSize: 4 * GiB, partCount: 10_000 });
    expect(planUpload(40_000 * GiB + 1, S3_RULES)).toMatchObject({ partSize: 5 * GiB, partCount: 8001 });
  });

  it("refuses to plan parts for an empty file", () => {
    expect(() => planParts(0, R2_RULES)).toThrow(
      expect.objectContaining({ name: "RangeError", message: expect.stringContaining("empty") }),
    );
  });

  it("keeps S3 plans within the part size and part count limits", () => {
    const s3Size = fc.oneof(
      fc.bigInt({ min: BigInt(64 * MiB + 1), max: BigInt(S3_RULES.maxObjectSize) }).map(Number),
      fc.integer({ min: 0, max: 100 }).map((n) => S3_RULES.maxObjectSize - n),
    );
    fc.assert(
      fc.property(s3Size, (size) => {
        const plan = planUpload(size, S3_RULES);
        return (
          plan.kind === "multipart" &&
          plan.partSize <= S3_RULES.maxPartSize &&
          plan.partCount <= S3_RULES.maxParts &&
          plan.lastPartSize > 0 &&
          plan.lastPartSize <= plan.partSize &&
          (plan.partCount - 1) * plan.partSize + plan.lastPartSize === size
        );
      }),
    );
  });

  it.each([
    {
      name: "one byte over the R2 object limit",
      size: R2_RULES.maxObjectSize + 1,
      message: "exceeds the storage limit",
    },
    { name: "a negative size", size: -1, message: "whole number of bytes" },
    { name: "a fractional size", size: 1.5, message: "whole number of bytes" },
    { name: "NaN", size: Number.NaN, message: "whole number of bytes" },
    { name: "Infinity", size: Number.POSITIVE_INFINITY, message: "whole number of bytes" },
  ])("rejects $name", ({ size, message }) => {
    expect(() => planUpload(size, R2_RULES)).toThrow(
      expect.objectContaining({ name: "RangeError", message: expect.stringContaining(message) }),
    );
  });

  it("always produces the smallest plan R2 accepts", () => {
    const anySize = fc.oneof(
      fc.integer({ min: 0, max: 512 * MiB }), // single PUT, 8 MiB parts, and 16 MiB parts from 256 MiB
      fc.integer({ min: -64, max: 64 }).map((n) => 256 * MiB + n),
      fc.integer({ min: 0, max: 2 ** 31 - 1 }).map((n) => n * 80), // up to ~160 GiB: the 16 and 32 MiB bands
      fc.bigInt({ min: 0n, max: BigInt(R2_RULES.maxObjectSize) }).map(Number),
    );
    fc.assert(
      fc.property(anySize, (size) => {
        const plan = planUpload(size, R2_RULES);
        if (plan.kind === "single") return size <= 64 * MiB;
        const firstPartSize = size < 256 * MiB ? 8 * MiB : 16 * MiB;
        const isPowerOfTwoTimesFirst = Number.isInteger(Math.log2(plan.partSize / firstPartSize));
        const halfWouldFit =
          plan.partSize === firstPartSize || Math.ceil(size / (plan.partSize / 2)) > R2_RULES.maxParts;
        return (
          size > 64 * MiB &&
          plan.partSize >= firstPartSize &&
          isPowerOfTwoTimesFirst &&
          halfWouldFit &&
          plan.partSize <= R2_RULES.maxPartSize &&
          plan.partCount <= R2_RULES.maxParts &&
          plan.lastPartSize > 0 &&
          plan.lastPartSize <= plan.partSize &&
          (plan.partCount - 1) * plan.partSize + plan.lastPartSize === size
        );
      }),
    );
  });
});
