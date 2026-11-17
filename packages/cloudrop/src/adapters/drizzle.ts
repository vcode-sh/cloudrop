// cloudrop/adapters/drizzle: the database store over an app's Drizzle database (spec M5 §7). The SQL core writes every
// statement; this entry runs them through Drizzle and exports the tables for the app's own schema. `drizzle-orm` is an
// optional peer: only this entry imports it.

import { configError } from "../errors.ts";
import type { CloudropStore, TransactionalStore } from "../server/store.ts";
import { sqlStore } from "../store/sql/store.ts";
import type { StoreTables } from "../store/sql/tables.ts";
import { type DrizzlePostgres, type DrizzleTransaction, postgresExecutor } from "./drizzle/postgres.ts";
import { type DrizzleAsyncSqlite, type DrizzleSqlite, sqliteExecutor } from "./drizzle/sqlite.ts";
import { withRoute } from "./transactional.ts";

export type { StoreTables } from "../store/sql/tables.ts";
export type { DrizzlePostgres, DrizzlePostgresQueryable, DrizzleTransaction } from "./drizzle/postgres.ts";
export type { CloudropPgTables } from "./drizzle/postgres-tables.ts";
export { cloudropPgTables } from "./drizzle/postgres-tables.ts";
export type { DrizzleAsyncSqlite, DrizzleSqlite, DrizzleSqliteQueryable } from "./drizzle/sqlite.ts";
export type { CloudropSqliteTables } from "./drizzle/sqlite-tables.ts";
export { cloudropSqliteTables } from "./drizzle/sqlite-tables.ts";
export type { CloudropTablesOptions } from "./drizzle/tables.ts";

/** What the overloads below take; each one names its dialect as a literal. */
interface DrizzleStoreOptions {
  dialect: "postgres" | "sqlite";
  tables?: StoreTables;
  transaction?: boolean;
}

/**
 * A cloudrop store over a Drizzle database: Postgres (node-postgres over a `Pool`, postgres.js) or SQLite
 * (better-sqlite3, libsql/Turso, D1). Create the tables first, from `cloudropPgTables` or `cloudropSqliteTables` in
 * your Drizzle schema or from the documented DDL; the store checks them on its first call. `tables` names them,
 * defaults `cloudrop_files` and `cloudrop_usage`, and on Postgres `tables.schema` names their schema (pass the same
 * `tables` to `cloudropPgTables`). A single node-postgres `Client` is refused: every request would share its one
 * connection, and a transaction on it would take the others' statements with it.
 *
 * With `transaction: true` (Postgres only), `onComplete` runs inside the completion's transaction with Drizzle's `tx`:
 * an app row written through `tx` commits with the upload or not at all, and routes must come from `store.route`.
 * Postgres waits at most 2 s for the row lock, so a second `/complete` of the same file answers busy. Keep storage and
 * other network calls out of that `onComplete`; they belong in `afterComplete`.
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
): TransactionalStore<DrizzleTransaction<TDb>>;
export function drizzleStore(
  db: DrizzlePostgres,
  options: { dialect: "postgres"; tables?: StoreTables; transaction?: false },
): CloudropStore;
export function drizzleStore(
  db: DrizzleSqlite | DrizzleAsyncSqlite,
  options: { dialect: "sqlite"; tables?: Omit<StoreTables, "schema"> },
): CloudropStore;
export function drizzleStore(
  db: DrizzlePostgres | DrizzleSqlite | DrizzleAsyncSqlite,
  options: DrizzleStoreOptions,
): CloudropStore<unknown> {
  const { dialect, tables, transaction = false } = options;
  if (dialect === "sqlite") {
    // The core refuses transaction: true on SQLite, with the same message for every adapter.
    return sqlStore(sqliteExecutor(db as DrizzleSqlite | DrizzleAsyncSqlite), { tables, transaction });
  }
  if (dialect !== "postgres") {
    throw configError(
      `drizzleStore's dialect ${JSON.stringify(dialect)} is not supported. Use "postgres" or "sqlite".`,
    );
  }
  const store = sqlStore(postgresExecutor(db as DrizzlePostgres), { tables, transaction });
  return transaction ? withRoute(store) : store;
}
