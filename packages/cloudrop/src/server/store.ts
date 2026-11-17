// The database store's public interface (spec M5 §4, M5-T2): what cloudrop asks of a store, so an app can write its
// own. The shipped adapters (`cloudrop/adapters/*`) and the testing memory store implement it; the contract suite in
// `src/testing/store-contract.ts` proves an implementation keeps every promise written here.

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

/** A file's row as the store holds it. Times are `Date`s whatever the database keeps. */
export interface FileRecord extends NewFile {
  /** The quota owner from the route's `owner` callback, or null. Not the token's `owner` (the `authorize` JSON). */
  owner: string | null;
  status: FileStatus;
  /** The multipart upload id once `attach` stored it. */
  uploadId: string | null;
  /** `onComplete`'s result as JSON, once completed. */
  result: string | null;
  /** The upload token's deadline. */
  expiresAt: Date;
  createdAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  /** When the row reached an ended status (`deleted` included). */
  endedAt: Date | null;
  /** When the sweep finished removing what the upload left in the bucket. */
  cleanedAt: Date | null;
}

/** What `claim` found. Only `claimed` lets the caller run `onComplete`. */
export type ClaimOutcome =
  | { kind: "claimed" }
  /** Already completed: answer the stored result and run nothing. */
  | { kind: "completed"; record: FileRecord }
  /** Another `/complete` holds a live claim, or the row lock timed out in transaction mode. */
  | { kind: "busy" }
  | { kind: "ended"; record: FileRecord }
  | { kind: "missing" };

/** The answer of a guarded status change. */
export type Transition =
  /** The row after the change. */
  | { changed: true; record: FileRecord }
  /** Nothing changed: the row as it is now, or null when there is none. */
  | { changed: false; record: FileRecord | null };

/** An owner's counters, kept for every row with an owner whether or not a quota is set. */
export interface OwnerUsage {
  /** Bytes of the owner's `pending` and `completing` rows. */
  reservedBytes: number;
  /** Bytes of the owner's `completed` rows. */
  activeBytes: number;
  /** The owner's `completed` rows (a `deleted` row no longer counts). */
  files: number;
}

/**
 * A database store. Each method is one atomic unit: either everything it describes is written, or it throws and nothing
 * is. Methods throw only on a database failure; every expected outcome is in the return value, and the server answers
 * any throw with a retryable `SERVER_ERROR` and logs it. Times come from the server as `now`; the store keeps them as
 * given. Every write also sets the row's `updated_at` to `now`.
 *
 * Usage counters change only for rows with an owner, always in the same unit as the status change that moves the bytes.
 * A change that moves no bytes (an owner-less row, or leaving an ended status) does not write the usage row at all.
 * `TTx` is the transaction handle `onComplete` receives when the store has `transaction`.
 */
