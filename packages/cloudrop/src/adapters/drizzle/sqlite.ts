// Drizzle on a synchronous SQLite driver (better-sqlite3, bun:sqlite): statements through `all` and `run`, a batch in
// `db.transaction(…, { behavior: "immediate" })`, which the driver runs to its end before any other call can start.
// No transaction mode: an interactive one would hold the only writer across `onComplete`'s awaits. Asynchronous SQLite
// drivers (libsql, D1, the proxy) are refused at construction: a synchronous transaction cannot wait for them.

import type { SQL } from "drizzle-orm";
import { configError } from "../../errors.ts";
import type { SqlExecutor, SqlRow, SqlStatement } from "../../store/sql/executor.ts";
import { drizzleSql } from "./statement.ts";

/** What the store calls on a synchronous Drizzle SQLite database or transaction. */
export interface DrizzleSqliteQueryable {
  all<T = unknown>(query: SQL): T[];
  run(query: SQL): unknown;
}

/** A Drizzle SQLite database over a synchronous driver: `drizzle(new Database(path))` from `drizzle-orm/better-sqlite3`. */
export interface DrizzleSqlite extends DrizzleSqliteQueryable {
  transaction<T>(run: (tx: DrizzleSqliteQueryable) => T, config?: { behavior?: "immediate" }): T;
}

/**
 * Whether the statement answers rows: better-sqlite3 refuses `all` for one that does not. Every statement the core
 * writes either starts with SELECT or ends its write with RETURNING when it needs rows back.
 */
const ANSWERS_ROWS = /^\s*SELECT\b|\bRETURNING\b/i;

function rowsOf(target: DrizzleSqliteQueryable, statement: SqlStatement): SqlRow[] {
  const query = drizzleSql("sqlite", statement);
  if (ANSWERS_ROWS.test(statement.sql)) return target.all<SqlRow>(query);
  target.run(query);
  return [];
}

export function sqliteExecutor(db: DrizzleSqlite): SqlExecutor {
  // Drizzle's own marker for its asynchronous SQLite databases; the types above already reject them.
  if ((db as { resultKind?: unknown }).resultKind === "async") {
    throw configError(
      "drizzleStore needs a synchronous SQLite driver such as better-sqlite3, and this Drizzle database is asynchronous (libsql, D1 or a proxy). For D1, use d1Executor from cloudrop/adapters/sql.",
    );
  }
  return {
    dialect: "sqlite",
    query: async (sql, params) => rowsOf(db, { sql, params }),
    batch: async (statements) =>
      db.transaction((tx) => statements.map((statement) => rowsOf(tx, statement)), { behavior: "immediate" }),
  };
}
