// postgres.js (`postgres`): statements through `sql.unsafe`, batches and transactions through `sql.begin`. Its shape is
// described by the members used here, so the library needs neither postgres.js nor its types;
// sql.db.integration.test.ts passes a real `postgres()` instance.

import { type SqlRow, sequential, type TransactionalSqlExecutor } from "../../store/sql/executor.ts";

/** What the executor calls on postgres.js's `sql` or a transaction's `sql`. */
export interface PostgresJsQueryable {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<readonly SqlRow[]>;
}

/**
 * A postgres.js instance, `postgres(url)`. `TTx` is its transaction's `sql`, which `onComplete` receives as `tx`; it is
 * inferred from the instance, so `tx` keeps postgres.js's own type.
 */
export interface PostgresJsSql<TTx extends PostgresJsQueryable = PostgresJsQueryable> extends PostgresJsQueryable {
  begin(run: (sql: TTx) => Promise<unknown>): Promise<unknown>;
  // postgres.js declares both forms of begin; TypeScript infers TTx from the last one, so the shape mirrors both.
  begin(options: string, run: (sql: TTx) => Promise<unknown>): Promise<unknown>;
}

/** The executor's statements on `sql` or a transaction's `sql`, in order when batched. */
const on = (sql: PostgresJsQueryable) =>
  sequential("postgres", async (query, params): Promise<SqlRow[]> => [...(await sql.unsafe(query, [...params]))]);

/**
 * An executor over postgres.js: `sqlStore(postgresJsExecutor(postgres(url)))`. Leave the connections at Postgres's
 * default isolation, READ COMMITTED: the store's guarantees rely on it (set no `default_transaction_isolation`).
 */
export function postgresJsExecutor<TTx extends PostgresJsQueryable>(
  sql: PostgresJsSql<TTx>,
): TransactionalSqlExecutor<TTx> {
  /** `sql.begin` commits when `work` resolves and rolls back when it throws; its answer is `work`'s. */
  const inTransaction = async <T>(work: (tx: TTx) => Promise<T>): Promise<T> =>
    // postgres.js types its answer from the callback, which the structural shape above cannot express.
    (await sql.begin(work)) as T;
  return {
    ...on(sql),
    // Outside a transaction, a batch gets one of its own.
    batch: (statements) => inTransaction((tx) => on(tx).batch(statements)),
    transaction: (run) => inTransaction((tx) => run(on(tx), tx)),
  };
}
