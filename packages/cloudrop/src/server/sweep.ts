// api.sweep (M5 spec §6): ends what was never finished and removes what it left in the bucket, driven by rows, never
// by listing the bucket. It deletes only an object whose cloudrop-id is its row's id, never touches a completed row,
// and is bounded per call, keyset-paged and idempotent, so two sweeps may run at once.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import type { ServerConfig } from "./config.ts";
import { removeLeftovers, settledAt } from "./leftovers.ts";
import { isStoreCursor } from "./owner-files.ts";
import type { CloudropStore, FileRecord } from "./store.ts";
import { storeCall } from "./store-calls.ts";
import { type Pass, type Position, type Run, readCursor, readOptions } from "./sweep-options.ts";

export interface SweepOptions {
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
   * never harmed; the grace keeps a slow one from being refused.
   */
  graceMs?: number;
}

export interface SweepReport {
  /** Unfinished uploads ended as expired, with what they left removed. */
  expired: number;
  /** Ended uploads whose late objects and parts were removed, counted once no upload URL can add more (M8-A4). */
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
  /**
   * Pass it to the next sweep to continue; null when every row has been seen, or when a listing failed after this call
   * had handled rows (counted in `failed`). A listing that fails before any row answers the store's error instead.
   * With `all`, it is null unless the signal stopped the call; a listing that fails after the first page counts in
   * `failed` and answers null too.
   */
  cursor: string | null;
}

/** A store written by hand answered a cursor the sweep cannot continue from (M11-R68). */
const BAD_CURSOR =
  "The store's stale answered a cursor that is not <milliseconds>:<id> of its page's last row, or null after the last page.";

interface Sweeper {
  config: ServerConfig;
  store: CloudropStore<unknown>;
  report: SweepReport;
  graceMs: number;
}

/**
 * removeLeftovers for a sweep step, which stops at the first failure by throwing, then the row marked cleaned, but only
 * once that check is final (M8-A4): a row that left pending less than 15 minutes before its end still has a URL that
 * can put an object back, so it stays for the next sweep. Answers whether the row was marked.
 */
async function removeAndMark({ config, store, graceMs }: Sweeper, record: FileRecord): Promise<boolean> {
  const checked = await removeLeftovers(config, record);
  if (checked.error) throw checked.error;
  if (checked.data.getTime() < settledAt(record, graceMs)) return false;
  await store.cleaned(record.id, checked.data);
  return true;
}

/**
 * The row is taken first: only a sweep whose `end` changed it may delete, so a /complete that claims it in between
 * keeps its object. A crash after the `end` leaves an expired row without cleaned_at, which the cleanup pass finishes.
 */
async function expire(sweeper: Sweeper, record: FileRecord): Promise<void> {
  const { store, report } = sweeper;
  if (record.status === "completing") {
    const ended = await store.end(record.id, "completing", "failed", new Date(), { cleaned: true });
    if (ended.changed) report.reported.push(ended.record);
    return;
  }
  const ended = await store.end(record.id, "pending", "expired", new Date());
  if (!ended.changed) return;
  await removeAndMark(sweeper, ended.record);
  report.expired += 1;
}

async function cleanUp(sweeper: Sweeper, record: FileRecord): Promise<void> {
  if (await removeAndMark(sweeper, record)) sweeper.report.cleaned += 1;
}

/**
 * One page of one pass: the rows handled and where the pass goes on, null when it is done. A row that fails is logged
 * and counted, and stays as it was for the next sweep: one bad row never stops the rows after it.
 */
