// api.eraseOwner (M8-A5): removes everything an owner uploaded, driven by the owner's rows, never by the application's
// key layout, and reports whether the store proves that nothing of the owner is left in the bucket or can still arrive.
// Each run is idempotent; run it again until it reports done.

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import { readGrace, removeLeftovers, settledAt } from "./leftovers.ts";
import { badOwner, isOwnerOrId } from "./owner-files.ts";
import type { CloudropStore, FileRecord, FileStatus } from "./store.ts";
import { storeCall } from "./store-calls.ts";

export interface EraseOptions {
  /**
   * How long a PUT already under way gets to land after its URL ran out, before the key is checked for the last time:
   * at least 900000 (15 minutes). Default 3600000 (1 hour).
   */
  graceMs?: number;
  /** Stops the run before the next file; the report then says done: false. */
  signal?: AbortSignal;
}

export interface EraseReport {
  /** Unfinished uploads ended, so their next /sign or /complete is refused. */
  revoked: number;
  /** Completed files deleted: their rows are `deleted` and their bytes released. */
  deleted: number;
  /** Ended uploads whose key this run checked once their URLs and the grace had run out: it holds nothing of theirs. */
  cleaned: number;
  /** Files this run could not handle (a storage or database error, logged with the file's id). */
  failed: number;
  /**
   * Files not provable yet: a completion still under way, an upload that started after this run began, or an ended
   * upload whose URLs, or the grace after them, have not run out. Their objects were removed where there were any.
   */
  waiting: number;
  /**
   * True when the run found nothing of the owner unfinished or completed, and every ended upload of theirs had its key
   * checked once its URLs and the grace after them ran out. Run eraseOwner again until it is.
   */
  done: boolean;
}

interface Eraser {
  config: ServerConfig;
  store: CloudropStore<unknown>;
  owner: string;
  graceMs: number;
  signal: AbortSignal | undefined;
  report: EraseReport;
}

const PAGE = 100;
/** Read together, in one statement per page: a file in any of them at that moment keeps the owner from done. */
const LIVE: readonly FileStatus[] = ["pending", "completing", "completed"];
/** Read after the live statuses, one at a time, as ended rows never change status again. */
const ENDED: readonly FileStatus[] = ["aborted", "rejected", "failed", "expired", "deleted"];
const EVERY: readonly FileStatus[] = [...LIVE, ...ENDED];

function readOptions(given: unknown): Result<{ graceMs: number; signal: AbortSignal | undefined }> {
  const options = given ?? {};
  if (!isPlainObject(options)) return fail(invalidInput("eraseOwner takes options such as { graceMs: 3600000 }."));
  const { signal } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return fail(invalidInput("signal must be an AbortSignal, such as AbortSignal.timeout(60_000)."));
  }
  const graceMs = readGrace(options.graceMs, "the time a PUT already under way gets to land after its URL ran out");
  return graceMs.error ? graceMs : ok({ graceMs: graceMs.data, signal });
}

/** A completed file: ended as deleted now, so the `deleted` pass removes its object. */
async function deleteCompleted({ config, store, report }: Eraser, record: FileRecord): Promise<void> {
  const ended = await storeCall(config.logger, `delete file ${record.id}`, () =>
    store.end(record.id, "completed", "deleted", new Date()),
  );
  if (ended.error) report.failed += 1;
  else if (ended.data.changed) report.deleted += 1;
}

/**
 * An ended upload. Proven when it is not `failed` (a stuck completion's object is kept by the sweep) and was cleaned
 * once its check became final. Otherwise its key is checked now, and the check is final once the grace has passed.
 */
async function checkEnded({ config, store, graceMs, report }: Eraser, record: FileRecord): Promise<void> {
  const settled = settledAt(record, graceMs);
  if (record.status !== "failed" && record.cleanedAt !== null && record.cleanedAt.getTime() >= settled) return;
  // Taken before the check: a check that only finishes after the settle time did not look after it.
  const checkedAt = Date.now();
  const removed = await removeLeftovers(config, record);
  if (removed.error) {
    config.logger.error(
      `cloudrop: eraseOwner could not remove what file ${record.id} left in the bucket. Run eraseOwner again.`,
      removed.error,
    );
    report.failed += 1;
    return;
  }
  if (checkedAt < settled) {
    report.waiting += 1;
    return;
  }
  if (record.cleanedAt === null) {
    const marked = await storeCall(config.logger, `mark file ${record.id} cleaned`, () =>
      store.cleaned(record.id, new Date()),
    );
    if (marked.error) {
      report.failed += 1;
      return;
    }
  }
  report.cleaned += 1;
}

