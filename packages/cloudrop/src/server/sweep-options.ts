// api.sweep's options, read once per call: where it starts (a cursor names the pass and the store's own cursor in it),
// how many rows, how long a grace, whether it runs every page, and the context of the erasures it carries on.

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, optionsOf } from "../input.ts";
import type { ContextOption } from "./delete-context.ts";
import { readGrace } from "./leftovers.ts";
import { isOwnerOrId, isStoreCursor, readLimit } from "./owner-files.ts";
import type { FileRecord } from "./store.ts";

/**
 * `api.sweep`'s options; `context` reaches the `onDelete` of a file the sweep deletes while it carries an erasure on,
 * as `eraseOwner`'s does, so it is required when the routes' `onDelete` declare one.
 */
export type SweepOptions<TErased = unknown> = SweepSettings & ContextOption<TErased>;

interface SweepSettings {
  /** Rows handled in this call, 1 to 1000; with `all`, rows per page. Default 100. */
  limit?: number;
  /**
   * Sweeps every page in this one call, `limit` rows at a time, until every row has been seen or `signal` aborts, and
   * answers the pages' reports summed. For a cron job: `sweep({ all: true, signal: AbortSignal.timeout(25_000) })`.
   */
  all?: boolean;
  /** With `all`: checked before each page. Once aborted, the call stops and its `cursor` continues where it stopped. */
  signal?: AbortSignal;
  /** The `cursor` an earlier sweep returned, to continue where it stopped; null, as a finished one answers, is none. */
  cursor?: string | null;
  /**
   * How long past its token's deadline an unfinished upload, and past its end an ended one, is left alone. At least
   * 900000 (15 minutes, the life of an upload URL), so no new PUT can start once a row may be cleaned up, and at most
   * 2592000000 (30 days). A PUT already under way that lands after its row was cleaned is left in the bucket. Default
   * 3600000 (1 hour). The sweep takes each row before it deletes anything, so a completion that started in time is
   * never harmed; the grace keeps a slow one from being refused. The erasures it carries on wait the same grace.
   */
  graceMs?: number;
}

export interface SweepReport {
  /** Unfinished uploads ended as expired, with what they left removed. */
  expired: number;
  /** Ended uploads whose late objects and parts were removed, counted once no upload URL can add more. */
  cleaned: number;
  /**
   * Rows that failed this time (a storage or database error, logged with the row's id). Each stays as it was and the
   * next sweep tries it again; the rows after it were still swept. A listing that failed after some rows counts too.
   */
  failed: number;
  /**
   * Completions stuck past their lease and deadline, now ended as failed. Their objects are kept, because their
   * onComplete may have recorded them: check each one. A row is reported once.
   */
  reported: FileRecord[];
  /** Owners whose erasure `eraseOwner` started and this sweep carried on, each counting as one row of `limit`. */
  erasing: number;
  /** Of those, the owners whose erasure this sweep finished: they now answer `done` at once. */
  erased: number;
  /**
   * Pass it to the next sweep to continue; null when every row has been seen, or when a listing failed after this call
   * had handled rows (counted in `failed`). A listing that fails before any row answers the store's error instead.
   * With `all`, it is null unless the signal stopped the call; a listing that fails after the first page counts in
   * `failed` and answers null too.
   */
  cursor: string | null;
}

/**
 * The pass, then the store's own cursor, empty for a pass's start: `isStoreCursor` for the expire and cleanup passes,
 * the last owner for the erase pass. A cursor that was edited is refused here, before the store sees it.
 */
const CURSOR = /^(expire|erase|cleanup):(.*)$/s;

/** The passes in the order a sweep runs them. */
export const PASSES = ["expire", "erase", "cleanup"] as const;

export type Pass = (typeof PASSES)[number];

/** Where a sweep starts: the pass and the store's cursor in it. */
export interface Position {
  pass: Pass;
  cursor: string | null;
}

export interface Run extends Position {
  limit: number;
  graceMs: number;
  all: boolean;
  signal: AbortSignal | undefined;
  /** Passed to `onDelete` for a file the erase pass deletes. */
  context: unknown;
}

/** Whether `cursor` is one the store answered for `pass`: an owner for the erase pass, a row's position otherwise. */
export const isPassCursor = (pass: Pass, cursor: string): boolean =>
  pass === "erase" ? isOwnerOrId(cursor) : isStoreCursor(cursor);

/** A sweep cursor read back into its position, or null when no sweep made it. */
export function readCursor(cursor: string): Position | null {
  const match = CURSOR.exec(cursor);
  const pass = match?.[1] as Pass | undefined;
  if (!match || !pass || (match[2] && !isPassCursor(pass, match[2]))) return null;
  return { pass, cursor: match[2] || null };
}

function readAll(options: Record<string, unknown>): Result<{ all: boolean; signal: AbortSignal | undefined }> {
  const { all = false, signal } = options;
  if (typeof all !== "boolean") return fail(invalidInput("all must be true or false."));
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return fail(invalidInput("signal must be an AbortSignal, such as AbortSignal.timeout(25_000)."));
  }
  if (signal !== undefined && !all) {
    return fail(invalidInput("signal stops a sweep between pages, so it needs all: true. Pass both, or neither."));
  }
  return ok({ all, signal });
}

export function readOptions(given: unknown): Result<Run> {
  const options = optionsOf(given);
  if (!options) return fail(invalidInput("sweep takes options such as { limit: 100 }."));
  const { cursor } = options;
  const limit = readLimit(options.limit);
  if (limit.error) return limit;
  const graceMs = readGrace(options.graceMs);
  if (graceMs.error) return graceMs;
  const all = readAll(options);
  if (all.error) return all;
  // Null is what a finished sweep answers: it starts over, like no cursor.
  const start =
    cursor == null ? { pass: "expire" as const, cursor: null } : typeof cursor === "string" && readCursor(cursor);
  if (!start) return fail(invalidInput("cursor must be one an earlier sweep returned. Leave it out to start over."));
  return ok({ limit: limit.data, graceMs: graceMs.data, ...all.data, ...start, context: options.context });
}
