// node-postgres (`pg`): a Pool, with batches and transactions on one checked-out client. The pool's shape is described
// by the members used here, so the library needs neither pg nor its types; sql.db.integration.test.ts passes a real
// pg.Pool.

import type { SqlRow, SqlStatement, TransactionalSqlExecutor } from "../../store/sql/executor.ts";

/** What the executor calls on a node-postgres pool or client; `onComplete` receives the transaction's client as `tx`. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: SqlRow[] }>;
}

/** A client checked out of the pool. */
export interface PgPoolClient extends PgQueryable {
  release(destroy?: boolean | Error): void;
}

/** A node-postgres `Pool`. Size it for your concurrency; transaction mode holds a client while `onComplete` runs. */
export interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>;
}

const rowsOf = async (client: PgQueryable, { sql, params }: SqlStatement) =>
  (await client.query(sql, [...params])).rows;

async function inOrder(client: PgQueryable, statements: readonly SqlStatement[]): Promise<SqlRow[][]> {
  const results: SqlRow[][] = [];
  for (const statement of statements) results.push(await rowsOf(client, statement));
  return results;
}

/**
 * An executor over a node-postgres pool: `sqlStore(pgExecutor(new Pool({ connectionString })))`. Leave the connections at
 * Postgres's default isolation, READ COMMITTED: the store's guarantees rely on it (set no
 * `default_transaction_isolation`).
 */
export function pgExecutor(pool: PgPool): TransactionalSqlExecutor<PgQueryable> {
  /** Runs `work` between BEGIN and COMMIT on one client; a throw rolls back and is rethrown. */
  async function inTransaction<T>(work: (client: PgPoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // A client that cannot even roll back is in an unknown state: the pool discards it instead of reusing it.
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.release(broken);
    }
  }

  return {
    dialect: "postgres",
    query: (sql, params) => rowsOf(pool, { sql, params }),
    batch: (statements) => inTransaction((client) => inOrder(client, statements)),
    transaction: (run) =>
      inTransaction((client) =>
        run(
          {
            dialect: "postgres",
            query: (sql, params) => rowsOf(client, { sql, params }),
            // Already inside the transaction: a failed statement aborts it, so nothing of the batch can commit alone.
            batch: (statements) => inOrder(client, statements),
          },
          client,
        ),
      ),
  };
}
