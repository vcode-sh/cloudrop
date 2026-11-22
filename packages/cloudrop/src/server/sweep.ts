// api.sweep (M5 spec §6): ends what was never finished and removes what it left in the bucket, driven by rows, never
// by listing the bucket. It deletes only an object whose cloudrop-id is its row's id, never touches a completed row
// but an erased owner's, and is bounded per call, keyset-paged and idempotent, so two sweeps may run at once. Between
// its two passes over rows it carries on every erasure `eraseOwner` started and has not finished (M12-O4).

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import type { ServerConfig } from "./config.ts";
import { continueErasure } from "./erase.ts";
import { removeLeftovers, settledAt } from "./leftovers.ts";
import type { CloudropStore, FileRecord } from "./store.ts";
import { storeCall } from "./store-calls.ts";
import {
  isPassCursor,
  PASSES,
  type Pass,
  type Position,
  type Run,
  readCursor,
  readOptions,
  type SweepReport,
} from "./sweep-options.ts";

export type { SweepOptions, SweepReport } from "./sweep-options.ts";

/** A store written by hand answered a cursor the sweep cannot continue from (M11-R68). */
const BAD_CURSOR =
  "The store's stale answered a cursor that is not <milliseconds>:<id> of its page's last row, or null after the last page.";
const BAD_ERASING_CURSOR =
  "The store's erasing answered a cursor that is not its page's last owner, or null after the last page.";

interface Sweeper {
  config: ServerConfig;
  store: CloudropStore<unknown>;
  report: SweepReport;
  run: Run;
}

/**
 * removeLeftovers for a sweep step, which stops at the first failure by throwing, then the row marked cleaned, but only
 * once that check is final (M8-A4): a row that left pending less than 15 minutes before its end still has a URL that
 * can put an object back, so it stays for the next sweep. Answers whether the row was marked.
 */
