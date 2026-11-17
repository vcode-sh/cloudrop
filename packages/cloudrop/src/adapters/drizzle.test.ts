// drizzleStore's construction-time checks, the statement translation, and the public types (`bun run typecheck`
// compiles this file: every expectTypeOf and expect-error directive is an assertion). What the store does on a real
// database is proven by the store contract in drizzle.db.integration.test.ts.

import Database from "better-sqlite3";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle as betterSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as libsql } from "drizzle-orm/libsql";
import { type NodePgQueryResultHKT, drizzle as nodePostgres } from "drizzle-orm/node-postgres";
import { PgDialect, type PgTransaction, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle as pgProxy } from "drizzle-orm/pg-proxy";
import { type PostgresJsQueryResultHKT, drizzle as postgresJs } from "drizzle-orm/postgres-js";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import pg from "pg";
import { afterAll, describe, expect, expectTypeOf, onTestFinished, test } from "vitest";
import type { FileStatus } from "../server/store.ts";
import { schemaStatements } from "../testing/db/schema.ts";
import { drizzleSql } from "./drizzle/statement.ts";
import { cloudropPgTables, cloudropSqliteTables, drizzleStore } from "./drizzle.ts";

const appUploads = pgTable("app_uploads", { fileId: text("file_id").primaryKey(), owner: text("owner").notNull() });
const schema = { appUploads };
// Neither client connects until a query runs, and none does here.
const pool = new pg.Pool();
afterAll(() => pool.end());
const postgresDb = nodePostgres({ client: pool, schema });
const sqliteConnection = new Database(":memory:");
afterAll(() => sqliteConnection.close());
const sqliteDb = betterSqlite({ client: sqliteConnection });
const policy = { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) } as const;
const NOW = new Date("2026-11-17T10:20:30.123Z");

const invalidConfig = (message: string) => expect.objectContaining({ code: "INVALID_CONFIG", message });

describe("drizzleStore", () => {
  test("refuses transaction: true on SQLite, naming Postgres and the lease it uses instead", () => {
    // @ts-expect-error: the SQLite options have no transaction.
    expect(() => drizzleStore(sqliteDb, { dialect: "sqlite", transaction: true })).toThrow(
      invalidConfig(
        "transaction: true needs Postgres. SQLite has a single writer, so a transaction held open while onComplete runs would block every other upload; leave the option out and completions use a lease.",
      ),
    );
  });

  test("refuses a single node-postgres Client, whose one connection every request would share", () => {
    // Drizzle runs BEGIN on a Client's only connection, so another request's reserve would join (and roll back with)
    // an onComplete transaction.
    const client = new pg.Client();
    expect(() => drizzleStore(nodePostgres({ client }), { dialect: "postgres", transaction: true })).toThrow(
      invalidConfig(
        "drizzleStore needs a pg Pool, not a single pg Client: a transaction on the one shared connection would take every other request's statements with it. Pass drizzle(new Pool({ connectionString })), or use postgres.js.",
      ),
    );
  });

  test("refuses a dialect it does not know", () => {
    // @ts-expect-error: only "postgres" and "sqlite".
    expect(() => drizzleStore(postgresDb, { dialect: "mysql" })).toThrow(
      invalidConfig(`drizzleStore's dialect "mysql" is not supported. Use "postgres" or "sqlite".`),
    );
  });

  test("offers a transaction and store.route only with transaction: true; otherwise completions use a lease", () => {
    const plain = drizzleStore(postgresDb, { dialect: "postgres" });
    const transactional = drizzleStore(postgresDb, { dialect: "postgres", transaction: true });
    expect([plain.transaction, "route" in plain]).toEqual([undefined, false]);
    expect([typeof transactional.transaction, typeof transactional.route]).toEqual(["function", "function"]);
  });

  test("names the shape when a driver's execute() answers neither rows nor { rows }", async () => {
    // pg-proxy hands back whatever the callback calls rows; this one answers the shape of Drizzle's AWS Data API driver.
    const store = drizzleStore(
      pgProxy(async () => ({ rows: { records: [], numberOfRecordsUpdated: 0 } as never })),
      { dialect: "postgres" },
    );
    await expect(store.get("f-1")).rejects.toThrow(
      invalidConfig(
        "This Drizzle driver's execute() answered { records, numberOfRecordsUpdated }, not rows or { rows }. Use drizzleStore with node-postgres or postgres.js, or build an executor for cloudrop/adapters/sql.",
      ),
    );
  });

  test("tells a write from a read by its RETURNING clause, not by a table named returning", async () => {
    // better-sqlite3 refuses `all` for a statement that answers no rows, such as the usage upsert of a reserve.
    const connection = new Database(":memory:");
    onTestFinished(() => {
      connection.close();
    });
    const tables = { files: "uploads", usage: "returning" };
    for (const statement of schemaStatements("sqlite", tables)) connection.exec(statement);
    const store = drizzleStore(betterSqlite({ client: connection }), { dialect: "sqlite", tables });
    const file = {
      id: "f-1",
      route: "files",
      key: "a.txt",
      name: "a.txt",
      type: "text/plain",
      size: 5,
      metadata: null,
    };
    expect(await store.reserve({ owner: "u-1", limit: 100, expiresAt: NOW, files: [file] }, NOW)).toEqual(["reserved"]);
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 5, activeBytes: 0, files: 0 });
  });
});

