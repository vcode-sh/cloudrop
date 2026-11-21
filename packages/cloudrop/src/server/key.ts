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

/** The result is not validated; pass it through `normalizeKey` before storing it. */
export function generatedKey(prefix: string, id: string, ext: string): string {
  const folder = prefix.replace(/\/+$/, "");
  return folder === "" ? `${id}${ext}` : `${folder}/${id}${ext}`;
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

/** The characters keyProblem calls control characters: Unicode's Cc, U+0000 to U+001F and U+007F to U+009F. */
const CONTROLS = /\p{Cc}/gu;
const isNoName = (part: string): boolean => part === "" || part === "." || part === "..";

/**
 * `normalizeKey` for the key a route's `prefix` or `key` function built for the file named `name`. A name comes from
 * the person, not from the route, and a real one can hold what a key cannot: macOS names a folder's icon file
 * "Icon\r". So the key is judged a second time with the name's share of the trouble replaced: each control character
 * the name has too, and, when the name has a ".", a ".." or an empty part between slashes, each such part of the key.
 * A key that is then fine was unusable because of the name alone, and `nameProblem` says why in words that follow
 * "This file's name"; whatever is still wrong is the route's own (M11-R222).
 */
export function keyForFile(
  built: unknown,
  name: string,
): { key: string } | { problem: string } | { nameProblem: string } {
  const key = normalizeKey(built);
  if ("key" in key || typeof built !== "string") return key;
  const noName = name.split("/").some(isNoName);
  const repaired = built
    .replace(CONTROLS, (char) => (name.includes(char) ? "_" : char))
    .split("/")
    .map((part) => (noName && isNoName(part) ? "_" : part))
    .join("/");
  const rest = normalizeKey(repaired);
  if ("problem" in rest) return rest;
  // The code point, never the character: the message is shown and logged.
  const [control] = built.match(CONTROLS) ?? [];
  const codePoint = control?.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
  return {
    nameProblem: control
      ? `has a control character (U+${codePoint}), which this upload cannot store`
      : 'has a "." or ".." part, or an empty part beside a "/", which this upload cannot store',
  };
}

// Raster images, video and audio display inline. Everything else downloads, including SVG, HTML and XML, which a
// browser would run as a page on the bucket's public domain: that closes stored XSS by default (spec §7.5).
const INLINE = /^(?:image\/(?!svg\+xml$)|video\/|audio\/)[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** `type` is a normalized MIME type and `name` well-formed Unicode. RFC 6266 with an RFC 5987 `filename*`. */
export function contentDisposition(type: string, name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${INLINE.test(type) ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeRfc3986(name)}`;
}
