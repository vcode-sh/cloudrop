// Shared helpers for the R2 spike: credential loading with redaction, an explicit SigV4 query presigner,
// a raw TLS HTTP/1.1 client (to send a Content-Length that differs from the body), and CRC32C / CRC64NVME.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:tls";

// ---------------------------------------------------------------- credentials and redaction

export interface R2Env {
  accountId: string;
  bucket: string;
  publicBase: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const ENV_KEYS = {
  BB_R2_ACCOUNT_ID: "accountId",
  BB_R2_BUCKET: "bucket",
  BB_R2_PUBLIC_BASE: "publicBase",
  BB_R2_ACCESS_KEY_ID: "accessKeyId",
  BB_R2_SECRET_ACCESS_KEY: "secretAccessKey",
} as const;

/** The credentials file named by CLOUDROP_R2_ENV_FILE. There is no default path: a run reads only the file it is given. */
export function envFilePath(): string {
  const path = process.env.CLOUDROP_R2_ENV_FILE;
  if (path) return path;
  console.error("CLOUDROP_R2_ENV_FILE is not set. Point it at a file with the five BB_R2_* lines and re-run.");
  process.exit(1);
}

/** Parses only literal KEY=VALUE lines for the five known keys. Never evaluates shell code. */
export function loadEnv(path: string): R2Env {
  const out: Partial<Record<keyof R2Env, string>> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const field = ENV_KEYS[match[1] as keyof typeof ENV_KEYS];
    if (!field) continue;
    let value = match[2];
    if (/^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
    out[field] = value;
  }
  for (const [key, field] of Object.entries(ENV_KEYS)) {
    if (!out[field]) throw new Error(`Missing ${key} in the credentials file. Add it and re-run.`);
  }
  return out as R2Env;
}

let secretsToRedact: [string, string][] = [];

export function registerRedactions(env: R2Env) {
  const publicHost = new URL(env.publicBase).host;
  secretsToRedact = [
    [env.secretAccessKey, "<secret>"],
    [env.accessKeyId, "<access-key-id>"],
    [env.accountId, "<account>"],
    [publicHost, "<public-host>"],
    [env.bucket, "<bucket>"],
  ];
}

export function redact(text: string): string {
  let out = text;
  for (const [value, label] of secretsToRedact) out = out.split(value).join(label);
  // Signatures are short-lived bearer material; never keep them in evidence.
  return out.replace(/X-Amz-Signature=[0-9a-f]+/gi, "X-Amz-Signature=<sig>").replace(/Signature=[0-9a-f]{64}/g, "Signature=<sig>");
}

// ---------------------------------------------------------------- SigV4 query presigner

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

export interface PresignInput {
  env: R2Env;
  method: string;
  key: string;
  expires: number;
  /** Extra query parameters (e.g. partNumber, uploadId, hoisted x-amz-* values). */
  query?: Record<string, string>;
  /** Headers to sign; the client must send them with these exact values. `host` is always signed. */
  signedHeaders?: Record<string, string>;
  /** Override the signing time, for expiry tests. */
  date?: Date;
}

export function s3Host(env: R2Env) {
  return `${env.accountId}.r2.cloudflarestorage.com`;
}

export function objectPath(env: R2Env, key: string) {
  return `/${env.bucket}/${key.split("/").map(enc).join("/")}`;
}

/** Presigns a path-style URL. Returns the URL and the exact X-Amz-SignedHeaders value. */
export function presign(input: PresignInput): { url: string; signedHeaderNames: string } {
  const { env, method, key, expires } = input;
  const host = s3Host(env);
  const now = input.date ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;

  const headers: Record<string, string> = { host };
  for (const [k, v] of Object.entries(input.signedHeaders ?? {})) headers[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(headers).sort();
  const signedHeaderNames = names.join(";");

  const query: Record<string, string> = {
    ...(input.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${env.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signedHeaderNames,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join("&");
  const path = objectPath(env, key);
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedHeaderNames,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${env.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, "auto"), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return { url: `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`, signedHeaderNames };
}

// ---------------------------------------------------------------- raw HTTP/1.1 over TLS

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  note?: string;
}

/**
 * Sends one request over a fresh TLS socket with `Connection: close`, writing headers exactly as given
 * (including a Content-Length that may disagree with the body). `halfClose` ends the write side after the body.
 */
export function rawRequest(
  url: string,
  method: string,
  headers: [string, string][],
  body: Uint8Array,
  opts: { halfClose?: boolean; timeoutMs?: number } = {},
): Promise<RawResponse> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: u.hostname, port: 443, servername: u.hostname, ALPNProtocols: ["http/1.1"] });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(parseRaw(Buffer.concat(chunks), note));
    };
    const timer = setTimeout(() => finish(`client timeout after ${opts.timeoutMs ?? 30000} ms`), opts.timeoutMs ?? 30000);
    socket.on("secureConnect", () => {
      const head = [`${method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, ...headers.map(([k, v]) => `${k}: ${v}`), "Connection: close", "", ""].join("\r\n");
      socket.write(head);
      if (body.length) socket.write(body);
      if (opts.halfClose) socket.end();
    });
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("end", () => finish());
    socket.on("close", () => finish());
    socket.on("error", (e) => finish(`socket error: ${e.message}`));
  });
}

function parseRaw(buf: Buffer, note?: string): RawResponse {
  const text = buf.toString("latin1");
  const split = text.indexOf("\r\n\r\n");
  if (split < 0) return { status: 0, headers: {}, body: text.slice(0, 500), note: note ?? "no HTTP response received" };
  const [statusLine, ...lines] = text.slice(0, split).split("\r\n");
  const headers: Record<string, string> = {};
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
  }
  let body = text.slice(split + 4);
  if (headers["transfer-encoding"]?.includes("chunked")) body = dechunk(body);
  const extra = text.slice(split + 4).match(/HTTP\/1\.1 \d{3}/g);
  return {
    status: Number(statusLine.split(" ")[1]),
    headers,
    body,
    note: [note, extra && extra.length > 0 ? `extra responses on socket: ${extra.join(", ")}` : undefined].filter(Boolean).join("; ") || undefined,
  };
}

function dechunk(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const eol = s.indexOf("\r\n", i);
    if (eol < 0) break;
    const size = Number.parseInt(s.slice(i, eol), 16);
    if (!size) break;
    out += s.slice(eol + 2, eol + 2 + size);
    i = eol + 2 + size + 2;
  }
  return out;
}

// ---------------------------------------------------------------- checksums

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32c(data: Uint8Array): Uint8Array {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC32C_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  c = (c ^ 0xffffffff) >>> 0;
  return new Uint8Array([c >>> 24, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff]);
}

// CRC64/NVME: reflected polynomial 0x9a6c9329ac4bc9b5, init and xorout all ones. Split into two 32-bit halves.
const CRC64_TABLE = (() => {
  const lo = new Uint32Array(256);
  const hi = new Uint32Array(256);
  const polyLo = 0xac4bc9b5;
  const polyHi = 0x9a6c9329;
  for (let n = 0; n < 256; n++) {
    let l = n;
    let h = 0;
    for (let k = 0; k < 8; k++) {
      const bit = l & 1;
      l = ((l >>> 1) | ((h & 1) << 31)) >>> 0;
      h = h >>> 1;
      if (bit) {
        l = (l ^ polyLo) >>> 0;
        h = (h ^ polyHi) >>> 0;
      }
    }
    lo[n] = l;
    hi[n] = h;
  }
  return { lo, hi };
})();

export function crc64nvme(data: Uint8Array): Uint8Array {
  let l = 0xffffffff;
  let h = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const idx = (l ^ data[i]) & 0xff;
    const nl = ((l >>> 8) | ((h & 0xff) << 24)) >>> 0;
    const nh = h >>> 8;
    l = (nl ^ CRC64_TABLE.lo[idx]) >>> 0;
    h = (nh ^ CRC64_TABLE.hi[idx]) >>> 0;
  }
  l = (l ^ 0xffffffff) >>> 0;
  h = (h ^ 0xffffffff) >>> 0;
  return new Uint8Array([h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff, l >>> 24, (l >>> 16) & 0xff, (l >>> 8) & 0xff, l & 0xff]);
}

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export const md5b64 = (data: Uint8Array) => createHash("md5").update(data).digest("base64");
export const md5hex = (data: Uint8Array) => createHash("md5").update(data).digest("hex");
