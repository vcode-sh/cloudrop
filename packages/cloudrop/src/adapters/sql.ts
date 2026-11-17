// cloudrop/adapters/sql: the database store over plain SQL drivers. `sqlStore(executor)` takes an executor for
// Postgres or SQLite; the four shipped here cover node-postgres, postgres.js, node:sqlite and Cloudflare D1, and any
// other driver needs only `query` and an atomic `batch` (spec M5 §7).

import type { RouteFunction } from "../server/route.ts";
import { routeFor } from "../server/route.ts";
import type { CloudropStore } from "../server/store.ts";
import type { SqlExecutor, TransactionalSqlExecutor } from "../store/sql/executor.ts";
import { type SqlStoreOptions, sqlStore as storeOverSql } from "../store/sql/store.ts";

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

/** A store over an executor that can hold a transaction; its `route()` types `onComplete`'s `tx`. */
export interface TransactionalSqlStore<TTx> extends CloudropStore<TTx> {
  transaction: NonNullable<CloudropStore<TTx>["transaction"]>;
  /**
   * `route()` for this store: the routes it makes run `onComplete` inside the store's transaction, with `tx` (the
   * executor's transaction handle) in its context, and only with this store passed to `createCloudrop`.
   */
  route: RouteFunction<{ tx: TTx }>;
}

/**
 * The database store over SQL tables, for Postgres or SQLite. Each method is one atomic unit (one statement on
 * Postgres, one batch on SQLite); the tables are checked on the first call. Postgres must run at its default isolation,
 * READ COMMITTED: the claim, quota and reconcile guarantees rely on its re-reading of a row it waited for. An executor
 * that can hold a transaction (`pgExecutor`, `postgresJsExecutor`) gives the store `transaction` and `route`.
 */
export function sqlStore<TTx>(
  executor: TransactionalSqlExecutor<TTx>,
  options?: SqlStoreOptions,
): TransactionalSqlStore<TTx>;
export function sqlStore<TTx = never>(executor: SqlExecutor<TTx>, options?: SqlStoreOptions): CloudropStore<TTx>;
export function sqlStore<TTx>(executor: SqlExecutor<TTx>, options?: SqlStoreOptions): CloudropStore<TTx> {
  const store: CloudropStore<TTx> & { route?: RouteFunction<{ tx: TTx }> } = storeOverSql(executor, options);
  // routeFor brands each route with this very object, the one the app passes to createCloudrop.
  if (store.transaction) store.route = routeFor<{ tx: TTx }>(store);
  return store;
}
