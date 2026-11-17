// cloudrop real-R2 feasibility spike. Throwaway. See docs/research/r2-spike-findings.md.
//
// Safety: writes only under a random `spike/cloudrop-<128-bit hex>/` prefix, registers every key and upload id,
// and on success, failure or interrupt aborts/deletes everything it created, then lists the prefix (objects and
// multipart uploads) to prove it is empty. All output passes through `redact()`; credentials are never printed.
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AwsClient } from "aws4fetch";
import {
  b64,
  crc32c,
  crc64nvme,
  envFilePath,
  hex,
  loadEnv,
  md5hex,
  objectPath,
  presign,
  rawRequest,
  redact,
  registerRedactions,
  s3Host,
  type RawResponse,
} from "./lib.ts";

const MiB = 1024 * 1024;
const ORIGIN = "http://localhost:5173";
const WORK_BUDGET_MS = 15 * 60_000;

// ---------------------------------------------------------------- self-check (no network)

if (process.argv.includes("--self-check")) {
  const v = new TextEncoder().encode("123456789");
  const c = hex(crc32c(v));
  const n = hex(crc64nvme(v));
  console.log(`crc32c("123456789") = ${c} (expected e3069283)`);
  console.log(`crc64nvme("123456789") = ${n} (expected ae8b14860a799888)`);
  process.exit(c === "e3069283" && n === "ae8b14860a799888" ? 0 : 1);
}

const env = loadEnv(envFilePath());
registerRedactions(env);
const host = s3Host(env);
const prefix = `spike/cloudrop-${randomBytes(16).toString("hex")}/`;
const aws = new AwsClient({ accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey, service: "s3", region: "auto", retries: 0 });

const log = (...parts: unknown[]) => console.log(redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));

// ---------------------------------------------------------------- ledger and cleanup

const ownedKeys = new Set<string>();
const ownedUploads = new Map<string, string>(); // uploadId -> key
let uploadedBytes = 0;

function key(name: string) {
  const k = `${prefix}${name}`;
  ownedKeys.add(k);
  return k;
}

async function cleanup(): Promise<{ objects: number; uploads: number; truncated: boolean }> {
  for (const [uploadId, k] of ownedUploads) {
    const r = await api("DELETE", k, { query: { uploadId } }).catch(() => undefined);
    if (r && r.status !== 204 && r.status !== 404) log(`cleanup: abort ${r.status} ${r.code ?? ""}`);
  }
  for (const k of ownedKeys) await api("DELETE", k).catch(() => undefined);
  // Reconcile anything the ledger missed (for example a lost create response), strictly inside our prefix.
  for (let sweep = 0; sweep < 3; sweep++) {
    const listed = await listPrefix();
    if (listed.keys.length === 0 && listed.uploads.length === 0 && !listed.truncated) break;
    for (const u of listed.uploads) if (u.key.startsWith(prefix)) await api("DELETE", u.key, { query: { uploadId: u.uploadId } });
    for (const k of listed.keys) if (k.startsWith(prefix)) await api("DELETE", k);
  }
  const final = await listPrefix();
  return { objects: final.keys.length, uploads: final.uploads.length, truncated: final.truncated };
}

async function listPrefix() {
  const objs = await api("GET", "", { query: { "list-type": "2", prefix, "max-keys": "1000" } });
  const ups = await api("GET", "", { query: { uploads: "", prefix, "max-uploads": "1000" } });
  if (objs.status !== 200 || ups.status !== 200) throw new Error(`Prefix listing failed: ${objs.status}/${ups.status}`);
  const keys = [...objs.text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  const uploads = [...ups.text.matchAll(/<Upload>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<UploadId>([^<]+)<\/UploadId>[\s\S]*?<\/Upload>/g)].map((m) => ({
    key: m[1],
    uploadId: m[2],
  }));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(objs.text) || /<IsTruncated>true<\/IsTruncated>/.test(ups.text);
  return { keys, uploads, truncated };
}

let cleaning: Promise<void> | undefined;
async function cleanupAndExit(code: number, reason: string) {
  cleaning ??= (async () => {
    log(`\n== cleanup (${reason})`);
    let proof: Awaited<ReturnType<typeof cleanup>> | undefined;
    try {
      proof = await cleanup();
    } catch (e) {
      log(`cleanup error: ${(e as Error).message}`);
    }
    const line = proof
      ? `CLEANUP PROOF prefix=${prefix} objects=${proof.objects} multipart_uploads=${proof.uploads} truncated=${proof.truncated} registered_keys=${ownedKeys.size} registered_uploads=${ownedUploads.size} uploaded_bytes=${uploadedBytes}`
      : `CLEANUP FAILED prefix=${prefix}: recover only this prefix`;
    log(line);
    evidence.push({ q: "cleanup", label: "proof", line });
    flushEvidence();
    const ok = proof && proof.objects === 0 && proof.uploads === 0 && !proof.truncated;
    process.exit(ok ? code : 1);
  })();
  await cleaning;
}
process.on("SIGINT", () => void cleanupAndExit(130, "SIGINT"));
process.on("SIGTERM", () => void cleanupAndExit(143, "SIGTERM"));
setTimeout(() => void cleanupAndExit(1, "work budget exceeded"), WORK_BUDGET_MS).unref();

// ---------------------------------------------------------------- evidence

const evidence: Record<string, unknown>[] = [];
const outDir = join(import.meta.dir, ".out");
function flushEvidence() {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "evidence.json"), redact(JSON.stringify(evidence, null, 2)));
}

interface Res {
  status: number;
  headers: Record<string, string>;
  text: string;
  code?: string;
  message?: string;
  note?: string;
}

