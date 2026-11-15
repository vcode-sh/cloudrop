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

const SIZE_STRING = /^(\d+)(?:\.(\d+))?(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/;

/** Bytes, or null when `size` is not a whole number of bytes, zero or more. */
export function parseSize(size: Size): number | null {
  // Normalize negative zero so returned and serialized limits agree.
  if (typeof size === "number") return Number.isSafeInteger(size) && size >= 0 ? size + 0 : null;
  const match = typeof size === "string" ? SIZE_STRING.exec(size) : null;
  if (match === null) return null;
  // Exact decimal arithmetic: a double cannot hold "1.5000000000000001", and rounding would change the limit.
  const fraction = match[2] ?? "";
  const scaled = BigInt(`${match[1]}${fraction}`) * BigInt(UNITS[match[3] ?? ""] as number);
  const divisor = 10n ** BigInt(fraction.length);
  if (scaled % divisor !== 0n) return null;
  const bytes = scaled / divisor;
  return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
}
