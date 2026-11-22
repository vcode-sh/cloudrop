// The file API's store operations (M5 spec §6): rows, usage, revocation, deletion, repair and the sweep. The server
// reaches them through the store object (M12-S1); without a store, api.ts answers each one INVALID_CONFIG.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, optionsOf } from "../input.ts";
import { type AllFilesOptions, listAllFiles } from "./all-files.ts";
import type { FileApi } from "./api.ts";
import type { ServerConfig } from "./config.ts";
import type { ContextOption } from "./delete-context.ts";
import { type EraseOptions, type EraseReport, eraseOwner } from "./erase.ts";
import { removeDeleted } from "./leftovers.ts";
import { badOwner, type FilesOptions, type FilesPage, isOwnerOrId, listFiles } from "./owner-files.ts";
import type { CloudropStore, CompletedRecord, FileRecord, FileRecordStatus, OwnerUsage, RecordOf } from "./store.ts";
import { storeCall } from "./store-calls.ts";
import { deleteCompleted } from "./store-delete.ts";
import { type SweepOptions, type SweepReport, sweep } from "./sweep.ts";

/**
 * `api` on a server with a store: the storage calls and the store's. `R` is the server's route names, the type of every
 * record's `route` and of the listings' `route` filter. `TDeleted` and `TErased` are the `context` the routes' `onDelete`
 * declare: required when it does not admit undefined.
 */
export interface StoreFileApi<R extends string = string, TDeleted = unknown, TErased = TDeleted> extends FileApi {
  /** A file's row, or null when the store has none. */
  file(id: string): Promise<Result<FileRecord<R> | null>>;
  /** An owner's completed files, newest or oldest first, optionally by route, name and type, a page at a time. */
  files(options: FilesOptions<R>): Promise<Result<FilesPage<CompletedRecord<R>>>>;
  /**
   * The files of every owner, in any status, newest or oldest first, optionally by owner, status, route, name and
   * type, a page at a time. It crosses owners: call it only behind your app's own admin check, never with options a
   * visitor chose. With a `status`, the records are typed by it: `{ status: "failed" }` answers `FailedRecord`s.
   */
  allFiles<S extends FileRecordStatus = FileRecordStatus>(
    options?: AllFilesOptions<R, S>,
  ): Promise<Result<FilesPage<RecordOf<S, R>>>>;
  /** An owner's counters, with or without a quota, and their erase mark: null unless `eraseOwner` marked them. */
  usage(owner: string): Promise<Result<OwnerUsage>>;
  /** Ends an owner's unfinished uploads, such as at sign-out: their next /sign or /complete is refused. */
  revokeUploads(owner: string): Promise<Result<{ revoked: number }>>;
  /**
   * Deletes a completed file: its route's `onDelete` runs, with `context` if you pass one (such as who asked and why),
   * its row becomes `deleted`, its bytes are released and its object removed. Idempotent: `deleted` says whether this
   * call deleted it. When `onDelete` returns a `CloudropError`, the file is kept and that error is the answer.
   */
  deleteFile(
    id: string,
    ...options: undefined extends TDeleted ? [DeleteFileOptions<TDeleted>?] : [DeleteFileOptions<TDeleted>]
  ): Promise<Result<DeletedFile>>;
  /**
   * Erases an owner, such as a deleted account, in one call: marks them, so every later upload of theirs is refused
   * with FORBIDDEN, ends their unfinished uploads, deletes every completed file, removes what ended uploads left and
   * empties `erase.prefixes`. What one run cannot finish, the sweep carries on; once done, a run answers done at once.
   */
  eraseOwner(
    owner: string,
    ...options: undefined extends TErased ? [EraseOptions<TErased>?] : [EraseOptions<TErased>]
  ): Promise<Result<EraseReport>>;
  /**
   * Clears an owner's erase mark, for an owner id used again or an erasure started by mistake: their uploads are
   * accepted again and the sweep stops erasing them. What was deleted stays deleted. `reopened` is false without a mark.
   */
  reopenOwner(owner: string): Promise<Result<{ reopened: boolean }>>;
  /** Recounts one owner's counters from their rows, or every owner's: for drift after manual database edits. */
  reconcile(options?: { owner?: string }): Promise<Result<{ checked: number; repaired: number }>>;
  /**
   * One bounded round of cleanup, which also carries on every unfinished erasure; run it on a schedule, such as an
   * hourly cron. Its `context` reaches `onDelete` as an erasure's does, so it is required when theirs is.
   */
  sweep(
    ...options: undefined extends TErased ? [SweepOptions<TErased>?] : [SweepOptions<TErased>]
  ): Promise<Result<SweepReport>>;
}

/** `api.deleteFile`'s options: the `context` its routes' `onDelete` declare. */
export type DeleteFileOptions<TDeleted = unknown> = ContextOption<TDeleted>;

