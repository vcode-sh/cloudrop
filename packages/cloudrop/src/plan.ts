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
// Measured on live R2 (docs/research/r2-spike-findings.md, "Part size, 2026-11-16"): for a 256 MiB file, 16 MiB parts
// beat 8 MiB by 26 % and 14 % in Node and by 56 % and 21 % in the browser at 4 and 8 PUTs at a time. Smaller files
// keep 8 MiB because sizes below 256 MiB were not measured.
const LARGE_FILE_SIZE = 256 * MiB;
const LARGE_FIRST_PART_SIZE = 16 * MiB;

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
 * Equal parts of 8 MiB, or 16 MiB from 256 MiB up, doubled until the count fits the part limit. Every part except the
 * last has exactly `partSize` bytes, which satisfies R2's equal-part rule by construction (spec §5.1).
 */
export function planParts(size: number, rules: StorageRules): MultipartPlan {
  assertStorable(size, rules);
  if (size === 0) throw new RangeError("An empty file has no parts. Upload it with a single PUT.");
  let partSize = Math.max(size >= LARGE_FILE_SIZE ? LARGE_FIRST_PART_SIZE : FIRST_PART_SIZE, rules.minPartSize);
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
