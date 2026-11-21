// Single-object operations and ListObjectsV2 of the fake R2.

import { escapeXml } from "../../storage/xml.ts";
import {
  checksumMismatch,
  etagOf,
  type FakeBucket,
  type FakeRequest,
  MAX_LIST_PAGE,
  META_PREFIX,
  objectId,
  readHeaders,
  type StoredObject,
} from "./bucket.ts";
import { errorResponse, preconditionFailed, xmlResponse } from "./responses.ts";

const utf8 = new TextEncoder();

// S3 lists keys in UTF-8 byte order, which differs from JavaScript's UTF-16 order for astral characters.
function compareKeys(a: string, b: string): number {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return (left[index] as number) - (right[index] as number);
  }
  return left.length - right.length;
}

export async function putObject(bucket: FakeBucket, { key, headers, body }: FakeRequest): Promise<Response> {
  const badChecksum = checksumMismatch(headers, body);
  if (badChecksum) return badChecksum;
  // Honoured even when unsigned (spike Q3).
  if (headers.get("if-none-match") === "*" && bucket.objects.has(objectId(key))) return preconditionFailed();
  const etag = await etagOf(body);
  bucket.objects.set(objectId(key), { key, body, headers: readHeaders(headers), etag, uploadedAt: bucket.now() });
  return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
}

function objectHeaders(object: StoredObject): Headers {
  const headers = new Headers({
    etag: `"${object.etag}"`,
    "last-modified": object.uploadedAt.toUTCString(),
    "content-length": String(object.body.length),
  });
  if (object.headers.type) headers.set("content-type", object.headers.type);
  if (object.headers.disposition) headers.set("content-disposition", object.headers.disposition);
  for (const [name, value] of Object.entries(object.headers.metadata)) {
    headers.set(`${META_PREFIX}${name}`, value);
  }
  if (object.partCount) headers.set("x-amz-mp-parts-count", String(object.partCount));
  return headers;
}

// The types R2 compressed in "HEAD and compression" (r2-spike-findings.md). Every other type is left alone, as the
// measured binary types and text/csv were.
const COMPRESSED_TYPES = new Set([
  "text/plain",
  "text/html",
  "text/markdown",
  "application/json",
  "application/javascript",
  "application/xml",
  "image/svg+xml",
  "font/ttf",
  "application/wasm",
]);
const SMALLEST_COMPRESSED = 50;

/**
 * R2 answers HEAD of a compressible object of 50 bytes or more with `content-encoding: gzip` and no `content-length`
 * unless the request asks for `identity`. A request without the header counts as offering gzip, as it reaches R2 from
 * Node's and Bun's fetch, which add `accept-encoding: gzip, …` when the caller sets none.
 */
function compressedHead(object: StoredObject, request: Headers, headers: Headers): Headers {
  const type = object.headers.type?.split(";")[0]?.trim().toLowerCase() ?? "";
  const wanted = request.get("accept-encoding")?.trim().toLowerCase();
  if (!COMPRESSED_TYPES.has(type) || object.body.length < SMALLEST_COMPRESSED || wanted === "identity") return headers;
  headers.delete("content-length");
  headers.set("content-encoding", "gzip");
  return headers;
}

function bodyResponse(object: StoredObject, rangeHeader: string | null, headers: Headers): Response {
  // Only closed ranges (bytes=a-b) are served. Open-ended and suffix forms are ignored and answer the whole object,
  // which RFC 9110 allows; the driver validates and sends closed ranges only.
  const range = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader ?? "");
  if (!range) return new Response(object.body, { status: 200, headers });
  const start = Number(range[1]);
  if (start >= object.body.length || Number(range[2]) < start) {
    return errorResponse(416, "InvalidRange", "The requested range is not satisfiable.");
  }
  const end = Math.min(Number(range[2]), object.body.length - 1);
  const slice = object.body.subarray(start, end + 1);
  headers.set("content-range", `bytes ${start}-${end}/${object.body.length}`);
  headers.set("content-length", String(slice.length));
  return new Response(slice, { status: 206, headers });
}

export function getObject(bucket: FakeBucket, { key, method, headers, query }: FakeRequest): Response {
  const object = bucket.objects.get(objectId(key));
  if (!object) {
    return method === "HEAD"
      ? new Response(null, { status: 404 })
      : errorResponse(404, "NoSuchKey", "The specified key does not exist.");
  }
  const responseHeaders = objectHeaders(object);
  if (method === "HEAD") {
    return new Response(null, { status: 200, headers: compressedHead(object, headers, responseHeaders) });
  }
  // S3's documented GetObject override; real R2 is checked by the contract suite on every backend.
  const disposition = query.get("response-content-disposition");
  if (disposition !== null) responseHeaders.set("content-disposition", disposition);
  return bodyResponse(object, headers.get("range"), responseHeaders);
}

export function deleteObject(bucket: FakeBucket, { key }: FakeRequest): Response {
  bucket.objects.delete(objectId(key));
  return new Response(null, { status: 204 });
}

export function listObjects(bucket: FakeBucket, { query }: FakeRequest): Response {
  // Matched and ordered by the stored form, so a prefix in either Unicode form finds the object.
  const prefix = objectId(query.get("prefix") ?? "");
  const token = query.get("continuation-token");
  const after = token === null ? "" : bucket.listTokens.get(token);
  if (after === undefined) return errorResponse(400, "InvalidArgument", "The continuation token is not valid.");
  const max = Math.min(Number(query.get("max-keys") ?? MAX_LIST_PAGE), MAX_LIST_PAGE);
  const matching = Array.from(bucket.objects)
    .filter(([key]) => key.startsWith(prefix) && (after === "" || compareKeys(key, after) > 0))
    .sort(([a], [b]) => compareKeys(a, b));
  const page = matching.slice(0, max);
  const truncated = matching.length > max;
  const contents = page
    .map(
      ([, object]) =>
        `<Contents><Key>${escapeXml(object.key)}</Key><Size>${object.body.length}</Size><ETag>"${object.etag}"</ETag><LastModified>${object.uploadedAt.toISOString()}</LastModified></Contents>`,
    )
    .join("");
  const nextToken = `fake-token-${bucket.listTokens.size + 1}`;
  if (truncated) bucket.listTokens.set(nextToken, page.at(-1)?.[0] ?? "");
  const next = truncated ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "";
  return xmlResponse(`<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`);
}
