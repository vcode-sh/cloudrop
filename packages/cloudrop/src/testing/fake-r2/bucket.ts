// The fake bucket's state and the helpers every operation shares.

import { crc32cBase64 } from "../../checksum.ts";
import { R2_RULES } from "../../rules.ts";
import { type Credentials, sha256Hex } from "../../storage/sigv4.ts";
import { errorResponse } from "./responses.ts";

export type Bytes = Uint8Array<ArrayBuffer>;

export interface StoredHeaders {
  type: string | undefined;
  disposition: string | undefined;
  metadata: Record<string, string>;
}

export interface StoredObject {
  body: Bytes;
  headers: StoredHeaders;
  etag: string;
  uploadedAt: Date;
  partCount?: number;
}

export interface StoredPart {
  body: Bytes;
  etag: string;
  checksumCrc32c: string | undefined;
  uploadedAt: Date;
}

export interface PendingUpload {
  key: string;
  headers: StoredHeaders;
  parts: Map<number, StoredPart>;
}

/** One bucket: its configuration, the clock it trusts, and everything stored in it. */
export interface FakeBucket {
  readonly name: string;
  readonly credentials: Credentials;
  readonly now: () => Date;
  readonly config: { cors?: string; lifecycle?: string } | undefined;
  readonly objects: Map<string, StoredObject>;
  readonly uploads: Map<string, PendingUpload>;
  readonly listTokens: Map<string, string>;
  uploadCounter: number;
}

/** A request whose signature has been verified, addressed to one key of the bucket. */
export interface FakeRequest {
  method: string;
  key: string;
  query: URLSearchParams;
  headers: Headers;
  body: Bytes;
}

export const META_PREFIX = "x-amz-meta-";
export const MAX_LIST_PAGE = 1000;

export async function etagOf(body: Bytes): Promise<string> {
  return (await sha256Hex(body)).slice(0, 32);
}

export function readHeaders(headers: Headers): StoredHeaders {
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

export function checksumMismatch(headers: Headers, body: Bytes): Response | null {
  const expected = headers.get("x-amz-checksum-crc32c");
  if (expected === null || expected === crc32cBase64(body)) return null;
  return errorResponse(400, "BadDigest", "The CRC32C you specified did not match the calculated checksum.");
}

export function findUpload(bucket: FakeBucket, key: string, query: URLSearchParams): PendingUpload | undefined {
  const upload = bucket.uploads.get(query.get("uploadId") ?? "");
  return upload && upload.key === key ? upload : undefined;
}

export function readPartNumber(query: URLSearchParams): number | Response {
  const partNumber = Number(query.get("partNumber"));
  if (Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= R2_RULES.maxParts) return partNumber;
  return errorResponse(400, "InvalidArgument", "Part number must be an integer between 1 and 10000.");
}
