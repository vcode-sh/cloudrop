// postgres.js (`postgres`): statements through `sql.unsafe`, batches and transactions through `sql.begin`. Its shape is
// described by the members used here, so the library needs neither postgres.js nor its types;
// sql.db.integration.test.ts passes a real `postgres()` instance.

import type { SqlExecutor, SqlRow, SqlStatement } from "../../store/sql/executor.ts";

/** What the executor calls on postgres.js's `sql` or a transaction's `sql`. */
export interface PostgresJsQueryable {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<readonly SqlRow[]>;
}

/** A postgres.js instance, `postgres(url)`. `onComplete` receives the transaction's `sql` as `tx`. */
export interface PostgresJsSql extends PostgresJsQueryable {
  begin(run: (sql: PostgresJsQueryable) => Promise<unknown>): Promise<unknown>;
}

const rowsOf = async (sql: PostgresJsQueryable, statement: SqlStatement): Promise<SqlRow[]> => [
  ...(await sql.unsafe(statement.sql, [...statement.params])),
];

async function inOrder(sql: PostgresJsQueryable, statements: readonly SqlStatement[]): Promise<SqlRow[][]> {
  const results: SqlRow[][] = [];
  for (const statement of statements) results.push(await rowsOf(sql, statement));
  return results;
}

/** An executor over postgres.js: `sqlStore(postgresJsExecutor(postgres(url)))`. */
export function postgresJsExecutor(sql: PostgresJsSql): SqlExecutor<PostgresJsQueryable> {
  /** `sql.begin` commits when `work` resolves and rolls back when it throws; its answer is `work`'s. */
  const inTransaction = async <T>(work: (tx: PostgresJsQueryable) => Promise<T>): Promise<T> =>
    // postgres.js types its answer from the callback, which the structural shape above cannot express.
    (await sql.begin(work)) as T;
  return {
    dialect: "postgres",
    query: (query, params) => rowsOf(sql, { sql: query, params }),
    batch: (statements) => inTransaction((tx) => inOrder(tx, statements)),
    transaction: (run) =>
      inTransaction((tx) =>
        run(
          {
            dialect: "postgres",
            query: (query, params) => rowsOf(tx, { sql: query, params }),
            // Already inside the transaction: a failed statement aborts it, so nothing of the batch can commit alone.
            batch: (statements) => inOrder(tx, statements),
          },
          tx,
        ),
      ),
  };
}
