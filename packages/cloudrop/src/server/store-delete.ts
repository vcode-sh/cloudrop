// A route's onDelete (M10-D4): run for each completed file that api.deleteFile, a replacing /complete or
// api.eraseOwner deletes. It runs before cloudrop locks the file, so the app's own locks come first, as in onComplete;
// only a lease-mode replacement's late arrival runs after (M10-D6). With a transaction it runs inside the deletion's,
// exactly once; without one, before the deletion is recorded, at least once, as onComplete runs under a lease.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { unfinished } from "./complete-steps.ts";
import type { RouteConfig, ServerConfig } from "./config.ts";
import type { CloudropStore, DeleteReason, FileRecord, Transition } from "./store.ts";
import { storeCall, storeUnavailable } from "./store-calls.ts";
import { storeOfRoute } from "./store-route.ts";

type Store = CloudropStore<unknown>;
/** The transaction a hook runs in; absent under a lease. */
type InTransaction = { tx: unknown } | undefined;

const PAGE = 100;

const hookFailed = (route: string): CloudropError =>
  new CloudropError(
    "SERVER_ERROR",
    `onDelete failed for route "${route}", so the file was kept. Its error is in the server log; fix it and try again.`,
    { retryable: true },
  );

/** The route whose onDelete a completed row runs; undefined for any other row, or a route the server no longer has. */
function hookedRoute(config: ServerConfig, row: FileRecord | null): RouteConfig | undefined {
  const route = row?.status === "completed" ? config.routes.get(row.route) : undefined;
  return route?.definition.onDelete ? route : undefined;
}

/** The route's onDelete for one file; false when it threw, which is logged. `tx` reaches only a store's own route. */
async function runOnDelete(
  config: ServerConfig,
  route: RouteConfig,
  { file, reason }: { file: FileRecord; reason: DeleteReason },
  transaction: InTransaction,
): Promise<boolean> {
  const extra = transaction && storeOfRoute(route.definition) ? transaction : {};
  try {
    await route.definition.onDelete?.({ ...extra, file, owner: file.owner, reason });
    return true;
  } catch (error) {
    config.logger.error(`cloudrop: onDelete failed for route "${route.name}" while deleting file ${file.id}.`, error);
    return false;
  }
}

/**
 * After onDelete threw: the file was kept, unless another deletion took it meanwhile (a hook may throw just because it
 * lost that race, such as on a duplicate audit row), and then the answer is the one `end` gives for a deleted row.
 */
async function afterThrow(config: ServerConfig, store: Store, id: string, route: string): Promise<Result<Transition>> {
  const row = await storeCall(config.logger, `get file ${id}`, () => store.get(id));
  if (row.error) return row;
  return row.data?.status === "completed" ? fail(hookFailed(route)) : ok({ changed: false, record: row.data });
}

/**
 * In one transaction: onDelete, then the row ends as deleted. When another deletion ended it first, onDelete's writes
 * roll back, so only that one's count.
 */
async function deleteInTransaction(
  config: ServerConfig,
  store: Store,
  transaction: NonNullable<Store["transaction"]>,
  { id, reason }: { id: string; reason: DeleteReason },
): Promise<Result<Transition>> {
  let answer: Result<Transition> = fail(storeUnavailable());
  let threw: string | undefined;
  // Set before a deliberate rollback, so an adapter that wraps the thrown error cannot hide which throw it was.
  let rolledBack = false;
  const rollBack = (result: Result<Transition>) => {
    answer = result;
    rolledBack = true;
    throw new Error("cloudrop: rolled back the deletion.");
  };
  try {
    await transaction(async (tx, scoped) => {
      const row = await scoped.get(id);
      const route = hookedRoute(config, row);
      if (route && row && !(await runOnDelete(config, route, { file: row, reason }, { tx }))) {
        threw = route.name;
        return rollBack(answer);
      }
      const ended = await scoped.end(id, "completed", "deleted", new Date());
      if (!ended.changed) return rollBack(ok(ended));
      answer = ok(ended);
    });
  } catch (error) {
    if (!rolledBack) {
      config.logger.error(`cloudrop: the store failed to delete file ${id}.`, error);
      return fail(storeUnavailable());
    }
  }
  return threw === undefined ? answer : afterThrow(config, store, id, threw);
}

