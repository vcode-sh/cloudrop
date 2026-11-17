// cloudrop/adapters/drizzle: the database store over an app's Drizzle database (spec M5 §7). The SQL core writes every
// statement; this entry runs them through Drizzle and exports the tables for the app's own schema. `drizzle-orm` is an
// optional peer: only this entry imports it.

import { configError } from "../errors.ts";
import { type RouteFunction, routeFor } from "../server/route.ts";
import type { CloudropStore } from "../server/store.ts";
import { sqlStore } from "../store/sql/store.ts";
import type { StoreTables } from "../store/sql/tables.ts";
import { type DrizzlePostgres, type DrizzleTransaction, postgresExecutor } from "./drizzle/postgres.ts";
import { type DrizzleSqlite, sqliteExecutor } from "./drizzle/sqlite.ts";

export type { StoreTables } from "../store/sql/tables.ts";
export type { DrizzlePostgres, DrizzlePostgresQueryable, DrizzleTransaction } from "./drizzle/postgres.ts";
export type { DrizzleSqlite, DrizzleSqliteQueryable } from "./drizzle/sqlite.ts";
export type { CloudropPostgresTables, CloudropSqliteTables, CloudropTablesOptions } from "./drizzle/tables.ts";
export { cloudropTables } from "./drizzle/tables.ts";

export interface DrizzleStoreOptions {
  dialect: "postgres" | "sqlite";
  /** The tables' names, defaults `cloudrop_files` and `cloudrop_usage`; the same as `cloudropTables`'. */
  tables?: StoreTables;
  /**
   * Postgres only. Runs `onComplete` in the same Drizzle transaction as the completion and gives it that `tx`: an app
   * row written through `tx` commits with the upload or not at all. Routes must then come from `store.route`.
   */
  transaction?: boolean;
}

/** A store built with `transaction: true`: its `route` makes routes whose `onComplete` receives Drizzle's `tx`. */
export type DrizzleTransactionalStore<TTx> = CloudropStore<TTx> &
  Required<Pick<CloudropStore<TTx>, "transaction">> & { route: RouteFunction<{ tx: TTx }> };

/**
 * A cloudrop store over a Drizzle database, Postgres (node-postgres, postgres.js) or synchronous SQLite
 * (better-sqlite3). Create the tables first, from `cloudropTables` in your Drizzle schema or the documented DDL; the
 * store checks them on its first call. With `transaction: true` (Postgres), `onComplete` runs inside the completion's
 * transaction, Postgres waits at most 2 s for the row lock, and a second `/complete` of the same file answers busy.
 * Keep storage and other network calls out of that `onComplete`; they belong in `afterComplete`.
 *
 * Usage:
 * ```ts
 * const db = drizzle(new Pool({ connectionString }));
 * const store = drizzleStore(db, { dialect: "postgres", transaction: true });
 * const avatars = store.route({ accept: "image/*", maxSize: "5MB", authorize }, {
 *   owner: ({ userId }) => userId,
 *   onComplete: async ({ tx, userId, file }) => {
 *     await tx.update(users).set({ avatar: file.key }).where(eq(users.id, userId));
 *   },
 * });
 * export const cloudrop = createCloudrop({ storage, secret, store, routes: { avatars } });
 * ```
 */
export function drizzleStore<TDb extends DrizzlePostgres>(
  db: TDb,
  options: { dialect: "postgres"; tables?: StoreTables; transaction: true },
): DrizzleTransactionalStore<DrizzleTransaction<TDb>>;
export function drizzleStore(
  db: DrizzlePostgres,
  options: { dialect: "postgres"; tables?: StoreTables; transaction?: false },
): CloudropStore;
export function drizzleStore(db: DrizzleSqlite, options: { dialect: "sqlite"; tables?: StoreTables }): CloudropStore;
export function drizzleStore(
  db: DrizzlePostgres | DrizzleSqlite,
  options: DrizzleStoreOptions,
): CloudropStore<unknown> {
  const { dialect, tables, transaction = false } = options;
  if (dialect === "sqlite") {
    if (transaction) {
      throw configError(
        "transaction: true needs Postgres. SQLite has a single writer, so a transaction held open while onComplete runs would block every other upload; leave the option out and completions use a lease.",
      );
    }
    return sqlStore(sqliteExecutor(db as DrizzleSqlite), { tables });
  }
  if (dialect !== "postgres") {
    throw configError(
      `drizzleStore's dialect ${JSON.stringify(dialect)} is not supported. Use "postgres" or "sqlite".`,
    );
  }
  const store = sqlStore(postgresExecutor(db as DrizzlePostgres, transaction), { tables });
  // routeFor brands routes with this very object, the one the app passes to createCloudrop.
  return transaction ? Object.assign(store, { route: routeFor(store) }) : store;
}
