// api.eraseOwner (M8-A5, M12-O): erases an owner in one call. It marks the owner first, so no upload of theirs is
// reserved after (M12-O2), then removes everything the owner's rows track, never by the application's key layout, then
// empties the folders `erase.prefixes` names (M12-O3), and records the erasure as finished once the store proves that
// nothing of the owner is left in the bucket or can still arrive. Each run is idempotent; the sweep carries on every
// marked owner's erasure until it is finished, and never marks one (M12-O4, M12-R3).

import { type CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, optionsOf } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import type { ContextOption } from "./delete-context.ts";
import { type Eraser, erasePasses } from "./erase-passes.ts";
import { emptyPrefixes, readPrefixes } from "./erase-prefixes.ts";
import { readGrace } from "./leftovers.ts";
import { badOwner, isOwnerOrId } from "./owner-files.ts";
import type { CloudropStore, OwnerErasure } from "./store.ts";
import { storeCall } from "./store-calls.ts";

/** `api.eraseOwner`'s options; `context` is what its routes' `onDelete` declare for an erasure. */
export type EraseOptions<TErased = unknown> = EraseRunOptions & ContextOption<TErased>;

interface EraseRunOptions {
  /**
   * How long a PUT already under way gets to land after its URL ran out, before the key is checked for the last time:
   * at least 900000 (15 minutes), at most 2592000000 (30 days). Default 3600000 (1 hour).
   */
  graceMs?: number;
  /** Stops the run before the next file; the report then says done: false. */
  signal?: AbortSignal;
}

export interface EraseReport {
  /** When the owner's erasure was first asked for: the erase mark, kept by every later run until `reopenOwner`. */
  requestedAt: Date;
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
   * Objects deleted from the folders `erase.prefixes` names, which no row tracks. They are emptied only once nothing of
   * the owner's rows is left; a folder that could not be emptied counts in `failed`.
   */
  prefixed: number;
  /**
   * True when the owner's erasure is finished: this run, or an earlier one, found nothing of the owner unfinished or
   * completed, every ended upload of theirs had its key checked once its URLs and the grace after them ran out, and
   * every prefix was emptied. From then on a run answers done at once. Until then the sweep runs it again for the
   * owner, so keep the sweep on its schedule: only the sweep ends a completion its server never finished.
   */
  done: boolean;
}

type Run = Pick<Eraser, "graceMs" | "signal" | "context">;

function readOptions(given: unknown): Result<Run> {
  const options = optionsOf(given);
  if (!options) return fail(invalidInput("eraseOwner takes options such as { graceMs: 3600000 }."));
  const { signal } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return fail(invalidInput("signal must be an AbortSignal, such as AbortSignal.timeout(60_000)."));
  }
  const graceMs = readGrace(options.graceMs);
  return graceMs.error ? graceMs : ok({ graceMs: graceMs.data, signal, context: options.context });
}

const emptyReport = (requestedAt: Date, done: boolean): EraseReport => ({
  requestedAt,
  revoked: 0,
  deleted: 0,
  refused: 0,
  cleaned: 0,
  failed: 0,
  waiting: 0,
  prefixed: 0,
  done,
});

/**
 * `erase.prefixes` is broken now. An owner whose erasure finished before still answers done: their folders were
 * emptied then, and nothing of theirs can be stored since. Any other owner gets the configuration error, and is not
 * marked. A failed read of the mark answers that error too.
 */
async function finishedBefore(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  owner: string,
  problem: CloudropError,
): Promise<Result<EraseReport>> {
  const usage = await storeCall(config.logger, `read the usage of ${owner}`, () => store.usage(owner));
  const erasure = usage.data?.erasure;
  return erasure?.erasedAt ? ok(emptyReport(erasure.requestedAt, true)) : fail(problem);
}

/**
 * The run once the owner's mark is known: revoke, the passes over rows, the prefixes, then `erased` against that very
 * mark, which records nothing when the owner was reopened meanwhile.
 */
async function runMarked(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  { owner, run, prefixes }: { owner: string; run: Run; prefixes: readonly string[] },
  { requestedAt, erasedAt }: OwnerErasure,
): Promise<Result<EraseReport>> {
  const report = emptyReport(requestedAt, erasedAt !== null);
  if (report.done || run.signal?.aborted) return ok(report);
  const startedAt = Date.now();
  const revoked = await storeCall(config.logger, `revoke the uploads of ${owner}`, () =>
    store.revoke(owner, new Date()),
  );
  if (revoked.error) return revoked;
  report.revoked = revoked.data;
  const eraser: Eraser = { config, store, owner, ...run, report };
  const passed = await erasePasses(eraser, startedAt);
  if (passed.error) return passed;
  if (!passed.data || report.failed > 0 || report.waiting > 0) return ok(report);
  if (!(await emptyPrefixes(eraser, prefixes))) return ok(report);
  const finished = await storeCall(config.logger, `record the erasure of ${owner} as finished`, () =>
    store.erased({ owner, requestedAt, now: new Date() }),
  );
  return finished.error ? finished : ok({ ...report, done: finished.data });
}

/**
 * The sweep's run for an owner its erase pass found (M12-O4). It never sets a mark (M12-R3): it carries on the mark
 * the owner has now, with that mark's `requestedAt`, and answers null when the owner has none, because the app reopened
 * them after the pass read its page.
 */
export async function continueErasure(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  owner: string,
  run: Run,
): Promise<Result<EraseReport | null>> {
  const usage = await storeCall(config.logger, `read the erase mark of ${owner}`, () => store.usage(owner));
  if (usage.error) return usage;
  const mark = usage.data.erasure;
  if (mark === null) return ok(null);
  const prefixes = readPrefixes(config, owner);
  // As in finishedBefore: an erasure finished before is done whatever erase.prefixes answers now.
  if (prefixes.error) return mark.erasedAt ? ok(emptyReport(mark.requestedAt, true)) : prefixes;
  return runMarked(config, store, { owner, run, prefixes: prefixes.data }, mark);
}

/**
 * The mark comes first. Every reserve of the owner either committed before it, and the row passes see its rows, or
 * reads it and refuses, so once an erasure is finished nothing of the owner can be stored again until `reopenOwner`.
 */
export async function eraseOwner(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  owner: unknown,
  given: unknown,
): Promise<Result<EraseReport>> {
  if (!isOwnerOrId(owner)) return badOwner();
  const run = readOptions(given);
  if (run.error) return run;
  const prefixes = readPrefixes(config, owner);
  if (prefixes.error) return finishedBefore(config, store, owner, prefixes.error);
  const marked = await storeCall(config.logger, `mark ${owner} for erasure`, () =>
    store.markErasure({ owner, now: new Date() }),
  );
  if (marked.error) return marked;
  return runMarked(config, store, { owner, run: run.data, prefixes: prefixes.data }, marked.data);
}