export interface CloudropStore<TTx = never> {
  /**
   * Writes the accepted files of one `/upload` as `pending` rows of one owner, adding each reserved file's size to the
   * owner's reserved bytes. With an owner and a `limit`, each file in order is reserved only when the owner's
   * `reservedBytes + activeBytes + size <= limit` (counting the files reserved before it in this call); otherwise it is
   * `"over-quota"` and nothing of it is written. The quota applies from the first file of an owner the store has never
   * counted (no usage row yet counts as zeros). Without an owner the limit does not apply and no usage is written. The
   * owner's usage row is created by its first reserved file, so a call that reserves nothing leaves none. A file whose
   * id already has a row makes the call throw (a primary-key violation, never `ON CONFLICT DO NOTHING`), and then
   * nothing of the call is written. Atomic for the whole call. Answers one outcome per file, in order.
   */
  reserve(
    input: { owner: string | null; limit: number | null; expiresAt: Date; files: readonly NewFile[] },
    now: Date,
  ): Promise<readonly ("reserved" | "over-quota")[]>;
  /** Stores the multipart upload id on a `pending` row whose `upload_id` is null or already this id: true, and
   *  `updated_at = now` (a repeat stamps it again). False for any other row, or none, which is left unchanged. */
  attach(id: string, uploadId: string, now: Date): Promise<boolean>;
  get(id: string): Promise<FileRecord | null>;
  /**
   * Takes the row for one `/complete`: a `pending` row, or a `completing` one claimed more than `leaseMs` before `now`,
   * becomes `completing` with this claim and `claimed_at = now`. A claim is live through exactly `leaseMs`: at
   * `claimed_at + leaseMs` the row is still `busy`, one millisecond later it can be taken. A `completing` row with a live
   * claim is `busy` even for the token that holds it (the store does not know who holds a token). `expires_at` is not
   * read: the server refuses a dead token before it claims. `completed` answers the record (a replay), an ended status
   * `ended` with the record; neither changes the row.
   */
  claim(id: string, claim: string, now: Date, leaseMs: number): Promise<ClaimOutcome>;
  /** Hands a claimed row back after `onComplete` threw: `completing` with this claim → `pending`, its claim and
   *  `claimed_at` cleared, usage untouched. False when the row holds another claim or another status. */
  release(id: string, claim: string, now: Date): Promise<boolean>;
  /**
   * `completing` with this claim → `completed` with `result` and `completed_at = now`; the owner's reserved bytes drop
   * by the size, active bytes rise by it and files by one. Unchanged for any other row: a repeat answers the completed
   * row, a lost claim the row another `/complete` holds. `claim` and `claimed_at` stay as they were, recording which
   * claim completed the row.
   */
  complete(id: string, claim: string, result: string | null, now: Date): Promise<Transition>;
  /**
   * Moves a row from exactly `from` to `to` and sets `ended_at = now`; `cleaned: true` also sets `cleaned_at = now`.
   * Usage follows `from`: `pending` or `completing` releases the reserved bytes; `completed` releases the active bytes
   * and one file; an ended status releases nothing. `claim` and `claimed_at` stay as they were. Unchanged when the
   * row is in another status, or missing.
   */
  end(id: string, from: FileStatus, to: EndedStatus, now: Date, options?: { cleaned?: boolean }): Promise<Transition>;
  /** Ends every `pending` row of one owner as `aborted`, releasing their reserved bytes. `completing` and later rows
   *  stay. Answers how many rows changed. */
  revoke(owner: string, now: Date): Promise<number>;
  /**
   * One page of sweep work, ordered by its time column, then id. `"expire"`: `pending` rows with `expires_at < before`,
   * and `completing` rows with `expires_at < before` and `claimed_at < claimedBefore`, by `expires_at`. `"cleanup"`:
   * `aborted`, `rejected`, `failed` and `deleted` rows with `cleaned_at` null and `ended_at < before`, by `ended_at`.
   * At most `limit` records; `cursor` continues after the previous page (keyset, so rows that leave the set between
   * pages skip nothing) and is null on the last page. A cursor is opaque and valid only for its own kind.
   */
  stale(input: {
    kind: "expire" | "cleanup";
    before: Date;
    claimedBefore: Date;
    limit: number;
    cursor: string | null;
  }): Promise<{ records: FileRecord[]; cursor: string | null }>;
  /** Sets `cleaned_at = now` on a row that has none; a cleaned or missing row is left as it is. */
  cleaned(id: string, now: Date): Promise<void>;
  /** The owner's counters; zeros for an owner the store has never counted. */
  usage(owner: string): Promise<OwnerUsage>;
  /**
   * Repairs an owner's counters: locks the owner's usage row, then recounts it from the owner's rows, so a concurrent
   * `reserve` is never lost. When the owner has rows but no usage row, it creates the row (on Postgres: insert it
   * with `ON CONFLICT DO NOTHING`, then lock, then recount). A missing row counts as zeros, so an owner whose recount
   * is all zeros gets no row. True when a counter changed (or the row was created). Writes only then, and stamps
   * `updated_at` with the database's clock, as no time is passed.
   */
  reconcile(owner: string): Promise<boolean>;
  /** One page of the owners that have counters, in the database's order of owner; `cursor` as for `stale`. */
  owners(cursor: string | null, limit: number): Promise<{ owners: string[]; cursor: string | null }>;
  /**
   * Runs `run` in one interactive database transaction and commits when it resolves; a throw rolls back every write
   * made through `tx` or the given `store` and is rethrown. Only stores that can hold one (Postgres) have it.
   */
  transaction?<T>(run: (tx: TTx, store: Omit<CloudropStore<TTx>, "transaction">) => Promise<T>): Promise<T>;
}
