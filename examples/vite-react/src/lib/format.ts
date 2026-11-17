const UNITS = ["bytes", "KB", "MB", "GB"];

/** A size as people read it, in the binary units cloudrop counts in (1 MB = 1024 * 1024 bytes). */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${UNITS[unit]}`;
}
