// Proves the database lane's fixtures on real databases: the DDL of spec §3, the raw reader the store contract trusts
// as its oracle, the per-file Postgres schema, and that Prisma, Drizzle and postgres.js reach the same database.

import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import postgres from "postgres";
import { beforeEach, describe, expect, onTestFinished, test } from "vitest";
import { createPostgresDatabase, type PostgresTestDatabase, usePostgresDatabase } from "./postgres.ts";
import { openPrismaClient } from "./prisma.ts";
import { type FileRow, rawReader } from "./raw-reader.ts";
import type { TestDatabase } from "./schema.ts";
import { useSqliteDatabase } from "./sqlite.ts";

const MAX_SAFE = 9007199254740991; // 2^53 - 1
const T1 = new Date("2026-11-17T10:20:30.123Z");
const T2 = new Date("2026-11-17T11:20:30.999Z");
const T3 = new Date("2026-11-17T10:20:31.001Z");

/** Inserts one row with the dialect's placeholders; SQLite gets times as integer milliseconds, as §3 stores them. */
async function insert(db: TestDatabase, table: string, values: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(values);
  const params = Object.values(values).map((value) =>
    value instanceof Date && db.dialect === "sqlite" ? value.getTime() : value,
  );
  const marks = columns.map((_, index) => (db.dialect === "postgres" ? `$${index + 1}` : "?"));
  await db.query(`INSERT INTO "${table}" (${columns.join(", ")}) VALUES (${marks.join(", ")})`, params);
}

const fileValues = (id: string, key: string) => ({
  id,
  route: "files",
  key,
  status: "pending",
  name: "a.txt",
  type: "text/plain",
  size: 1,
  expires_at: T2,
  created_at: T1,
  updated_at: T1,
});

