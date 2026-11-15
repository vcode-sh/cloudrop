export type CloudropErrorCode =
  // Storage driver.
  | "INVALID_INPUT"
  | "INVALID_CONFIG"
  | "STORAGE_UNREACHABLE"
  | "STORAGE_DENIED"
  | "STORAGE_ERROR"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "NO_SUCH_UPLOAD"
  | "INVALID_PART"
  | "CHECKSUM_MISMATCH"
  // Upload endpoints (spec §5, §7).
  | "UNAUTHORIZED"
  | "ORIGIN_NOT_ALLOWED"
  | "METHOD_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "BODY_TOO_LARGE"
  | "UNKNOWN_ROUTE"
  | "INVALID_METADATA"
  | "TOO_MANY_FILES"
  | "FILE_TOO_LARGE"
  | "FILE_TYPE_NOT_ALLOWED"
  | "INVALID_TOKEN"
  | "UPLOAD_EXPIRED"
  | "NOT_UPLOADED"
  | "PARTS_MISSING"
  | "VERIFICATION_FAILED"
  | "SERVER_ERROR";

export interface CloudropErrorOptions {
  retryable?: boolean;
  status?: number;
  storageCode?: string;
  /** PARTS_MISSING: the part numbers to upload again. */
  parts?: readonly number[];
  cause?: unknown;
}

export class CloudropError extends Error {
  readonly code: CloudropErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** The storage service's own error code, for logs. Never shown to end users. */
  readonly storageCode: string | undefined;
  /**
   * PARTS_MISSING only: the part numbers the client must upload again before it retries `/complete`. The one field
   * besides `code`, `message` and `retryable` that reaches the client. Undefined for every other code.
   */
  readonly parts: readonly number[] | undefined;

  constructor(code: CloudropErrorCode, message: string, options: CloudropErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "CloudropError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.storageCode = options.storageCode;
    this.parts = options.parts;
  }
}

export type Result<T> = { data: T; error: null } | { data: null; error: CloudropError };

export function ok<T>(data: T): Result<T> {
  return { data, error: null };
}

export function fail(error: CloudropError): { data: null; error: CloudropError } {
  return { data: null, error };
}

/** Construction-time configuration errors are thrown, never returned: they need a code change, not a retry. */
export function configError(message: string): CloudropError {
  return new CloudropError("INVALID_CONFIG", message);
}
