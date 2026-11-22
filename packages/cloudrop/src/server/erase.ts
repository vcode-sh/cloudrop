// api.eraseOwner (M8-A5): removes everything an owner uploaded, driven by the owner's rows, never by the application's
// key layout, and reports whether the store proves that nothing of the owner is left in the bucket or can still arrive.
// Each run is idempotent; run it again until it reports done.

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, optionsOf } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import type { ContextOption } from "./delete-context.ts";
import { readGrace, removeLeftovers, settledAt } from "./leftovers.ts";
import { badOwner, isOwnerOrId } from "./owner-files.ts";
import type { CloudropStore, FileRecord, FileRecordStatus } from "./store.ts";
import { storeCall } from "./store-calls.ts";
import { deleteCompleted } from "./store-delete.ts";

/** `api.eraseOwner`'s options; `context` is what its routes' `onDelete` declare for an erasure (M12-T6). */
export type EraseOptions<TErased = unknown> = EraseSettings & ContextOption<TErased>;

interface EraseSettings {
  /**
   * How long a PUT already under way gets to land after its URL ran out, before the key is checked for the last time:
   * at least 900000 (15 minutes), at most 2592000000 (30 days). Default 3600000 (1 hour).
   */
  graceMs?: number;
  /** Stops the run before the next file; the report then says done: false. */
  signal?: AbortSignal;
}

export interface EraseReport {
  /**
   * Unfinished uploads ended, so their next /sign or /complete is refused. What they had uploaded is removed later in
   * the run, where each counts again, in `cleaned`, `waiting` or `failed`.
   */
  revoked: number;
  /**
   * Completed files deleted: their rows are `deleted` and their bytes released. Their objects are removed later in the
   * run, where each counts again, in `cleaned`, `waiting` or `failed`.
   */
  deleted: number;
  /**
   * Completed files kept because their route's `onDelete` refused. Each is still completed, with its object in the
   * bucket, and counts in `waiting` too.
   */
  refused: number;
  /**
   * Ended uploads whose key this run checked once their URLs and the grace had run out: the bucket holds nothing of
   * theirs, and nothing can arrive.
   */
  cleaned: number;
  /**
   * Files this run could not handle, each logged with its id. After a storage or database error the object may still
   * be in the bucket. A file whose `onDelete` threw is still completed, with its object, and counts in `waiting` too.
   */
  failed: number;
  /**
   * Files not proven gone yet, of two kinds. Still live, with what they stored still in the bucket: a completed file its
   * `onDelete` kept, a completion under way (one its server never finished stays so until the sweep ends it), and an
   * upload that started after this run began. Or ended so recently that one of its URLs, or a PUT in the grace after
   * them, can still put an object back: this run removed its object, and a later run checks its key again.
   */
  waiting: number;
  /**
   * True when the run found nothing of the owner unfinished or completed, and every ended upload of theirs had its key
   * checked once its URLs and the grace after them ran out. Run eraseOwner again until it is, with the sweep on its
   * schedule: only the sweep ends a completion its server never finished.
   */
  done: boolean;
}

interface Eraser {
  config: ServerConfig;
  store: CloudropStore<unknown>;
  owner: string;
  graceMs: number;
  signal: AbortSignal | undefined;
  context: unknown;
  report: EraseReport;
}

const PAGE = 100;
/** Read together, in one statement per page: a file in any of them at that moment keeps the owner from done. */
const LIVE: readonly FileRecordStatus[] = ["pending", "completing", "completed"];
/** Read after the live statuses, one at a time, as ended rows never change status again. */
const ENDED: readonly FileRecordStatus[] = ["aborted", "rejected", "failed", "expired", "deleted"];
const EVERY: readonly FileRecordStatus[] = [...LIVE, ...ENDED];
/** Every row of the owner's, in the store's default order. */
const UNFILTERED = { route: null, name: null, type: null, order: "newest" } as const;

function readOptions(given: unknown): Result<{ graceMs: number; signal: AbortSignal | undefined; context: unknown }> {
  const options = optionsOf(given);
  if (!options) return fail(invalidInput("eraseOwner takes options such as { graceMs: 3600000 }."));
  const { signal } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return fail(invalidInput("signal must be an AbortSignal, such as AbortSignal.timeout(60_000)."));
  }
  const graceMs = readGrace(options.graceMs);
  return graceMs.error ? graceMs : ok({ graceMs: graceMs.data, signal, context: options.context });
}