const postgresBackend = {
  name: "postgres",
  use(): PostgresTestDatabase {
    const db = usePostgresDatabase();
    beforeEach(async () => {
      await db.reset();
      await db.createTables();
    });
    return db;
  },
  columnsSql: `SELECT column_name || ' ' || data_type || ' ' || is_nullable AS c FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
  // "<column> <type> <nullable>", from spec §3.
  columns: [
    "id text NO",
    "route text NO",
    "key text NO",
    "owner text YES",
    "status text NO",
    "name text NO",
    "type text NO",
    "size bigint NO",
    "upload_id text YES",
    "metadata text YES",
    "result text YES",
    "claim text YES",
    "claimed_at timestamp with time zone YES",
    "expires_at timestamp with time zone NO",
    "created_at timestamp with time zone NO",
    "updated_at timestamp with time zone NO",
    "completed_at timestamp with time zone YES",
    "ended_at timestamp with time zone YES",
    "cleaned_at timestamp with time zone YES",
    "request_key text YES",
  ],
  usageColumns: [
    "owner text NO",
    "reserved_bytes bigint NO",
    "active_bytes bigint NO",
    "files integer NO",
    "updated_at timestamp with time zone NO",
  ],
  duplicateId: 'duplicate key value violates unique constraint "cloudrop_files_pkey"',
};

const sqliteBackend = {
  name: "sqlite",
  use() {
    const db = useSqliteDatabase();
    beforeEach(() => db.createTables());
    return db;
  },
  columnsSql: `SELECT name || ' ' || type || ' ' || iif("notnull", 'NO', 'YES') AS c FROM pragma_table_info(?)`,
  columns: [
    "id TEXT NO",
    "route TEXT NO",
    "key TEXT NO",
    "owner TEXT YES",
    "status TEXT NO",
    "name TEXT NO",
    "type TEXT NO",
    "size INTEGER NO",
    "upload_id TEXT YES",
    "metadata TEXT YES",
    "result TEXT YES",
    "claim TEXT YES",
    "claimed_at INTEGER YES",
    "expires_at INTEGER NO",
    "created_at INTEGER NO",
    "updated_at INTEGER NO",
    "completed_at INTEGER YES",
    "ended_at INTEGER YES",
    "cleaned_at INTEGER YES",
    "request_key TEXT YES",
  ],
  usageColumns: [
    "owner TEXT NO",
    "reserved_bytes INTEGER NO",
    "active_bytes INTEGER NO",
    "files INTEGER NO",
    "updated_at INTEGER NO",
  ],
  duplicateId: "UNIQUE constraint failed: cloudrop_files.id",
};

describe.each([postgresBackend, sqliteBackend])("$name", (backend) => {
  const db: TestDatabase = backend.use();
  const reader = rawReader(db);

  test("creates the files table with the columns, types and nullability of spec §3", async () => {
    const rows = await db.query(backend.columnsSql, ["cloudrop_files"]);
    expect(rows.map((row) => row.c)).toEqual(backend.columns);
  });

  test("creates the usage table with the columns, types and nullability of spec §3", async () => {
    const rows = await db.query(backend.columnsSql, ["cloudrop_usage"]);
    expect(rows.map((row) => row.c)).toEqual(backend.usageColumns);
  });

  test("accepts a second row with the same key and refuses a second row with the same id", async () => {
    await insert(db, "cloudrop_files", fileValues("id-1", "same/key.txt"));
    await insert(db, "cloudrop_files", fileValues("id-2", "same/key.txt"));
    await expect(insert(db, "cloudrop_files", fileValues("id-1", "other.txt"))).rejects.toThrow(backend.duplicateId);
    expect((await reader.files()).map((row) => `${row.id} ${row.key}`)).toEqual([
      "id-1 same/key.txt",
      "id-2 same/key.txt",
    ]);
  });

  test("the raw reader returns a full row and a row of nulls exactly", async () => {
    await insert(db, "cloudrop_files", {
      ...fileValues("full", "users/7/ä b/../x.png"),
      owner: "user_7",
      status: "completed",
      size: MAX_SAFE,
      upload_id: "upload-1",
      metadata: '{"album":"z"}',
      result: '{"ok":true}',
      claim: "claim-1",
      claimed_at: T3,
      completed_at: T3,
      ended_at: T2,
      cleaned_at: T2,
      request_key: "key-of-the-request-1",
    });
    await insert(db, "cloudrop_files", fileValues("nulls", "k"));
    const full: FileRow = {
      id: "full",
      route: "files",
      key: "users/7/ä b/../x.png",
      owner: "user_7",
      status: "completed",
      name: "a.txt",
      type: "text/plain",
      size: 9007199254740991,
      uploadId: "upload-1",
      metadata: '{"album":"z"}',
      result: '{"ok":true}',
      claim: "claim-1",
      claimedAt: new Date("2026-11-17T10:20:31.001Z"),
      expiresAt: new Date("2026-11-17T11:20:30.999Z"),
      createdAt: new Date("2026-11-17T10:20:30.123Z"),
      updatedAt: new Date("2026-11-17T10:20:30.123Z"),
      completedAt: new Date("2026-11-17T10:20:31.001Z"),
      endedAt: new Date("2026-11-17T11:20:30.999Z"),
      cleanedAt: new Date("2026-11-17T11:20:30.999Z"),
      requestKey: "key-of-the-request-1",
    };
    expect(await reader.file("full")).toEqual(full);
    expect(await reader.file("nulls")).toEqual({
      ...full,
      id: "nulls",
      key: "k",
      owner: null,
      status: "pending",
      size: 1,
      uploadId: null,
      metadata: null,
      result: null,
      claim: null,
      claimedAt: null,
      completedAt: null,
      endedAt: null,
      cleanedAt: null,
      requestKey: null,
    });
    expect(await reader.file("absent")).toBeNull();
  });

  test("the raw reader returns usage counters up to 2^53 - 1", async () => {
    await insert(db, "cloudrop_usage", {
      owner: "user_7",
      reserved_bytes: MAX_SAFE,
      active_bytes: 0,
      files: 3,
      updated_at: T1,
    });
    expect(await reader.usages()).toEqual([
      { owner: "user_7", reservedBytes: 9007199254740991, activeBytes: 0, files: 3, updatedAt: T1 },
    ]);
    expect(await reader.usage("nobody")).toBeNull();
  });

  test("custom table names reach both the DDL and the reader", async () => {
    await db.createTables({ files: "app_uploads", usage: "app_quota" });
    await insert(db, "app_uploads", fileValues("custom", "k"));
    const custom = rawReader(db, { files: "app_uploads", usage: "app_quota" });
    expect((await custom.files()).map((row) => row.id)).toEqual(["custom"]);
    expect(await custom.usages()).toEqual([]);
  });
});

describe("postgres only", () => {
  const db = usePostgresDatabase();
  beforeEach(async () => {
    await db.reset();
    await db.createTables();
  });

  test("creates the six indexes of spec §3 beside the primary key, none of them unique on key", async () => {
    const rows = await db.query(
      "SELECT replace(indexdef, current_schema() || '.', '') AS def FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname COLLATE \"C\"",
    );
    expect(rows.map((row) => row.def)).toEqual([
      "CREATE INDEX cloudrop_files_key_idx ON cloudrop_files USING btree (key)",
      "CREATE INDEX cloudrop_files_owner_status_idx ON cloudrop_files USING btree (owner, status)",
      "CREATE UNIQUE INDEX cloudrop_files_pkey ON cloudrop_files USING btree (id)",
      "CREATE INDEX cloudrop_files_route_request_key_idx ON cloudrop_files USING btree (route, request_key)",
      "CREATE INDEX cloudrop_files_status_claimed_at_idx ON cloudrop_files USING btree (status, claimed_at)",
      "CREATE INDEX cloudrop_files_status_cleaned_at_ended_at_idx ON cloudrop_files USING btree (status, cleaned_at, ended_at)",
      "CREATE INDEX cloudrop_files_status_expires_at_idx ON cloudrop_files USING btree (status, expires_at)",
      "CREATE UNIQUE INDEX cloudrop_usage_pkey ON cloudrop_usage USING btree (owner)",
    ]);
  });

  test.each([
    ["reserved_bytes", { reserved_bytes: -1, active_bytes: 0, files: 0 }],
    ["active_bytes", { reserved_bytes: 0, active_bytes: -1, files: 0 }],
    ["files", { reserved_bytes: 0, active_bytes: 0, files: -1 }],
  ])("the CHECK constraint refuses a negative %s", async (column, counters) => {
    await expect(insert(db, "cloudrop_usage", { owner: "o", ...counters, updated_at: T1 })).rejects.toThrow(
      `new row for relation "cloudrop_usage" violates check constraint "cloudrop_usage_${column}_check"`,
    );
  });

  test("the raw reader refuses a size beyond 2^53 instead of rounding it", async () => {
    await insert(db, "cloudrop_files", { ...fileValues("big", "k"), size: "9007199254740993" });
    await expect(rawReader(db).file("big")).rejects.toThrow(
      'Column size holds string "9007199254740993"; expected an integer within 2^53.',
    );
  });

  test("postgres.js, Drizzle and Prisma land in this file's schema through the fixture's URL", async () => {
    const client = postgres(db.url, { max: 1 });
    onTestFinished(() => client.end());
    const [fromPostgresJs] = await client`SELECT current_schema() AS schema`;

    const drizzleDb = drizzlePostgres(db.url);
    onTestFinished(() => drizzleDb.$client.end());
    const fromDrizzle = await drizzleDb.execute(sql`SELECT current_schema() AS schema`);

    const prisma = await openPrismaClient(db);
    onTestFinished(() => prisma.$disconnect());
    const fromPrisma = await prisma.$queryRawUnsafe("SELECT current_schema() AS schema");

    expect([fromPostgresJs, fromDrizzle.rows[0], ...(fromPrisma as unknown[])]).toEqual([
      { schema: db.schema },
      { schema: db.schema },
      { schema: db.schema },
    ]);
  });

  test("close() drops a database's schema with its tables", async () => {
    const scoped = createPostgresDatabase();
    onTestFinished(() => scoped.close());
    await scoped.open();
    await scoped.database.createTables();
    const present = "SELECT nspname FROM pg_namespace WHERE nspname = $1";
    expect(await db.query(present, [scoped.database.schema])).toEqual([{ nspname: scoped.database.schema }]);
    await scoped.close();
    expect(await db.query(present, [scoped.database.schema])).toEqual([]);
  });
});

describe("sqlite only", () => {
  const db = useSqliteDatabase({ file: true });
  beforeEach(() => db.createTables());

  test("creates the six indexes of spec §3 beside the primary keys, none of them unique on key", async () => {
    // "<index> [UNIQUE] (<columns in key order>)" from SQLite's own catalog, for both tables.
    const rows = await db.query(`SELECT list.name || iif(list."unique", ' UNIQUE', '') || ' (' ||
        (SELECT group_concat(name, ', ') FROM (SELECT name FROM pragma_index_info(list.name) ORDER BY seqno)) || ')' AS def
      FROM (SELECT 'cloudrop_files' AS name UNION ALL SELECT 'cloudrop_usage') AS tables, pragma_index_list(tables.name) AS list
      ORDER BY list.name`);
    expect(rows.map((row) => row.def)).toEqual([
      "cloudrop_files_key_idx (key)",
      "cloudrop_files_owner_status_idx (owner, status)",
      "cloudrop_files_route_request_key_idx (route, request_key)",
      "cloudrop_files_status_claimed_at_idx (status, claimed_at)",
      "cloudrop_files_status_cleaned_at_ended_at_idx (status, cleaned_at, ended_at)",
      "cloudrop_files_status_expires_at_idx (status, expires_at)",
      "sqlite_autoindex_cloudrop_files_1 UNIQUE (id)",
      "sqlite_autoindex_cloudrop_usage_1 UNIQUE (owner)",
    ]);
  });

  test("the raw reader refuses a time stored as ISO text", async () => {
    await insert(db, "cloudrop_files", { ...fileValues("iso", "k"), expires_at: "2026-11-17T11:20:30.999Z" });
    await expect(rawReader(db).file("iso")).rejects.toThrow(
      'Column expires_at holds string "2026-11-17T11:20:30.999Z"; expected a timestamptz, or integer milliseconds on SQLite.',
    );
  });

  test("Prisma and Drizzle open the same database file", async () => {
    await insert(db, "cloudrop_files", fileValues("shared", "k"));
    const prisma = await openPrismaClient(db);
    onTestFinished(() => prisma.$disconnect());
    const fromPrisma = await prisma.$queryRawUnsafe("SELECT id FROM cloudrop_files");

    // Drizzle 0.45 has no node:sqlite driver; its proxy driver runs the statements on a second connection to the file.
    if (!db.path) throw new Error("This describe opens its database with { file: true }.");
    const second = new DatabaseSync(db.path);
    onTestFinished(() => second.close());
    const drizzleDb = drizzleProxy(async (query, params) => {
      const statement = second.prepare(query);
      statement.setReturnArrays(true);
      return { rows: statement.all(...params) };
    });
    const fromDrizzle = await drizzleDb.all(sql`SELECT id FROM cloudrop_files`);

    expect([fromPrisma, fromDrizzle]).toEqual([[{ id: "shared" }], [["shared"]]]);
  });
});
