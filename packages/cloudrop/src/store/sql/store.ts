// The SQL core's entry: a CloudropStore over any SqlExecutor, for Postgres or SQLite. Every adapter
// (`cloudrop/adapters/sql`, Drizzle, Prisma) builds an executor and calls this; none writes SQL of its own.

import { configError } from "../../errors.ts";
import type { CloudropStore } from "../../server/store.ts";
import { isConflict, isLockTimeout, type SqlExecutor } from "./executor.ts";
import { postgresWrites } from "./postgres.ts";
import { type SqlContext, type StoreMethods, singleStatementMethods } from "./reads.ts";
import { sqliteWrites } from "./sqlite.ts";
import { checkSchema, quoteTables, type StoreTables, tableNames } from "./tables.ts";

export interface SqlStoreOptions {
  /**
   * The two tables' names, defaults `cloudrop_files` and `cloudrop_usage`, and on Postgres their schema; letters,
   * digits and `_`.
   */
  tables?: StoreTables;
  /**
   * Postgres only, with an executor that has `transaction()`. On: each completion's claim, `onComplete` and record
   * share one transaction, and the store gets `route` for routes whose `onComplete` receives it as `tx`; a completion
   * holds a connection and the row lock while `onComplete` runs. Off (the default): a completion holds its file with
   * a lease and no connection.
   */
  transaction?: boolean;
}

const NEEDS_POSTGRES =
  "transaction: true needs Postgres. SQLite has one writer at a time, so a transaction held open while onComplete runs would stall every other upload; leave the option out and completions use a lease.";
const NEEDS_TRANSACTION =
  "transaction: true needs an executor with transaction(), such as pgExecutor or postgresJsExecutor. Add one to your executor, or leave the option out and completions use a lease.";

/** Postgres waits at most this long for a row lock inside a transaction; a claim that waits longer is `busy`. */
const LOCK_TIMEOUT = "2s";

function methodsOver(context: SqlContext): StoreMethods {
  const writes = context.dialect === "postgres" ? postgresWrites(context) : sqliteWrites(context);
  return { ...singleStatementMethods(context), ...writes };
}

/**
 * The same methods, each waiting for `ready` first. A call that Postgres ended to break a deadlock or a serialization
 * conflict (40P01, 40001) runs once more: it is one atomic unit and rolled back whole. The store's own statements lock
 * rows in one order and cannot deadlock each other; an app's own transaction over these tables can (M11-R61).
 */
function afterCheck(methods: StoreMethods, ready: () => Promise<void>): StoreMethods {
  const checked: Record<string, (...args: never[]) => Promise<unknown>> = {};
  for (const [name, method] of Object.entries(methods) as [string, (...args: never[]) => Promise<unknown>][]) {
    checked[name] = async (...args) => {
      await ready();
      return method(...args).catch((error: unknown) => {
        if (!isConflict(error)) throw error;
        return method(...args);
      });
    };
  }
  // Every key of `methods` was copied with its own signature, only deferred.
  return checked as unknown as StoreMethods;
}

/**
 * A store over SQL tables. Each method is one atomic unit (one statement on Postgres, one batch on SQLite). The schema
 * is checked once, on the first call, and a missing table or column fails that call with `INVALID_CONFIG`. With
 * `transaction: true` the store has `transaction` too, from the executor's: inside it a claim waits at most 2 seconds for
 * Postgres's row lock, so an overlapping `/complete` answers `busy` instead of waiting for `onComplete` to finish; the
 * app's own statements through `tx` keep the lock timeout their session had. Postgres must run at its default
 * isolation, READ COMMITTED: claims, quota and reconcile rely on its re-reading of a row they waited for.
 */
export function sqlStore<TTx = never>(executor: SqlExecutor<TTx>, options: SqlStoreOptions = {}): CloudropStore<TTx> {
  const { dialect } = executor;
  if (dialect !== "postgres" && dialect !== "sqlite") {
    throw configError(
      `The executor's dialect ${JSON.stringify(dialect)} is not supported. Use "postgres" or "sqlite".`,
    );
  }
  const tables = quoteTables(tableNames(options.tables, dialect));
  let schema: Promise<void> | undefined;
  const ready = () => {
    // A failed check is not kept, so a fixed schema (or a database back up) is picked up by the next call.
    schema ??= checkSchema(executor, tables).catch((error: unknown) => {
      schema = undefined;
      throw error;
    });
    return schema;
  };
  const store: CloudropStore<TTx> = afterCheck(methodsOver({ executor, dialect, tables }), ready);
  if (!options.transaction) return store;
  if (dialect !== "postgres") throw configError(NEEDS_POSTGRES);
  if (!executor.transaction) throw configError(NEEDS_TRANSACTION);
  const transaction = executor.transaction.bind(executor);
  return {
    ...store,
    async transaction<T>(run: (tx: TTx, store: StoreMethods) => Promise<T>): Promise<T> {
      await ready();
      let timedOut = false;
      let answer: { value: T } | undefined;
      try {
        return await transaction<T>(async (inner, tx) => {
          const methods = methodsOver({ executor: inner, dialect, tables });
          // The cap covers the claim alone: onComplete's own statements through tx then run at whatever lock timeout
          // the session had, restored exactly (a session-level SET included, which DEFAULT would drop). Another
          // /complete holding the row lock past the cap makes the row busy, not broken. The CTE is materialized so the
          // saved value is read before set_config changes it. Transaction mode is Postgres only (checked above).
          const claim: StoreMethods["claim"] = async (...args) => {
            const [row] = await inner.query(
              `WITH before AS MATERIALIZED (SELECT current_setting('lock_timeout') AS saved)
               SELECT saved, set_config('lock_timeout', '${LOCK_TIMEOUT}', true) FROM before`,
              [],
            );
            let outcome: Awaited<ReturnType<StoreMethods["claim"]>>;
            try {
              outcome = await methods.claim(...args);
            } catch (error) {
              if (!isLockTimeout(error)) throw error;
              timedOut = true;
              return { kind: "busy" };
            }
            await inner.query("SELECT set_config('lock_timeout', $1::text, true)", [String(row?.saved)]);
            return outcome;
          };
          const value = await run(tx, { ...methods, claim });
          answer = { value };
          return value;
        });
      } catch (error) {
        // postgres.js fails a transaction in which any statement failed, even the claim answered as busy above. That
        // transaction rolled back with nothing written, which is what node-postgres does silently, so run's answer
        // stands.
        if (timedOut && answer && isLockTimeout(error)) return answer.value;
        throw error;
      }
    },
  };
}
