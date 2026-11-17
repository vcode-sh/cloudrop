// Drizzle on Postgres: statements through `execute`, batches and transactions through `db.transaction`. The database is
// described by the two members used here, so any Drizzle Postgres driver fits and the library needs no Drizzle types
// beyond `SQL`; drizzle.db.integration.test.ts runs it on node-postgres and postgres.js.

import type { SQL } from "drizzle-orm";
import { configError } from "../../errors.ts";
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

/** How a result looked, for the message: its keys, never its values. */
const shapeOf = (result: unknown): string =>
  typeof result === "object" && result !== null ? `{ ${Object.keys(result).join(", ")} }` : typeof result;

/** node-postgres answers `{ rows }`, postgres.js the rows themselves. */
async function rowsOf(target: DrizzlePostgresQueryable, statement: SqlStatement): Promise<SqlRow[]> {
  const result = await target.execute(drizzleSql("postgres", statement));
  if (Array.isArray(result)) return result;
  const { rows } = (result ?? {}) as { rows?: unknown };
  if (Array.isArray(rows)) return rows;
  throw configError(
    `This Drizzle driver's execute() answered ${shapeOf(result)}, not rows or { rows }. Use drizzleStore with node-postgres or postgres.js, or build an executor for cloudrop/adapters/sql.`,
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

/**
 * True for a node-postgres client that is not a pool: Drizzle's node-postgres driver checks out a connection for a
 * transaction only from a pool (its own test: the constructor's name contains "Pool"), and otherwise runs BEGIN on the
 * client's one connection, which every other request is using too.
 */
function isSingleConnection(db: DrizzlePostgres): boolean {
  const client: unknown = (db as { $client?: unknown }).$client;
  if (typeof client !== "object" || client === null) return false;
  const { query, connect } = client as { query?: unknown; connect?: unknown };
  return typeof query === "function" && typeof connect === "function" && !client.constructor.name.includes("Pool");
}

/** The executor; with `transactions`, it also runs `onComplete` in a Drizzle transaction whose `tx` the route gets. */
export function postgresExecutor(db: DrizzlePostgres, transactions: boolean): SqlExecutor<DrizzlePostgresQueryable> {
  if (isSingleConnection(db)) {
    throw configError(
      "drizzleStore needs a pg Pool, not a single pg Client: a transaction on the one shared connection would take every other request's statements with it. Pass drizzle(new Pool({ connectionString })), or use postgres.js.",
    );
  }
  const executor: SqlExecutor<DrizzlePostgresQueryable> = {
    ...within(db),
    batch: (statements) => db.transaction((tx) => inOrder(tx, statements)),
  };
  if (transactions) executor.transaction = (run) => db.transaction((tx) => run(within(tx), tx));
  return executor;
}
