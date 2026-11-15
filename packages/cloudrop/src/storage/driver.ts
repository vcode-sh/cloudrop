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

/** One rule of the bucket's CORS configuration, as S3's GetBucketCors returns it. */
export interface BucketCorsRule {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
}

/** One rule of the bucket's lifecycle configuration; only what cloudrop checks. */
export interface BucketLifecycleRule {
  id: string;
  enabled: boolean;
  /**
   * The rule's first `<Prefix>`, from its filter or the legacy field; "" covers the whole bucket. Tag and size filters
   * are not read, so a rule scoped only by them also reads as "". S3 allows no tag filter on a rule that aborts
   * incomplete multipart uploads.
   */
  prefix: string;
  /** Days after which an incomplete multipart upload is aborted, when the rule does that. */
  abortIncompleteMultipartUploadDays?: number;
}

/** Implemented by cloudrop's presets, r2() and s3(); its methods may change before 1.0. */
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
  /**
   * A presigned GET. `signedAt` (default now) lets callers round the signing time so that one URL is shared by everyone
   * in a time window. `disposition` is signed into the URL as `response-content-disposition`.
   */
  presignGet(
    key: string,
    options: { expiresIn: number; signedAt?: Date; disposition?: string },
  ): Promise<Result<{ url: string; expiresAt: Date }>>;
  /** The bucket's CORS rules; [] when it has none. Credentials that may not read them get STORAGE_DENIED. */
  getBucketCors(): Promise<Result<BucketCorsRule[]>>;
  /** The bucket's lifecycle rules; [] when it has none. Credentials that may not read them get STORAGE_DENIED. */
  getBucketLifecycle(): Promise<Result<BucketLifecycleRule[]>>;
  /** `null` only when the object does not exist; every other failure is an error. */
  head(key: string): Promise<Result<ObjectInfo | null>>;
  /** Inclusive byte range. */
  getRange(key: string, start: number, end: number): Promise<Result<Uint8Array>>;
  /**
   * Single PUT, up to `rules.maxSinglePutSize`. A Blob is streamed to the storage, never read into memory, so its
   * payload is signed as UNSIGNED-PAYLOAD; other bodies are signed with their SHA-256. Without `options.type`, a Blob's
   * own `type` becomes the stored content type.
   */
  put(
    key: string,
    body: Uint8Array<ArrayBuffer> | ArrayBuffer | string | Blob,
    options?: WriteOptions,
  ): Promise<Result<{ etag: string }>>;
  /**
   * Server-side copy that keeps type, disposition and metadata; multipart copy above the single-PUT limit. Every copy
   * request is conditional on the source's ETag, so a source overwritten during the copy fails it with a retryable
   * STORAGE_ERROR instead of mixing two versions.
   */
  copy(from: string, to: string): Promise<Result<{ etag: string }>>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<Result<void>>;
  /**
   * Deletes any number of keys, one DeleteObject request per key, 16 at a time. Every key ends up in `deleted` (a
   * missing key counts as deleted) or in `failed` with its own error; an invalid key fails without a request. Order is
   * not guaranteed.
   */
  deleteMany(
    keys: readonly string[],
  ): Promise<Result<{ deleted: string[]; failed: { key: string; error: CloudropError }[] }>>;
  list(
    prefix: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<Result<{ items: ListedObject[]; nextCursor: string | null }>>;
}