const INTERESTING = /^(etag|content-length|content-type|content-range|content-disposition|last-modified|x-amz-(?!request-id|id-2)|access-control-|vary|cache-control|cf-cache-status)/;
function summarize(r: Res) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) if (INTERESTING.test(k)) headers[k] = v;
  return { status: r.status, code: r.code, message: r.message, headers, note: r.note, body: r.code ? undefined : r.text.length > 0 && r.text.length < 8000 && r.text.startsWith("<") ? r.text : undefined };
}

function record(q: string, label: string, request: Record<string, unknown>, r: Res) {
  const entry = { q, label, request, response: summarize(r) };
  evidence.push(entry);
  log(`[${q}] ${label}: ${r.status} ${r.code ?? ""} ${r.note ? `(${r.note})` : ""}`);
  return r;
}

const xmlCode = (t: string) => /<Code>([^<]+)<\/Code>/.exec(t)?.[1];
const xmlMessage = (t: string) => /<Message>([^<]*)<\/Message>/.exec(t)?.[1];
const toRes = (status: number, headers: Record<string, string>, text: string, note?: string): Res => ({ status, headers, text, code: xmlCode(text), message: xmlMessage(text), note });

// ---------------------------------------------------------------- transports

/** Header-authenticated request (server-side operations). */
async function api(method: string, k: string, o: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array | string } = {}): Promise<Res> {
  const qs = Object.entries(o.query ?? {})
    .map(([a, b]) => (b === "" ? encodeURIComponent(a) : `${encodeURIComponent(a)}=${encodeURIComponent(b)}`))
    .join("&");
  const path = k ? objectPath(env, k) : `/${env.bucket}`;
  const res = await aws.fetch(`https://${host}${path}${qs ? `?${qs}` : ""}`, { method, headers: o.headers, body: o.body });
  if (o.body instanceof Uint8Array && ["PUT", "POST"].includes(method)) uploadedBytes += o.body.length;
  return toRes(res.status, Object.fromEntries(res.headers), await res.text());
}

/** What a browser would do with a presigned URL: plain fetch, body framed honestly. */
async function browserLike(url: string, method: string, headers: Record<string, string>, body?: Uint8Array): Promise<Res> {
  const res = await fetch(url, { method, headers, body });
  if (body) uploadedBytes += body.length;
  return toRes(res.status, Object.fromEntries(res.headers), await res.text());
}

async function raw(url: string, method: string, headers: [string, string][], body: Uint8Array, opts?: { halfClose?: boolean; timeoutMs?: number }): Promise<Res> {
  uploadedBytes += body.length;
  const r: RawResponse = await rawRequest(url, method, headers, body, opts);
  return toRes(r.status, r.headers, r.body, r.note);
}

