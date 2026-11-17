// The SQL core's entry: a CloudropStore over any SqlExecutor, for Postgres or SQLite. Every adapter
// (`cloudrop/adapters/sql`, Drizzle, Prisma) builds an executor and calls this; none writes SQL of its own.

import { configError } from "../../errors.ts";
import type { CloudropStore } from "../../server/store.ts";
import { isLockTimeout, type SqlExecutor } from "./executor.ts";
import { postgresWrites } from "./postgres.ts";
import { type SqlContext, type StoreMethods, singleStatementMethods } from "./reads.ts";
import { sqliteWrites } from "./sqlite.ts";
import { checkSchema, quoteTables, type StoreTables } from "./tables.ts";

export interface SqlStoreOptions {
  /** The two tables' names, defaults `cloudrop_files` and `cloudrop_usage`; letters, digits and `_`. */
  tables?: StoreTables;
}

/** Postgres waits at most this long for a row lock inside a transaction; a claim that waits longer is `busy`. */
const LOCK_TIMEOUT = "2s";

function methodsOver(context: SqlContext): StoreMethods {
  const writes = context.dialect === "postgres" ? postgresWrites(context) : sqliteWrites(context);
  return { ...singleStatementMethods(context), ...writes };
}

/** The same methods, each waiting for `ready` first. */
function afterCheck(methods: StoreMethods, ready: () => Promise<void>): StoreMethods {
  const checked: Record<string, (...args: never[]) => Promise<unknown>> = {};
  for (const [name, method] of Object.entries(methods) as [string, (...args: never[]) => Promise<unknown>][]) {
    checked[name] = async (...args) => {
      await ready();
      return method(...args);
    };
  }
  // Every key of `methods` was copied with its own signature, only deferred.
  return checked as unknown as StoreMethods;
}

/**
 * A store over SQL tables. Each method is one atomic unit (one statement on Postgres, one batch on SQLite). The schema
 * is checked once, on the first call, and a missing table or column fails that call with `INVALID_CONFIG`. When the
 * executor can hold a transaction, the store has `transaction` too: inside it a claim waits at most 2 seconds for
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
  const { names, ...tables } = quoteTables(options.tables);
  let schema: Promise<void> | undefined;
  const ready = () => {
    // A failed check is not kept, so a fixed schema (or a database back up) is picked up by the next call.
    schema ??= checkSchema(executor, names).catch((error: unknown) => {
      schema = undefined;
      throw error;
    });
    return schema;
  };
  const store: CloudropStore<TTx> = afterCheck(methodsOver({ executor, dialect, tables }), ready);
  const transaction = executor.transaction?.bind(executor);
  if (!transaction) return store;
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
          // saved value is read before set_config changes it.
          const capLockWait = async (): Promise<string | undefined> => {
            if (dialect !== "postgres") return undefined;
            const [row] = await inner.query(
              `WITH before AS MATERIALIZED (SELECT current_setting('lock_timeout') AS saved)
               SELECT saved, set_config('lock_timeout', '${LOCK_TIMEOUT}', true) FROM before`,
              [],
            );
            return String(row?.saved);
          };
          const claim: StoreMethods["claim"] = async (...args) => {
            const saved = await capLockWait();
            let outcome: Awaited<ReturnType<StoreMethods["claim"]>>;
            try {
              outcome = await methods.claim(...args);
            } catch (error) {
              if (!isLockTimeout(error)) throw error;
              timedOut = true;
              return { kind: "busy" };
            }
            if (saved !== undefined) await inner.query("SELECT set_config('lock_timeout', $1::text, true)", [saved]);
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
