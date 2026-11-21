// Multipart upload operations of the fake R2: create, upload a part, list parts, complete and abort.

import { R2_RULES } from "../../rules.ts";
import { escapeXml, stripQuotes, xmlBlocks, xmlText } from "../../storage/xml.ts";
import {
  type Bytes,
  checksumMismatch,
  etagOf,
  type FakeBucket,
  type FakeRequest,
  findUpload,
  MAX_LIST_PAGE,
  objectId,
  type PendingUpload,
  readHeaders,
  readPartNumber,
  type StoredPart,
} from "./bucket.ts";
import { errorResponse, noSuchUpload, preconditionFailed, xmlResponse } from "./responses.ts";

const utf8 = new TextEncoder();

function concat(chunks: Bytes[]): Bytes {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function createUpload(bucket: FakeBucket, { key, headers }: FakeRequest): Response {
  bucket.uploadCounter += 1;
  // Real upload IDs are opaque; this one needs URL encoding, so a client that forgets it fails here.
  const uploadId = `fake/upload+${bucket.uploadCounter}==`;
  bucket.uploads.set(uploadId, { key, headers: readHeaders(headers), parts: new Map() });
  return xmlResponse(
    `<InitiateMultipartUploadResult><Bucket>${escapeXml(bucket.name)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${escapeXml(uploadId)}</UploadId></InitiateMultipartUploadResult>`,
  );
}

export async function uploadPart(bucket: FakeBucket, { key, query, headers, body }: FakeRequest): Promise<Response> {
  const upload = findUpload(bucket, key, query);
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
    uploadedAt: bucket.now(),
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

// The stored parts the CompleteMultipartUpload body names, in its order.
function requestedParts(upload: PendingUpload, body: Bytes): StoredPart[] | Response {
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
  return parts;
}

export async function completeUpload(
  bucket: FakeBucket,
  { key, query, headers, body }: FakeRequest,
): Promise<Response> {
  const uploadId = query.get("uploadId") ?? "";
  const upload = findUpload(bucket, key, query);
  if (!upload) return noSuchUpload();
  const parts = requestedParts(upload, body);
  if (parts instanceof Response) return parts;
  const sizeFailure = partSizeFailure(parts);
  if (sizeFailure) return sizeFailure;
  // A failed conditional Complete discards the upload (spike Q3).
  if (headers.get("if-none-match") === "*" && bucket.objects.has(objectId(key))) {
    bucket.uploads.delete(uploadId);
    return preconditionFailed();
  }
  const etag = `${await etagOf(utf8.encode(parts.map((part) => part.etag).join("")))}-${parts.length}`;
  bucket.objects.set(objectId(key), {
    key,
    body: concat(parts.map((part) => part.body)),
    headers: upload.headers,
    etag,
    uploadedAt: bucket.now(),
    partCount: parts.length,
  });
  bucket.uploads.delete(uploadId);
  return xmlResponse(
    `<CompleteMultipartUploadResult><Bucket>${escapeXml(bucket.name)}</Bucket><Key>${escapeXml(key)}</Key><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`,
  );
}

export function listParts(bucket: FakeBucket, { key, query }: FakeRequest): Response {
  const upload = findUpload(bucket, key, query);
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

export function abortUpload(bucket: FakeBucket, { key, query }: FakeRequest): Response {
  // Real R2 answers 204 even after the upload completed (spike Q11), where AWS S3 answers 404.
  if (findUpload(bucket, key, query)) bucket.uploads.delete(query.get("uploadId") ?? "");
  return new Response(null, { status: 204 });
}