const bytes = (n: number) => new Uint8Array(randomBytes(n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pathOnly = (url: string) => {
  const u = new URL(url);
  return { path: u.pathname, queryParams: [...u.searchParams.keys()], signedHeaders: u.searchParams.get("X-Amz-SignedHeaders") };
};

async function createMpu(k: string, headers: Record<string, string> = {}) {
  const r = await api("POST", k, { query: { uploads: "" }, headers });
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(r.text)?.[1];
  if (r.status !== 200 || !uploadId) throw new Error(`CreateMultipartUpload failed: ${r.status} ${r.code}`);
  ownedUploads.set(uploadId, k);
  return uploadId;
}

function completeXml(parts: { n: number; etag: string; extra?: Record<string, string> }[]) {
  const inner = parts
    .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag>${Object.entries(p.extra ?? {}).map(([a, b]) => `<${a}>${b}</${a}>`).join("")}</Part>`)
    .join("");
  return `<CompleteMultipartUpload>${inner}</CompleteMultipartUpload>`;
}

async function putPart(k: string, uploadId: string, n: number, body: Uint8Array, headers: Record<string, string> = {}) {
  return api("PUT", k, { query: { partNumber: String(n), uploadId }, headers, body });
}

// ---------------------------------------------------------------- questions

async function q1() {
  const N = 1024;
  const ct = "application/octet-stream";
  const signed = (k: string) => presign({ env, method: "PUT", key: k, expires: 600, signedHeaders: { "content-length": String(N), "content-type": ct } });
  const cases: { label: string; cl: number; body: number; ct?: string; halfClose?: boolean }[] = [
    { label: "control: CL=signed N, body N", cl: N, body: N },
    { label: "honest framing, shorter: CL=N-100, body N-100", cl: N - 100, body: N - 100 },
    { label: "honest framing, longer: CL=N+100, body N+100", cl: N + 100, body: N + 100 },
    { label: "CL=N (as signed), body N-100 then half-close", cl: N, body: N - 100, halfClose: true },
    { label: "CL=N (as signed), body N+100 trailing bytes", cl: N, body: N + 100 },
    { label: "content-type mismatch: text/plain vs signed octet-stream", cl: N, body: N, ct: "text/plain" },
  ];
  for (const [i, c] of cases.entries()) {
    const k = key(`q1/signed-${i}`);
    const { url, signedHeaderNames } = signed(k);
    const r = await raw(url, "PUT", [["Content-Type", c.ct ?? ct], ["Content-Length", String(c.cl)]], bytes(c.body), { halfClose: c.halfClose, timeoutMs: 20000 });
    record("Q1", c.label, { signedHeaders: signedHeaderNames, sentContentLength: c.cl, bodyBytes: c.body }, r);
    const head = await api("HEAD", k);
    record("Q1", `  HEAD after "${c.label}"`, {}, head);
  }
  // Unsigned content-length: only host + content-type signed.
  const k = key("q1/unsigned");
  const { url, signedHeaderNames } = presign({ env, method: "PUT", key: k, expires: 600, signedHeaders: { "content-type": ct } });
  const r = await raw(url, "PUT", [["Content-Type", ct], ["Content-Length", "4096"]], bytes(4096));
  record("Q1", "unsigned content-length: planned 1024, sent 4096", { signedHeaders: signedHeaderNames, sentContentLength: 4096 }, r);
  record("Q1", "  HEAD after unsigned", {}, await api("HEAD", k));
}

async function q2() {
  const k = key("q2/parts");
  const uploadId = await createMpu(k);
  const P = 64 * 1024;
  const sign = (n: number, len: number | undefined) =>
    presign({ env, method: "PUT", key: k, expires: 600, query: { partNumber: String(n), uploadId }, signedHeaders: len === undefined ? {} : { "content-length": String(len) } });
  const cases = [
    { n: 1, signedLen: P, cl: P, label: "control: part 1 CL=signed" },
    { n: 2, signedLen: P, cl: P - 1, label: "part 2: CL one byte shorter than signed" },
    { n: 3, signedLen: P, cl: P + 1, label: "part 3: CL one byte longer than signed" },
    { n: 4, signedLen: undefined, cl: P * 2, label: "part 4: content-length not signed, sent 2x planned" },
  ];
  for (const c of cases) {
    const { url, signedHeaderNames } = sign(c.n, c.signedLen);
    const r = await raw(url, "PUT", [["Content-Length", String(c.cl)]], bytes(c.cl));
    record("Q2", c.label, { signedHeaders: signedHeaderNames, sentContentLength: c.cl }, r);
  }
  const lp = await api("GET", k, { query: { uploadId } });
  record("Q2", "ListParts after part attempts", {}, lp);
  const sizes = [...lp.text.matchAll(/<PartNumber>(\d+)<\/PartNumber>[\s\S]*?<Size>(\d+)<\/Size>/g)].map((m) => `${m[1]}:${m[2]}`);
  log(`[Q2] stored parts (number:size) = ${sizes.join(", ")}`);
  evidence.push({ q: "Q2", label: "stored parts", sizes });
  await api("DELETE", k, { query: { uploadId } });
}

async function q3() {
  const k = key("q3/create-only");
  const { url, signedHeaderNames } = presign({ env, method: "PUT", key: k, expires: 600, signedHeaders: { "if-none-match": "*" } });
  record("Q3", "presigned PUT, If-None-Match:* signed and sent, fresh key", { signedHeaders: signedHeaderNames }, await browserLike(url, "PUT", { "If-None-Match": "*" }, bytes(100)));
  await sleep(1200);
  record("Q3", "same URL again, key exists", { signedHeaders: signedHeaderNames }, await browserLike(url, "PUT", { "If-None-Match": "*" }, bytes(100)));
  await sleep(1200);
  record("Q3", "same URL, If-None-Match header omitted", { signedHeaders: signedHeaderNames }, await browserLike(url, "PUT", {}, bytes(100)));
  await sleep(1200);
  // Unsigned If-None-Match sent on a URL that signs only host: does R2 honour an unsigned conditional?
  const plain = presign({ env, method: "PUT", key: k, expires: 600 });
  record("Q3", "URL signs only host, If-None-Match:* sent unsigned, key exists", { signedHeaders: plain.signedHeaderNames }, await browserLike(plain.url, "PUT", { "If-None-Match": "*" }, bytes(100)));
  record("Q3", "  HEAD (size 100 either way; check etag vs first PUT)", {}, await api("HEAD", k));

  // CompleteMultipartUpload with If-None-Match on a fresh key, then on an existing key.
  const fresh = key("q3/mpu-fresh");
  const u1 = await createMpu(fresh);
  const p1 = await putPart(fresh, u1, 1, bytes(1000));
  record("Q3", "Complete If-None-Match:* fresh key", {}, await api("POST", fresh, { query: { uploadId: u1 }, headers: { "If-None-Match": "*" }, body: completeXml([{ n: 1, etag: p1.headers.etag }]) }));
  const u2 = await createMpu(fresh);
  const p2 = await putPart(fresh, u2, 1, bytes(1000));
  await sleep(1200);
  record("Q3", "Complete If-None-Match:* existing key", {}, await api("POST", fresh, { query: { uploadId: u2 }, headers: { "If-None-Match": "*" }, body: completeXml([{ n: 1, etag: p2.headers.etag }]) }));
  record("Q3", "  ListParts on that upload after 412", {}, await api("GET", fresh, { query: { uploadId: u2 } }));
}

async function partSizes(label: string, sizes: number[]) {
  const k = key(`q4/${label}`);
  const uploadId = await createMpu(k);
  const parts: { n: number; etag: string }[] = [];
  for (const [i, size] of sizes.entries()) {
    const r = await putPart(k, uploadId, i + 1, bytes(size));
    record("Q4", `${label}: UploadPart ${i + 1} (${size / MiB} MiB)`, { size }, r);
    if (r.status === 200) parts.push({ n: i + 1, etag: r.headers.etag });
  }
  const c = record("Q4", `${label}: Complete`, { sizesMiB: sizes.map((s) => s / MiB) }, await api("POST", k, { query: { uploadId }, body: completeXml(parts) }));
  if (c.status !== 200) record("Q4", `${label}: ListParts after failed Complete (is the upload still usable?)`, {}, await api("GET", k, { query: { uploadId } }));
  return { k, uploadId, completed: c.status === 200 };
}

async function q4() {
  const a = await partSizes("a-equal-plus-smaller-last", [5 * MiB, 5 * MiB, 1 * MiB]);
  await partSizes("b-last-larger", [5 * MiB, 6 * MiB]);
  await partSizes("c-unequal-middle", [5 * MiB, 6 * MiB, 1 * MiB]);
  await partSizes("d-small-non-last", [1 * MiB, 5 * MiB]);
  return a.k;
}

async function q5() {
  // PutObject with x-amz-checksum-crc32c signed into the presigned URL as a header.
  const body = bytes(2048);
  const good = b64(crc32c(body));
  const bad = b64(crc32c(bytes(16)));
  for (const [label, value, algo] of [
    ["PUT crc32c header signed, correct", good, false],
    ["PUT crc32c header signed, wrong", bad, false],
    ["PUT crc32c + x-amz-sdk-checksum-algorithm signed, correct", good, true],
  ] as const) {
    const k = key(`q5/put-${label.includes("wrong") ? "wrong" : algo ? "algo" : "good"}`);
    const h: Record<string, string> = { "x-amz-checksum-crc32c": value };
    if (algo) h["x-amz-sdk-checksum-algorithm"] = "CRC32C";
    const { url, signedHeaderNames } = presign({ env, method: "PUT", key: k, expires: 600, signedHeaders: h });
    record("Q5", label, { signedHeaders: signedHeaderNames }, await browserLike(url, "PUT", h, body));
  }
  // Same, hoisted into the query string (what the AWS SDK presigner does with x-amz-* headers).
  for (const [label, value] of [
    ["PUT crc32c as query param, correct", good],
    ["PUT crc32c as query param, wrong", bad],
  ] as const) {
    const k = key(`q5/putq-${label.includes("wrong") ? "wrong" : "good"}`);
    const { url } = presign({ env, method: "PUT", key: k, expires: 600, query: { "x-amz-checksum-crc32c": value, "x-amz-sdk-checksum-algorithm": "CRC32C" } });
    record("Q5", label, pathOnly(url), await browserLike(url, "PUT", {}, body));
  }
  const goodKey = `${prefix}q5/put-good`;
  record("Q5", "HEAD put-good (no checksum mode)", {}, await api("HEAD", goodKey));
  record("Q5", "HEAD put-good x-amz-checksum-mode: ENABLED", {}, await api("HEAD", goodKey, { headers: { "x-amz-checksum-mode": "ENABLED" } }));
  record("Q5", "GetObjectAttributes put-good", {}, await api("GET", goodKey, { query: { attributes: "" }, headers: { "x-amz-object-attributes": "ETag,Checksum,ObjectSize,ObjectParts" } }));

  // Multipart CRC32C COMPOSITE via presigned UploadPart URLs.
  const k = key("q5/mpu-crc32c");
  const uploadId = await createMpu(k, { "x-amz-checksum-algorithm": "CRC32C", "x-amz-checksum-type": "COMPOSITE" });
  const part1 = bytes(5 * MiB);
  const part2 = bytes(1000);
  const c1 = crc32c(part1);
  const c2 = crc32c(part2);
  const signPart = (n: number, v: string) => presign({ env, method: "PUT", key: k, expires: 600, query: { partNumber: String(n), uploadId }, signedHeaders: { "x-amz-checksum-crc32c": v } });
  const wrong = signPart(1, b64(c2));
  record("Q5", "presigned UploadPart 1, wrong crc32c", { signedHeaders: wrong.signedHeaderNames }, await browserLike(wrong.url, "PUT", { "x-amz-checksum-crc32c": b64(c2) }, part1));
  const r1 = await browserLike(signPart(1, b64(c1)).url, "PUT", { "x-amz-checksum-crc32c": b64(c1) }, part1);
  record("Q5", "presigned UploadPart 1, correct crc32c", {}, r1);
  const r2 = await browserLike(signPart(2, b64(c2)).url, "PUT", { "x-amz-checksum-crc32c": b64(c2) }, part2);
  record("Q5", "presigned UploadPart 2, correct crc32c", {}, r2);
  // A part with no checksum header on an upload created with CRC32C.
  const r3 = await putPart(k, uploadId, 3, bytes(1000));
  record("Q5", "UploadPart 3 without checksum header on a CRC32C upload", {}, r3);
  record("Q5", "ListParts (CRC32C upload)", {}, await api("GET", k, { query: { uploadId } }));
  const composite = b64(crc32c(new Uint8Array([...c1, ...c2])));
  log(`[Q5] expected composite crc32c = ${composite}-2, part1=${b64(c1)} part2=${b64(c2)}`);
  evidence.push({ q: "Q5", label: "expected composite", composite: `${composite}-2`, part1: b64(c1), part2: b64(c2) });
  const parts = [
    { n: 1, etag: r1.headers.etag, extra: { ChecksumCRC32C: b64(c1) } },
    { n: 2, etag: r2.headers.etag, extra: { ChecksumCRC32C: b64(c2) } },
  ];
  record("Q5", "Complete CRC32C with a wrong part checksum in the XML", {}, await api("POST", k, { query: { uploadId }, body: completeXml([{ ...parts[0], extra: { ChecksumCRC32C: b64(c2) } }, parts[1]]) }));
  record("Q5", "Complete CRC32C (correct parts 1-2)", {}, await api("POST", k, { query: { uploadId }, body: completeXml(parts) }));
  record("Q5", "HEAD mpu-crc32c checksum mode", {}, await api("HEAD", k, { headers: { "x-amz-checksum-mode": "ENABLED" } }));

  // Unconfigured upload, part sent with a wrong crc32c: validated anyway?
  const k2 = key("q5/mpu-unconfigured");
  const u2 = await createMpu(k2);
  record("Q5", "UploadPart wrong crc32c on an upload created without checksum algorithm", {}, await putPart(k2, u2, 1, part2, { "x-amz-checksum-crc32c": b64(c1) }));
  record("Q5", "UploadPart correct crc32c on an upload created without checksum algorithm", {}, await putPart(k2, u2, 1, part2, { "x-amz-checksum-crc32c": b64(c2) }));
  await api("DELETE", k2, { query: { uploadId: u2 } });

  // CRC64NVME FULL_OBJECT multipart.
  const k3 = key("q5/mpu-crc64");
  const u3 = await createMpu(k3, { "x-amz-checksum-algorithm": "CRC64NVME", "x-amz-checksum-type": "FULL_OBJECT" });
  const p1 = await putPart(k3, u3, 1, part1, { "x-amz-checksum-crc64nvme": b64(crc64nvme(part1)) });
  record("Q5", "CRC64NVME UploadPart 1 with part crc64", {}, p1);
  const p2 = await putPart(k3, u3, 2, part2, { "x-amz-checksum-crc64nvme": b64(crc64nvme(part2)) });
  record("Q5", "CRC64NVME UploadPart 2 with part crc64", {}, p2);
  const full = b64(crc64nvme(new Uint8Array([...part1, ...part2])));
  log(`[Q5] expected full-object crc64nvme = ${full}`);
  evidence.push({ q: "Q5", label: "expected full-object crc64nvme", full });
  const cparts = [
    { n: 1, etag: p1.headers.etag, extra: { ChecksumCRC64NVME: b64(crc64nvme(part1)) } },
    { n: 2, etag: p2.headers.etag, extra: { ChecksumCRC64NVME: b64(crc64nvme(part2)) } },
  ];
  const wrongFull = b64(crc64nvme(part2));
  const w = record("Q5", "Complete CRC64NVME with WRONG full-object header", {}, await api("POST", k3, { query: { uploadId: u3 }, headers: { "x-amz-checksum-crc64nvme": wrongFull, "x-amz-checksum-type": "FULL_OBJECT" }, body: completeXml(cparts) }));
  if (w.status !== 200) {
    record("Q5", "  ListParts after rejected Complete", {}, await api("GET", k3, { query: { uploadId: u3 } }));
    record("Q5", "Complete CRC64NVME with correct full-object header", {}, await api("POST", k3, { query: { uploadId: u3 }, headers: { "x-amz-checksum-crc64nvme": full, "x-amz-checksum-type": "FULL_OBJECT" }, body: completeXml(cparts) }));
  }
  record("Q5", "HEAD mpu-crc64 checksum mode", {}, await api("HEAD", k3, { headers: { "x-amz-checksum-mode": "ENABLED" } }));
}

async function q6() {
  const body = bytes(3000);
  for (const mode of ["WHEN_SUPPORTED", "WHEN_REQUIRED"] as const) {
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${host}`,
      forcePathStyle: true,
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
      requestChecksumCalculation: mode,
      responseChecksumValidation: mode,
    });
    for (const variant of ["plain", "with-content-type", "with-ChecksumAlgorithm-CRC32C"] as const) {
      const k = key(`q6/sdk-${mode}-${variant}`);
      const input: ConstructorParameters<typeof PutObjectCommand>[0] = { Bucket: env.bucket, Key: k };
      if (variant !== "plain") input.ContentType = "application/octet-stream";
      if (variant === "with-ChecksumAlgorithm-CRC32C") input.ChecksumAlgorithm = "CRC32C";
      const url = await getSignedUrl(client, new PutObjectCommand(input), { expiresIn: 600 });
      const u = new URL(url);
      const checksumParams = Object.fromEntries([...u.searchParams].filter(([n]) => /checksum/i.test(n)));
      const headers: Record<string, string> = variant === "plain" ? {} : { "Content-Type": "application/octet-stream" };
      const r = await browserLike(url, "PUT", headers, body);
      record("Q6", `aws-sdk ${mode} ${variant}: plain browser PUT`, { ...pathOnly(url), checksumParams }, r);
    }
    client.destroy();
  }
  // aws4fetch presign, default and allHeaders.
  for (const allHeaders of [false, true]) {
    const k = key(`q6/aws4fetch-allHeaders-${allHeaders}`);
    const signed = await aws.sign(`https://${host}${objectPath(env, k)}?X-Amz-Expires=600`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      aws: { signQuery: true, allHeaders },
    });
    const r = await browserLike(signed.url, "PUT", { "Content-Type": "application/octet-stream" }, body);
    record("Q6", `aws4fetch signQuery allHeaders=${allHeaders}: browser PUT`, pathOnly(signed.url), r);
  }
}