/**
 * Ends a completed file as deleted, after its route's onDelete; answers as `end` does. A throw in onDelete keeps the
 * file and answers SERVER_ERROR. Without any onDelete on the server, this is `end` alone, as before onDelete existed.
 */
export async function deleteCompleted(
  config: ServerConfig,
  store: Store,
  id: string,
  reason: DeleteReason,
): Promise<Result<Transition>> {
  const end = () =>
    storeCall(config.logger, `delete file ${id}`, () => store.end(id, "completed", "deleted", new Date()));
  if (![...config.routes.values()].some((route) => route.definition.onDelete)) return end();
  // Bound, as a store written as a class reads its own fields in transaction.
  if (store.transaction) return deleteInTransaction(config, store, store.transaction.bind(store), { id, reason });
  const row = await storeCall(config.logger, `get file ${id}`, () => store.get(id));
  if (row.error) return row;
  const route = hookedRoute(config, row.data);
  if (route && row.data && !(await runOnDelete(config, route, { file: row.data, reason }, undefined))) {
    return afterThrow(config, store, id, route.name);
  }
  return end();
}

/**
 * Before a replacing completion is recorded: onDelete for each file of the owner it is about to replace, with `tx` in a
 * transaction. Answers their ids, or null when the route has no onDelete; a throw answers as one in onComplete does,
 * and the completion is not recorded.
 */
export async function beforeReplacing(
  config: ServerConfig,
  store: Store | Omit<Store, "transaction">,
  { route, owner }: { route: RouteConfig; owner: string | null },
  transaction?: InTransaction,
): Promise<Result<Set<string> | null>> {
  if (!route.replace || !route.definition.onDelete) return ok(null);
  const ran = new Set<string>();
  if (owner === null) return ok(ran);
  const query = { owner, statuses: ["completed"] as const, route: route.name, name: null, type: null, limit: PAGE };
  let cursor: string | null = null;
  do {
    const page: Result<{ records: FileRecord[]; cursor: string | null }> = await storeCall(
      config.logger,
      `list the files of ${owner} on route "${route.name}"`,
      () => store.list({ ...query, order: "newest", cursor }),
    );
    if (page.error) return page;
    for (const file of page.data.records) {
      if (!(await runOnDelete(config, route, { file, reason: "replaced" }, transaction))) return fail(unfinished());
      ran.add(file.id);
    }
    cursor = page.data.cursor;
  } while (cursor !== null);
  return ok(ran);
}

/**
 * In a transaction: whether the completion replaced exactly the files `beforeReplacing` ran onDelete for. Another
 * completion or deletion of the owner's files in between makes it false, and the completion rolls back.
 */
export const replacedAsListed = (listed: ReadonlySet<string> | null, replaced: readonly FileRecord[]): boolean =>
  listed === null || (replaced.length === listed.size && replaced.every((file) => listed.has(file.id)));

/**
 * Under a lease, once the completion is recorded: onDelete for a replaced file that completed after `beforeReplacing`
 * listed the owner's files. The deletion is recorded, so a throw is only logged.
 */
export async function afterReplacing(
  config: ServerConfig,
  route: RouteConfig,
  listed: ReadonlySet<string> | null,
  replaced: readonly FileRecord[],
): Promise<void> {
  if (listed === null) return;
  for (const file of replaced) {
    if (listed.has(file.id)) continue;
    // The row as it was while completed: a deletion changes only its status and `endedAt`.
    const before: FileRecord = { ...file, status: "completed", endedAt: null };
    await runOnDelete(config, route, { file: before, reason: "replaced" }, undefined);
  }
}
