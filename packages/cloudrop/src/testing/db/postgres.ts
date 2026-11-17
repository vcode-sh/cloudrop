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

/** A Postgres test database with its lifecycle in the caller's hands; usePostgresDatabase() wires it to hooks. */
export interface PostgresLifecycle {
  readonly database: PostgresTestDatabase;
  /** Connects and creates the schema. Call close() even when this fails. */
  open(): Promise<void>;
  /** Drops the schema with everything in it and ends the pool; does nothing when nothing was opened. */
  close(): Promise<void>;
}

export function createPostgresDatabase(): PostgresLifecycle {
  const schema = `cloudrop_test_${randomBytes(6).toString("hex")}`;
  let state: { pool: pg.Pool; url: string } | undefined;

  const ready = () => {
    if (!state) throw new Error("This Postgres test database is not open: use it after its beforeAll (or open()) ran.");
    return state;
  };
  const query = async (sql: string, params: readonly unknown[] = []) =>
    (await ready().pool.query(sql, [...params])).rows;
  const database: PostgresTestDatabase = {
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
  return {
    database,
    async open() {
      const options = `-c search_path=${schema}`;
      const url = new URL(serverUrl());
      url.searchParams.set("options", options);
      // Kept before CREATE SCHEMA, so close() ends the pool even when the schema could not be created.
      state = { pool: new pg.Pool({ connectionString: serverUrl(), options, max: 10 }), url: url.href };
      await state.pool.query(`CREATE SCHEMA ${schema}`);
    },
    async close() {
      if (!state) return;
      const { pool } = state;
      state = undefined;
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}

/**
 * Call at the top of a test file or `describe`. It creates the schema before the scope's tests and drops it after
 * them; the teardown is registered here, before anything is acquired, so a failed setup is still cleaned up.
 */
export function usePostgresDatabase(): PostgresTestDatabase {
  const lifecycle = createPostgresDatabase();
  beforeAll(lifecycle.open);
  afterAll(lifecycle.close);
  return lifecycle.database;
}

/**
 * A second schema for this scope, `<schema>_app`, for stores built with `tables.schema`. Whatever creates it, it is
 * dropped after the scope's tests; call this after usePostgresDatabase(), so the drop runs before the pool ends.
 */
export function useAppSchema(db: PostgresTestDatabase): string {
  const schema = `${db.schema}_app`;
  afterAll(() => db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
  return schema;
}

/**
 * Resolves once `sql`, which counts waiting sessions as `waiting`, answers exactly 1: a test's race is set up. Each
 * caller filters to its own sessions, because other test files run against the same server at the same time.
 */
export async function untilOneWaits(
  db: Pick<TestDatabase, "query">,
  sql: string,
  params: readonly unknown[],
  failure: string,
): Promise<void> {
  for (let polls = 0; polls < 500; polls++) {
    const [row] = await db.query(sql, params);
    if (row?.waiting === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(failure);
}