async function q7() {
  const k = key("q7/expiry");
  const past = new Date(Date.now() - 60_000);
  const expired = presign({ env, method: "PUT", key: k, expires: 1, date: past });
  record("Q7", "expired presigned PUT with Origin", { origin: ORIGIN }, await browserLike(expired.url, "PUT", { Origin: ORIGIN }, bytes(10)));
  const expiredGet = presign({ env, method: "GET", key: k, expires: 1, date: past });
  record("Q7", "expired presigned GET with Origin", { origin: ORIGIN }, await browserLike(expiredGet.url, "GET", { Origin: ORIGIN }));
  const valid = presign({ env, method: "PUT", key: k, expires: 604800 });
  record("Q7", "expires=604800 (7 days) PUT with Origin", { origin: ORIGIN }, await browserLike(valid.url, "PUT", { Origin: ORIGIN }, bytes(10)));
  await sleep(1200);
  const over = presign({ env, method: "PUT", key: k, expires: 604801 });
  record("Q7", "expires=604801 PUT", {}, await browserLike(over.url, "PUT", {}, bytes(10)));
  const signedInFuture = presign({ env, method: "PUT", key: k, expires: 600, date: new Date(Date.now() + 30 * 60_000) });
  record("Q7", "X-Amz-Date 30 min in the future", {}, await browserLike(signedInFuture.url, "PUT", {}, bytes(10)));
}

