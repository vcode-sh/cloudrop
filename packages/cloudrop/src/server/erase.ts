// api.eraseOwner (M8-A5, M12-O): erases an owner in one call. It marks the owner first, so no upload of theirs is
// reserved after (M12-O2), then removes everything the owner's rows track, never by the application's key layout, then
// empties the folders `erase.prefixes` names (M12-O3), and records the erasure as finished once the store proves that
// nothing of the owner is left in the bucket or can still arrive. Each run is idempotent; the sweep runs it again for
// every marked owner until it is finished (M12-O4).

import { CloudropError, configError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, optionsOf } from "../input.ts";
import { deletePrefix } from "./api.ts";
import type { ServerConfig } from "./config.ts";
import type { ContextOption } from "./delete-context.ts";
import { type Eraser, erasePasses } from "./erase-passes.ts";
import { readGrace } from "./leftovers.ts";
import { badOwner, isOwnerOrId } from "./owner-files.ts";
import type { CloudropStore } from "./store.ts";
import { storeCall } from "./store-calls.ts";

/** `api.eraseOwner`'s options; `context` is what its routes' `onDelete` declare for an erasure (M12-T6). */
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

/**
 * The owner as one whole segment of a folder prefix, as it is or URI-encoded (M12-O3), so that `() => ["avatars/"]`,
 * which would empty every owner's folder, is refused. Compared in NFC, the form deletePrefix reads a prefix in.
 */
function ownsPrefix(prefix: unknown, owner: string): prefix is string {
  if (typeof prefix !== "string" || !prefix.endsWith("/")) return false;
  const forms = new Set([owner, encodeURIComponent(owner)].map((form) => form.normalize("NFC")));
  return prefix
    .normalize("NFC")
    .split("/")
    .some((segment) => forms.has(segment));
}

const PREFIX_RULE =
  'It must answer a list of folders that end in "/" and each have the owner, as it is or URI-encoded, as one whole segment between slashes, such as "exports/<owner>/", so that no prefix reaches another owner\'s files.';

/** `erase.prefixes(owner)`, each checked before any is emptied. */
function readPrefixes(config: ServerConfig, owner: string): Result<readonly string[]> {
  if (!config.erasePrefixes) return ok([]);
  let prefixes: unknown;
  try {
    prefixes = config.erasePrefixes(owner);
  } catch (cause) {
    return fail(new CloudropError("INVALID_CONFIG", "erase.prefixes threw; its cause says why. Fix it.", { cause }));
  }
  if (!Array.isArray(prefixes)) return fail(configError(`erase.prefixes answered no list. ${PREFIX_RULE}`));
  const unsafe = prefixes.findIndex((prefix) => !ownsPrefix(prefix, owner));
  if (unsafe === -1) return ok(prefixes);
  const shown: unknown = prefixes[unsafe];
  return fail(configError(`erase.prefixes answered ${JSON.stringify(shown) ?? String(shown)}. ${PREFIX_RULE}`));
}

/** Empties each prefix in turn, counting what it deleted; a folder that fails is logged and counted in `failed`. */
async function emptyPrefixes({ config, signal, report }: Eraser, prefixes: readonly string[]): Promise<boolean> {
  for (const prefix of prefixes) {
    if (signal?.aborted) return false;
    const emptied = await deletePrefix(config.storage, prefix.normalize("NFC"));
    if (emptied.error) {
      config.logger.error(`cloudrop: eraseOwner could not empty ${prefix}. Run eraseOwner again.`, emptied.error);
      report.failed += 1;
    } else {
      report.prefixed += emptied.data.deleted;
    }
  }
  return report.failed === 0;
}

/**
 * One run for an owner the options were read for: also the sweep's, for each marked owner (M12-O4). The mark comes
 * first. Every reserve of the owner either committed before it, and the row passes see its rows, or reads it and
 * refuses, so once an erasure is finished nothing of the owner can be stored again until `reopenOwner`.
 */
export async function eraseRun(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  owner: string,
  run: Run,
): Promise<Result<EraseReport>> {
  const prefixes = readPrefixes(config, owner);
  if (prefixes.error) return prefixes;
  const marked = await storeCall(config.logger, `mark ${owner} for erasure`, () =>
    store.markErasure({ owner, now: new Date() }),
  );
  if (marked.error) return marked;
  const { requestedAt, erasedAt } = marked.data;
  const counts = { revoked: 0, deleted: 0, refused: 0, cleaned: 0, failed: 0, waiting: 0, prefixed: 0 };
  const report: EraseReport = { requestedAt, ...counts, done: erasedAt !== null };
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
  if (!(await emptyPrefixes(eraser, prefixes.data))) return ok(report);
  const finished = await storeCall(config.logger, `record the erasure of ${owner} as finished`, () =>
    store.erased({ owner, requestedAt, now: new Date() }),
  );
  return finished.error ? finished : ok({ ...report, done: finished.data });
}

export async function eraseOwner(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  owner: unknown,
  given: unknown,
): Promise<Result<EraseReport>> {
  if (!isOwnerOrId(owner)) return badOwner();
  const options = readOptions(given);
  return options.error ? options : eraseRun(config, store, owner, options.data);
}