/** What `api.deleteFile` did. */
export interface DeletedFile {
  id: string;
  /** True when this call deleted the file; false when it was deleted already. */
  deleted: boolean;
  /**
   * True when the file's row is marked cleaned: the bucket was checked once the file's URLs and the grace after them
   * had run out, and holds nothing of it. False while the sweep still has to check again, also after a failure to remove
   * the object, which is logged.
   */
  cleaned: boolean;
}

/** The store's calls alone, as `storeApi` and the store-less stub in `api.ts` make them. */
export type StoreMethods = Omit<StoreFileApi, keyof FileApi>;

const OWNERS_PAGE = 100;

const badId = () => fail(invalidInput("Pass the file id, as returned with the uploaded file."));

const notCompleted = (): CloudropError =>
  new CloudropError(
    "NOT_FOUND",
    "No completed file has this id. deleteFile deletes only files whose upload completed.",
  );

async function deleteFile(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  id: string,
  given: unknown,
): Promise<Result<DeletedFile>> {
  const options = optionsOf(given);
  if (!options) return fail(invalidInput("deleteFile takes the file id and optionally { context }."));
  const ended = await deleteCompleted(config, store, id, { reason: "deleted", context: options.context });
  // Also onDelete's refusal: the error as the hook returned it, without the mark deleteCompleted answers it with.
  if (ended.error) return fail(ended.error);
  const { changed: deleted, record } = ended.data;
  if (record?.status !== "deleted") return fail(notCompleted());
  // Deleted and cleaned before: nothing is left to do. Deleted but not cleaned: an earlier call stopped in between, or
  // the file's URLs could still put it back, and the key is checked again.
  const cleaned = (!deleted && record.cleanedAt !== null) || (await removeDeleted(config, store, record, "deleted"));
  return ok({ id, deleted, cleaned });
}

async function reconcile(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: unknown,
): Promise<Result<{ checked: number; repaired: number }>> {
  const options = optionsOf(given);
  if (!options) return fail(invalidInput("reconcile takes { owner } or nothing."));
  const repair = (owner: string) => storeCall(config.logger, `reconcile owner ${owner}`, () => store.reconcile(owner));
  if (options.owner !== undefined) {
    if (!isOwnerOrId(options.owner)) return badOwner();
    const repaired = await repair(options.owner);
    return repaired.error ? repaired : ok({ checked: 1, repaired: Number(repaired.data) });
  }
  const totals = { checked: 0, repaired: 0 };
  let cursor: string | null = null;
  do {
    const page: Result<{ owners: string[]; cursor: string | null }> = await storeCall(
      config.logger,
      "list owners",
      () => store.owners(cursor, OWNERS_PAGE),
    );
    if (page.error) return page;
    for (const owner of page.data.owners) {
      const repaired = await repair(owner);
      if (repaired.error) return repaired;
      totals.checked += 1;
      totals.repaired += Number(repaired.data);
    }
    cursor = page.data.cursor;
  } while (cursor !== null);
  return ok(totals);
}

/** The store operations, each waiting for the environment like every api call (`whenReady`). */
export function storeApi(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  whenReady: <T>(call: () => Promise<Result<T>>) => Promise<Result<T>>,
): StoreMethods {
  const { logger } = config;
  return {
    file: (id) =>
      whenReady(async () => (isOwnerOrId(id) ? storeCall(logger, `get file ${id}`, () => store.get(id)) : badId())),
    files: (options) => whenReady(() => listFiles(config, store, options)),
    allFiles: <S extends FileRecordStatus>(options?: AllFilesOptions<string, S>) =>
      whenReady(() => listAllFiles<S>(config, store, options)),
    usage: (owner) =>
      whenReady(async () =>
        isOwnerOrId(owner) ? storeCall(logger, `read the usage of ${owner}`, () => store.usage(owner)) : badOwner(),
      ),
    revokeUploads: (owner) =>
      whenReady(async () => {
        if (!isOwnerOrId(owner)) return badOwner();
        const revoked = await storeCall(logger, `revoke the uploads of ${owner}`, () =>
          store.revoke(owner, new Date()),
        );
        return revoked.error ? revoked : ok({ revoked: revoked.data });
      }),
    deleteFile: (id, options) =>
      whenReady(async () => (isOwnerOrId(id) ? deleteFile(config, store, id, options) : badId())),
    eraseOwner: (owner, options) => whenReady(() => eraseOwner(config, store, owner, options)),
    reopenOwner: (owner) =>
      whenReady(async () => {
        if (!isOwnerOrId(owner)) return badOwner();
        const reopened = await storeCall(logger, `reopen ${owner}`, () => store.reopen({ owner, now: new Date() }));
        return reopened.error ? reopened : ok({ reopened: reopened.data });
      }),
    reconcile: (options) => whenReady(() => reconcile(config, store, options)),
    sweep: (options) => whenReady(() => sweep(config, store, options)),
  };
}