async function q8() {
  record("Q8", "GetBucketCors", {}, await api("GET", "", { query: { cors: "" } }));
  const k = `${prefix}q8/preflight`;
  const url = `https://${host}${objectPath(env, k)}`;
  const publicOrigin = new URL(env.publicBase).origin;
  const preflights: [string, string, string, string][] = [
    ["PUT from localhost, content-type", ORIGIN, "PUT", "content-type"],
    ["PUT from localhost, no request headers", ORIGIN, "PUT", ""],
    ["PUT from localhost, x-amz-checksum-crc32c", ORIGIN, "PUT", "x-amz-checksum-crc32c"],
    ["GET from localhost", ORIGIN, "GET", ""],
    ["GET from the public origin", publicOrigin, "GET", "range"],
    ["PUT from the public origin", publicOrigin, "PUT", "content-type"],
  ];
  for (const [label, origin, method, reqHeaders] of preflights) {
    const headers: Record<string, string> = { Origin: origin, "Access-Control-Request-Method": method };
    if (reqHeaders) headers["Access-Control-Request-Headers"] = reqHeaders;
    const res = await fetch(url, { method: "OPTIONS", headers });
    record("Q8", `OPTIONS ${label}`, { origin: origin === ORIGIN ? origin : "<public-origin>", method, reqHeaders }, toRes(res.status, Object.fromEntries(res.headers), await res.text()));
  }
  // A real (non-preflight) presigned PUT carrying Origin: is ETag exposed?
  const k2 = key("q8/with-origin");
  const p = presign({ env, method: "PUT", key: k2, expires: 600 });
  record("Q8", "presigned PUT with Origin localhost (response CORS headers)", { origin: ORIGIN }, await browserLike(p.url, "PUT", { Origin: ORIGIN }, bytes(10)));
}

