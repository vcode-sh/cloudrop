import { CloudropError } from "../errors.ts";
import { GiB, MiB } from "../rules.ts";
import type { CompletedPart, ObjectOptions } from "./driver.ts";

const encoder = new TextEncoder();
const MAX_KEY_BYTES = 1024;
// 2 KiB is AWS S3's user-metadata limit (R2 allows 8 KiB); one limit keeps r2() and s3() interchangeable.
const MAX_METADATA_BYTES = 2048;

export function invalidInput(message: string): CloudropError {
  return new CloudropError("INVALID_INPUT", message);
}

/** An object literal or Object.create(null): never an array, a Map, a Response, an Error or another class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Keys reach the URL path, where `.` and `..` segments would be normalised away and break the signature (an earlier
 * implementation signed `/m/id/` for a file named `..`). Reject them instead of rewriting them.
 */
export function keyProblem(key: string): string | null {
  // Plain-JavaScript callers can pass anything; a TypeError here would escape the Result contract.
  if (typeof key !== "string") return "The object key must be a string. Pass the key as text.";
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

const isPrintableAscii = (value: unknown): boolean => typeof value === "string" && /^[\x20-\x7e]*$/.test(value);

function metadataProblem(metadata: Record<string, string> | undefined): string | null {
  if (metadata === undefined) return null;
  // Object.entries would read a string or an array as names "0", "1"…, and a Map as no metadata at all.
  if (!isPlainObject(metadata)) {
    return 'Metadata must be an object of names and text values, such as { "cloudrop-id": "f1" }.';
  }
  let bytes = 0;
  for (const [name, value] of Object.entries(metadata)) {
    // The offending name is not echoed: it is caller-controlled and unbounded (newlines would forge log lines).
    if (!/^[a-z0-9-]+$/.test(name))
      return "A metadata name may contain only lowercase letters, digits and hyphens. Rename it.";
    if (typeof value !== "string") return `Metadata value for "${name}" must be a string. Convert it first.`;
    // Printable ASCII only: Headers would send "é" as one Latin-1 byte while S3 reads UTF-8.
    if (!isPrintableAscii(value))
      return `Metadata value for "${name}" must be printable ASCII. Encode other text first.`;
    // Headers trims surrounding spaces, so the stored value would differ from the one passed.
    if (value.startsWith(" ") || value.endsWith(" "))
      return `Metadata value for "${name}" must not start or end with a space. Trim it.`;
    bytes += name.length + value.length;
  }
  return bytes > MAX_METADATA_BYTES ? "Metadata exceeds 2 KiB. Store large values in your database instead." : null;
}

/**
 * Header values must be printable ASCII strings: fetch rejects characters above U+00FF before a request is sent, and
 * the signer cannot trim a number.
 */
export function objectOptionsProblem(options: ObjectOptions): string | null {
  if (options.type !== undefined && !isPrintableAscii(options.type)) {
    return 'The content type must be printable ASCII, such as "text/plain; charset=utf-8".';
  }
  if (options.disposition !== undefined && !isPrintableAscii(options.disposition)) {
    return "The content disposition must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.";
  }
  return metadataProblem(options.metadata);
}

export function bodyProblem(body: unknown): string | null {
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const buffer = body instanceof Uint8Array ? body.buffer : body;
    // Hashing a view over shared memory, or over a buffer that was transferred, throws a TypeError. The check never
    // names SharedArrayBuffer: browsers without cross-origin isolation do not define it.
    if (buffer instanceof ArrayBuffer && !buffer.detached) return null;
    return "The body's buffer is detached or shared (a SharedArrayBuffer). Copy the bytes into a new Uint8Array first.";
  }
  if (typeof body === "string" || body instanceof Blob) return null;
  return "The body must be a Uint8Array, an ArrayBuffer, a string or a Blob.";
}

/** Base64 of 4 bytes: five free characters, a sixth that carries only 2 data bits (A, Q, g or w), then "==". */
export function checksumProblem(checksum: string | undefined): string | null {
  if (checksum === undefined || /^[A-Za-z0-9+/]{5}[AQgw]==$/.test(checksum)) return null;
  return 'The CRC32C checksum must be the base64 of 4 bytes, such as "4waSgw==". Compute it from the exact bytes you send.';
}

// Upload IDs and continuation tokens are opaque, but both travel in a signed query: printable ASCII, no spaces.
const isToken = (value: unknown): boolean => typeof value === "string" && /^[\x21-\x7e]+$/.test(value);

export function uploadIdProblem(uploadId: string): string | null {
  return isToken(uploadId)
    ? null
    : "The upload ID is empty or malformed. Pass the uploadId that createMultipart returned.";
}

export function cursorProblem(cursor: string): string | null {
  return isToken(cursor) ? null : "The list cursor is empty or malformed. Pass the nextCursor of the previous page.";
}

export function prefixProblem(prefix: string): string | null {
  if (typeof prefix !== "string") return 'The list prefix must be a string. Pass "" to list every object.';
  if (prefix.isWellFormed()) return null;
  return "The list prefix is not valid Unicode (it has a lone surrogate). Remove or replace that character.";
}

/** The most keys or parts S3 returns in one list page. */
export const MAX_LIST_PAGE: number = 1000;

export function limitProblem(limit: number): string | null {
  if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIST_PAGE) return null;
  return `The page size must be between 1 and ${MAX_LIST_PAGE}.`;
}

export function partsProblem(parts: readonly CompletedPart[], maxParts: number): string | null {
  const valid =
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every(
      (part) =>
        partNumberProblem(part?.partNumber, maxParts) === null && typeof part.etag === "string" && part.etag !== "",
    );
  return valid
    ? null
    : `Pass at least one part, each with a part number between 1 and ${maxParts} and the ETag the storage returned for it.`;
}

/** Only the list's shape: each key is checked on its own and reported per key. */
export function keyListProblem(keys: readonly string[]): string | null {
  return Array.isArray(keys) ? null : "deleteMany takes an array of keys. Wrap a single key in an array.";
}

const BYTE_UNITS: readonly [string, number][] = [
  ["GiB", GiB],
  ["MiB", MiB],
  ["KiB", 1024],
];

export function formatBytes(bytes: number): string {
  const unit = BYTE_UNITS.find(([, size]) => bytes >= size);
  return unit ? `${Number((bytes / unit[1]).toFixed(3))} ${unit[0]}` : `${bytes} bytes`;
}

export function sizeProblem(size: number, max: number, of: "file" | "part" = "file"): string | null {
  if (!Number.isSafeInteger(size) || size < 0) return "Size must be a whole number of bytes, zero or more.";
  if (size <= max) return null;
  return of === "part"
    ? `The part is over the part size limit of ${formatBytes(max)}. Use smaller parts.`
    : `Size is over the limit of ${formatBytes(max)}. Upload a smaller file or split it.`;
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