async function removeAndMark({ config, store, run }: Sweeper, record: FileRecord): Promise<boolean> {
  const checked = await removeLeftovers(config, record);
  if (checked.error) throw checked.error;
  if (checked.data.getTime() < settledAt(record, run.graceMs)) return false;
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
 * An owner whose run failed is warned about once per sweep (M12-R5): it is not finished, so the next sweep runs it
 * again, and a sweep without a cursor starts the pass at the first owner, so it holds a row of the limit each time.
 */
function warnUnfinished(config: ServerConfig, owner: string, why: string): void {
  config.logger.warn(
    `cloudrop: the sweep could not finish erasing ${owner} (${why}). The next sweep tries again, and until one succeeds this owner takes one row of each sweep's limit ahead of the owners after it: fix the cause, or continue each sweep from the cursor the last one answered.`,
  );
}

/**
 * The erasures of one page of marked owners, each carried on with the sweep's grace, signal and context. One that
 * fails is counted and warned about, and the next sweep runs it again. Answers how many owners it ran.
 */
async function eraseEach({ config, store, report, run }: Sweeper, owners: readonly string[]): Promise<number> {
  const { graceMs, signal, context } = run;
  for (const [ran, owner] of owners.entries()) {
    // Stopped: the owners left on this page stay marked, and the cursor continues after the last one that ran.
    if (signal?.aborted) return ran;
    const { data: erased, error } = await continueErasure(config, store, owner, { graceMs, signal, context });
    if (error) {
      report.erasing += 1;
      report.failed += 1;
      warnUnfinished(config, owner, error.message);
      continue;
    }
    // Reopened since the page was read: not erased, and still one owner of the page's limit.
    if (erased === null) continue;
    report.erasing += 1;
    report.failed += erased.failed;
    if (erased.done) report.erased += 1;
    else if (erased.failed > 0)
      warnUnfinished(config, owner, `${erased.failed} of its files or folders failed, as logged`);
  }
  return owners.length;
}

type Page = { handled: number; cursor: string | null };

/**
 * One page of the erase pass: the owners whose erasure is unfinished, by owner. Stopped part way, it answers the last
 * owner that ran, or the cursor it was given ("" for the pass's start) when none did, so continuing skips no owner.
 */
async function erasePage(sweeper: Sweeper, page: { limit: number; cursor: string | null }): Promise<Result<Page>> {
  const { config, store } = sweeper;
  const found = await storeCall(config.logger, "find the owners being erased", () => store.erasing(page));
  if (found.error) return found;
  const cursor = checkedCursor(config, "erase", found.data.cursor);
  if (cursor.error) return cursor;
  const { owners } = found.data;
  const ran = await eraseEach(sweeper, owners);
  if (ran < owners.length) return ok({ handled: ran, cursor: owners[ran - 1] ?? page.cursor ?? "" });
  return ok({ handled: owners.length, cursor: cursor.data });
}

/** A sweep continues from the cursor it is given back, and `all` from this one: any other shape cannot be continued. */
function checkedCursor(config: ServerConfig, pass: Pass, cursor: string | null): Result<string | null> {
  if (cursor === null || isPassCursor(pass, cursor)) return ok(cursor);
  const problem = pass === "erase" ? BAD_ERASING_CURSOR : BAD_CURSOR;
  config.logger.error(`cloudrop: ${problem}`);
  return fail(new CloudropError("SERVER_ERROR", problem));
}

/**
 * One page of one pass over rows: the rows handled and where the pass goes on, null when it is done. A row that fails
 * is logged and counted, and stays as it was for the next sweep: one bad row never stops the rows after it.
 */
async function sweepPage(
  sweeper: Sweeper,
  pass: "expire" | "cleanup",
  page: { before: number; limit: number; cursor: string | null },
): Promise<Result<Page>> {
  const { config, store, report } = sweeper;
  const claimedBefore = new Date(Date.now() - config.completionLeaseMs);
  const found = await storeCall(config.logger, `find ${pass} work`, () =>
    store.stale({ kind: pass, before: new Date(page.before), claimedBefore, limit: page.limit, cursor: page.cursor }),
  );
  if (found.error) return found;
  const cursor = checkedCursor(config, pass, found.data.cursor);
  if (cursor.error) return cursor;
  for (const record of found.data.records) {
    try {
      await (pass === "expire" ? expire(sweeper, record) : cleanUp(sweeper, record));
    } catch (error) {
      config.logger.error(`cloudrop: the sweep could not finish file ${record.id}. The next sweep tries again.`, error);
      report.failed += 1;
    }
  }
  return ok({ handled: found.data.records.length, cursor: cursor.data });
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

/**
 * One bounded call: at most `limit` rows, and owners in the erase pass, from `run`'s position, counted into `report`.
 * The passes run in order, each continuing where the last stopped, until one stops within its page or the budget runs
 * out.
 */
const sweepOnce: Sweep = async (config, store, run, report) => {
  const { limit } = run;
  const sweeper: Sweeper = { config, store, report, run };
  const before = Date.now() - run.graceMs;
  let budget = limit;
  let cursor = run.cursor;
  const passes = PASSES.slice(PASSES.indexOf(run.pass));
  for (const [index, pass] of passes.entries()) {
    const page =
      pass === "erase"
        ? await erasePage(sweeper, { limit: budget, cursor })
        : await sweepPage(sweeper, pass, { before, limit: budget, cursor });
    if (page.error) return listingFailed(report, limit - budget, page.error);
    if (page.data.cursor !== null) return stoppedAt(report, `${pass}:${page.data.cursor}`);
    budget -= page.data.handled;
    cursor = null;
    const next = passes[index + 1];
    if (next === undefined) break;
    if (budget === 0) return stoppedAt(report, `${next}:`);
  }
  return stoppedAt(report, null);
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
  given: unknown,
): Promise<Result<SweepReport>> {
  const options = readOptions(given);
  if (options.error) return options;
  const report: SweepReport = { expired: 0, cleaned: 0, failed: 0, reported: [], erasing: 0, erased: 0, cursor: null };
  return (options.data.all ? sweepAll : sweepOnce)(config, store, options.data, report);
}
