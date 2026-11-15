// AWS Signature Version 4 for S3, on WebCrypto, so it runs in browsers, Workers, Deno, Bun and Node.
// Presigned URLs sign exactly the headers the client will send: R2 enforces signed content-length, content-type and
// checksum headers, and ignores checksum values passed as query parameters (docs/research/r2-spike-findings.md).

const encoder = new TextEncoder();

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigningInput {
  method: string;
  url: URL;
  /** Headers to sign. `host` is always signed and taken from `url`. */
  headers?: Record<string, string>;
  credentials: Credentials;
  region: string;
  date: Date;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

function importHmacKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmac(key: CryptoKey, data: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

async function deriveSigningKey(secretAccessKey: string, day: string, region: string): Promise<CryptoKey> {
  let raw = await hmac(await importHmacKey(encoder.encode(`AWS4${secretAccessKey}`)), day);
  for (const part of [region, "s3", "aws4_request"]) raw = await hmac(await importHmacKey(raw), part);
  return importHmacKey(raw);
}

// The signing key only changes with the UTC day, region or secret, so a multipart upload derives it once instead of
// once per part. Bounded: a long-lived process that rotates secrets must not grow it without limit.
const SIGNING_KEY_CACHE_LIMIT = 16;
const signingKeys = new Map<string, Promise<CryptoKey>>();

function signingKey(secretAccessKey: string, day: string, region: string): Promise<CryptoKey> {
  const id = JSON.stringify([secretAccessKey, day, region]);
  const cached = signingKeys.get(id);
  if (cached) return cached;
  const derived = deriveSigningKey(secretAccessKey, day, region);
  derived.catch(() => signingKeys.delete(id));
  if (signingKeys.size >= SIGNING_KEY_CACHE_LIMIT) signingKeys.delete(signingKeys.keys().next().value as string);
  signingKeys.set(id, derived);
  return derived;
}

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encodes an object key for a URL path: each segment RFC 3986-encoded, slashes kept. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

// `URL` leaves `!'()*+` and similar characters raw in the path, but S3 signs the RFC 3986 form of every segment
// (encoded once, never twice), so decode and encode again.
function canonicalPath(url: URL): string {
  return url.pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(params: URLSearchParams): string {
  return Array.from(params, ([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([aName, aValue], [bName, bValue]) => {
      if (aName !== bName) return aName < bName ? -1 : 1;
      if (aValue === bValue) return 0;
      return aValue < bValue ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function canonicalHeaders(url: URL, headers: Record<string, string>): { canonical: string; signedHeaders: string } {
  const all: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(headers)) all[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  const names = Object.keys(all).sort();
  return { canonical: names.map((name) => `${name}:${all[name]}\n`).join(""), signedHeaders: names.join(";") };
}

async function sign(input: SigningInput, amzDate: string, scope: string, canonicalRequest: string): Promise<string> {
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const key = await signingKey(input.credentials.secretAccessKey, amzDate.slice(0, 8), input.region);
  return toHex(await hmac(key, stringToSign));
}

export async function presignUrl(input: SigningInput & { expiresIn: number }): Promise<URL> {
  const amzDate = toAmzDate(input.date);
  const scope = `${amzDate.slice(0, 8)}/${input.region}/s3/aws4_request`;
  const { canonical, signedHeaders } = canonicalHeaders(input.url, input.headers ?? {});
  const url = new URL(input.url);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(input.expiresIn));
  url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);
  const query = canonicalQuery(url.searchParams);
  const request = [input.method, canonicalPath(url), query, canonical, signedHeaders, UNSIGNED_PAYLOAD].join("\n");
  url.search = `${query}&X-Amz-Signature=${await sign(input, amzDate, scope, request)}`;
  return url;
}

export async function signRequest(input: SigningInput & { payloadHash: string }): Promise<Record<string, string>> {
  const amzDate = toAmzDate(input.date);
  const scope = `${amzDate.slice(0, 8)}/${input.region}/s3/aws4_request`;
  const headers = { ...input.headers, "x-amz-content-sha256": input.payloadHash, "x-amz-date": amzDate };
  const { canonical, signedHeaders } = canonicalHeaders(input.url, headers);
  const request = [
    input.method,
    canonicalPath(input.url),
    canonicalQuery(input.url.searchParams),
    canonical,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const signature = await sign(input, amzDate, scope, request);
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