describe("drizzleSql", () => {
  test("on Postgres, keeps each cast and takes the value $n names, even out of order", () => {
    const query = drizzleSql("postgres", {
      sql: "UPDATE t SET a = $2::bigint WHERE id = $1::text AND b = $3::timestamptz",
      params: ["f-1", 7, "2026-11-17T10:00:00.000Z"],
    });
    expect(new PgDialect().sqlToQuery(query)).toMatchObject({
      sql: "UPDATE t SET a = $1::bigint WHERE id = $2::text AND b = $3::timestamptz",
      params: [7, "f-1", "2026-11-17T10:00:00.000Z"],
    });
  });

  test("on SQLite, gives each ? the next value, null included", () => {
    const query = drizzleSql("sqlite", { sql: "INSERT INTO t VALUES (?, ?, ?)", params: ["f-1", null, 9] });
    expect(new SQLiteSyncDialect().sqlToQuery(query)).toMatchObject({
      sql: "INSERT INTO t VALUES (?, ?, ?)",
      params: ["f-1", null, 9],
    });
  });
});

describe("cloudropPgTables and cloudropSqliteTables", () => {
  test.for([
    { name: "cloudropPgTables", tables: () => cloudropPgTables({ tables: { files: "my files" } }) },
    { name: "cloudropSqliteTables", tables: () => cloudropSqliteTables({ tables: { files: "my files" } }) },
  ])("$name refuses a table name the store would refuse, naming the option", ({ tables }) => {
    expect(tables).toThrow(invalidConfig(expect.stringContaining("The files table name")));
  });
});

// Types only from here: the routes below are built, never called.

type NodePgTx = PgTransaction<NodePgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
drizzleStore(postgresDb, { dialect: "postgres", transaction: true }).route(policy, {
  onComplete: async ({ tx, userId, file }) => {
    expectTypeOf(tx).toEqualTypeOf<NodePgTx>();
    await tx.insert(appUploads).values({ fileId: file.id, owner: userId });
    return null;
  },
});

type PostgresJsTx = PgTransaction<
  PostgresJsQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;
drizzleStore(postgresJs.mock(), { dialect: "postgres", transaction: true }).route(policy, {
  onComplete: ({ tx }) => {
    expectTypeOf(tx).toEqualTypeOf<PostgresJsTx>();
    return null;
  },
});

// An asynchronous SQLite database with an atomic batch (libsql, D1) is accepted.
expectTypeOf(drizzleStore(libsql.mock(), { dialect: "sqlite" }).reserve).toBeFunction();

// @ts-expect-error: without transaction: true there is no tx, so no store.route.
void drizzleStore(postgresDb, { dialect: "postgres" }).route;
// @ts-expect-error: transaction: false is the same.
void drizzleStore(postgresDb, { dialect: "postgres", transaction: false }).route;
// @ts-expect-error: nor on SQLite.
void drizzleStore(sqliteDb, { dialect: "sqlite" }).route;
// @ts-expect-error: a SQLite database is not a Postgres one.
void (() => drizzleStore(sqliteDb, { dialect: "postgres" }));

/** The rows `select().from(files)` gives, per spec §3: times as Dates on both dialects, sizes as numbers. */
type FileRow = {
  id: string;
  route: string;
  key: string;
  owner: string | null;
  status: FileStatus;
  name: string;
  type: string;
  size: number;
  uploadId: string | null;
  metadata: string | null;
  result: string | null;
  claim: string | null;
  claimedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  endedAt: Date | null;
  cleanedAt: Date | null;
};
type UsageRow = { owner: string; reservedBytes: number; activeBytes: number; files: number; updatedAt: Date };

const postgresTables = cloudropPgTables();
const sqliteTables = cloudropSqliteTables({ tables: { files: "uploads" } });
expectTypeOf<typeof postgresTables.files.$inferSelect>().toEqualTypeOf<FileRow>();
expectTypeOf<typeof postgresTables.usage.$inferSelect>().toEqualTypeOf<UsageRow>();
expectTypeOf<typeof sqliteTables.files.$inferSelect>().toEqualTypeOf<FileRow>();
expectTypeOf<typeof sqliteTables.usage.$inferSelect>().toEqualTypeOf<UsageRow>();