async function q9to11() {
  const k = key("q9/parallel");
  const uploadId = await createMpu(k, { "x-amz-meta-cloudrop-id": "spike-0001", "Content-Type": "application/x-cloudrop-test" });
  const bodies = Array.from({ length: 8 }, () => bytes(5 * MiB));
  const t0 = performance.now();
  const results = await Promise.all(
    bodies.map(async (b, i) => {
      const { url } = presign({ env, method: "PUT", key: k, expires: 600, query: { partNumber: String(i + 1), uploadId }, signedHeaders: { "content-length": String(b.length) } });
      const r = await browserLike(url, "PUT", {}, b);
      return { n: i + 1, r, ms: Math.round(performance.now() - t0) };
    }),
  );
  for (const { n, r, ms } of results) record("Q9", `parallel UploadPart ${n} (finished at ${ms} ms)`, {}, r);
  const statuses = results.map((x) => x.r.status);
  evidence.push({ q: "Q9", label: "parallel statuses", statuses });

  // Q10: ListParts with pagination.
  let marker = "0";
  for (let page = 1; page <= 4; page++) {
    const lp = record("Q10", `ListParts max-parts=3 page ${page}`, { partNumberMarker: marker }, await api("GET", k, { query: { uploadId, "max-parts": "3", "part-number-marker": marker } }));
    const next = /<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/.exec(lp.text)?.[1];
    if (!/<IsTruncated>true<\/IsTruncated>/.test(lp.text) || !next) break;
    marker = next;
  }

  // Q11: complete, then retry; HEAD for metadata.
  const parts = results.filter((x) => x.r.status === 200).map((x) => ({ n: x.n, etag: x.r.headers.etag }));
  const xml = completeXml(parts);
  record("Q11", "Complete (8 parts)", {}, await api("POST", k, { query: { uploadId }, body: xml }));
  const expected = md5hex(new Uint8Array(Buffer.concat(bodies.map((b) => Buffer.from(md5hex(b), "hex")))));
  evidence.push({ q: "Q11", label: "expected multipart etag", etag: `"${expected}-8"` });
  record("Q10", "ListParts after Complete", {}, await api("GET", k, { query: { uploadId } }));
  await sleep(1200);
  record("Q11", "Complete retried after success", {}, await api("POST", k, { query: { uploadId }, body: xml }));
  record("Q11", "HEAD after Complete", {}, await api("HEAD", k));
  record("Q11", "AbortMultipartUpload after Complete", {}, await api("DELETE", k, { query: { uploadId } }));

  // Same-key PutObject bursts.
  const kb = key("q9/burst");
  const seq: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await api("PUT", kb, { body: bytes(64) });
    seq.push(r.status);
    if (r.status !== 200) record("Q9", `sequential burst PUT ${i + 1}`, {}, r);
    await sleep(150);
  }
  log(`[Q9] sequential same-key PUT x5 within ~1 s: ${seq.join(",")}`);
  evidence.push({ q: "Q9", label: "sequential burst statuses", statuses: seq });
  await sleep(2000);
  const par = await Promise.all(Array.from({ length: 5 }, () => api("PUT", kb, { body: bytes(64) })));
  for (const [i, r] of par.entries()) if (r.status !== 200) record("Q9", `concurrent burst PUT ${i + 1}`, {}, r);
  log(`[Q9] concurrent same-key PUT x5: ${par.map((r) => r.status).join(",")}`);
  evidence.push({ q: "Q9", label: "concurrent burst statuses", statuses: par.map((r) => r.status) });
}

