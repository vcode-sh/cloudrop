// The seam between the SQL core and a database driver (spec M5 §7, M5-T11). An executor runs SQL text with positional
// parameters and hands rows back as plain objects; the core builds every statement and decodes every value, so an
// executor is a few lines over its driver (`cloudrop/adapters/sql` ships four).

/** One row as the driver returns it, keyed by column name. */
export type SqlRow = Record<string, unknown>;

/** One statement with its parameters: `$1::type` placeholders on Postgres, `?` on SQLite. */
export interface SqlStatement {
  sql: string;
  params: readonly unknown[];
}

export type SqlDialect = "postgres" | "sqlite";

/** What the store needs from a database. `TTx` is the handle `onComplete` receives as `tx` in transaction mode. */
export interface SqlExecutor<TTx = never> {
  dialect: SqlDialect;
  /** Runs one statement and answers its rows (none for a write without `RETURNING`). */
  query(sql: string, params: readonly unknown[]): Promise<SqlRow[]>;
  /**
   * Runs the statements in order and atomically: every one commits, or the batch throws and none does. It need not be
   * interactive (D1's `batch()` is enough). Answers each statement's rows, in order.
   */
  batch(statements: readonly SqlStatement[]): Promise<SqlRow[][]>;
  /**
   * Runs `run` in one interactive transaction, committing when it resolves and rolling back when it throws. Only
   * executors whose database can hold one (Postgres) have it; the store then offers `transaction` too.
   */
  transaction?<T>(run: (executor: Omit<SqlExecutor<TTx>, "transaction">, tx: TTx) => Promise<T>): Promise<T>;
}

/** An executor that can hold a transaction (node-postgres, postgres.js): its store gets `transaction` and `route`. */
export type TransactionalSqlExecutor<TTx> = SqlExecutor<TTx> & Required<Pick<SqlExecutor<TTx>, "transaction">>;

/**
 * An executor whose `batch` runs its statements one after another through `query`: for a connection already inside
 * a transaction, where a failed statement aborts the transaction, so nothing of the batch can commit alone.
 */
export function sequential(dialect: SqlDialect, query: SqlExecutor["query"]): Omit<SqlExecutor<never>, "transaction"> {
  return {
    dialect,
    query,
    async batch(statements) {
      const results: SqlRow[][] = [];
      for (const { sql, params } of statements) results.push(await query(sql, params));
      return results;
    },
  };
}

/** Runs one built statement. */
export function runStatement(
  executor: Pick<SqlExecutor<unknown>, "query">,
  statement: SqlStatement,
): Promise<SqlRow[]> {
  return executor.query(statement.sql, statement.params);
}

/**
 * True when the error carries this Postgres SQLSTATE: node-postgres and postgres.js set it as `code`, and a wrapper
 * (Drizzle's query error) keeps the driver's error as `cause`, so the chain is followed a few levels.
 * Prisma 7 answers `P2010` and keeps its driver adapter's error under `meta.driverAdapterError`; that error's `cause`
 * holds the SQLSTATE as `originalCode`, and as `code` only for the errors the adapter does not name (measured, 7.10.1:
 * 55P03 has both, 23505 becomes kind "UniqueConstraintViolation" with `originalCode` alone).
 */
function hasCode(error: unknown, sqlState: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const { code, originalCode, cause, meta } = current as {
      code?: unknown;
      originalCode?: unknown;
      cause?: unknown;
      meta?: { driverAdapterError?: unknown };
    };
    if (code === sqlState || originalCode === sqlState) return true;
    current = cause ?? meta?.driverAdapterError;
  }
  return false;
}

/** Postgres's `lock_not_available`, raised when `lock_timeout` runs out. */
export const isLockTimeout = (error: unknown): boolean => hasCode(error, "55P03");

/** Postgres's `unique_violation`. */
export const isUniqueViolation = (error: unknown): boolean => hasCode(error, "23505");
