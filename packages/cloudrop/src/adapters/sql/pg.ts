// node-postgres (`pg`): a Pool, with batches and transactions on one checked-out client. The pool's shape is described
// by the members used here, so the library needs neither pg nor its types; sql.db.integration.test.ts passes a real
// pg.Pool.

import { type SqlRow, sequential, type TransactionalSqlExecutor } from "../../store/sql/executor.ts";

/** What the executor calls on a node-postgres pool or client; `onComplete` gets the transaction's client as `tx`. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: SqlRow[] }>;
}

/** A client checked out of the pool. */
export interface PgPoolClient extends PgQueryable {
  release(destroy?: boolean | Error): void;
  /** node-postgres reports a connection that fails between statements as an `error` event of the client. */
  on?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
}

/** A node-postgres `Pool`. Size it for your concurrency; transaction mode holds a client while `onComplete` runs. */
export interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>;
}

/** The executor's statements on one pool or client, in order when batched. */
const on = (client: PgQueryable) =>
  sequential("postgres", async (sql, params) => (await client.query(sql, [...params])).rows);

/**
 * An executor over a node-postgres pool: `sqlStore(pgExecutor(new Pool({ connectionString })))`. Leave the
 * connections at Postgres's default isolation, READ COMMITTED: the store's guarantees rely on it (set no
 * `default_transaction_isolation`).
 */
export function pgExecutor(pool: PgPool): TransactionalSqlExecutor<PgQueryable> {
  /** Runs `work` between BEGIN and COMMIT on one client; a throw rolls back and is rethrown. */
  async function inTransaction<T>(work: (client: PgPoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let broken = false;
    // A connection that fails while it is checked out but idle, such as while onComplete runs, is an 'error' event of
    // the client, which the pool listens for only while the client is idle in it: without a listener, Node throws it
    // and the process stops. The next statement fails with that error, so the listener only marks the client broken.
    const onError = () => {
      broken = true;
    };
    // Only a client that can also drop the listener gets one: otherwise each checkout would add another.
    const { on, removeListener } = client;
    const listening = on !== undefined && removeListener !== undefined;
    if (listening) on.call(client, "error", onError);
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
      if (listening) removeListener.call(client, "error", onError);
      client.release(broken);
    }
  }

  return {
    ...on(pool),
    // Outside a transaction, a batch gets one of its own on one client.
    batch: (statements) => inTransaction((client) => on(client).batch(statements)),
    transaction: (run) => inTransaction((client) => run(on(client), client)),
  };
}
