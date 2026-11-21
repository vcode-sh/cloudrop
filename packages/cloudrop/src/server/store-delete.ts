// A route's onDelete (M10-D4): run for each completed file that api.deleteFile, a replacing /complete or
// api.eraseOwner deletes. It runs before cloudrop locks the file, so the app's own locks come first, as in onComplete;
// only a lease-mode replacement's late arrival runs after (M10-D6). With a transaction it runs inside the deletion's,
// and its writes through tx commit once (a racing deletion that finds the file gone rolls back); without one, before
// the deletion is recorded, at least once, as onComplete runs under a lease. It refuses a deletion by returning a
// CloudropError (M11-D3): the file is kept, nothing is logged, and the caller answers that error.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { unfinished } from "./complete-steps.ts";
import type { RouteConfig, ServerConfig } from "./config.ts";
import type { DeleteReason } from "./delete-context.ts";
import type { CloudropStore, FileRecord, Transition } from "./store.ts";
import { storeCall, storeUnavailable } from "./store-calls.ts";
import { storeOfRoute } from "./store-route.ts";

type Store = CloudropStore<unknown>;
/** The transaction a hook runs in; absent under a lease. */
type InTransaction = { tx: unknown } | undefined;

const PAGE = 100;

/** As `end` answers. `refused` marks the error as the one the file's onDelete returned to keep it, not a failure. */
type DeleteOutcome = Result<Transition> & { refused?: true };

/** Why a file is deleted, and what reaches its onDelete besides the row. */
export interface Deletion {
  reason: DeleteReason;
  context?: unknown;
  request?: Request;
}

const hookFailed = (route: string): CloudropError =>
  new CloudropError(
    "SERVER_ERROR",
    `onDelete failed for route "${route}", so the file was kept. Its error is in the server log; fix it and try again.`,
    { retryable: true },
  );

/** The route whose onDelete a completed file runs; undefined without one, or for a route the server no longer has. */
function hookedRoute(config: ServerConfig, file: FileRecord): RouteConfig | undefined {
  const route = config.routes.get(file.route);
  return route?.definition.onDelete ? route : undefined;
}

/**
 * The answer for a row that was not completed when the deletion read it, as `end` gives for one it does not change.
 * `end` is never called for such a row (M11-R150): the hook is chosen from this read, so an upload whose completion is
 * recorded right after it would be deleted with no onDelete.
 */
const asRead = (row: FileRecord | null): Result<Transition> => ok({ changed: false, record: row });

/**
 * The route's onDelete for one file. Undefined lets the deletion go on; anything else keeps the file: the CloudropError
 * the hook returned to refuse, or false when the hook failed, which is logged. It failed when it threw (a CloudropError
 * too: one may come from a cloudrop call inside the hook) or returned any other value. `tx` reaches only a store's own
 * route.
 */
async function runOnDelete(
  config: ServerConfig,
  route: RouteConfig,
  file: FileRecord,
  { reason, context, request }: Deletion,
  transaction: InTransaction,
): Promise<CloudropError | false | undefined> {
  const extra = transaction && storeOfRoute(route.definition) ? transaction : {};
  const from = request === undefined ? {} : { request };
  try {
    const kept = await route.definition.onDelete?.({ ...extra, ...from, file, owner: file.owner, reason, context });
    if (kept === undefined || kept instanceof CloudropError) return kept;
    // A CloudropError from a second installed copy of cloudrop fails that check too, so the message names the cause.
    throw new TypeError(
      `onDelete returned a value of type ${typeof kept}. To keep the file, return a CloudropError from the same cloudrop the server uses; otherwise return nothing.`,
    );
  } catch (error) {
    config.logger.error(`cloudrop: onDelete failed for route "${route.name}" while deleting file ${file.id}.`, error);
    return false;
  }
}

/**
 * After onDelete failed: the file was kept, unless another deletion took it meanwhile (a hook may throw just because it
 * lost that race, such as on a duplicate audit row), and then the answer is the one `end` gives for a deleted row. A
 * refusal is not read again: it is the hook's answer to this caller, whatever happens to the file since (M11-D5).
 */
