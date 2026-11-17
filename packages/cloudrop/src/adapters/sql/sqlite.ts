// node:sqlite (`DatabaseSync`): synchronous, so a batch between BEGIN IMMEDIATE and COMMIT runs to its end before any
// other call can start, and no transaction mode is offered (an interactive one would hold the only connection across
// `onComplete`'s awaits). The database is described by the members used here; sql.db.integration.test.ts passes a real
// DatabaseSync.

import type { SqlExecutor, SqlRow, SqlStatement } from "../../store/sql/executor.ts";

/** What the executor calls on a node:sqlite `DatabaseSync`. */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...params: unknown[]): SqlRow[] };
}

/**
 * An executor over node:sqlite: `sqlStore(sqliteExecutor(new DatabaseSync(path)))`. Do not share the connection with
 * code that holds its own transaction open across awaits: a batch's BEGIN would then fail. When another connection or
 * process writes the same file, open it with a busy timeout, `new DatabaseSync(path, { timeout: 5000 })`: the default
 * of 0 fails a batch at once with "database is locked" while the other writer holds the file.
 */
export function sqliteExecutor(db: SqliteDatabase): SqlExecutor {
  const rowsOf = ({ sql, params }: SqlStatement) => db.prepare(sql).all(...params);
  return {
    dialect: "sqlite",
    query: async (sql, params) => rowsOf({ sql, params }),
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(rowsOf);
        db.exec("COMMIT");
        return results;
      } catch (error) {
        // Some errors (a full disk) end the transaction themselves, and ROLLBACK then fails; the statement's error is
        // the one worth reporting.
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
  };
}
