// Upgrading to 1.0 (M12-O1): a usage table without the erase mark's columns fails the store's first call with
// INVALID_CONFIG that prints the upgrade's SQL for the dialect and the table's own name. The oracle is the database:
// that SQL, run as printed, makes the store work and builds the index the guide's DDL builds.

import { describe, expect, test } from "vitest";
import { pgExecutor, sqliteExecutor, sqlStore } from "../../adapters/sql.ts";
import type { CloudropStore } from "../../server/store.ts";
import { useAppSchema, usePostgresDatabase } from "../../testing/db/postgres.ts";
import type { TestDatabase } from "../../testing/db/schema.ts";
import { useSqliteDatabase } from "../../testing/db/sqlite.ts";

const NOW = new Date("2026-11-22T10:20:30.123Z");

/** The SQL the message tells the reader to run, one statement at a time. */
function printedSql(message: string): string[] {
  const [, sql = ""] = message.split("Run, in a migration: ");
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

/** The store's first call fails with `message`; its SQL, run, lets the next call mark an owner. */
async function upgradesWith(db: TestDatabase, store: CloudropStore<unknown>, message: string) {
  await expect(store.usage("u-1")).rejects.toMatchObject({ code: "INVALID_CONFIG", message });
  for (const statement of printedSql(message)) await db.query(statement);
  expect(await store.markErasure({ owner: "u-1", now: NOW })).toEqual({ requestedAt: NOW, erasedAt: null });
}

describe("Postgres, a usage table from 0.6, in a schema", () => {
  const db = usePostgresDatabase();
  const schema = useAppSchema(db);

  test("the first call prints the upgrade, which makes the store work", async () => {
    await db.reset();
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.createTables({ schema });
    await db.query(`ALTER TABLE "${schema}"."cloudrop_usage" DROP COLUMN erase_requested_at, DROP COLUMN erased_at`);
    const usage = `"${schema}"."cloudrop_usage"`;
    await upgradesWith(
      db,
      sqlStore(pgExecutor(db.pool), { tables: { schema } }),
      `The table ${usage} has no column "erase_requested_at". cloudrop 1.0 keeps an owner's erase mark in that table. Run, in a migration: ALTER TABLE ${usage} ADD COLUMN erase_requested_at timestamptz(3), ADD COLUMN erased_at timestamptz(3); CREATE INDEX "cloudrop_usage_erasing_idx" ON ${usage} (owner) WHERE erase_requested_at IS NOT NULL AND erased_at IS NULL;`,
    );
    const indexes = await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2", [
      schema,
      "cloudrop_usage_erasing_idx",
    ]);
    expect(indexes).toEqual([
      {
        indexdef: `CREATE INDEX cloudrop_usage_erasing_idx ON ${schema}.cloudrop_usage USING btree (owner) WHERE ((erase_requested_at IS NOT NULL) AND (erased_at IS NULL))`,
      },
    ]);
  });
});

describe("SQLite, a usage table from 0.6 with its own name", () => {
  const db = useSqliteDatabase();

  test("the first call prints the upgrade, which makes the store work", async () => {
    await db.createTables({ usage: "upload_usage" });
    await db.query('DROP INDEX "upload_usage_erasing_idx"');
    await db.query("ALTER TABLE upload_usage DROP COLUMN erased_at");
    await db.query("ALTER TABLE upload_usage DROP COLUMN erase_requested_at");
    await upgradesWith(
      db,
      sqlStore(sqliteExecutor(db.database), { tables: { usage: "upload_usage" } }),
      'The table "upload_usage" has no column "erase_requested_at". cloudrop 1.0 keeps an owner\'s erase mark in that table. Run, in a migration: ALTER TABLE "upload_usage" ADD COLUMN erase_requested_at INTEGER; ALTER TABLE "upload_usage" ADD COLUMN erased_at INTEGER; CREATE INDEX "upload_usage_erasing_idx" ON "upload_usage" (owner) WHERE erase_requested_at IS NOT NULL AND erased_at IS NULL;',
    );
    expect(await db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'upload_usage'")).toEqual(
      [{ name: "sqlite_autoindex_upload_usage_1" }, { name: "upload_usage_erasing_idx" }],
    );
  });

  // A migration that stopped half way: only the missing column is added, so the printed SQL runs without an error.
  test("a table with one of the two columns gets only the other", async () => {
    await db.createTables();
    await db.query('DROP INDEX "cloudrop_usage_erasing_idx"');
    await db.query("ALTER TABLE cloudrop_usage DROP COLUMN erased_at");
    await upgradesWith(
      db,
      sqlStore(sqliteExecutor(db.database)),
      'The table "cloudrop_usage" has no column "erased_at". cloudrop 1.0 keeps an owner\'s erase mark in that table. Run, in a migration: ALTER TABLE "cloudrop_usage" ADD COLUMN erased_at INTEGER; CREATE INDEX "cloudrop_usage_erasing_idx" ON "cloudrop_usage" (owner) WHERE erase_requested_at IS NOT NULL AND erased_at IS NULL;',
    );
  });
});
