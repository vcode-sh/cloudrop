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
   * How long past its token's deadline an unfinished upload is left alone, so a request that started in time can end.
   * Default 3600000 (1 hour). Cleanup after an abort waits at least 15 minutes, the life of a signed URL.
   */
  graceMs?: number;
}

export interface SweepReport {
  /** Unfinished uploads ended as expired, with what they left removed. */
  expired: number;
  /** Ended uploads whose late objects and parts were removed. */
  cleaned: number;
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
/** A signed URL's life (URL_LIFETIME_SECONDS): a PUT signed before an abort can land until then. */
const MIN_CLEANUP_AGE_MS = 900_000;
const CURSOR = /^(expire|cleanup):(.*)$/s;

type Pass = "expire" | "cleanup";

function readOptions(given: unknown): Result<{ limit: number; graceMs: number; pass: Pass; cursor: string | null }> {
  const options = given ?? {};
  if (!isPlainObject(options)) return fail(invalidInput("sweep takes options such as { limit: 100 }."));
  const { limit = DEFAULT_LIMIT, graceMs = DEFAULT_GRACE_MS, cursor } = options;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT) {
    return fail(invalidInput(`limit must be a whole number from 1 to ${MAX_LIMIT}.`));
  }
  if (!Number.isSafeInteger(graceMs) || (graceMs as number) < 0) {
    return fail(invalidInput("graceMs must be a whole number of milliseconds, 0 or more."));
  }
  const match = cursor === undefined ? ["", "expire", ""] : typeof cursor === "string" ? CURSOR.exec(cursor) : null;
  if (!match) return fail(invalidInput("cursor must be one an earlier sweep returned. Leave it out to start over."));
  return ok({ limit: limit as number, graceMs: graceMs as number, pass: match[1] as Pass, cursor: match[2] || null });
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

const call = <T>({ config }: Sweeper, what: string, run: () => Promise<T>) => storeCall(config.logger, what, run);

async function expire(sweeper: Sweeper, record: FileRecord): Promise<Result<void>> {
  const { store, report } = sweeper;
  if (record.status === "completing") {
    const ended = await call(sweeper, `end the stuck completion of file ${record.id}`, () =>
      store.end(record.id, "completing", "failed", new Date(), { cleaned: true }),
    );
    if (ended.error) return ended;
    if (ended.data.changed) report.reported.push(ended.data.record);
    return ok(undefined);
  }
  const removed = await removeLeftovers(sweeper.config, record);
  if (removed.error) return removed;
  const ended = await call(sweeper, `expire file ${record.id}`, () =>
    store.end(record.id, "pending", "expired", new Date(), { cleaned: true }),
  );
  if (ended.error) return ended;
  if (ended.data.changed) report.expired += 1;
  return ok(undefined);
}

async function cleanUp(sweeper: Sweeper, record: FileRecord): Promise<Result<void>> {
  const removed = await removeLeftovers(sweeper.config, record);
  if (removed.error) return removed;
  const marked = await call(sweeper, `mark file ${record.id} cleaned`, () =>
    sweeper.store.cleaned(record.id, new Date()),
  );
  if (marked.error) return marked;
  sweeper.report.cleaned += 1;
  return ok(undefined);
}

/** One page of one pass: the rows handled and where the pass goes on, or null when it is done. */
async function sweepPage(
  sweeper: Sweeper,
  pass: Pass,
  page: { before: number; limit: number; cursor: string | null },
): Promise<Result<{ handled: number; cursor: string | null }>> {
  const claimedBefore = new Date(Date.now() - sweeper.config.completionLeaseMs);
  const found = await call(sweeper, `find ${pass} work`, () =>
    sweeper.store.stale({
      kind: pass,
      before: new Date(page.before),
      claimedBefore,
      limit: page.limit,
      cursor: page.cursor,
    }),
  );
  if (found.error) return found;
  for (const record of found.data.records) {
    const done = await (pass === "expire" ? expire(sweeper, record) : cleanUp(sweeper, record));
    if (done.error) return done;
  }
  return ok({ handled: found.data.records.length, cursor: found.data.cursor });
}

export async function sweep(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: SweepOptions | undefined,
): Promise<Result<SweepReport>> {
  const options = readOptions(given);
  if (options.error) return options;
  const { limit, graceMs } = options.data;
  const sweeper: Sweeper = { config, store, report: { expired: 0, cleaned: 0, reported: [], cursor: null } };
  const now = Date.now();
  let budget = limit;
  let cursor = options.data.cursor;
  if (options.data.pass === "expire") {
    const page = await sweepPage(sweeper, "expire", { before: now - graceMs, limit, cursor });
    if (page.error) return page;
    if (page.data.cursor !== null) return ok({ ...sweeper.report, cursor: `expire:${page.data.cursor}` });
    budget -= page.data.handled;
    cursor = null;
    if (budget === 0) return ok({ ...sweeper.report, cursor: "cleanup:" });
  }
  const before = now - Math.max(graceMs, MIN_CLEANUP_AGE_MS);
  const page = await sweepPage(sweeper, "cleanup", { before, limit: budget, cursor });
  if (page.error) return page;
  return ok({ ...sweeper.report, cursor: page.data.cursor === null ? null : `cleanup:${page.data.cursor}` });
}
