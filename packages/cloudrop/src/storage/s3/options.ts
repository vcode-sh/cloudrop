import type { ObjectOptions, WriteOptions } from "../driver.ts";

export const META_PREFIX = "x-amz-meta-";

export function objectHeaders(options: ObjectOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.type) headers["content-type"] = options.type;
  if (options.disposition) headers["content-disposition"] = options.disposition;
  for (const [name, value] of Object.entries(options.metadata ?? {})) headers[`${META_PREFIX}${name}`] = value;
  return headers;
}

export function writeHeaders(options: WriteOptions): Record<string, string> {
  const headers = objectHeaders(options);
  if (options.ifNoneMatch) headers["if-none-match"] = "*";
  if (options.checksumCrc32c) headers["x-amz-checksum-crc32c"] = options.checksumCrc32c;
  return headers;
}

// Plain-JavaScript callers can pass null or nothing. An empty object lets the field checks answer with a clear
// INVALID_INPUT (for example a missing size) instead of a TypeError; for optional options it is the right default.
export function orEmpty<T extends object>(options: T | null | undefined): T {
  return options ?? ({} as T);
}
