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

/**
 * Equal parts of 8, 16, 32… MiB: the smallest size that keeps the count within the part limit. Every part except the
 * last has exactly `partSize` bytes, which satisfies R2's equal-part rule by construction (spec §5.1).
 */
export function planParts(size: number, rules: StorageRules): MultipartPlan {
  assertStorable(size, rules);
  let partSize = Math.max(FIRST_PART_SIZE, rules.minPartSize);
  while (Math.ceil(size / partSize) > rules.maxParts) partSize *= 2;
  const partCount = Math.max(1, Math.ceil(size / partSize));
  return { kind: "multipart", size, partSize, partCount, lastPartSize: size - (partCount - 1) * partSize };
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
