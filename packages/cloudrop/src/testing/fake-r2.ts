// In-process fake of the R2 S3 API with the behaviour measured on real R2 (docs/research/r2-spike-findings.md).
// It re-signs requests with cloudrop's own signer, so it proves R2's rules (signed headers, expiry, part sizes),
// never the signer itself: sigv4.test.ts (AWS vectors, aws4fetch) and the RustFS, Wrangler and R2 lanes do that.

import { crc32cBase64 } from "../checksum.ts";
import { R2_RULES } from "../rules.ts";
import type { FetchLike } from "../storage/driver.ts";
import { type Credentials, presignUrl, sha256Hex, signRequest, UNSIGNED_PAYLOAD } from "../storage/sigv4.ts";
import { escapeXml, stripQuotes, xmlBlocks, xmlText } from "../storage/xml.ts";

export interface FakeR2Options {
  bucket: string;
  credentials: Credentials;
  now?: () => Date;
}

export interface FakeR2 {
  fetch: FetchLike;
  pendingUploads(): number;
}

type Bytes = Uint8Array<ArrayBuffer>;

interface StoredHeaders {
  type: string | undefined;
  disposition: string | undefined;
  metadata: Record<string, string>;
}

interface StoredObject {
  body: Bytes;
  headers: StoredHeaders;
  etag: string;
  uploadedAt: Date;
  partCount?: number;
}

interface StoredPart {
  body: Bytes;
  etag: string;
  checksumCrc32c: string | undefined;
  uploadedAt: Date;
}

interface PendingUpload {
  key: string;
  headers: StoredHeaders;
  parts: Map<number, StoredPart>;
}

const XML_HEADERS = { "content-type": "application/xml" };
const META_PREFIX = "x-amz-meta-";
// S3 rejects a request dated further ahead than this; the spike measured 30 minutes ahead (Q7).
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
const MAX_LIST_PAGE = 1000;
const utf8 = new TextEncoder();

function xmlResponse(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: XML_HEADERS });
}

function errorResponse(status: number, code: string, message: string): Response {
  return xmlResponse(`<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`, status);
}

const noSuchUpload = (): Response =>
  errorResponse(404, "NoSuchUpload", "The specified multipart upload does not exist.");
const clockSkewed = (): Response =>
  errorResponse(
    403,
    "RequestTimeTooSkewed",
    "The difference between the request time and the server time is too large.",
  );
const preconditionFailed = (): Response =>
  errorResponse(412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold.");

function parseAmzDate(value: string): Date {
  return new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );
}

async function etagOf(body: Bytes): Promise<string> {
  return (await sha256Hex(body)).slice(0, 32);
}

function concat(chunks: Bytes[]): Bytes {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// S3 lists keys in UTF-8 byte order, which differs from JavaScript's UTF-16 order for astral characters.
function compareKeys(a: string, b: string): number {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return (left[index] as number) - (right[index] as number);
  }
  return left.length - right.length;
}

// The signer canonicalises from URLSearchParams, which reads "+" as a space. S3 reads the query as written, where "+"
// is a literal plus, so a request whose query differs from the signed one only in encoding must fail the signature.
// Rebuilding the pairs with decodeURIComponent alone makes the signer see the query the way S3 does.
function queryAsWritten(url: URL): URL {
  const params = new URLSearchParams();
  for (const pair of url.search.slice(1).split("&")) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    params.append(
      decodeURIComponent(at < 0 ? pair : pair.slice(0, at)),
      at < 0 ? "" : decodeURIComponent(pair.slice(at + 1)),
    );
  }
  const rebuilt = new URL(url);
  rebuilt.search = params.toString();
  return rebuilt;
}

function readHeaders(headers: Headers): StoredHeaders {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith(META_PREFIX)) metadata[name.slice(META_PREFIX.length)] = value;
  });
  return {
    type: headers.get("content-type") ?? undefined,
    disposition: headers.get("content-disposition") ?? undefined,
    metadata,
  };
}

function checksumMismatch(headers: Headers, body: Bytes): Response | null {
  const expected = headers.get("x-amz-checksum-crc32c");
  if (expected === null || expected === crc32cBase64(body)) return null;
  return errorResponse(400, "BadDigest", "The CRC32C you specified did not match the calculated checksum.");
}