type Handler = (eraser: Eraser, record: FileRecord) => Promise<void>;

/**
 * Every page of the owner's rows in `statuses`, each row handled in turn. False when the signal stopped the run, which
 * is checked before each page and each row.
 */
async function eachRow(eraser: Eraser, statuses: readonly FileStatus[], handle: Handler): Promise<Result<boolean>> {
  const { config, store, owner, signal } = eraser;
  let cursor: string | null = null;
  do {
    if (signal?.aborted) return ok(false);
    const page: Result<{ records: FileRecord[]; cursor: string | null }> = await storeCall(
      config.logger,
      `list the ${statuses.join(" or ")} files of ${owner}`,
      () => store.list({ owner, statuses, route: null, limit: PAGE, cursor }),
    );
    if (page.error) return page;
    for (const record of page.data.records) {
      if (signal?.aborted) return ok(false);
      await handle(eraser, record);
    }
    cursor = page.data.cursor;
  } while (cursor !== null);
  return ok(true);
}

const wait = async ({ report }: Eraser): Promise<void> => {
  report.waiting += 1;
};

/** Each pass in turn. False when the signal stopped the run. */
async function runPasses(
  eraser: Eraser,
  passes: readonly (readonly [readonly FileStatus[], Handler])[],
): Promise<Result<boolean>> {
  for (const [statuses, handle] of passes) {
    const finished = await eachRow(eraser, statuses, handle);
    if (finished.error || !finished.data) return finished;
  }
  return ok(true);
}

/**
 * The last reads, when nothing is waiting yet. The owner's newest file in any status: one created since the run
 * started is an upload that began while it went on, even one already cancelled after its status was read. Then the
 * live statuses once more, for an /upload whose reserve began just before the run and committed during it. One that
 * starts after these reads is the race the guide describes.
 */
async function lastReads(eraser: Eraser, startedAt: number): Promise<Result<boolean>> {
  const { config, store, owner, report } = eraser;
  if (report.waiting > 0) return ok(true);
  const newest = await storeCall(config.logger, `list the newest file of ${owner}`, () =>
    store.list({ owner, statuses: EVERY, route: null, limit: 1, cursor: null }),
  );
  if (newest.error) return newest;
  if ((newest.data.records[0]?.createdAt.getTime() ?? 0) < startedAt) return eachRow(eraser, LIVE, wait);
  report.waiting += 1;
  return ok(true);
}

export async function eraseOwner(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  owner: unknown,
  given: unknown,
): Promise<Result<EraseReport>> {
  if (!isOwnerOrId(owner)) return badOwner();
  const options = readOptions(given);
  if (options.error) return options;
  const report: EraseReport = { revoked: 0, deleted: 0, cleaned: 0, failed: 0, waiting: 0, done: false };
  if (options.data.signal?.aborted) return ok(report);
  const startedAt = Date.now();
  const revoked = await storeCall(config.logger, `revoke the uploads of ${owner}`, () =>
    store.revoke(owner, new Date()),
  );
  if (revoked.error) return revoked;
  report.revoked = revoked.data;
  const eraser: Eraser = { config, store, owner, ...options.data, report };
  // The proof rests on this order. Once one read finds none of the owner's files live, none can end after it (only a
  // new /upload adds files), so the ended passes see every ended file. Reading the live statuses one at a time would
  // miss a file that moves between two of them, such as a completion that fails and hands its file back.
  const ran = await runPasses(eraser, [
    [["completed"], deleteCompleted],
    [LIVE, wait],
    ...ENDED.map((status) => [[status], checkEnded] as const),
  ]);
  const finished = ran.error || !ran.data ? ran : await lastReads(eraser, startedAt);
  if (finished.error) return finished;
  return ok({ ...report, done: finished.data && report.failed === 0 && report.waiting === 0 });
}
