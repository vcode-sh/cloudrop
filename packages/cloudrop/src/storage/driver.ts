import type { CloudropError, Result } from "../errors.ts";
import type { StorageRules } from "../rules.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Stored with the object. Metadata names use lowercase letters, digits and hyphens. */
export interface ObjectOptions {
  type?: string;
  disposition?: string;
  metadata?: Record<string, string>;
}

export interface WriteOptions extends ObjectOptions {
  /** Create-only: the write fails with ALREADY_EXISTS when the key exists. */
  ifNoneMatch?: boolean;
  /** Base64 CRC32C of the body; the storage rejects mismatching bytes. */
  checksumCrc32c?: string;
}

/**
 * A presigned request. Send `headers` exactly as given. The body length must equal the signed size; clients do not
 * set Content-Length themselves (browsers forbid it), the HTTP stack derives it from the body.
 */
export interface PresignedRequest {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectInfo {
  key: string;
  size: number;
  type?: string;
  disposition?: string;
  etag: string;
  uploadedAt: Date;
  metadata: Record<string, string>;
  checksumCrc64nvme?: string;
}

export interface PartInfo {
  partNumber: number;
  size: number;
  etag: string;
  checksumCrc32c?: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string;
  uploadedAt: Date;
}

export interface StorageDriver {
  readonly rules: StorageRules;
  readonly publicUrl?: string;
  presignPut(
    key: string,
    options: WriteOptions & { size: number; expiresIn: number },
  ): Promise<Result<PresignedRequest>>;
  createMultipart(key: string, options: ObjectOptions): Promise<Result<{ uploadId: string }>>;
  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: { size: number; expiresIn: number; checksumCrc32c?: string },
  ): Promise<Result<PresignedRequest>>;
  listParts(key: string, uploadId: string): Promise<Result<PartInfo[]>>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
    options?: { ifNoneMatch?: boolean },
  ): Promise<Result<{ etag: string }>>;
  /** Idempotent: aborting an unknown or finished upload succeeds. */
  abortMultipart(key: string, uploadId: string): Promise<Result<void>>;
  /** `null` only when the object does not exist; every other failure is an error. */
  head(key: string): Promise<Result<ObjectInfo | null>>;
  /** Inclusive byte range. */
  getRange(key: string, start: number, end: number): Promise<Result<Uint8Array>>;
  put(
    key: string,
    body: Uint8Array<ArrayBuffer> | string | Blob,
    options?: WriteOptions,
  ): Promise<Result<{ etag: string }>>;
  /** Server-side copy that keeps type, disposition and metadata; multipart copy above the single-PUT limit. */
  copy(from: string, to: string): Promise<Result<{ etag: string }>>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<Result<void>>;
  /** Per-key results; order is not guaranteed. */
  deleteMany(
    keys: readonly string[],
  ): Promise<Result<{ deleted: string[]; failed: { key: string; error: CloudropError }[] }>>;
  list(
    prefix: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<Result<{ items: ListedObject[]; nextCursor: string | null }>>;
}
