// drizzleStore's construction-time checks, the statement translation, and the public types (`bun run typecheck`
// compiles this file: every expectTypeOf and expect-error directive is an assertion). It names only what drizzle-orm
// 0.45 and 1.0 both export, so scripts/check-drizzle-versions.sh compiles it against 0.45 too. What the store does on a
// real database is proven by the store contract in drizzle.db.integration.test.ts.

import Database from "better-sqlite3";
import { drizzle as betterSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as libsql } from "drizzle-orm/libsql";
import { drizzle as nodePostgres } from "drizzle-orm/node-postgres";
import { getTableConfig as getPgTableConfig, PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle as pgProxy } from "drizzle-orm/pg-proxy";
import { drizzle as postgresJs } from "drizzle-orm/postgres-js";
import pg from "pg";
import { afterAll, describe, expect, expectTypeOf, onTestFinished, test } from "vitest";
import type { FileStatus } from "../server/store.ts";
import { schemaStatements } from "../testing/db/schema.ts";
import { drizzleSql } from "./drizzle/statement.ts";
import { cloudropPgTables, cloudropSqliteTables, drizzleStore } from "./drizzle.ts";

const appUploads = pgTable("app_uploads", { fileId: text("file_id").primaryKey(), owner: text("owner").notNull() });
// Neither client connects until a query runs, and none does here.
const pool = new pg.Pool();
afterAll(() => pool.end());
const postgresDb = nodePostgres({ client: pool });
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
        "transaction: true needs Postgres. SQLite has one writer at a time, so a transaction held open while onComplete runs would stall every other upload; leave the option out and completions use a lease.",
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
    expect(
      await store.reserve({ owner: "u-1", limit: 100, expiresAt: NOW, requestKey: null, files: [file] }, NOW),
    ).toEqual(["reserved"]);
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
    const query = drizzleSql("sqlite", { sql: "SELECT ? AS a, ? AS b, ? AS c", params: ["f-1", null, 9] });
    expect(sqliteDb.all(query)).toEqual([{ a: "f-1", b: null, c: 9 }]);
  });
});

const NO_SQLITE_SCHEMA = "SQLite has no schemas: remove schema from { tables }.";

describe("cloudropPgTables and cloudropSqliteTables", () => {
  test.for([
    { name: "cloudropPgTables", tables: () => cloudropPgTables({ tables: { files: "my files" } }) },
    { name: "cloudropSqliteTables", tables: () => cloudropSqliteTables({ tables: { files: "my files" } }) },
  ])("$name refuses a table name the store would refuse, naming the option", ({ tables }) => {
    expect(tables).toThrow(invalidConfig(expect.stringContaining("The files table name")));
  });

  test('cloudropPgTables puts the tables in "public" when tables.schema says so, as the store qualifies them', () => {
    // Drizzle's pgSchema() refuses "public"; the store accepts it and writes "public"."cloudrop_files".
    const { files, usage } = cloudropPgTables({ tables: { schema: "public" } });
    expect([getPgTableConfig(files).schema, getPgTableConfig(usage).schema]).toEqual(["public", "public"]);
  });

  test("cloudropSqliteTables and drizzleStore on SQLite refuse tables.schema, which SQLite does not have", () => {
    // @ts-expect-error: SQLite's tables take no schema.
    const tables = () => cloudropSqliteTables({ tables: { schema: "app" } });
    // @ts-expect-error: nor does drizzleStore on SQLite.
    const store = () => drizzleStore(sqliteDb, { dialect: "sqlite", tables: { schema: "app" } });
    expect(tables).toThrow(invalidConfig(NO_SQLITE_SCHEMA));
    expect(store).toThrow(invalidConfig(NO_SQLITE_SCHEMA));
  });
});

// Types only from here: the routes below are built, never called.

/** What Drizzle's own `transaction` hands its callback: the `tx` `onComplete` must receive. */
type DrizzleTx<TDb extends { transaction: (run: never) => unknown }> = Parameters<Parameters<TDb["transaction"]>[0]>[0];

drizzleStore(postgresDb, { dialect: "postgres", transaction: true }).route(policy, {
  onComplete: async ({ tx, userId, file }) => {
    expectTypeOf(tx).toEqualTypeOf<DrizzleTx<typeof postgresDb>>();
    expectTypeOf(tx).not.toBeAny();
    await tx.insert(appUploads).values({ fileId: file.id, owner: userId });
    return null;
  },
});

const postgresJsDb = postgresJs.mock();
drizzleStore(postgresJsDb, { dialect: "postgres", transaction: true }).route(policy, {
  onComplete: async ({ tx, userId, file }) => {
    expectTypeOf(tx).toEqualTypeOf<DrizzleTx<typeof postgresJsDb>>();
    await tx.insert(appUploads).values({ fileId: file.id, owner: userId });
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
  requestKey: string | null;
};
type UsageRow = { owner: string; reservedBytes: number; activeBytes: number; files: number; updatedAt: Date };

const postgresTables = cloudropPgTables();
const sqliteTables = cloudropSqliteTables({ tables: { files: "uploads" } });
expectTypeOf<typeof postgresTables.files.$inferSelect>().toEqualTypeOf<FileRow>();
expectTypeOf<typeof postgresTables.usage.$inferSelect>().toEqualTypeOf<UsageRow>();
// One table type for both shapes: a schema's tables and the search path's.
expectTypeOf<typeof postgresTables.files._.schema>().toEqualTypeOf<string | undefined>();
expectTypeOf<typeof sqliteTables.files.$inferSelect>().toEqualTypeOf<FileRow>();
expectTypeOf<typeof sqliteTables.usage.$inferSelect>().toEqualTypeOf<UsageRow>();
