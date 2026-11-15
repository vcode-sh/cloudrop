import { CloudropError } from "../errors.ts";

const encoder = new TextEncoder();
const MAX_KEY_BYTES = 1024;
// 2 KiB is AWS S3's user-metadata limit (R2 allows 8 KiB); one limit keeps r2() and s3() interchangeable.
const MAX_METADATA_BYTES = 2048;

export function invalidInput(message: string): CloudropError {
  return new CloudropError("INVALID_INPUT", message);
}

/**
 * Keys reach the URL path, where `.` and `..` segments would be normalised away and break the signature (an earlier
 * implementation signed `/m/id/` for a file named `..`). Reject them instead of rewriting them.
 */
export function keyProblem(key: string): string | null {
  if (key.length === 0) return "The object key is empty. Pass a non-empty key.";
  // A lone surrogate cannot be percent-encoded (encodeURIComponent throws) and TextEncoder would silently replace it.
  if (!key.isWellFormed()) {
    return "The object key is not valid Unicode (it has a lone surrogate). Remove or replace that character.";
  }
  if (encoder.encode(key).length > MAX_KEY_BYTES) return "The object key is longer than 1024 bytes. Use a shorter key.";
  if (key.startsWith("/")) return "The object key starts with a slash. Remove the leading slash.";
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
      return "The object key contains control characters. Remove them.";
  }
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    return "The object key contains a '.' or '..' segment. Use plain path segments.";
  }
  return null;
}

export function metadataProblem(metadata: Record<string, string> | undefined): string | null {
  let bytes = 0;
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (!/^[a-z0-9-]+$/.test(name))
      return `Metadata name "${name}" may contain only lowercase letters, digits and hyphens.`;
    if (!/^[\x20-\x7e]*$/.test(value))
      return `Metadata value for "${name}" must be printable ASCII. Encode other text first.`;
    bytes += name.length + value.length;
  }
  return bytes > MAX_METADATA_BYTES ? "Metadata exceeds 2 KiB. Store large values in your database instead." : null;
}

export function sizeProblem(size: number, max: number): string | null {
  if (Number.isSafeInteger(size) && size >= 0 && size <= max) return null;
  return `Size must be a whole number of bytes between 0 and ${max}.`;
}

/** `Number.isInteger` is false for NaN and Infinity, and the cap rules out `1e+21`, so only sane digits reach the signer. */
export function expiryProblem(seconds: number, max: number): string | null {
  if (Number.isInteger(seconds) && seconds >= 1 && seconds <= max) return null;
  return `Expiry must be a whole number of seconds between 1 and ${max}.`;
}

export function partNumberProblem(partNumber: number, maxParts: number): string | null {
  if (Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= maxParts) return null;
  return `Part number must be between 1 and ${maxParts}.`;
}

export function rangeProblem(start: number, end: number): string | null {
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start) return null;
  return "The byte range must satisfy 0 <= start <= end.";
}