async function sweepPage(
  sweeper: Sweeper,
  pass: Pass,
  page: { before: number; limit: number; cursor: string | null },
): Promise<Result<{ handled: number; cursor: string | null }>> {
  const { config, store, report } = sweeper;
  const claimedBefore = new Date(Date.now() - config.completionLeaseMs);
  const found = await storeCall(config.logger, `find ${pass} work`, () =>
    store.stale({ kind: pass, before: new Date(page.before), claimedBefore, limit: page.limit, cursor: page.cursor }),
  );
  if (found.error) return found;
  // A sweep continues from the cursor it is given back, and `all` from this one: any other shape cannot be continued.
  if (found.data.cursor !== null && !isStoreCursor(found.data.cursor)) {
    config.logger.error(`cloudrop: ${BAD_CURSOR}`);
    return fail(new CloudropError("SERVER_ERROR", BAD_CURSOR));
  }
  for (const record of found.data.records) {
    try {
      await (pass === "expire" ? expire(sweeper, record) : cleanUp(sweeper, record));
    } catch (error) {
      config.logger.error(`cloudrop: the sweep could not finish file ${record.id}. The next sweep tries again.`, error);
      report.failed += 1;
    }
  }
  return ok({ handled: found.data.records.length, cursor: found.data.cursor });
}

const stoppedAt = (report: SweepReport, cursor: string | null): Result<SweepReport> => ok({ ...report, cursor });

/**
 * A listing that failed. Before any row was handled in this call: the store's error, so a caller looping on the
 * cursor stops. After: what was done, the listing counted in `failed`, and no cursor, so the caller stops all the same
 * and the next sweep starts over. A cursor the sweep cannot continue from is not such a failure: no later sweep gets
 * past it, so it is answered as the error whatever was done before it (M11-R68, M11-R242).
 */
function listingFailed(report: SweepReport, handled: number, error: CloudropError): Result<SweepReport> {
  if (handled === 0 || !error.retryable) return fail(error);
  report.failed += 1;
  return stoppedAt(report, null);
}

type Sweep = (
  config: ServerConfig,
  store: CloudropStore<unknown>,
  run: Run,
  report: SweepReport,
) => Promise<Result<SweepReport>>;

/** One bounded call: at most `limit` rows, from `run`'s position, counted into `report`. */
const sweepOnce: Sweep = async (config, store, run, report) => {
  const { limit, graceMs, pass } = run;
  const sweeper: Sweeper = { config, store, report, graceMs };
  const now = Date.now();
  let budget = limit;
  let cursor = run.cursor;
  if (pass === "expire") {
    const page = await sweepPage(sweeper, "expire", { before: now - graceMs, limit, cursor });
    if (page.error) return fail(page.error);
    if (page.data.cursor !== null) return stoppedAt(report, `expire:${page.data.cursor}`);
    budget -= page.data.handled;
    cursor = null;
    if (budget === 0) return stoppedAt(report, "cleanup:");
  }
  const page = await sweepPage(sweeper, "cleanup", { before: now - graceMs, limit: budget, cursor });
  if (page.error) return listingFailed(report, limit - budget, page.error);
  return stoppedAt(report, page.data.cursor === null ? null : `cleanup:${page.data.cursor}`);
};

/**
 * Every page, one bounded call after another, all counted into one report. A failure after the first page is answered
 * like one within a call: what was done, the listing counted in `failed`, and no cursor.
 */
const sweepAll: Sweep = async (config, store, run, total) => {
  let position: Position | null = run;
  for (let pages = 0; position !== null; pages++) {
    if (run.signal?.aborted) return stoppedAt(total, `${position.pass}:${position.cursor ?? ""}`);
    const page = await sweepOnce(config, store, { ...run, ...position }, total);
    if (page.error) return pages === 0 ? page : listingFailed(total, 1, page.error);
    position = page.data.cursor === null ? null : readCursor(page.data.cursor);
  }
  return ok(total);
};

export async function sweep(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: SweepOptions | undefined,
): Promise<Result<SweepReport>> {
  const options = readOptions(given);
  if (options.error) return options;
  const report: SweepReport = { expired: 0, cleaned: 0, failed: 0, reported: [], cursor: null };
  return (options.data.all ? sweepAll : sweepOnce)(config, store, options.data, report);
}
