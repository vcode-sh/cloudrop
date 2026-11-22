// eraseOwner's row passes (M8-A5): every row of the owner's, read by status in the order the proof rests on, each
// handled in turn, then the last reads for an upload that raced the run. erase.ts marks the owner first and empties the
// prefixes after, once these passes report done.

import { ok, type Result } from "../errors.ts";
import type { ServerConfig } from "./config.ts";
import type { EraseReport } from "./erase.ts";
import { removeLeftovers, settledAt } from "./leftovers.ts";
import type { CloudropStore, FileRecord, FileRecordStatus } from "./store.ts";
import { storeCall } from "./store-calls.ts";
import { deleteCompleted } from "./store-delete.ts";

/** One run of one owner's erasure, and its report so far. */
export interface Eraser {
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

/**
 * The row passes, then the last reads. The proof rests on this order. Once one read finds none of the owner's files
 * live, none can end after it (only a new /upload adds files), so the ended passes see every ended file. Reading the
 * live statuses one at a time would miss a file that moves between two of them, such as a completion that fails and
 * hands its file back. False when the signal stopped the run.
 */
export async function erasePasses(eraser: Eraser, startedAt: number): Promise<Result<boolean>> {
  const ran = await runPasses(eraser, [
    [["completed"], deleteOne],
    [LIVE, wait],
    ...ENDED.map((status) => [[status], checkEnded] as const),
  ]);
  return ran.error || !ran.data ? ran : lastReads(eraser, startedAt);
}
