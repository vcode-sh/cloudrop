import { GiB, MiB } from "../rules.ts";

/** A size in bytes, or a number with a unit: "512KB", "5MB", "1.5GB". KB, MB, GB and TB are binary (1 KB = 1024 bytes). */
export type Size = number | `${number}${"B" | "KB" | "MB" | "GB" | "TB" | "KiB" | "MiB" | "GiB" | "TiB"}`;

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  KiB: 1024,
  MB: MiB,
  MiB,
  GB: GiB,
  GiB,
  TB: 1024 * GiB,
  TiB: 1024 * GiB,
};

/** Bytes, or null when `size` is not a whole number of bytes, zero or more. */
export function parseSize(size: Size): number | null {
  const match = typeof size === "string" ? /^(\d+(?:\.\d+)?)(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/.exec(size) : null;
  const bytes = typeof size === "number" ? size : Number(match?.[1]) * (UNITS[match?.[2] ?? ""] ?? Number.NaN);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
