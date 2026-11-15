import { GiB, MiB } from "../rules.ts";

/** A size in bytes, or a number with a unit: "512KB", "5MB", "1.5GB". KB, MB, GB and TB are binary (1 KB = 1024 bytes). */
export type Size = number | `${number}${"B" | "KB" | "MB" | "GB" | "TB" | "KiB" | "MiB" | "GiB" | "TiB"}`;

const KiB = 1024n;
const UNITS: Record<string, bigint> = {
  B: 1n,
  KB: KiB,
  KiB,
  MB: BigInt(MiB),
  MiB: BigInt(MiB),
  GB: BigInt(GiB),
  GiB: BigInt(GiB),
  TB: BigInt(GiB) * KiB,
  TiB: BigInt(GiB) * KiB,
};

const SIZE_STRING = /^(\d+)(?:\.(\d+))?(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/;

/** Bytes, or null when `size` is not a whole number of bytes, zero or more. */
export function parseSize(size: Size): number | null {
  if (typeof size === "number") return Number.isSafeInteger(size) && size >= 0 ? size + 0 : null;
  const match = typeof size === "string" ? SIZE_STRING.exec(size) : null;
  if (match === null) return null;
  // Exact decimal arithmetic: a double cannot hold "1.5000000000000001", and rounding would change the limit.
  const fraction = match[2] ?? "";
  const scaled = BigInt(`${match[1]}${fraction}`) * (UNITS[match[3] ?? ""] as bigint);
  const divisor = 10n ** BigInt(fraction.length);
  if (scaled % divisor !== 0n) return null;
  const bytes = scaled / divisor;
  return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
}
