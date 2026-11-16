// How a file is cut into parts, apart from the planner's storage rules (plan.ts): the browser client needs only these
// two, and importing them from plan.ts would ship the rules and size constants it never uses.

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
