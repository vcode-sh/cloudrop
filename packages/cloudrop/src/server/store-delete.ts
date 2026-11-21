// A route's onDelete (M10-D4): run for each completed file that api.deleteFile, a replacing /complete or
// api.eraseOwner deletes. With a transaction it runs inside the deletion's, exactly once; without one it runs before the
// deletion is recorded, at least once, as onComplete runs under a lease.

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

/** The row's route when it has an onDelete; undefined otherwise, or when the server no longer has that route. */
const hookedRoute = (config: ServerConfig, name: string): RouteConfig | undefined => {
  const route = config.routes.get(name);
  return route?.definition.onDelete ? route : undefined;
};

/** The row as it was while completed: a deletion changes only its status and `endedAt`. */
const beforeDeletion = (record: FileRecord): FileRecord => ({ ...record, status: "completed", endedAt: null });

/** The route's onDelete for one file; false when it threw, which is logged. `tx` reaches only a store's own route. */
async function runOnDelete(
  config: ServerConfig,
  route: RouteConfig,
  file: FileRecord,
  reason: DeleteReason,
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
 * In one transaction: onDelete, then the row ends as deleted. When another deletion ended it first, onDelete's writes
 * roll back, so only that one's count. onDelete runs before cloudrop locks the row and the owner's usage, so its own
 * locks come first, as in onComplete.
 */
async function deleteInTransaction(
  config: ServerConfig,
  transaction: NonNullable<Store["transaction"]>,
  id: string,
  reason: DeleteReason,
): Promise<Result<Transition>> {
  let answer: Result<Transition> = fail(storeUnavailable());
  // Set before a deliberate rollback, so an adapter that wraps the thrown error cannot hide which throw it was.
  let rolledBack = false;
  const rollBack = (result: Result<Transition>) => {
    answer = result;
    rolledBack = true;
    throw new Error("cloudrop: rolled back the deletion.");
  };
  try {
    await transaction(async (tx, store) => {
      const row = await store.get(id);
      const route = row?.status === "completed" ? hookedRoute(config, row.route) : undefined;
      if (route && row && !(await runOnDelete(config, route, row, reason, { tx }))) {
        return rollBack(fail(hookFailed(route.name)));
      }
      const ended = await store.end(id, "completed", "deleted", new Date());
      if (!ended.changed) return rollBack(ok(ended));
      answer = ok(ended);
    });
  } catch (error) {
    if (rolledBack) return answer;
    config.logger.error(`cloudrop: the store failed to delete file ${id}.`, error);
    return fail(storeUnavailable());
  }
  return answer;
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
  if (store.transaction) return deleteInTransaction(config, store.transaction.bind(store), id, reason);
  const row = await storeCall(config.logger, `get file ${id}`, () => store.get(id));
  if (row.error) return row;
  const route = row.data?.status === "completed" ? hookedRoute(config, row.data.route) : undefined;
  if (route && row.data && !(await runOnDelete(config, route, row.data, reason, undefined))) {
    return fail(hookFailed(route.name));
  }
  return end();
}

/**
 * Under a lease, before a replacing completion is recorded: onDelete for each file of the owner it is about to replace.
 * Answers their ids; a throw answers as one in onComplete does, and the completion is not recorded.
 */
export async function beforeReplacing(
  config: ServerConfig,
  store: Store,
  route: RouteConfig,
  owner: string | null,
): Promise<Result<Set<string>>> {
  const ran = new Set<string>();
  if (!route.replace || !route.definition.onDelete || owner === null) return ok(ran);
  let cursor: string | null = null;
  do {
    const query = { owner, statuses: ["completed"] as const, route: route.name, name: null, type: null };
    const page: Result<{ records: FileRecord[]; cursor: string | null }> = await storeCall(
      config.logger,
      `list the files of ${owner} on route "${route.name}"`,
      () => store.list({ ...query, order: "newest", limit: PAGE, cursor }),
    );
    if (page.error) return page;
    for (const file of page.data.records) {
      if (!(await runOnDelete(config, route, file, "replaced", undefined))) return fail(unfinished());
      ran.add(file.id);
    }
    cursor = page.data.cursor;
  } while (cursor !== null);
  return ok(ran);
}

/**
 * onDelete for the files a completion replaced, except those `ran` already covered. In a transaction it stops at the
 * first throw, which rolls the completion back; under a lease the deletion is recorded, so each runs and a throw is
 * only logged. False when one threw.
 */
export async function afterReplacing(
  config: ServerConfig,
  route: RouteConfig,
  replaced: readonly FileRecord[],
  { ran = new Set<string>(), transaction }: { ran?: ReadonlySet<string>; transaction?: InTransaction },
): Promise<boolean> {
  if (!route.definition.onDelete) return true;
  let allRan = true;
  for (const file of replaced) {
    if (ran.has(file.id)) continue;
    allRan = (await runOnDelete(config, route, beforeDeletion(file), "replaced", transaction)) && allRan;
    if (!allRan && transaction) return false;
  }
  return allRan;
}
