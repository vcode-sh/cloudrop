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

/** Postgres's `lock_not_available`, raised when `lock_timeout` runs out. */
const LOCK_TIMEOUT = "55P03";

/**
 * True for Postgres's lock timeout: node-postgres and postgres.js set it as `code`, and a wrapper (Drizzle's query
 * error) keeps the driver's error as `cause`, so the chain is followed a few levels.
 */
export function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (code === LOCK_TIMEOUT) return true;
    current = cause;
  }
  return false;
}
