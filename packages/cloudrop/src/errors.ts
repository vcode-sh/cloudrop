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
  | "FORBIDDEN"
  | "ORIGIN_NOT_ALLOWED"
  | "METHOD_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "BODY_TOO_LARGE"
  | "UNKNOWN_ROUTE"
  | "INVALID_METADATA"
  | "TOO_MANY_FILES"
  | "FILE_TOO_LARGE"
  | "FILE_TYPE_NOT_ALLOWED"
  // The client's account (M10-A): the page belongs to another account than the session's.
  | "ACCOUNT_CHANGED"
  // Database store (M5 spec §5.3): a file over its owner's quota.
  | "QUOTA_EXCEEDED"
  | "INVALID_TOKEN"
  | "UPLOAD_EXPIRED"
  | "NOT_UPLOADED"
  | "PARTS_MISSING"
  | "VERIFICATION_FAILED"
  | "SERVER_ERROR"
  // Client (spec §6.2): never sent by the server.
  | "UPLOAD_REJECTED"
  | "ABORTED"
  | "NETWORK_ERROR"
  // The browser could not reach the bucket while the upload server answers: usually its CORS rule (M12-E7).
  | "BUCKET_BLOCKED"
  | "UPLOAD_IN_USE"
  | "CLIENT_CLOSED"
  // The browser's own storage for resume records (IndexedDB) or its Web Locks failed: never the bucket (M12-A7).
  | "BROWSER_STORAGE_ERROR";

/** Codes only the client produces; the server's status table has no entry for them. */
export type ClientErrorCode =
  | "UPLOAD_REJECTED"
  | "ABORTED"
  | "NETWORK_ERROR"
  | "BUCKET_BLOCKED"
  | "UPLOAD_IN_USE"
  | "CLIENT_CLOSED"
  | "BROWSER_STORAGE_ERROR";

/** What a type check found in a file it refused (M11-K1). The two types are MIME types, never a name, key or byte. */
export interface ContentRefusal {
  /** The type the file was sent as. */
  declared: string;
  /**
   * The type the file's first bytes show, when they decided. Absent when the declared type alone was refused, as at
   * `/upload`, where no bytes exist yet.
   */
  detected?: string;
  /**
   * "mismatch": the content is another type than declared. "refused": `detected`, or `declared` without it, is a kind
   * this server refuses (a web page, a program, a script, an XML type the route does not name, a `deny` entry).
   * "not-accepted": the file was sent untyped and its content's type is not in the route's `accept`.
   */
  reason: "mismatch" | "refused" | "not-accepted";
}

export interface CloudropErrorOptions {
  retryable?: boolean;
  status?: number;
  storageCode?: string;
  /** PARTS_MISSING: the part numbers to upload again. */
  parts?: readonly number[];
  /** FILE_TYPE_NOT_ALLOWED: what the check found. Left out of an error with any other code. */
  content?: ContentRefusal;
  /** The file of a job this error belongs to. */
  file?: { id: string; name: string };
  cause?: unknown;
}

export class CloudropError extends Error {
  readonly code: CloudropErrorCode;
  readonly retryable: boolean;
  /** The HTTP status the storage service answered, for logs. The handler's own answer takes its status from `code`. */
  readonly status: number | undefined;
  /** The storage service's own error code, for logs. Never shown to end users. */
  readonly storageCode: string | undefined;
  /**
   * PARTS_MISSING only: the part numbers the client must upload again before it retries `/complete`. With `content`,
   * the only fields besides `code`, `message` and `retryable` that reach the client. Undefined for every other code.
   */
  readonly parts: readonly number[] | undefined;
  /**
   * FILE_TYPE_NOT_ALLOWED from a type check such as `contentChecks()`: the type the file was sent as, the type its
   * bytes show and why it was refused, for an app that words the refusal itself. Undefined for every other error.
   */
  readonly content: ContentRefusal | undefined;
  /** The file of a job this error belongs to; undefined for an error of the whole job or of the server. */
  readonly file: { id: string; name: string } | undefined;

  constructor(code: CloudropErrorCode, message: string, options: CloudropErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "CloudropError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.storageCode = options.storageCode;
    this.parts = options.parts;
    this.content = code === "FILE_TYPE_NOT_ALLOWED" ? options.content : undefined;
    this.file = options.file;
  }
}

export type Result<T> = { data: T; error: null } | { data: null; error: CloudropError };

export function ok<T>(data: T): Result<T> {
  return { data, error: null };
}

export function fail(error: CloudropError): { data: null; error: CloudropError } {
  return { data: null, error };
}

/** One file refused at /upload because its owner's quota has no room for it (M5-T5): per file, not retryable. */
export function quotaExceeded(): CloudropError {
  return new CloudropError(
    "QUOTA_EXCEEDED",
    "Your storage limit is reached. Delete some files or ask for more space, then try again.",
  );
}

/** Construction-time configuration errors are thrown, never returned: they need a code change, not a retry. */
export function configError(message: string): CloudropError {
  return new CloudropError("INVALID_CONFIG", message);
}
