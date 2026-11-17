// cloudrop/adapters/sql: the database store over plain SQL drivers. `sqlStore(executor)` takes an executor for
// Postgres or SQLite; the four shipped here cover node-postgres, postgres.js, node:sqlite and Cloudflare D1, and any
// other driver needs only `query` and an atomic `batch` (spec M5 §7).

export type { SqlDialect, SqlExecutor, SqlRow, SqlStatement } from "../store/sql/executor.ts";
export type { SqlStoreOptions } from "../store/sql/store.ts";
export { sqlStore } from "../store/sql/store.ts";
export type { StoreTables } from "../store/sql/tables.ts";
export type { D1Database, D1Statement } from "./sql/d1.ts";
export { d1Executor } from "./sql/d1.ts";
export type { PgPool, PgPoolClient, PgQueryable } from "./sql/pg.ts";
export { pgExecutor } from "./sql/pg.ts";
export type { PostgresJsQueryable, PostgresJsSql } from "./sql/postgres-js.ts";
export { postgresJsExecutor } from "./sql/postgres-js.ts";
export type { SqliteDatabase } from "./sql/sqlite.ts";
export { sqliteExecutor } from "./sql/sqlite.ts";