export function createFakeR2(options: FakeR2Options): FakeR2 {
  const now = options.now ?? (() => new Date());
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, PendingUpload>();
  const listTokens = new Map<string, string>();
  let uploadCounter = 0;

  // A signed content-length is the body's real length: fetch derives the header from the body, so the fake does too.
  function signedHeaderValue(request: Request, name: string, body: Bytes): string | null {
    return name === "content-length" ? String(body.length) : request.headers.get(name);
  }

  async function verifyPresigned(request: Request, url: URL, body: Bytes): Promise<Response | null> {
    const query = url.searchParams;
    const signedAt = parseAmzDate(query.get("X-Amz-Date") ?? "");
    const expires = Number(query.get("X-Amz-Expires"));
    if (Number.isNaN(signedAt.getTime())) {
      return errorResponse(400, "AuthorizationQueryParametersError", "X-Amz-Date is missing or malformed.");
    }
    if (!Number.isInteger(expires) || expires < 1 || expires > R2_RULES.maxPresignSeconds) {
      return errorResponse(400, "InvalidArgument", "X-Amz-Expires must be between 1 and 604800 seconds.");
    }
    if (signedAt.getTime() - now().getTime() > MAX_CLOCK_SKEW_MS) return clockSkewed();
    if (now().getTime() > signedAt.getTime() + expires * 1000) {
      return errorResponse(403, "ExpiredRequest", "Request has expired.");
    }
    const signedNames = (query.get("X-Amz-SignedHeaders") ?? "").split(";");
    const headers: Record<string, string> = {};
    for (const name of signedNames) {
      if (name === "host") continue;
      const value = signedHeaderValue(request, name, body);
      if (value === null) return errorResponse(403, "SignatureDoesNotMatch", `Signed header ${name} is missing.`);
      headers[name] = value;
    }
    // Measured on real R2 for a presigned PUT only (live lane, 2026-11-15, spike row 18): an x-amz-meta-* header the
    // URL did not sign fails the signature. Other methods were not measured, so the fake does not assert it for them.
    const unsignedMeta =
      request.method === "PUT" &&
      [...request.headers.keys()].find((name) => name.startsWith(META_PREFIX) && !signedNames.includes(name));
    if (unsignedMeta) return errorResponse(403, "SignatureDoesNotMatch", `Header ${unsignedMeta} is not signed.`);
    const unsigned = new URL(url);
    for (const name of Array.from(unsigned.searchParams.keys())) {
      if (name.startsWith("X-Amz-")) unsigned.searchParams.delete(name);
    }
    const expected = await presignUrl({
      method: request.method,
      url: unsigned,
      headers,
      credentials: options.credentials,
      region: (query.get("X-Amz-Credential") ?? "").split("/")[2] ?? "",
      date: signedAt,
      expiresIn: expires,
    });
    if (expected.searchParams.get("X-Amz-Signature") === query.get("X-Amz-Signature")) return null;
    return errorResponse(403, "SignatureDoesNotMatch", "The request signature does not match.");
  }

  async function verifyHeaderSigned(request: Request, url: URL, body: Bytes): Promise<Response | null> {
    const authorization = request.headers.get("authorization");
    if (!authorization) return errorResponse(403, "AccessDenied", "The request is not signed.");
    const signedAt = parseAmzDate(request.headers.get("x-amz-date") ?? "");
    if (Number.isNaN(signedAt.getTime())) {
      return errorResponse(403, "SignatureDoesNotMatch", "X-Amz-Date is missing or malformed.");
    }
    // A header-signed request has no expiry, so both a stale and a future date are skew.
    if (Math.abs(signedAt.getTime() - now().getTime()) > MAX_CLOCK_SKEW_MS) return clockSkewed();
    const payloadHash = request.headers.get("x-amz-content-sha256") ?? "";
    if (payloadHash !== UNSIGNED_PAYLOAD && payloadHash !== (await sha256Hex(body))) {
      return errorResponse(400, "XAmzContentSHA256Mismatch", "The payload hash does not match the body.");
    }
    const headers: Record<string, string> = {};
    for (const name of /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(";") ?? []) {
      if (name === "host" || name === "x-amz-date" || name === "x-amz-content-sha256") continue;
      const value = signedHeaderValue(request, name, body);
      if (value === null) return errorResponse(403, "SignatureDoesNotMatch", `Signed header ${name} is missing.`);
      headers[name] = value;
    }
    const expected = await signRequest({
      method: request.method,
      url,
      headers,
      credentials: options.credentials,
      region: /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(authorization)?.[1] ?? "",
      date: signedAt,
      payloadHash,
    });
    if (expected.authorization === authorization) return null;
    return errorResponse(403, "SignatureDoesNotMatch", "The request signature does not match.");
  }

  async function putObject(key: string, headers: Headers, body: Bytes): Promise<Response> {
    const badChecksum = checksumMismatch(headers, body);
    if (badChecksum) return badChecksum;
    // Honoured even when unsigned (spike Q3).
    if (headers.get("if-none-match") === "*" && objects.has(key)) return preconditionFailed();
    const etag = await etagOf(body);
    objects.set(key, { body, headers: readHeaders(headers), etag, uploadedAt: now() });
    return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
  }

  function getObject(key: string, method: string, headers: Headers): Response {
    const object = objects.get(key);
    if (!object) {
      return method === "HEAD"
        ? new Response(null, { status: 404 })
        : errorResponse(404, "NoSuchKey", "The specified key does not exist.");
    }
    const responseHeaders = new Headers({
      etag: `"${object.etag}"`,
      "last-modified": object.uploadedAt.toUTCString(),
      "content-length": String(object.body.length),
    });
    if (object.headers.type) responseHeaders.set("content-type", object.headers.type);
    if (object.headers.disposition) responseHeaders.set("content-disposition", object.headers.disposition);
    for (const [name, value] of Object.entries(object.headers.metadata)) {
      responseHeaders.set(`${META_PREFIX}${name}`, value);
    }
    if (object.partCount) responseHeaders.set("x-amz-mp-parts-count", String(object.partCount));
    if (method === "HEAD") return new Response(null, { status: 200, headers: responseHeaders });
    // Only closed ranges (bytes=a-b) are served. Open-ended and suffix forms are ignored and answer the whole object,
    // which RFC 9110 allows; the driver validates and sends closed ranges only.
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
    if (!range) return new Response(object.body, { status: 200, headers: responseHeaders });
    const start = Number(range[1]);
    if (start >= object.body.length || Number(range[2]) < start) {
      return errorResponse(416, "InvalidRange", "The requested range is not satisfiable.");
    }
    const end = Math.min(Number(range[2]), object.body.length - 1);
    const slice = object.body.subarray(start, end + 1);
    responseHeaders.set("content-range", `bytes ${start}-${end}/${object.body.length}`);
    responseHeaders.set("content-length", String(slice.length));
    return new Response(slice, { status: 206, headers: responseHeaders });
  }

  function createUpload(key: string, headers: Headers): Response {
    uploadCounter += 1;
    // Real upload IDs are opaque; this one needs URL encoding, so a client that forgets it fails here.
    const uploadId = `fake/upload+${uploadCounter}==`;
    uploads.set(uploadId, { key, headers: readHeaders(headers), parts: new Map() });
    return xmlResponse(
      `<InitiateMultipartUploadResult><Bucket>${escapeXml(options.bucket)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${escapeXml(uploadId)}</UploadId></InitiateMultipartUploadResult>`,
    );
  }

  function findUpload(key: string, query: URLSearchParams): PendingUpload | undefined {
    const upload = uploads.get(query.get("uploadId") ?? "");
    return upload && upload.key === key ? upload : undefined;
  }

  function readPartNumber(query: URLSearchParams): number | Response {
    const partNumber = Number(query.get("partNumber"));
    if (Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= R2_RULES.maxParts) return partNumber;
    return errorResponse(400, "InvalidArgument", "Part number must be an integer between 1 and 10000.");
  }

  async function uploadPart(key: string, query: URLSearchParams, headers: Headers, body: Bytes): Promise<Response> {
    const upload = findUpload(key, query);
    if (!upload) return noSuchUpload();
    const badChecksum = checksumMismatch(headers, body);
    if (badChecksum) return badChecksum;
    const partNumber = readPartNumber(query);
    if (partNumber instanceof Response) return partNumber;
    const etag = await etagOf(body);
    upload.parts.set(partNumber, {
      body,
      etag,
      checksumCrc32c: headers.get("x-amz-checksum-crc32c") ?? undefined,
      uploadedAt: now(),
    });
    return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
  }

  // The part-size rules are checked only here, never at UploadPart, and a failure keeps the upload alive (spike Q4).
  function partSizeFailure(parts: StoredPart[]): Response | null {
    const firstSize = parts[0]?.body.length ?? 0;
    for (const [index, part] of parts.entries()) {
      const isLast = index === parts.length - 1;
      if (!isLast && part.body.length < R2_RULES.minPartSize) {
        return errorResponse(
          400,
          "EntityTooSmall",
          "Your proposed upload is smaller than the minimum allowed object size.",
        );
      }
      // Every part but the last must equal the first; the last may be smaller, never larger (spike Q4).
      if (isLast ? part.body.length > firstSize : part.body.length !== firstSize) {
        return errorResponse(400, "InvalidPart", "All non-trailing parts must have the same length.");
      }
    }
    return null;
  }

  async function complete(key: string, query: URLSearchParams, headers: Headers, body: Bytes): Promise<Response> {
    const uploadId = query.get("uploadId") ?? "";
    const upload = findUpload(key, query);
    if (!upload) return noSuchUpload();
    const requested = xmlBlocks(new TextDecoder().decode(body), "Part").map((block) => ({
      partNumber: Number(xmlText(block, "PartNumber")),
      etag: stripQuotes(xmlText(block, "ETag") ?? ""),
    }));
    if (requested.length === 0) return errorResponse(400, "MalformedXML", "The request lists no parts.");
    const parts: StoredPart[] = [];
    let previousNumber = 0;
    for (const item of requested) {
      if (item.partNumber <= previousNumber) {
        return errorResponse(400, "InvalidPartOrder", "Parts must be listed in ascending order.");
      }
      previousNumber = item.partNumber;
      const part = upload.parts.get(item.partNumber);
      if (!part || part.etag !== item.etag) {
        return errorResponse(400, "InvalidPart", `Part ${item.partNumber} was not found or its ETag does not match.`);
      }
      parts.push(part);
    }
    const sizeFailure = partSizeFailure(parts);
    if (sizeFailure) return sizeFailure;
    // A failed conditional Complete discards the upload (spike Q3).
    if (headers.get("if-none-match") === "*" && objects.has(key)) {
      uploads.delete(uploadId);
      return preconditionFailed();
    }
    const etag = `${await etagOf(utf8.encode(parts.map((part) => part.etag).join("")))}-${parts.length}`;
    objects.set(key, {
      body: concat(parts.map((part) => part.body)),
      headers: upload.headers,
      etag,
      uploadedAt: now(),
      partCount: parts.length,
    });
    uploads.delete(uploadId);
    return xmlResponse(
      `<CompleteMultipartUploadResult><Bucket>${escapeXml(options.bucket)}</Bucket><Key>${escapeXml(key)}</Key><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`,
    );
  }

  function listParts(key: string, query: URLSearchParams): Response {
    const upload = findUpload(key, query);
    if (!upload) return noSuchUpload();
    const max = Math.min(Number(query.get("max-parts") ?? MAX_LIST_PAGE), MAX_LIST_PAGE);
    const marker = Number(query.get("part-number-marker") ?? 0);
    const remaining = Array.from(upload.parts)
      .filter(([number]) => number > marker)
      .sort(([a], [b]) => a - b);
    const page = remaining.slice(0, max);
    const truncated = remaining.length > max;
    const parts = page
      .map(([number, part]) => {
        const checksum = part.checksumCrc32c ? `<ChecksumCRC32C>${part.checksumCrc32c}</ChecksumCRC32C>` : "";
        return `<Part><PartNumber>${number}</PartNumber><ETag>"${part.etag}"</ETag><Size>${part.body.length}</Size><LastModified>${part.uploadedAt.toISOString()}</LastModified>${checksum}</Part>`;
      })
      .join("");
    const next = truncated ? `<NextPartNumberMarker>${page.at(-1)?.[0] ?? marker}</NextPartNumberMarker>` : "";
    return xmlResponse(`<ListPartsResult><IsTruncated>${truncated}</IsTruncated>${next}${parts}</ListPartsResult>`);
  }

  async function copy(key: string, query: URLSearchParams, headers: Headers): Promise<Response> {
    const [sourceBucket = "", ...sourceSegments] = (headers.get("x-amz-copy-source") ?? "")
      .replace(/^\//, "")
      .split("/");
    const source =
      decodeURIComponent(sourceBucket) === options.bucket
        ? objects.get(sourceSegments.map(decodeURIComponent).join("/"))
        : undefined;
    if (!source) return errorResponse(404, "NoSuchKey", "The copy source does not exist.");
    // Modelled on S3's documented CopyObject and UploadPartCopy precondition.
    const ifMatch = headers.get("x-amz-copy-source-if-match");
    if (ifMatch !== null && stripQuotes(ifMatch) !== source.etag) return preconditionFailed();
    if (query.has("uploadId")) {
      const upload = findUpload(key, query);
      if (!upload) return noSuchUpload();
      const partNumber = readPartNumber(query);
      if (partNumber instanceof Response) return partNumber;
      let body = source.body;
      const rangeHeader = headers.get("x-amz-copy-source-range");
      if (rangeHeader !== null) {
        const range = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
        const [start, end] = [Number(range?.[1]), Number(range?.[2])];
        if (!range || start > end || end >= source.body.length) {
          return errorResponse(
            400,
            "InvalidArgument",
            "The copy source range is malformed or outside the source object.",
          );
        }
        body = source.body.subarray(start, end + 1);
      }
      const etag = await etagOf(body);
      upload.parts.set(partNumber, { body, etag, checksumCrc32c: undefined, uploadedAt: now() });
      return xmlResponse(`<CopyPartResult><ETag>"${etag}"</ETag></CopyPartResult>`);
    }
    // R2 keeps type, disposition and metadata by default and drops what a REPLACE does not resend (spike Q14).
    const replaced = headers.get("x-amz-metadata-directive") === "REPLACE";
    // R2 also rewrites a multipart object's ETag to the plain content hash on copy (spike Q14).
    const etag = await etagOf(source.body);
    objects.set(key, {
      body: source.body,
      headers: replaced ? readHeaders(headers) : source.headers,
      etag,
      uploadedAt: now(),
    });
    return xmlResponse(`<CopyObjectResult><ETag>"${etag}"</ETag></CopyObjectResult>`);
  }

  function listObjects(query: URLSearchParams): Response {
    const prefix = query.get("prefix") ?? "";
    const token = query.get("continuation-token");
    const after = token === null ? "" : listTokens.get(token);
    if (after === undefined) return errorResponse(400, "InvalidArgument", "The continuation token is not valid.");
    const max = Math.min(Number(query.get("max-keys") ?? MAX_LIST_PAGE), MAX_LIST_PAGE);
    const matching = Array.from(objects)
      .filter(([key]) => key.startsWith(prefix) && (after === "" || compareKeys(key, after) > 0))
      .sort(([a], [b]) => compareKeys(a, b));
    const page = matching.slice(0, max);
    const truncated = matching.length > max;
    const contents = page
      .map(
        ([key, object]) =>
          `<Contents><Key>${escapeXml(key)}</Key><Size>${object.body.length}</Size><ETag>"${object.etag}"</ETag><LastModified>${object.uploadedAt.toISOString()}</LastModified></Contents>`,
      )
      .join("");
    const nextToken = `fake-token-${listTokens.size + 1}`;
    if (truncated) listTokens.set(nextToken, page.at(-1)?.[0] ?? "");
    const next = truncated ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "";
    return xmlResponse(
      `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`,
    );
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, bucketSegment = "", ...keySegments] = url.pathname.split("/");
    if (decodeURIComponent(bucketSegment) !== options.bucket) {
      return errorResponse(404, "NoSuchBucket", "The specified bucket does not exist.");
    }
    const key = keySegments.map(decodeURIComponent).join("/");
    const body: Bytes = new Uint8Array(await request.arrayBuffer());
    let writtenUrl: URL;
    try {
      writtenUrl = queryAsWritten(url);
    } catch {
      return errorResponse(400, "InvalidURI", "The query string is not valid percent-encoding.");
    }
    const denied = url.searchParams.has("X-Amz-Signature")
      ? await verifyPresigned(request, writtenUrl, body)
      : await verifyHeaderSigned(request, writtenUrl, body);
    if (denied) return denied;

    const query = url.searchParams;
    const { method, headers } = request;
    if (method === "GET" && key === "" && query.get("list-type") === "2") return listObjects(query);
    if (method === "POST" && query.has("uploads")) return createUpload(key, headers);
    if (method === "PUT" && headers.has("x-amz-copy-source")) return copy(key, query, headers);
    if (method === "PUT" && query.has("uploadId")) return uploadPart(key, query, headers, body);
    if (method === "POST" && query.has("uploadId")) return complete(key, query, headers, body);
    if (method === "GET" && query.has("uploadId")) return listParts(key, query);
    if (method === "DELETE" && query.has("uploadId")) {
      // Real R2 answers 204 even after the upload completed (spike Q11), where AWS S3 answers 404.
      if (findUpload(key, query)) uploads.delete(query.get("uploadId") ?? "");
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") return putObject(key, headers, body);
    if (method === "GET" || method === "HEAD") return getObject(key, method, headers);
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return errorResponse(501, "NotImplemented", `${method} is not implemented by the fake.`);
  }

  return {
    fetch: (input, init) => handle(new Request(input, init)),
    pendingUploads: () => uploads.size,
  };
}
