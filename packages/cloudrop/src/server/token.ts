// The upload token (spec §5.2): `<base64url(JSON payload)>.<base64url(HMAC-SHA256 of the first part)>`. It carries
// everything later calls need, so the server keeps no state and trusts nothing a client sends besides the token.
// It is signed, not encrypted: the browser can read it, so it never holds a secret.

import { CloudropError, fail, ok, type Result } from "../errors.ts";

export interface UploadTokenPayload {
  v: 1;
  route: string;
  fileId: string;
  key: string;
  name: string;
  size: number;
  type: string;
  /** Multipart only. */
  uploadId?: string;
  /** Multipart only: every part but the last has this size. */
  partSize?: number;
  /** The authorize result, as JSON. */
  owner: unknown;
  /** The validated metadata, as JSON. */
  metadata: unknown;
  /** Unix seconds; the token is expired from this second on. */
  exp: number;
}

export type MultipartToken = UploadTokenPayload & { uploadId: string; partSize: number };

export const isMultipart = (token: UploadTokenPayload): token is MultipartToken => token.uploadId !== undefined;

// The longest token /upload issues: 2 KiB of JSON each for owner and metadata, a 1,024-byte key, a 255-character name
// (up to 6 JSON bytes per character) and the storage's upload ID come to about 12 KiB of base64url. A longer one is
// refused before any HMAC; the 64 KiB body cap still bounds the request.
const MAX_TOKEN_LENGTH = 16_384;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Reads a body that one of our keys signed. Only a holder of a secret can sign, but a body that is not this version's
// JSON (another deployment sharing the secret, a future format) is still an invalid token, never a throw.
function readPayload(body: string): UploadTokenPayload | null {
  try {
    const bytes = Uint8Array.from(atob(body.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    const payload = JSON.parse(decoder.decode(bytes)) as { v?: unknown; exp?: unknown } | null;
    return payload?.v === 1 && Number.isSafeInteger(payload.exp) ? (payload as UploadTokenPayload) : null;
  } catch {
    // atob refuses a length no base64 string can have; JSON.parse refuses text that is not JSON.
    return null;
  }
}

export function importTokenKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export interface TokenKeys {
  signing: CryptoKey;
  /** The signing key first, then the previous ones: any of them verifies, so secrets rotate without breaking uploads. */
  all: readonly CryptoKey[];
}

/**
 * Imported once, at configuration time, as non-extractable keys: no request imports a key, and nothing after start-up
 * needs the plaintext secret. Measured 2026-11-15 (Ryzen 9 9950X3D, 20,000 verifications): 6.3 us per verify with the
 * imported key against 7.2 us importing per call on Bun 1.4.4, 13.5 against 17.8 us on Node 24.22.2.
 */
export async function importTokenKeys([current, ...previous]: readonly [string, ...string[]]): Promise<TokenKeys> {
  const signing = await importTokenKey(current);
  return { signing, all: [signing, ...(await Promise.all(previous.map(importTokenKey)))] };
}

async function signature(key: CryptoKey, body: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))));
}

// Compares the base64url text, not decoded bytes: the last character of 32 bytes in base64 carries two unused bits,
// so decoding would accept four spellings of one signature. WebCrypto's verify() does not promise constant time in
// its specification, so the comparison is ours: it reads every character whatever the first difference.
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export async function signToken(payload: UploadTokenPayload, key: CryptoKey): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await signature(key, body)}`;
}

const invalidToken = (): CloudropError =>
  new CloudropError("INVALID_TOKEN", "The upload token is not valid. Start the upload again.", { status: 400 });

export const uploadExpired = (): CloudropError =>
  new CloudropError("UPLOAD_EXPIRED", "This upload expired. Start it again to upload the file.", { status: 410 });

/**
 * The payload of a token any of `keys` signed. An expired token is UPLOAD_EXPIRED unless `allowExpired` (abort, which
 * only cleans up). Plain-JavaScript input of any type is answered with INVALID_TOKEN.
 */
export async function verifyToken(
  token: unknown,
  keys: readonly CryptoKey[],
  nowSeconds: number,
  options: { allowExpired?: boolean } = {},
): Promise<Result<UploadTokenPayload>> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return fail(invalidToken());
  const [body = "", given = "", extra] = token.split(".");
  if (extra !== undefined) return fail(invalidToken());
  const checks = await Promise.all(keys.map(async (key) => sameText(await signature(key, body), given)));
  const payload = checks.includes(true) ? readPayload(body) : null;
  if (payload === null) return fail(invalidToken());
  if (nowSeconds >= payload.exp && !options.allowExpired) return fail(uploadExpired());
  return ok(payload);
}