async function afterThrow(config: ServerConfig, store: Store, id: string, route: string): Promise<Result<Transition>> {
  const row = await storeCall(config.logger, `get file ${id}`, () => store.get(id));
  if (row.error) return row;
  return row.data?.status === "completed" ? fail(hookFailed(route)) : asRead(row.data);
}

/**
 * In one transaction: onDelete, then the row ends as deleted. When another deletion ended it first, or the hook
 * refuses, onDelete's writes roll back.
 */
async function deleteInTransaction(
  config: ServerConfig,
  store: Store,
  transaction: NonNullable<Store["transaction"]>,
  id: string,
  deletion: Deletion,
): Promise<DeleteOutcome> {
  let answer: DeleteOutcome = fail(storeUnavailable());
  let threw: string | undefined;
  // Set before a deliberate rollback, so an adapter that wraps the thrown error cannot hide which throw it was.
  let rolledBack = false;
  const rollBack = (result: DeleteOutcome) => {
    answer = result;
    rolledBack = true;
    throw new Error("cloudrop: rolled back the deletion.");
  };
  try {
    await transaction(async (tx, scoped) => {
      const row = await scoped.get(id);
      if (row?.status !== "completed") {
        answer = asRead(row);
        return;
      }
      const route = hookedRoute(config, row);
      if (route) {
        const kept = await runOnDelete(config, route, row, deletion, { tx });
        if (kept) return rollBack({ ...fail(kept), refused: true });
        if (kept === false) {
          threw = route.name;
          return rollBack(answer);
        }
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
 * Ends a completed file as deleted, after its route's onDelete; answers as `end` does, and for a file that was not
 * completed when read, from that read. A throw in onDelete keeps the file and answers SERVER_ERROR; a CloudropError it
 * returns keeps the file and is the answer, marked `refused`. Without any onDelete on the server, this is `end` alone,
 * as before onDelete existed.
 */
export async function deleteCompleted(
  config: ServerConfig,
  store: Store,
  id: string,
  deletion: Deletion,
): Promise<DeleteOutcome> {
  const end = () =>
    storeCall(config.logger, `delete file ${id}`, () => store.end(id, "completed", "deleted", new Date()));
  if (![...config.routes.values()].some((route) => route.definition.onDelete)) return end();
  // Bound, as a store written as a class reads its own fields in transaction.
  if (store.transaction) return deleteInTransaction(config, store, store.transaction.bind(store), id, deletion);
  const row = await storeCall(config.logger, `get file ${id}`, () => store.get(id));
  if (row.error) return row;
  if (row.data?.status !== "completed") return asRead(row.data);
  const route = hookedRoute(config, row.data);
  if (route) {
    const kept = await runOnDelete(config, route, row.data, deletion, undefined);
    if (kept) return { ...fail(kept), refused: true };
    if (kept === false) return afterThrow(config, store, id, route.name);
  }
  return end();
}

/**
 * Before a replacing completion is recorded: onDelete for each file of the owner it is about to replace, with `tx` in a
 * transaction. Answers their ids, or null when the route has no onDelete. A throw answers as one in onComplete does,
 * a refusal with the error the hook returned, and either way the completion is not recorded.
 */
export async function beforeReplacing(
  config: ServerConfig,
  store: Store | Omit<Store, "transaction">,
  { route, owner, request }: { route: RouteConfig; owner: string | null; request: Request },
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
      const kept = await runOnDelete(config, route, file, { reason: "replaced", request }, transaction);
      if (kept !== undefined) return fail(kept || unfinished());
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
 * listed the owner's files. The deletion is recorded, so a throw is only logged, and so is a refusal (M11-D8).
 */
export async function afterReplacing(
  config: ServerConfig,
  route: RouteConfig,
  listed: ReadonlySet<string> | null,
  replaced: readonly FileRecord[],
  request: Request,
): Promise<void> {
  if (listed === null) return;
  for (const file of replaced) {
    if (listed.has(file.id)) continue;
    // The row as it was while completed: a deletion changes only its status and `endedAt`.
    const before: FileRecord = { ...file, status: "completed", endedAt: null };
    const refused = await runOnDelete(config, route, before, { reason: "replaced", request }, undefined);
    if (refused) {
      config.logger.error(
        `cloudrop: onDelete for route "${route.name}" refused file ${file.id} after it was replaced, so the file is deleted all the same.`,
        refused,
      );
    }
  }
}
