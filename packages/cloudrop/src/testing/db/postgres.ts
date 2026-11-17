// The database lane's Postgres: one fresh schema per test file on the server scripts/test-db.sh starts, reached
// through a node-postgres pool whose every connection has that schema as its search path.

import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { schemaStatements, type TestDatabase } from "./schema.ts";

export interface PostgresTestDatabase extends TestDatabase {
  readonly dialect: "postgres";
  /** "cloudrop_test_<hex>": this file's schema, dropped with everything in it after the file's tests. */
  readonly schema: string;
  /**
   * A connection URL that lands in this file's schema, for another client (postgres.js, Drizzle, Prisma): it carries
   * `options=-c search_path=<schema>`.
   */
  readonly url: string;
  /** The fixture's own pool of up to 10 connections, enough for concurrency rows that need 8. */
  readonly pool: pg.Pool;
  /** Drops every table of this file's schema, so the next test starts empty. */
  reset(): Promise<void>;
}

function serverUrl(): string {
  const url = process.env.CLOUDROP_POSTGRES_URL;
  if (!url) {
    throw new Error(
      "CLOUDROP_POSTGRES_URL is not set. Run the database tests with `bun run test:db` (scripts/test-db.sh), which starts Postgres and sets it.",
    );
  }
  return url;
}

/**
 * Call at the top of a test file or `describe`. It creates the schema before the scope's tests and drops it after
 * them; the teardown is registered here, before anything is acquired, so a failed setup is still cleaned up.
 */
export function usePostgresDatabase(): PostgresTestDatabase {
  const schema = `cloudrop_test_${randomBytes(6).toString("hex")}`;
  let state: { pool: pg.Pool; url: string } | undefined;

  beforeAll(async () => {
    const options = `-c search_path=${schema}`;
    const url = new URL(serverUrl());
    url.searchParams.set("options", options);
    state = { pool: new pg.Pool({ connectionString: serverUrl(), options, max: 10 }), url: url.href };
    await state.pool.query(`CREATE SCHEMA ${schema}`);
  });
  afterAll(async () => {
    if (!state) return;
    try {
      await state.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await state.pool.end();
    }
  });

  const ready = () => {
    if (!state) throw new Error("usePostgresDatabase() is ready only in tests and hooks that run after its beforeAll.");
    return state;
  };
  const query = async (sql: string, params: readonly unknown[] = []) =>
    (await ready().pool.query(sql, [...params])).rows;
  return {
    dialect: "postgres",
    schema,
    get url() {
      return ready().url;
    },
    get pool() {
      return ready().pool;
    },
    query,
    async createTables(tables) {
      for (const statement of schemaStatements("postgres", tables)) await query(statement);
    },
    async reset() {
      await query(`DROP SCHEMA ${schema} CASCADE`);
      await query(`CREATE SCHEMA ${schema}`);
    },
  };
}