/**
 * A completed file: ended as deleted now, after its route's onDelete, so the `deleted` pass removes its object. One the
 * hook refused stays completed, and the live pass counts it as waiting.
 */
async function deleteOne({ config, store, context, report }: Eraser, record: FileRecord): Promise<void> {
  const ended = await deleteCompleted(config, store, record.id, { reason: "erased", context });
  if (ended.refused) report.refused += 1;
  else if (ended.error) report.failed += 1;
  else if (ended.data.changed) report.deleted += 1;
}

/**
 * An ended upload. Proven when it is not `failed` (a stuck completion's object is kept by the sweep) and was cleaned
 * once its check became final. Otherwise its key is checked now, and the check is final once the grace has passed.
 */
async function checkEnded({ config, store, graceMs, report }: Eraser, record: FileRecord): Promise<void> {
  const settled = settledAt(record, graceMs);
  if (record.status !== "failed" && record.cleanedAt !== null && record.cleanedAt.getTime() >= settled) return;
  const checked = await removeLeftovers(config, record);
  if (checked.error) {
    config.logger.error(
      `cloudrop: eraseOwner could not remove what file ${record.id} left in the bucket. Run eraseOwner again.`,
      checked.error,
    );
    report.failed += 1;
    return;
  }
  // The time the check started: a check that only finishes after the settle time did not look after it.
  const checkedAt = checked.data;
  if (checkedAt.getTime() < settled) {
    report.waiting += 1;
    return;
  }
  if (record.cleanedAt === null) {
    const marked = await storeCall(config.logger, `mark file ${record.id} cleaned`, () =>
      store.cleaned(record.id, checkedAt),
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
async function eachRow(
  eraser: Eraser,
  statuses: readonly FileRecordStatus[],
  handle: Handler,
): Promise<Result<boolean>> {
  const { config, store, owner, signal } = eraser;
  let cursor: string | null = null;
  do {
    if (signal?.aborted) return ok(false);
    const page: Result<{ records: FileRecord[]; cursor: string | null }> = await storeCall(
      config.logger,
      `list the ${statuses.join(" or ")} files of ${owner}`,
      () => store.list({ owner, statuses, ...UNFILTERED, limit: PAGE, cursor }),
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
  passes: readonly (readonly [readonly FileRecordStatus[], Handler])[],
): Promise<Result<boolean>> {
  for (const [statuses, handle] of passes) {
    const finished = await eachRow(eraser, statuses, handle);
    if (finished.error || !finished.data) return finished;
  }
  return ok(true);
}

/**
 * The last reads, when nothing is waiting yet. The owner's newest file in any status: one created since the run
 * started is an upload that began while it went on, even one already cancelled after its status was read. A row
 * carries the clock of the server that took its upload, which may lag this one's, so "since the run started" reaches
 * back by the grace: the store's times allow servers that much apart, as the sweep does, and a file that young was
 * waiting in this run anyway when the passes saw it (M11-R215). Then the live statuses once more, for an /upload
 * whose reserve began just before the run, committed during it and is still unfinished. One cancelled before these
 * reads, and one that starts after them, are the race the guide describes.
 */
async function lastReads(eraser: Eraser, startedAt: number): Promise<Result<boolean>> {
  const { config, store, owner, graceMs, report } = eraser;
  if (report.waiting > 0) return ok(true);
  const newest = await storeCall(config.logger, `list the newest file of ${owner}`, () =>
    store.list({ owner, statuses: EVERY, ...UNFILTERED, limit: 1, cursor: null }),
  );
  if (newest.error) return newest;
  const created = newest.data.records[0]?.createdAt.getTime() ?? 0;
  if (created < startedAt - graceMs) return eachRow(eraser, LIVE, wait);
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
  const report: EraseReport = { revoked: 0, deleted: 0, refused: 0, cleaned: 0, failed: 0, waiting: 0, done: false };
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
    [["completed"], deleteOne],
    [LIVE, wait],
    ...ENDED.map((status) => [[status], checkEnded] as const),
  ]);
  const finished = ran.error || !ran.data ? ran : await lastReads(eraser, startedAt);
  if (finished.error) return finished;
  return ok({ ...report, done: finished.data && report.failed === 0 && report.waiting === 0 });
}
