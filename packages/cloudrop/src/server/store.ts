// The database store's public interface (spec M5 §4, M5-T2): what cloudrop asks of a store, so an app can write its
// own. The shipped adapters (`cloudrop/adapters/*`) and the testing memory store implement it; the contract suite in
// `src/testing/store-contract.ts` proves an implementation keeps every promise written here.

import type { EndedStatus, FileRecord, FileRecordStatus, NewFile } from "./file-record.ts";
import type { OwnerUsage, ReserveOutcome, StoreErasure } from "./store-erasure.ts";
import type { RouteFunction } from "./store-route.ts";

export type {
  AbortedRecord,
  CompletedRecord,
  CompletingRecord,
  DeletedRecord,
  EndedStatus,
  ExpiredRecord,
  FailedRecord,
  FileRecord,
  FileRecordStatus,
  MappedRecord,
  NewFile,
  PendingRecord,
  RecordOf,
  RejectedRecord,
} from "./file-record.ts";
export type { OwnerErasure, OwnerUsage, ReserveOutcome, StoreErasure } from "./store-erasure.ts";

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

/** What `complete` did: the transition, and the files `replace` deleted in the same unit (none without it). */
export type Completion = Transition & { replaced: FileRecord[] };

/** The filters, order and page that `list` and `listAll` share; `list`'s documentation says what each means. */
interface ListQuery {
  route: string | null;
  name: string | null;
  type: string | null;
  order: "newest" | "oldest";
  limit: number;
  cursor: string | null;
}

