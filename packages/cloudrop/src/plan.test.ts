import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planUpload } from "./plan.ts";
import { GiB, MiB, R2_RULES, S3_RULES } from "./rules.ts";

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

  it("keeps 8 MiB parts up to exactly 10,000 parts and doubles one byte later", () => {
    expect(planUpload(80_000 * MiB, R2_RULES)).toEqual({
      kind: "multipart",
      size: 80_000 * MiB,
      partSize: 8 * MiB,
      partCount: 10_000,
      lastPartSize: 8 * MiB,
    });
    expect(planUpload(80_000 * MiB + 1, R2_RULES)).toEqual({
      kind: "multipart",
      size: 80_000 * MiB + 1,
      partSize: 16 * MiB,
      partCount: 5001,
      lastPartSize: 1,
    });
  });

  it("doubles the part size until the file fits in 10,000 parts", () => {
    expect(planUpload(100 * GiB, R2_RULES)).toMatchObject({ partSize: 16 * MiB, partCount: 6400 });
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

  it("accepts the largest object each storage allows and plans it within the part limit", () => {
    for (const rules of [R2_RULES, S3_RULES]) {
      const plan = planUpload(rules.maxObjectSize, rules);
      expect(plan).toMatchObject({ kind: "multipart", size: rules.maxObjectSize });
      if (plan.kind === "multipart") expect(plan.partCount).toBeLessThanOrEqual(rules.maxParts);
    }
  });

  it.each([
    {
      name: "one byte over the R2 object limit",
      size: R2_RULES.maxObjectSize + 1,
      message: "exceeds the storage limit",
    },
    { name: "a negative size", size: -1, message: "whole number of bytes" },
    { name: "a fractional size", size: 1.5, message: "whole number of bytes" },
  ])("rejects $name", ({ size, message }) => {
    expect(() => planUpload(size, R2_RULES)).toThrow(
      expect.objectContaining({ name: "RangeError", message: expect.stringContaining(message) }),
    );
  });

  it("always produces the smallest plan R2 accepts", () => {
    const anySize = fc.oneof(
      fc.integer({ min: 0, max: 128 * MiB }),
      fc.integer({ min: 0, max: 2 ** 31 - 1 }).map((n) => n * 40), // up to ~80 GiB: the 8 and 16 MiB bands
      fc.bigInt({ min: 0n, max: BigInt(R2_RULES.maxObjectSize) }).map(Number),
    );
    fc.assert(
      fc.property(anySize, (size) => {
        const plan = planUpload(size, R2_RULES);
        if (plan.kind === "single") return size <= 64 * MiB;
        const isPowerOfTwoTimes8MiB = Number.isInteger(Math.log2(plan.partSize / (8 * MiB)));
        const halfWouldFit = plan.partSize === 8 * MiB || Math.ceil(size / (plan.partSize / 2)) > R2_RULES.maxParts;
        return (
          size > 64 * MiB &&
          isPowerOfTwoTimes8MiB &&
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
