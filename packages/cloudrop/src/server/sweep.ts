// api.sweep (M5 spec §6): ends what was never finished and removes what it left in the bucket, driven by rows, never
// by listing the bucket. It deletes only an object whose cloudrop-id is its row's id, never touches a completed row,
// and is bounded per call, keyset-paged and idempotent, so two sweeps may run at once.

import { type CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import { readGrace, removeLeftovers } from "./leftovers.ts";
import type { CloudropStore, FileRecord } from "./store.ts";
import { storeCall } from "./store-calls.ts";

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
  /** The `cursor` an earlier sweep returned, to continue where it stopped. */
  cursor?: string;
  /**
   * How long past its token's deadline an unfinished upload, and past its end an ended one, is left alone. At least
   * 900000 (15 minutes, the life of an upload URL), so no new PUT can start once a row may be cleaned up. A PUT already
   * under way that lands after its row was cleaned is left in the bucket. Default 3600000 (1 hour). The sweep takes
   * each row before it deletes anything, so a completion that started in time is never harmed; the grace keeps a slow
   * one from being refused.
   */
  graceMs?: number;
}

export interface SweepReport {
  /** Unfinished uploads ended as expired, with what they left removed. */
  expired: number;
  /** Ended uploads whose late objects and parts were removed. */
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
   * With `all`, it is null unless the signal stopped the call.
   */
  cursor: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/**
 * The pass, then the store's own cursor: `<milliseconds>:<id>` as `stale` promises, empty for the cleanup pass's
 * start. A cursor that was edited is refused here, before the store sees it.
 */
const CURSOR = /^(expire|cleanup):((?:\d{1,15}:.+)?)$/s;

type Pass = "expire" | "cleanup";

/** Where a sweep starts: the pass and the store's cursor in it. */
interface Position {
  pass: Pass;
  cursor: string | null;
}

interface Run extends Position {
  limit: number;
  graceMs: number;
  all: boolean;
  signal: AbortSignal | undefined;
}

/** A sweep cursor read back into its position, or null when no sweep made it. */
function readCursor(cursor: string): Position | null {
  const match = CURSOR.exec(cursor);
  return match ? { pass: match[1] as Pass, cursor: match[2] || null } : null;
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

function readOptions(given: unknown): Result<Run> {
  const options = given ?? {};
  if (!isPlainObject(options)) return fail(invalidInput("sweep takes options such as { limit: 100 }."));
  const { limit = DEFAULT_LIMIT, cursor } = options;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return fail(invalidInput(`limit must be a whole number from 1 to ${MAX_LIMIT}.`));
  }
  const graceMs = readGrace(options.graceMs);
  if (graceMs.error) return graceMs;
  const all = readAll(options);
  if (all.error) return all;
  const start = cursor === undefined ? { pass: "expire" as const, cursor: null } : readCursor(String(cursor));
  if (!start || (cursor !== undefined && typeof cursor !== "string")) {
    return fail(invalidInput("cursor must be one an earlier sweep returned. Leave it out to start over."));
  }
  return ok({ limit, graceMs: graceMs.data, ...all.data, ...start });
}

interface Sweeper {
  config: ServerConfig;
  store: CloudropStore<unknown>;
  report: SweepReport;
}

/** removeLeftovers for a sweep step, which stops at the first failure by throwing. */
async function removeOrThrow(config: ServerConfig, record: FileRecord): Promise<void> {
  const removed = await removeLeftovers(config, record);
  if (removed.error) throw removed.error;
}

/**
 * The row is taken first: only a sweep whose `end` changed it may delete, so a /complete that claims it in between
 * keeps its object. A crash after the `end` leaves an expired row without cleaned_at, which the cleanup pass finishes.
 */
async function expire({ config, store, report }: Sweeper, record: FileRecord): Promise<void> {
  if (record.status === "completing") {
    const ended = await store.end(record.id, "completing", "failed", new Date(), { cleaned: true });
    if (ended.changed) report.reported.push(ended.record);
    return;
  }
  const ended = await store.end(record.id, "pending", "expired", new Date());
  if (!ended.changed) return;
  await removeOrThrow(config, ended.record);
  await store.cleaned(record.id, new Date());
  report.expired += 1;
}

async function cleanUp({ config, store, report }: Sweeper, record: FileRecord): Promise<void> {
  await removeOrThrow(config, record);
  await store.cleaned(record.id, new Date());
  report.cleaned += 1;
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
 * and the next sweep starts over.
 */
function listingFailed(report: SweepReport, handled: number, error: CloudropError): Result<SweepReport> {
  if (handled === 0) return fail(error);
  return stoppedAt({ ...report, failed: report.failed + 1 }, null);
}

/** One bounded call: at most `limit` rows, from `run`'s position. */
async function sweepOnce(config: ServerConfig, store: CloudropStore<unknown>, run: Run): Promise<Result<SweepReport>> {
  const { limit, graceMs, pass } = run;
  const report: SweepReport = { expired: 0, cleaned: 0, failed: 0, reported: [], cursor: null };
  const sweeper: Sweeper = { config, store, report };
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
}

/**
 * Every page, one bounded call after another, the reports summed. A failure after the first page is answered like one
 * within a call: what was done, the listing counted in `failed`, and no cursor.
 */
async function sweepAll(config: ServerConfig, store: CloudropStore<unknown>, run: Run): Promise<Result<SweepReport>> {
  const total: SweepReport = { expired: 0, cleaned: 0, failed: 0, reported: [], cursor: null };
  let position: Position | null = run;
  for (let pages = 0; position !== null; pages++) {
    if (run.signal?.aborted) return stoppedAt(total, `${position.pass}:${position.cursor ?? ""}`);
    const page = await sweepOnce(config, store, { ...run, ...position });
    if (page.error) return pages === 0 ? page : listingFailed(total, 1, page.error);
    total.expired += page.data.expired;
    total.cleaned += page.data.cleaned;
    total.failed += page.data.failed;
    total.reported.push(...page.data.reported);
    position = page.data.cursor === null ? null : readCursor(page.data.cursor);
  }
  return ok(total);
}

export async function sweep(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: SweepOptions | undefined,
): Promise<Result<SweepReport>> {
  const options = readOptions(given);
  if (options.error) return options;
  return options.data.all ? sweepAll(config, store, options.data) : sweepOnce(config, store, options.data);
}
