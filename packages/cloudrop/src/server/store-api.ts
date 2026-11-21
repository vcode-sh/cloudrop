// The file API's store operations (M5 spec §6): rows, usage, revocation, deletion, repair and the sweep. Without a
// store each one answers INVALID_CONFIG.

import { CloudropError, configError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import { type EraseOptions, type EraseReport, eraseOwner } from "./erase.ts";
import { removeDeleted } from "./leftovers.ts";
import { badOwner, type FilesOptions, type FilesPage, isOwnerOrId, listFiles } from "./owner-files.ts";
import type { CloudropStore, FileRecord, OwnerUsage } from "./store.ts";
import { storeCall } from "./store-calls.ts";
import { deleteCompleted } from "./store-delete.ts";
import { type SweepOptions, type SweepReport, sweep } from "./sweep.ts";

export interface StoreFileApi {
  /** A file's row, or null when the store has none. */
  file(id: string): Promise<Result<FileRecord | null>>;
  /** An owner's completed files, newest or oldest first, optionally by route, name and type, a page at a time. */
  files(options: FilesOptions): Promise<Result<FilesPage>>;
  /** An owner's counters, with or without a quota. */
  usage(owner: string): Promise<Result<OwnerUsage>>;
  /** Ends an owner's unfinished uploads, such as at sign-out: their next /sign or /complete is refused. */
  revokeUploads(options: { owner: string }): Promise<Result<{ revoked: number }>>;
  /**
   * Deletes a completed file: its route's `onDelete` runs, its row becomes `deleted`, its bytes are released and its
   * object removed. Idempotent.
   */
  deleteFile(id: string): Promise<Result<{ id: string }>>;
  /**
   * Erases an owner, such as a deleted account: ends their unfinished uploads, deletes every completed file and removes
   * what ended uploads left. Idempotent; run it again, such as with each sweep, until it reports done.
   */
  eraseOwner(owner: string, options?: EraseOptions): Promise<Result<EraseReport>>;
  /** Recounts one owner's counters from their rows, or every owner's: for drift after manual database edits. */
  reconcile(options?: { owner?: string }): Promise<Result<{ checked: number; repaired: number }>>;
  /** One bounded round of cleanup; run it on a schedule, such as an hourly cron. */
  sweep(options?: SweepOptions): Promise<Result<SweepReport>>;
}

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
): Promise<Result<{ id: string }>> {
  const ended = await deleteCompleted(config, store, id, "deleted");
  if (ended.error) return ended;
  const { changed, record } = ended.data;
  if (record?.status !== "deleted") return fail(notCompleted());
  // Deleted and cleaned before: nothing is left to do. Deleted but not cleaned: an earlier call stopped in between, or
  // the file's URLs could still put it back, and the key is checked again.
  if (!changed && record.cleanedAt !== null) return ok({ id });
  const removed = await removeDeleted(config, store, record);
  return removed.error ? removed : ok({ id });
}

async function reconcile(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: unknown,
): Promise<Result<{ checked: number; repaired: number }>> {
  const options = given ?? {};
  if (!isPlainObject(options)) return fail(invalidInput("reconcile takes { owner } or nothing."));
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
  whenReady: <T>(call: () => Promise<Result<T>>) => Promise<Result<T>>,
): StoreFileApi {
  const { logger } = config;
  const withStore = <T>(name: keyof StoreFileApi, call: (store: CloudropStore<unknown>) => Promise<Result<T>>) =>
    whenReady(() =>
      config.store
        ? call(config.store)
        : Promise.resolve(fail(configError(`api.${name} needs a database store. Pass store to createCloudrop.`))),
    );
  return {
    file: (id) =>
      withStore("file", async (store) =>
        isOwnerOrId(id) ? storeCall(logger, `get file ${id}`, () => store.get(id)) : badId(),
      ),
    files: (options) => withStore("files", (store) => listFiles(config, store, options)),
    usage: (owner) =>
      withStore("usage", async (store) =>
        isOwnerOrId(owner) ? storeCall(logger, `read the usage of ${owner}`, () => store.usage(owner)) : badOwner(),
      ),
    revokeUploads: (options) =>
      withStore("revokeUploads", async (store) => {
        const owner = isPlainObject(options) ? options.owner : undefined;
        if (!isOwnerOrId(owner)) return badOwner();
        const revoked = await storeCall(logger, `revoke the uploads of ${owner}`, () =>
          store.revoke(owner, new Date()),
        );
        return revoked.error ? revoked : ok({ revoked: revoked.data });
      }),
    deleteFile: (id) =>
      withStore("deleteFile", async (store) => (isOwnerOrId(id) ? deleteFile(config, store, id) : badId())),
    eraseOwner: (owner, options) => withStore("eraseOwner", (store) => eraseOwner(config, store, owner, options)),
    reconcile: (options) => withStore("reconcile", (store) => reconcile(config, store, options)),
    sweep: (options) => withStore("sweep", (store) => sweep(config, store, options)),
  };
}