async function q12() {
  const k = key("q12/disposition.txt");
  const disposition = `attachment; filename="report.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`;
  const signedHeaders = { "content-type": "text/plain; charset=utf-8", "content-disposition": disposition };
  const { url, signedHeaderNames } = presign({ env, method: "PUT", key: k, expires: 600, signedHeaders });
  record("Q12", "presigned PUT with signed content-disposition", { signedHeaders: signedHeaderNames }, await browserLike(url, "PUT", signedHeaders, new TextEncoder().encode("cloudrop spike\n")));
  record("Q12", "same URL, content-disposition omitted", {}, await browserLike(url, "PUT", { "content-type": "text/plain; charset=utf-8" }, new TextEncoder().encode("x")));
  record("Q12", "GET via S3 endpoint", {}, await api("GET", k));
  const pub = await fetch(`${env.publicBase.replace(/\/$/, "")}/${k}`, { redirect: "manual" });
  record("Q12", "GET via public base", {}, toRes(pub.status, Object.fromEntries(pub.headers), (await pub.text()).slice(0, 200)));
}

async function q13(multipartKey: string) {
  const k = key("q13/single");
  record("Q13", "PUT single 8 KiB", {}, await api("PUT", k, { body: bytes(8192), headers: { "Content-Type": "application/pdf", "x-amz-meta-cloudrop-id": "single-1" } }));
  record("Q13", "ranged GET 0-4095 single", {}, await api("GET", k, { headers: { Range: "bytes=0-4095" } }));
  record("Q13", "HEAD single", {}, await api("HEAD", k));
  record("Q13", "ranged GET 0-4095 multipart", {}, await api("GET", multipartKey, { headers: { Range: "bytes=0-4095" } }));
  record("Q13", "HEAD multipart", {}, await api("HEAD", multipartKey));
  record("Q13", "HEAD multipart partNumber=1", {}, await api("HEAD", multipartKey, { query: { partNumber: "1" } }));
}

async function q14(multipartKey: string) {
  const src = key("q14/pending-src");
  await api("PUT", src, { body: bytes(4096), headers: { "Content-Type": "image/png", "Content-Disposition": 'inline; filename="a.png"', "x-amz-meta-cloudrop-id": "copy-1" } });
  const dst = key("q14/final-dst");
  record("Q14", "CopyObject (default directive)", {}, await api("PUT", dst, { headers: { "x-amz-copy-source": `/${env.bucket}/${src}` } }));
  record("Q14", "HEAD source", {}, await api("HEAD", src));
  record("Q14", "HEAD copy", {}, await api("HEAD", dst));
  const dst2 = key("q14/final-from-multipart");
  record("Q14", "CopyObject of a multipart source", {}, await api("PUT", dst2, { headers: { "x-amz-copy-source": `/${env.bucket}/${multipartKey}` } }));
  record("Q14", "HEAD copy of multipart", {}, await api("HEAD", dst2));
  const dst3 = key("q14/final-replace");
  record("Q14", "CopyObject REPLACE directive with new metadata", {}, await api("PUT", dst3, { headers: { "x-amz-copy-source": `/${env.bucket}/${src}`, "x-amz-metadata-directive": "REPLACE", "Content-Type": "image/png", "x-amz-meta-cloudrop-verified": "1" } }));
  record("Q14", "HEAD copy REPLACE", {}, await api("HEAD", dst3));
}

// Follow-ups added after the first run: checksum fields in ListParts, the default checksum on HEAD,
// recovery after an InvalidPart Complete, and CopyObject of a multipart source that carries metadata.
async function q15() {
  // a) CRC32C composite upload: ListParts fields, Complete with correct XML, HEAD of a part.
  const k = key("q15/crc32c");
  const uploadId = await createMpu(k, { "x-amz-checksum-algorithm": "CRC32C", "x-amz-checksum-type": "COMPOSITE" });
  const part1 = bytes(5 * MiB);
  const part2 = bytes(1000);
  const r1 = await putPart(k, uploadId, 1, part1, { "x-amz-checksum-crc32c": b64(crc32c(part1)) });
  const r2 = await putPart(k, uploadId, 2, part2, { "x-amz-checksum-crc32c": b64(crc32c(part2)) });
  record("Q15", "ListParts on a CRC32C upload", {}, await api("GET", k, { query: { uploadId } }));
  record("Q15", "Complete CRC32C without checksum elements in the XML", {}, await api("POST", k, { query: { uploadId }, body: completeXml([{ n: 1, etag: r1.headers.etag }, { n: 2, etag: r2.headers.etag }]) }));
  record("Q15", "HEAD partNumber=1 checksum mode", {}, await api("HEAD", k, { query: { partNumber: "1" }, headers: { "x-amz-checksum-mode": "ENABLED" } }));

  // b) Default upload (no algorithm): what does ListParts show?
  const k2 = key("q15/default");
  const u2 = await createMpu(k2);
  await putPart(k2, u2, 1, part2);
  record("Q15", "ListParts on an upload created without checksum algorithm", {}, await api("GET", k2, { query: { uploadId: u2 } }));
  // e) Wrong per-part CRC64NVME.
  record("Q15", "UploadPart with wrong x-amz-checksum-crc64nvme", {}, await putPart(k2, u2, 2, part2, { "x-amz-checksum-crc64nvme": b64(crc64nvme(part1.subarray(0, 10))) }));
  await api("DELETE", k2, { query: { uploadId: u2 } });

  // c) Default single PUT: HEAD with checksum mode.
  const k3 = key("q15/single-default");
  const body = bytes(4096);
  await api("PUT", k3, { body });
  record("Q15", "HEAD checksum mode on a PUT sent without checksum headers", { expectedCrc64nvme: b64(crc64nvme(body)) }, await api("HEAD", k3, { headers: { "x-amz-checksum-mode": "ENABLED" } }));

  // g) Recover after InvalidPart: re-upload the offending last part smaller, then Complete again.
  const k4 = key("q15/recover");
  const u4 = await createMpu(k4);
  const a = await putPart(k4, u4, 1, bytes(5 * MiB));
  const b = await putPart(k4, u4, 2, bytes(6 * MiB));
  record("Q15", "Complete [5,6] MiB", {}, await api("POST", k4, { query: { uploadId: u4 }, body: completeXml([{ n: 1, etag: a.headers.etag }, { n: 2, etag: b.headers.etag }]) }));
  const b2 = await putPart(k4, u4, 2, bytes(1 * MiB));
  record("Q15", "re-upload part 2 as 1 MiB", {}, b2);
  record("Q15", "Complete [5,1] MiB on the same upload id", {}, await api("POST", k4, { query: { uploadId: u4 }, body: completeXml([{ n: 1, etag: a.headers.etag }, { n: 2, etag: b2.headers.etag }]) }));

  // h) CopyObject of a multipart source with metadata and content type.
  const k5 = key("q15/mp-with-meta");
  const u5 = await createMpu(k5, { "Content-Type": "video/mp4", "x-amz-meta-cloudrop-id": "mp-meta-1", "Content-Disposition": "attachment" });
  const p = await putPart(k5, u5, 1, part2);
  await api("POST", k5, { query: { uploadId: u5 }, body: completeXml([{ n: 1, etag: p.headers.etag }]) });
  const k6 = key("q15/mp-copy");
  record("Q15", "CopyObject of a multipart source with metadata", {}, await api("PUT", k6, { headers: { "x-amz-copy-source": `/${env.bucket}/${k5}` } }));
  record("Q15", "HEAD multipart source", {}, await api("HEAD", k5));
  record("Q15", "HEAD copy", { md5OfContent: md5hex(part2) }, await api("HEAD", k6));
}

