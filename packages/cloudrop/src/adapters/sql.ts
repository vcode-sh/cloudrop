// cloudrop/adapters/sql: the database store over plain SQL drivers. `sqlStore(executor)` takes an executor for
// Postgres or SQLite; the four shipped here cover node-postgres, postgres.js, node:sqlite and Cloudflare D1, and any
// other driver needs only `query` and an atomic `batch` (spec M5 §7).

import type { CloudropStore, TransactionalStore } from "../server/store.ts";
import type { SqlExecutor, TransactionalSqlExecutor } from "../store/sql/executor.ts";
import { type SqlStoreOptions, sqlStore as storeOverSql } from "../store/sql/store.ts";
import { withRoute } from "./transactional.ts";

export type {
  SqlDialect,
  SqlExecutor,
  SqlRow,
  SqlStatement,
  TransactionalSqlExecutor,
} from "../store/sql/executor.ts";
export type { SqlStoreOptions } from "../store/sql/store.ts";
export type { StoreTables } from "../store/sql/tables.ts";
export type { D1Database, D1Statement } from "./sql/d1.ts";
export { d1Executor } from "./sql/d1.ts";
export type { PgPool, PgPoolClient, PgQueryable } from "./sql/pg.ts";
export { pgExecutor } from "./sql/pg.ts";
export type { PostgresJsQueryable, PostgresJsSql } from "./sql/postgres-js.ts";
export { postgresJsExecutor } from "./sql/postgres-js.ts";
export type { SqliteDatabase } from "./sql/sqlite.ts";
export { sqliteExecutor } from "./sql/sqlite.ts";

/**
 * The database store over SQL tables, for Postgres or SQLite. Each method is one atomic unit (one statement on
 * Postgres, one batch on SQLite); the tables are checked on the first call. Postgres must run at its default isolation,
 * READ COMMITTED: the claim, quota and reconcile guarantees rely on its re-reading of a row it waited for. With
 * `transaction: true` and an executor that can hold a transaction (`pgExecutor`, `postgresJsExecutor`), completions
 * run in a transaction and the store gets `route`; without it, completions use a lease.
 */
export function sqlStore<TTx>(
  executor: TransactionalSqlExecutor<TTx>,
  options: SqlStoreOptions & { transaction: true },
): TransactionalStore<TTx>;
export function sqlStore(
  executor: SqlExecutor<unknown>,
  options?: SqlStoreOptions & { transaction?: false },
): CloudropStore;
export function sqlStore<TTx>(executor: SqlExecutor<TTx>, options: SqlStoreOptions = {}): CloudropStore<TTx> {
  const store = storeOverSql(executor, options);
  return options.transaction ? withRoute(store) : store;
}
