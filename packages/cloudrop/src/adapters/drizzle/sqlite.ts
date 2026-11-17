// Drizzle on SQLite, through `all` and `run`. A synchronous driver (better-sqlite3) runs a batch in
// `db.transaction(…, { behavior: "immediate" })`, which ends before any other call can start. An asynchronous one with
// an atomic batch (libsql/Turso, D1) runs it through `db.batch`, ordered and all-or-nothing. Neither has transaction
// mode: an interactive transaction would hold the only writer across `onComplete`'s awaits.

import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
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
 * A Drizzle SQLite database over an asynchronous driver with an atomic batch: `drizzle-orm/libsql` (Turso) or
 * `drizzle-orm/d1`. `all` and `run` build a statement that runs when awaited, or as part of `batch`.
 */
export interface DrizzleAsyncSqlite {
  all<T = unknown>(query: SQL): BatchItem<"sqlite"> & PromiseLike<T[]>;
  run(query: SQL): BatchItem<"sqlite"> & PromiseLike<unknown>;
  batch(statements: readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]): PromiseLike<readonly unknown[]>;
}

/**
 * Whether the statement answers rows: better-sqlite3 refuses `all` for one that does not. Every statement the core
 * writes either starts with SELECT or ends its write with a RETURNING clause when it needs rows back. A table named
 * `returning` is quoted, so the word is followed by `"`, never by whitespace.
 */
const ANSWERS_ROWS = /^\s*SELECT\b|\bRETURNING\s/i;
const answersRows = ({ sql }: SqlStatement) => ANSWERS_ROWS.test(sql);

function synchronousExecutor(db: DrizzleSqlite): SqlExecutor {
  const rowsOf = (target: DrizzleSqliteQueryable, statement: SqlStatement): SqlRow[] => {
    const query = drizzleSql("sqlite", statement);
    if (answersRows(statement)) return target.all<SqlRow>(query);
    target.run(query);
    return [];
  };
  return {
    dialect: "sqlite",
    query: async (sql, params) => rowsOf(db, { sql, params }),
    batch: async (statements) =>
      db.transaction((tx) => statements.map((statement) => rowsOf(tx, statement)), { behavior: "immediate" }),
  };
}

function batchingExecutor(db: DrizzleAsyncSqlite): SqlExecutor {
  const built = (statement: SqlStatement) => {
    const query = drizzleSql("sqlite", statement);
    return answersRows(statement) ? db.all<SqlRow>(query) : db.run(query);
  };
  // A write's answer (libsql's ResultSet, D1's meta) is not rows.
  const rowsFrom = (statement: SqlStatement, answer: unknown) => (answersRows(statement) ? (answer as SqlRow[]) : []);
  return {
    dialect: "sqlite",
    query: async (sql, params) => rowsFrom({ sql, params }, await built({ sql, params })),
    async batch(statements) {
      const [first, ...rest] = statements;
      if (!first) return [];
      const answers = await db.batch([built(first), ...rest.map(built)]);
      return statements.map((statement, index) => rowsFrom(statement, answers[index]));
    },
  };
}

export function sqliteExecutor(db: DrizzleSqlite | DrizzleAsyncSqlite): SqlExecutor {
  return "batch" in db && typeof db.batch === "function"
    ? batchingExecutor(db as DrizzleAsyncSqlite)
    : synchronousExecutor(db as DrizzleSqlite);
}
