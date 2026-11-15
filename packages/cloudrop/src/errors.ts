export type CloudropErrorCode =
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
  | "CHECKSUM_MISMATCH";

export interface CloudropErrorOptions {
  retryable?: boolean;
  status?: number;
  storageCode?: string;
  cause?: unknown;
}

export class CloudropError extends Error {
  readonly code: CloudropErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** The storage service's own error code, for logs. Never shown to end users. */
  readonly storageCode: string | undefined;

  constructor(code: CloudropErrorCode, message: string, options: CloudropErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "CloudropError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.storageCode = options.storageCode;
  }
}

export type Result<T> = { data: T; error: null } | { data: null; error: CloudropError };

export function ok<T>(data: T): Result<T> {
  return { data, error: null };
}

export function fail(error: CloudropError): { data: null; error: CloudropError } {
  return { data: null, error };
}
