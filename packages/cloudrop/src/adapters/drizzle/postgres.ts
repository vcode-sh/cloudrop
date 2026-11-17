// Drizzle on Postgres: statements through `execute`, batches and transactions through `db.transaction`. The database is
// described by the two members used here, so any Drizzle Postgres driver fits and the library needs no Drizzle types
// beyond `SQL`; drizzle.db.integration.test.ts runs it on node-postgres and postgres.js.

import type { SQL } from "drizzle-orm";
import type { SqlExecutor, SqlRow, SqlStatement } from "../../store/sql/executor.ts";
import { drizzleSql } from "./statement.ts";

/** What the store calls on a Drizzle Postgres database or transaction. */
export interface DrizzlePostgresQueryable {
  execute(query: SQL): PromiseLike<unknown>;
}

/** A Drizzle Postgres database: `drizzle(pool)` from `drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`, … */
export interface DrizzlePostgres extends DrizzlePostgresQueryable {
  transaction<T>(run: (tx: DrizzlePostgresQueryable) => Promise<T>): Promise<T>;
}

/** The `tx` Drizzle hands to `db.transaction`'s callback, for this database's driver and schema. */
export type DrizzleTransaction<TDb extends DrizzlePostgres> = Parameters<Parameters<TDb["transaction"]>[0]>[0];

/** node-postgres answers `{ rows }`, postgres.js the rows themselves. */
async function rowsOf(target: DrizzlePostgresQueryable, statement: SqlStatement): Promise<SqlRow[]> {
  const result = await target.execute(drizzleSql("postgres", statement));
  if (Array.isArray(result)) return result;
  const { rows } = (result ?? {}) as { rows?: unknown };
  if (Array.isArray(rows)) return rows;
  throw new Error(
    "This Drizzle driver's execute() answered neither rows nor { rows }. Use drizzleStore with node-postgres or postgres.js, or build an executor for cloudrop/adapters/sql.",
  );
}

async function inOrder(target: DrizzlePostgresQueryable, statements: readonly SqlStatement[]): Promise<SqlRow[][]> {
  const results: SqlRow[][] = [];
  for (const statement of statements) results.push(await rowsOf(target, statement));
  return results;
}

/** Inside a transaction: a failed statement aborts it, so nothing of a batch can commit alone. */
const within = (tx: DrizzlePostgresQueryable): Omit<SqlExecutor, "transaction"> => ({
  dialect: "postgres",
  query: (sql, params) => rowsOf(tx, { sql, params }),
  batch: (statements) => inOrder(tx, statements),
});

/** The executor; with `transactions`, it also runs `onComplete` in a Drizzle transaction whose `tx` the route gets. */
export function postgresExecutor(db: DrizzlePostgres, transactions: boolean): SqlExecutor<DrizzlePostgresQueryable> {
  const executor: SqlExecutor<DrizzlePostgresQueryable> = {
    ...within(db),
    batch: (statements) => db.transaction((tx) => inOrder(tx, statements)),
  };
  if (transactions) executor.transaction = (run) => db.transaction((tx) => run(within(tx), tx));
  return executor;
}
