// CopyObject, UploadPartCopy and the bucket-configuration reads and writes of the fake R2.

import { stripQuotes, xmlBlocks } from "../../storage/xml.ts";
import {
  type Bytes,
  etagOf,
  type FakeBucket,
  type FakeRequest,
  findUpload,
  readHeaders,
  readPartNumber,
  type StoredObject,
} from "./bucket.ts";
import { errorResponse, noSuchUpload, preconditionFailed, xmlResponse } from "./responses.ts";

function copySource(bucket: FakeBucket, headers: Headers): StoredObject | Response {
  const [sourceBucket = "", ...sourceSegments] = (headers.get("x-amz-copy-source") ?? "").replace(/^\//, "").split("/");
  const source =
    decodeURIComponent(sourceBucket) === bucket.name
      ? bucket.objects.get(sourceSegments.map(decodeURIComponent).join("/"))
      : undefined;
  if (!source) return errorResponse(404, "NoSuchKey", "The copy source does not exist.");
  // Modelled on S3's documented CopyObject and UploadPartCopy precondition.
  const ifMatch = headers.get("x-amz-copy-source-if-match");
  if (ifMatch !== null && stripQuotes(ifMatch) !== source.etag) return preconditionFailed();
  return source;
}

function copiedRange(source: StoredObject, rangeHeader: string | null): Bytes | Response {
  if (rangeHeader === null) return source.body;
  const range = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
  const [start, end] = [Number(range?.[1]), Number(range?.[2])];
  if (!range || start > end || end >= source.body.length) {
    return errorResponse(400, "InvalidArgument", "The copy source range is malformed or outside the source object.");
  }
  return source.body.subarray(start, end + 1);
}

async function copyPart(
  bucket: FakeBucket,
  { key, query, headers }: FakeRequest,
  source: StoredObject,
): Promise<Response> {
  const upload = findUpload(bucket, key, query);
  if (!upload) return noSuchUpload();
  const partNumber = readPartNumber(query);
  if (partNumber instanceof Response) return partNumber;
  const body = copiedRange(source, headers.get("x-amz-copy-source-range"));
  if (body instanceof Response) return body;
  const etag = await etagOf(body);
  upload.parts.set(partNumber, { body, etag, checksumCrc32c: undefined, uploadedAt: bucket.now() });
  return xmlResponse(`<CopyPartResult><ETag>"${etag}"</ETag></CopyPartResult>`);
}

async function copyObject(bucket: FakeBucket, { key, headers }: FakeRequest, source: StoredObject): Promise<Response> {
  // R2 keeps type, disposition and metadata by default and drops what a REPLACE does not resend (spike Q14).
  const replaced = headers.get("x-amz-metadata-directive") === "REPLACE";
  // R2 also rewrites a multipart object's ETag to the plain content hash on copy (spike Q14).
  const etag = await etagOf(source.body);
  bucket.objects.set(key, {
    body: source.body,
    headers: replaced ? readHeaders(headers) : source.headers,
    etag,
    uploadedAt: bucket.now(),
  });
  return xmlResponse(`<CopyObjectResult><ETag>"${etag}"</ETag></CopyObjectResult>`);
}

/** A PUT with `x-amz-copy-source`: UploadPartCopy when it names an upload, CopyObject otherwise. */
export async function copy(bucket: FakeBucket, request: FakeRequest): Promise<Response> {
  const source = copySource(bucket, request.headers);
  if (source instanceof Response) return source;
  return request.query.has("uploadId") ? copyPart(bucket, request, source) : copyObject(bucket, request, source);
}

export function bucketConfig(bucket: FakeBucket, name: "cors" | "lifecycle"): Response {
  if (!bucket.config) return errorResponse(403, "AccessDenied", "Access Denied");
  const xml = bucket.config[name];
  if (xml !== undefined) return xmlResponse(xml);
  const code = name === "cors" ? "NoSuchCORSConfiguration" : "NoSuchLifecycleConfiguration";
  return errorResponse(404, code, "The bucket has no such configuration.");
}

// What S3 requires of each rule in the body: a CORS rule allows at least one origin and one method; a lifecycle rule
// has a status and a scope.
const SHAPES = {
  cors: { root: "CORSConfiguration", rule: "CORSRule", needs: [["AllowedOrigin"], ["AllowedMethod"]] },
  lifecycle: { root: "LifecycleConfiguration", rule: "Rule", needs: [["Status"], ["Filter", "Prefix"]] },
} as const;

function wellFormed(xml: string, name: "cors" | "lifecycle"): boolean {
  const { root, rule, needs } = SHAPES[name];
  const rules = xmlBlocks(xmlBlocks(xml, root)[0] ?? "", rule);
  return rules.length > 0 && rules.every((each) => needs.every((tags) => tags.some((tag) => each.includes(`<${tag}`))));
}

/**
 * PutBucketCors and PutBucketLifecycleConfiguration: the body replaces the whole configuration, as S3 documents. Refused
 * like the reads when the bucket models an object token (no `bucketConfig`). S3 requires an integrity checksum on both
 * (Content-MD5 or x-amz-checksum-*); R2's answer without one is unmeasured, so the fake follows S3 and checks SHA-256.
 */
export async function putBucketConfig(
  bucket: FakeBucket,
  name: "cors" | "lifecycle",
  { headers, body }: FakeRequest,
): Promise<Response> {
  if (!bucket.config) return errorResponse(403, "AccessDenied", "Access Denied");
  const sha256 = headers.get("x-amz-checksum-sha256");
  if (sha256 === null) {
    return errorResponse(400, "InvalidRequest", "Missing required header for this request: Content-MD5");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  if (sha256 !== btoa(String.fromCharCode(...digest))) {
    return errorResponse(400, "BadDigest", "The SHA256 you specified did not match the calculated checksum.");
  }
  const xml = new TextDecoder().decode(body).replace(/^<\?xml[^>]*\?>/, "");
  if (!wellFormed(xml, name)) return errorResponse(400, "MalformedXML", "The XML you provided was not well-formed.");
  bucket.config[name] = xml;
  return new Response(null, { status: 200 });
}