/** One page of rows, and the cursor of the next page or null. */
type RecordPage = { records: FileRecord[]; cursor: string | null };

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
export interface CloudropStore<TTx = never> extends StoreErasure {
  /**
   * Writes the accepted files of one `/upload` as `pending` rows of one owner, adding each reserved file's size to the
   * owner's reserved bytes. With an owner and a `limit`, each file in order is reserved only when the owner's
   * `reservedBytes + activeBytes + size <= limit` (counting the files reserved before it in this call); otherwise it is
   * `"over-quota"` and nothing of it is written. The quota applies from the first file of an owner the store has never
   * counted (no usage row yet counts as zeros). Without an owner the limit does not apply and no usage is written. The
   * owner's usage row is created by its first reserved file, so a call that reserves nothing leaves none. A file whose
   * id already has a row makes the call throw (a primary-key violation, never `ON CONFLICT DO NOTHING`), and then
   * nothing of the call is written. Atomic for the whole call. Answers one outcome per file, in order.
   *
   * `requestKey` is the `/upload` request's idempotency key, stored on every row written. When it is not null, the call
   * first ends as `aborted` (`ended_at = now`, `cleaned_at` left null for the sweep) every `pending` row with this key,
   * the route of the call's files and the same owner (null matches null), releasing their reserved bytes, so the quota
   * check of the new files counts without them: a retry supersedes an attempt whose answer was lost. Rows in any other
   * status are left alone. The rows are superseded whatever the new files' outcomes, even when every one is over the
   * quota, and not at all when the call throws. A call with no files writes nothing. The server passes a key only with
   * an owner (M5-T105): owner-less rows hold no quota, so superseding them would free nothing. A store that ignores
   * `requestKey` keeps the old cost: lost answers hold their bytes until the sweep.
   *
   * With an owner whose usage row carries an erase mark (`markErasure`), every file is `"erased"` and the call writes
   * nothing, superseding included. The mark is read under the same usage-row lock as the quota (on Postgres the row is
   * locked first, with or without a limit), so a reserve either commits before the mark or is refused (M12-O2).
   */
  reserve(
    input: {
      owner: string | null;
      limit: number | null;
      expiresAt: Date;
      requestKey: string | null;
      files: readonly NewFile[];
    },
    now: Date,
  ): Promise<readonly ReserveOutcome[]>;
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
   *
   * With `replace`, and when the row has an owner, the same unit also ends every other `completed` row of that owner on
   * the row's route as `deleted` (`ended_at = now`, `cleaned_at` left null), releasing their active bytes and files, and
   * answers them, as they are now, in `replaced`. Two such completions of one owner and route never both keep their
   * previous files: the second sees the first's row as completed and replaces it. Without `replace`, or when nothing
   * changed, `replaced` is empty.
   */
  complete(
    id: string,
    claim: string,
    result: string | null,
    now: Date,
    options?: { replace?: boolean },
  ): Promise<Completion>;
  /**
   * Moves a row from exactly `from` to `to` and sets `ended_at = now`; `cleaned: true` also sets `cleaned_at = now`.
   * Usage follows `from`: `pending` or `completing` releases the reserved bytes; `completed` releases the active bytes
   * and one file; an ended status releases nothing. `claim` and `claimed_at` stay as they were. Unchanged when the
   * row is in another status, or missing.
   */
  end(
    id: string,
    from: FileRecordStatus,
    to: EndedStatus,
    now: Date,
    options?: { cleaned?: boolean },
  ): Promise<Transition>;
  /** Ends every `pending` row of one owner as `aborted`, releasing their reserved bytes. `completing` and later rows
   *  stay. Answers how many rows changed. May be several units, each ending rows with their bytes (M11-R240). */
  revoke(owner: string, now: Date): Promise<number>;
  /**
   * One page of sweep work, ordered by its time column, then id. `"expire"`: `pending` rows with `expires_at < before`,
   * and `completing` rows with `expires_at < before` and `claimed_at < claimedBefore`, by `expires_at`. `"cleanup"`:
   * `aborted`, `rejected`, `failed`, `expired` and `deleted` rows with `cleaned_at` null and `ended_at < before`, by
   * `ended_at`.
   * At most `limit` records; `cursor` continues after the previous page (keyset, so rows that leave the set between
   * pages skip nothing) and is null on the last page. A cursor is `<milliseconds>:<id>`, the last row's time and id
   * (the sweep refuses any other before calling the store), and is valid only for its own kind.
   */
  stale(input: {
    kind: "expire" | "cleanup";
    before: Date;
    claimedBefore: Date;
    limit: number;
    cursor: string | null;
  }): Promise<RecordPage>;
  /**
   * One page of an owner's rows in any of `statuses` (none: an empty page), ordered by `created_at`, then id: both
   * descending for `"newest"`, ascending for `"oldest"`, ids in byte order. Each filter that is not null narrows it:
   * `route` to that route; `name` to names that contain it, with ASCII letters matched in either case and every other
   * character, `%` and `_` included, only as itself; `type` to that exact type, or, when it ends in `/` (`"image/"`),
   * to every type that starts with it. One page is read in one statement, so a row in one of the statuses when it runs
   * is on it or on a later page, whatever status changes happen meanwhile. At most `limit` records; `cursor` continues
   * after the previous page (keyset, so rows that leave the statuses between pages skip nothing) and is null on the
   * last page. A cursor is `<milliseconds>:<id>`, the last row's `created_at` and id (the file API refuses any other
   * before calling the store).
   */
  list(input: ListQuery & { owner: string; statuses: readonly FileRecordStatus[] }): Promise<RecordPage>;
  /**
   * `list` across owners, for `api.allFiles` (M11-L): `owner` null is every owner, rows without one included, and
   * `status` null every status; given, each narrows to that one. Optional, so a store written before 0.6 still
   * compiles: without it `api.allFiles` answers `INVALID_CONFIG`.
   */
  listAll?(input: ListQuery & { owner: string | null; status: FileRecordStatus | null }): Promise<RecordPage>;
  /** Sets `cleaned_at = now` on a row that has none; a cleaned or missing row is left as it is. */
  cleaned(id: string, now: Date): Promise<void>;
  /** The owner's counters and erase mark; zeros and null for an owner the store has never counted. */
  usage(owner: string): Promise<OwnerUsage>;
  /**
   * Repairs an owner's counters: locks the owner's usage row, then recounts it from the owner's rows, so a concurrent
   * `reserve` is never lost. When the owner has rows but no usage row, it creates the row (on Postgres: insert it
   * with `ON CONFLICT DO NOTHING`, then lock, then recount, in one transaction). A missing row counts as zeros, so an
   * owner whose recount is all zeros gets no row. True when a counter changed (or the row was created). Writes only
   * then, and stamps `updated_at` with the database's clock, as no time is passed.
   */
  reconcile(owner: string): Promise<boolean>;
  /**
   * One page of the owners that have counters, in byte order of owner, like ids; `cursor` continues after the
   * previous page (keyset) and is null on the last page.
   */
  owners(cursor: string | null, limit: number): Promise<{ owners: string[]; cursor: string | null }>;
  /**
   * Runs `run` in one interactive database transaction and commits when it resolves; a throw rolls back every write
   * made through `tx` or the given `store` and is rethrown. Only stores that can hold one (Postgres) have it.
   */
  transaction?<T>(run: (tx: TTx, store: Omit<CloudropStore<TTx>, "transaction">) => Promise<T>): Promise<T>;
}

/**
 * A store built with `transaction: true`: completions run in its transaction, and `route` makes the routes whose
 * `onComplete` receives that transaction as `tx`. Its routes work only with this very store passed to `createCloudrop`.
 */
export type TransactionalStore<TTx> = CloudropStore<TTx> &
  Required<Pick<CloudropStore<TTx>, "transaction">> & { route: RouteFunction<{ tx: TTx }> };