// Follow-up: the AWS SDK presigner's SignedHeaders was `host` even with ContentType set. Is a different
// Content-Type then accepted, and does `signableHeaders` change that?
async function q16() {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${host}`,
    forcePathStyle: true,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  for (const signable of [false, true]) {
    const k = key(`q16/sdk-signable-${signable}`);
    const cmd = new PutObjectCommand({ Bucket: env.bucket, Key: k, ContentType: "image/png", ContentLength: 64 });
    const url = await getSignedUrl(client, cmd, signable ? { expiresIn: 600, signableHeaders: new Set(["content-type", "content-length"]) } : { expiresIn: 600 });
    record("Q16", `aws-sdk ContentType=image/png signableHeaders=${signable}: PUT with text/plain`, pathOnly(url), await browserLike(url, "PUT", { "Content-Type": "text/plain" }, bytes(64)));
    await sleep(1200);
    record("Q16", `aws-sdk ContentType=image/png signableHeaders=${signable}: PUT with image/png, 65 bytes`, pathOnly(url), await browserLike(url, "PUT", { "Content-Type": "image/png" }, bytes(65)));
    record("Q16", "  HEAD", {}, await api("HEAD", k));
  }
  client.destroy();
}

// Follow-up: can Transfer-Encoding: chunked (no Content-Length) bypass a signed content-length?
async function q17() {
  const chunked = (payload: Uint8Array) => {
    const head = new TextEncoder().encode(`${payload.length.toString(16)}\r\n`);
    const tail = new TextEncoder().encode("\r\n0\r\n\r\n");
    return new Uint8Array([...head, ...payload, ...tail]);
  };
  const N = 1024;
  for (const [label, signedHeaders, size, extra] of [
    ["signed content-length=1024, chunked body of 4096, no Content-Length", { "content-length": String(N) }, 4096, []],
    ["signed content-length=1024, chunked body of 1024, Content-Length header omitted", { "content-length": String(N) }, N, []],
    ["signed content-length=1024, chunked 4096 plus a Content-Length: 1024 header", { "content-length": String(N) }, 4096, [["Content-Length", String(N)]]],
    ["only host signed, chunked body of 4096", {}, 4096, []],
  ] as const) {
    const k = key(`q17/${label.replace(/[^a-z0-9]+/gi, "-")}`);
    const { url, signedHeaderNames } = presign({ env, method: "PUT", key: k, expires: 600, signedHeaders });
    const r = await raw(url, "PUT", [["Transfer-Encoding", "chunked"], ...(extra as unknown as [string, string][])], chunked(bytes(size)), { timeoutMs: 20000 });
    record("Q17", label, { signedHeaders: signedHeaderNames }, r);
    record("Q17", "  HEAD", {}, await api("HEAD", k));
  }
}

// ---------------------------------------------------------------- main

const only = process.argv.slice(2).filter((a) => /^q\d+$/i.test(a)).map((a) => a.toLowerCase());
const want = (q: string) => only.length === 0 || only.includes(q);

log(`prefix: ${prefix}`);
log(`started: ${new Date().toISOString()} bun ${Bun.version}`);
try {
  if (want("q1")) await q1();
  if (want("q2")) await q2();
  if (want("q3")) await q3();
  let mpKey = "";
  if (want("q4") || want("q13") || want("q14")) mpKey = await q4();
  if (want("q5")) await q5();
  if (want("q6")) await q6();
  if (want("q7")) await q7();
  if (want("q8")) await q8();
  if (want("q9")) await q9to11();
  if (want("q12")) await q12();
  if (want("q13")) await q13(mpKey);
  if (want("q14")) await q14(mpKey);
  if (want("q15")) await q15();
  if (want("q16")) await q16();
  if (want("q17")) await q17();
  await cleanupAndExit(0, "done");
} catch (e) {
  log(`error: ${(e as Error).stack ?? e}`);
  await cleanupAndExit(1, "error");
}
