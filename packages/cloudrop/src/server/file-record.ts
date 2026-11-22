// A file's row by status (spec 1.0 §3b, M12-T1): what each status says about its times and result, derived from the
// store's writes. The stores only cast to these types; the store contract's `expectWellFormed` proves the cast on every
// backend.

/** Where a file's row stands. `pending` until a `/complete` claims it; the five ended statuses never change again. */
export type FileStatus =
  | "pending"
  | "completing"
  | "completed"
  | "aborted"
  | "rejected"
  | "failed"
  | "expired"
  | "deleted";

/** The statuses `end` can move a row to. */
export type EndedStatus = "aborted" | "rejected" | "failed" | "expired" | "deleted";

/** One accepted file of an `/upload`, written before anything is signed. */
export interface NewFile {
  /** The file id from the upload token and the object's `cloudrop-id`; the row's primary key. */
  id: string;
  route: string;
  /** The object key. Not unique: a route may upload the same key again after a cancel. */
  key: string;
  name: string;
  type: string;
  /** Bytes, as signed. */
  size: number;
  /** The validated metadata as JSON, or null. */
  metadata: string | null;
}

/**
 * What every file's row holds, whatever its status. Times are `Date`s whatever the database keeps. `R` is the server's
 * route names: a row of a route that was removed still reads as one of them, so keep a retired route declared until its
 * rows are erased.
 */
interface RecordBase<R extends string> extends Omit<NewFile, "route"> {
  route: R;
  /** The quota owner from the route's `owner` callback, or null. Not the token's `owner` (the `authorize` JSON). */
  owner: string | null;
  /** The multipart upload id once `attach` stored it. */
  uploadId: string | null;
  /** The upload token's deadline. */
  expiresAt: Date;
  createdAt: Date;
}

/** Reserved by an `/upload` and not yet claimed by a `/complete`. */
export interface PendingRecord<R extends string = string> extends RecordBase<R> {
  status: "pending";
  claimedAt: null;
  completedAt: null;
  endedAt: null;
  cleanedAt: null;
  result: null;
}

/** Claimed by a `/complete` whose `onComplete` has not finished. */
export interface CompletingRecord<R extends string = string> extends RecordBase<R> {
  status: "completing";
  claimedAt: Date;
  completedAt: null;
  endedAt: null;
  cleanedAt: null;
  result: null;
}

/** A completed file. */
export interface CompletedRecord<R extends string = string> extends RecordBase<R> {
  status: "completed";
  claimedAt: Date;
  completedAt: Date;
  endedAt: null;
  cleanedAt: null;
  /** `onComplete`'s result as JSON, or null when it returned none. */
  result: string | null;
}

/** A completed file deleted since, by `api.deleteFile`, an erasure or a replacing route. */
export interface DeletedRecord<R extends string = string> extends RecordBase<R> {
  status: "deleted";
  claimedAt: Date;
  completedAt: Date;
  endedAt: Date;
  /** When the sweep, or the deletion itself, found nothing of the file left in the bucket. */
  cleanedAt: Date | null;
  /** `onComplete`'s result as JSON, kept from the completion. */
  result: string | null;
}

/** Cancelled by `/abort`, revoked, or superseded by a retried `/upload`, before any claim. */
export interface AbortedRecord<R extends string = string> extends RecordBase<R> {
  status: "aborted";
  claimedAt: null;
  completedAt: null;
  endedAt: Date;
  cleanedAt: Date | null;
  result: null;
}

/** Never claimed before its token ran out; the sweep ended it. */
export interface ExpiredRecord<R extends string = string> extends RecordBase<R> {
  status: "expired";
  claimedAt: null;
  completedAt: null;
  endedAt: Date;
  cleanedAt: Date | null;
  result: null;
}

/** Refused by a check during its `/complete`, which claimed it first. */
export interface RejectedRecord<R extends string = string> extends RecordBase<R> {
  status: "rejected";
  claimedAt: Date;
  completedAt: null;
  endedAt: Date;
  cleanedAt: Date | null;
  result: null;
}

/**
 * An upload the server gave up on: one whose storage could not start (never claimed), or a completion stuck past its
 * token, which the sweep ends and marks cleaned at once, keeping its object for you to inspect.
 */
export type FailedRecord<R extends string = string> = RecordBase<R> & {
  status: "failed";
  completedAt: null;
  endedAt: Date;
  result: null;
} & ({ claimedAt: null; cleanedAt: Date | null } | { claimedAt: Date; cleanedAt: Date });

/**
 * A file's row as the store holds it, by status: each status fixes which times are set (spec 1.0 §3b, M12-T1), so
 * `record.status === "completed"` narrows `completedAt` to a `Date`. `endedAt` is when the row reached an ended status
 * (`deleted` included); `cleanedAt` when the sweep finished removing what the upload left in the bucket.
 */
export type FileRecord<R extends string = string> =
  | PendingRecord<R>
  | CompletingRecord<R>
  | CompletedRecord<R>
  | DeletedRecord<R>
  | AbortedRecord<R>
  | ExpiredRecord<R>
  | RejectedRecord<R>
  | FailedRecord<R>;

/** The records of one status, or of a union of statuses: `RecordOf<"failed">` is `FailedRecord`. */
export type RecordOf<S extends FileStatus, R extends string = string> = Extract<FileRecord<R>, { status: S }>;
