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
   * How long after an upload's URLs could last start a PUT its key is checked for the last time, as the sweep's
   * `graceMs`: at least 900000 (15 minutes). Default 3600000 (1 hour).
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
  /** Ended uploads whose key was checked for the last time in this run and holds nothing of theirs. */
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
/** The ended statuses, read after `completed`, so the files this run deletes are checked in the same run. */
const ENDED: readonly FileStatus[] = ["aborted", "rejected", "failed", "expired", "deleted"];
/** Read last: a file that is here once everything else was handled keeps the owner from being proven empty. */
const LIVE: readonly FileStatus[] = ["pending", "completing", "completed"];

function readOptions(given: unknown): Result<{ graceMs: number; signal: AbortSignal | undefined }> {
  const options = given ?? {};
  if (!isPlainObject(options)) return fail(invalidInput("eraseOwner takes options such as { graceMs: 3600000 }."));
  const { signal } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return fail(invalidInput("signal must be an AbortSignal, such as AbortSignal.timeout(60_000)."));
  }
  const graceMs = readGrace(options.graceMs);
  return graceMs.error ? graceMs : ok({ graceMs: graceMs.data, signal });
}

/** A completed file: ended as deleted now, so the `deleted` pass after it removes its object. */
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
  const removed = await removeLeftovers(config, record);
  if (removed.error) {
    config.logger.error(
      `cloudrop: eraseOwner could not remove what file ${record.id} left in the bucket. Run eraseOwner again.`,
      removed.error,
    );
    report.failed += 1;
    return;
  }
  if (Date.now() < settled) {
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

/** Every page of the owner's rows in `status`, each row handled in turn. False when the signal stopped the run. */
async function eachRow(eraser: Eraser, status: FileStatus, handle: Handler): Promise<Result<boolean>> {
  const { config, store, owner, signal } = eraser;
  let cursor: string | null = null;
  do {
    const page: Result<{ records: FileRecord[]; cursor: string | null }> = await storeCall(
      config.logger,
      `list the ${status} files of ${owner}`,
      () => store.list({ owner, status, route: null, limit: PAGE, cursor }),
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

export async function eraseOwner(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  owner: unknown,
  given: unknown,
): Promise<Result<EraseReport>> {
  if (!isOwnerOrId(owner)) return badOwner();
  const options = readOptions(given);
  if (options.error) return options;
  const revoked = await storeCall(config.logger, `revoke the uploads of ${owner}`, () =>
    store.revoke(owner, new Date()),
  );
  if (revoked.error) return revoked;
  const report: EraseReport = { revoked: revoked.data, deleted: 0, cleaned: 0, failed: 0, waiting: 0, done: false };
  const eraser: Eraser = { config, store, owner, ...options.data, report };
  const passes: readonly (readonly [FileStatus, Handler])[] = [
    ["completed", deleteCompleted],
    ...ENDED.map((status) => [status, checkEnded] as const),
    ...LIVE.map((status) => [status, wait] as const),
  ];
  for (const [status, handle] of passes) {
    const finished = await eachRow(eraser, status, handle);
    if (finished.error) return finished;
    if (!finished.data) return ok(report);
  }
  return ok({ ...report, done: report.failed === 0 && report.waiting === 0 });
}
