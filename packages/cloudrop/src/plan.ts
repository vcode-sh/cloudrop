import { MiB, type StorageRules } from "./rules.ts";

export type MultipartPlan = {
  kind: "multipart";
  size: number;
  partSize: number;
  partCount: number;
  lastPartSize: number;
};
export type UploadPlan = { kind: "single"; size: number } | MultipartPlan;

const DEFAULT_MULTIPART_THRESHOLD: number = 64 * MiB;
const FIRST_PART_SIZE = 8 * MiB;

function assertStorable(size: number, rules: StorageRules): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`File size must be a whole number of bytes, got ${size}.`);
  }
  if (size > rules.maxObjectSize) {
    throw new RangeError(`File size ${size} exceeds the storage limit of ${rules.maxObjectSize} bytes.`);
  }
}

/** How many parts of `partSize` bytes a file of `size` bytes needs. */
export const countParts = (size: number, partSize: number): number => Math.ceil(size / partSize);

/**
 * The size of part `partNumber` (from 1): `partSize` for every part but the last, which holds the rest. Equal parts
 * satisfy R2's equal-part rule by construction (spec §5.1).
 */
export function sizeOfPart(size: number, partSize: number, partNumber: number): number {
  const count = countParts(size, partSize);
  return partNumber < count ? partSize : size - (count - 1) * partSize;
}

/**
 * Equal parts of 8, 16, 32… MiB: the smallest size that keeps the count within the part limit. Every part except the
 * last has exactly `partSize` bytes, which satisfies R2's equal-part rule by construction (spec §5.1).
 */
export function planParts(size: number, rules: StorageRules): MultipartPlan {
  assertStorable(size, rules);
  if (size === 0) throw new RangeError("An empty file has no parts. Upload it with a single PUT.");
  let partSize = Math.max(FIRST_PART_SIZE, rules.minPartSize);
  // The cap is safe: maxObjectSize <= maxParts * maxPartSize, so maxPartSize parts always fit the count limit.
  while (countParts(size, partSize) > rules.maxParts) partSize = Math.min(partSize * 2, rules.maxPartSize);
  const partCount = countParts(size, partSize);
  return { kind: "multipart", size, partSize, partCount, lastPartSize: sizeOfPart(size, partSize, partCount) };
}

export function planUpload(
  size: number,
  rules: StorageRules,
  options: { multipartThreshold?: number } = {},
): UploadPlan {
  assertStorable(size, rules);
  const threshold = Math.min(options.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD, rules.maxSinglePutSize);
  if (size === 0 || size <= threshold) return { kind: "single", size };
  return planParts(size, rules);
}
