// Drizzle on SQLite, through `all` and `run`. A synchronous driver (better-sqlite3) runs a batch in
// `db.transaction(…, { behavior: "immediate" })`, which ends before any other call can start. An asynchronous one with
// an atomic batch (libsql/Turso) runs it through `db.batch`, ordered and all-or-nothing. D1 runs through the binding
// Drizzle keeps as `db.$client`, as `d1Executor` does: drizzle-orm 0.45's D1 `batch` cannot take a raw statement with
// parameters (it reads a `stmt` that `db.run(sql)` never prepares; measured in the Wrangler lane). None has transaction
// mode: an interactive transaction would hold the only writer across `onComplete`'s awaits.

import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SqlExecutor, SqlRow, SqlStatement } from "../../store/sql/executor.ts";
import { type D1Database, d1Executor } from "../sql/d1.ts";
import { drizzleSql } from "./statement.ts";

/** What the store calls on a synchronous Drizzle SQLite database or transaction. */
export interface DrizzleSqliteQueryable {
  all<T = unknown>(query: SQL): T[];
  run(query: SQL): unknown;
}

/**
 * A Drizzle SQLite database over a synchronous driver: `drizzle({ client: new Database(path) })` from
 * `drizzle-orm/better-sqlite3`.
 * `transaction` is not generic here: drizzle-orm 0.45 types its answer as the callback's, 1.0 through a conditional type
 * that refuses async callbacks, and both fit this shape.
 */
export interface DrizzleSqlite extends DrizzleSqliteQueryable {
  transaction(run: (tx: DrizzleSqliteQueryable) => SqlRow[][], config?: { behavior?: "immediate" }): unknown;
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
    // The transaction answers what its callback returned.
    batch: async (statements) =>
      db.transaction((tx) => statements.map((statement) => rowsOf(tx, statement)), {
        behavior: "immediate",
      }) as SqlRow[][],
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

/** The D1 binding of a `drizzle-orm/d1` database, which Drizzle keeps as `$client`; null for any other driver. */
function d1Binding(db: object): D1Database | null {
  const client: unknown = "$client" in db ? db.$client : null;
  const isD1 =
    typeof client === "object" &&
    client !== null &&
    "prepare" in client &&
    typeof client.prepare === "function" &&
    "batch" in client &&
    typeof client.batch === "function";
  return isD1 ? (client as D1Database) : null;
}

export function sqliteExecutor(db: DrizzleSqlite | DrizzleAsyncSqlite): SqlExecutor {
  const d1 = d1Binding(db);
  if (d1) return d1Executor(d1);
  return "batch" in db && typeof db.batch === "function"
    ? batchingExecutor(db as DrizzleAsyncSqlite)
    : synchronousExecutor(db as DrizzleSqlite);
}
