// api.sweep (M5 spec §6): ends what was never finished and removes what it left in the bucket, driven by rows, never
// by listing the bucket. It deletes only an object whose cloudrop-id is its row's id, never touches a completed row,
// and is bounded per call, keyset-paged and idempotent, so two sweeps may run at once.

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import type { CloudropStore, FileRecord } from "./store.ts";
import { storeCall } from "./store-calls.ts";

export interface SweepOptions {
  /** Rows handled in this call, 1 to 1000. Default 100. */
  limit?: number;
  /** The `cursor` an earlier sweep returned, to continue where it stopped. */
  cursor?: string;
  /**
   * How long past its token's deadline an unfinished upload, and past its end an ended one, is left alone. At least
   * 900000 (15 minutes, the life of an upload URL), so a PUT under way at the deadline lands before its row is cleaned
   * up. Default 3600000 (1 hour). The sweep takes each row before it deletes anything, so a completion that started in
   * time is never harmed; the grace keeps a slow one from being refused.
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
   * next sweep tries it again; the rows after it were still swept.
   */
  failed: number;
  /**
   * Completions stuck past their lease and deadline, now ended as failed. Their objects are kept, because their
   * onComplete may have recorded them: check each one. A row is reported once.
   */
  reported: FileRecord[];
  /** Pass it to the next sweep to continue; null when every row has been seen. */
  cursor: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_GRACE_MS = 3_600_000;
/**
 * A signed URL's life (URL_LIFETIME_SECONDS): a PUT signed before a row ended can land until then, so no row is
 * cleaned up sooner after its deadline or its end.
 */
const MIN_GRACE_MS = 900_000;
const CURSOR = /^(expire|cleanup):(.*)$/s;

type Pass = "expire" | "cleanup";

function readOptions(given: unknown): Result<{ limit: number; graceMs: number; pass: Pass; cursor: string | null }> {
  const options = given ?? {};
  if (!isPlainObject(options)) return fail(invalidInput("sweep takes options such as { limit: 100 }."));
  const { limit = DEFAULT_LIMIT, graceMs = DEFAULT_GRACE_MS, cursor } = options;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return fail(invalidInput(`limit must be a whole number from 1 to ${MAX_LIMIT}.`));
  }
  if (typeof graceMs !== "number" || !Number.isSafeInteger(graceMs) || graceMs < MIN_GRACE_MS) {
    return fail(
      invalidInput(
        `graceMs must be at least ${MIN_GRACE_MS} (15 minutes), the life of an upload URL, so a PUT under way at the deadline lands first.`,
      ),
    );
  }
  const match = cursor === undefined ? ["", "expire", ""] : typeof cursor === "string" ? CURSOR.exec(cursor) : null;
  if (!match) return fail(invalidInput("cursor must be one an earlier sweep returned. Leave it out to start over."));
  return ok({ limit, graceMs, pass: match[1] as Pass, cursor: match[2] || null });
}

/**
 * Aborts the row's multipart upload (unless the row completed it) and deletes the object at its key only when the
 * object is this row's: a key may hold a later upload's file.
 */
export async function removeLeftovers(config: ServerConfig, record: FileRecord): Promise<Result<void>> {
  const { storage } = config;
  if (record.uploadId && record.completedAt === null) {
    const aborted = await storage.abortMultipart(record.key, record.uploadId);
    if (aborted.error) return aborted;
  }
  const head = await storage.head(record.key);
  if (head.error) return head;
  if (head.data?.metadata["cloudrop-id"] !== record.id) return ok(undefined);
  return storage.delete(record.key);
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

/** The report so far, with the cursor to continue from: a sweep always answers what it did. */
const stoppedAt = (report: SweepReport, cursor: string | null): Result<SweepReport> => ok({ ...report, cursor });

export async function sweep(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: SweepOptions | undefined,
): Promise<Result<SweepReport>> {
  const options = readOptions(given);
  if (options.error) return options;
  const { limit, graceMs, pass } = options.data;
  const report: SweepReport = { expired: 0, cleaned: 0, failed: 0, reported: [], cursor: null };
  const sweeper: Sweeper = { config, store, report };
  const now = Date.now();
  let budget = limit;
  let cursor = options.data.cursor;
  if (pass === "expire") {
    const page = await sweepPage(sweeper, "expire", { before: now - graceMs, limit, cursor });
    if (page.error) return stoppedAt(report, `expire:${cursor ?? ""}`);
    if (page.data.cursor !== null) return stoppedAt(report, `expire:${page.data.cursor}`);
    budget -= page.data.handled;
    cursor = null;
    if (budget === 0) return stoppedAt(report, "cleanup:");
  }
  const page = await sweepPage(sweeper, "cleanup", { before: now - graceMs, limit: budget, cursor });
  if (page.error) return stoppedAt(report, `cleanup:${cursor ?? ""}`);
  return stoppedAt(report, page.data.cursor === null ? null : `cleanup:${page.data.cursor}`);
}
