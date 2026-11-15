// Object keys and the stored Content-Disposition (spec §5.3, §7.5). The server chooses every key; the client's file
// name reaches only the Content-Disposition header, percent-encoded.

import { encodeRfc3986 } from "../storage/sigv4.ts";
import { keyProblem } from "../storage/validate.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID (https://github.com/ulid/spec): 48 bits of milliseconds, then 80 random bits, in Crockford base32. */
export function ulid(nowMs: number, random: Uint8Array): string {
  let time = "";
  for (let rest = nowMs, index = 0; index < 10; index++, rest = Math.floor(rest / 32)) {
    time = CROCKFORD.charAt(rest % 32) + time;
  }
  let tail = "";
  let bits = 0;
  let value = 0;
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      tail += CROCKFORD.charAt((value >>> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  return time + tail;
}

export function newFileId(): string {
  return ulid(Date.now(), crypto.getRandomValues(new Uint8Array(10)));
}

export function generatedKey(prefix: string, fileId: string, ext: string): string {
  const folder = prefix.replace(/\/+$/, "");
  return folder === "" ? `${fileId}${ext}` : `${folder}/${fileId}${ext}`;
}

/**
 * The key, NFC-normalized, or why it cannot be stored. A key reaches the URL path, so `.`, `..`, empty segments, a
 * leading slash and control characters are refused, never rewritten: rewriting would make two inputs share a key.
 */
export function normalizeKey(key: unknown): { key: string } | { problem: string } {
  if (typeof key !== "string") return { problem: "The object key must be a string." };
  const normalized = key.normalize("NFC");
  const problem =
    keyProblem(normalized) ??
    (normalized.split("/").includes("")
      ? "The object key has an empty segment (a doubled or trailing slash). Remove it."
      : null);
  return problem === null ? { key: normalized } : { problem };
}

// Raster images, video and audio display inline. Everything else downloads, including SVG, HTML and XML, which a
// browser would run as a page on the bucket's public domain: that closes stored XSS by default (spec §7.5).
const INLINE = /^(image\/(?!svg\+xml$)|video\/|audio\/)/;

/** `type` is a normalized MIME type and `name` well-formed Unicode. RFC 6266 with an RFC 5987 `filename*`. */
export function contentDisposition(type: string, name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${INLINE.test(type) ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeRfc3986(name)}`;
}
