// The store contract through every executor cloudrop/adapters/sql ships, on real databases: node-postgres and
// postgres.js on Postgres 18 (pools of 10, so the concurrent cases race real connections), node:sqlite on a fresh
// database per case. D1 runs it in the Wrangler lane. Below the contract, the rows only these drivers can break.

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { driverRows } from "../testing/db/driver-rows.ts";
import { usePostgresDatabase } from "../testing/db/postgres.ts";
import { rawTables } from "../testing/db/raw-tables.ts";
import { sqlStoreTarget } from "../testing/db/sql-target.ts";
import { useSqliteDatabase } from "../testing/db/sqlite.ts";
import { describeStoreContract } from "../testing/store-contract.ts";
import { type PostgresJsSql, pgExecutor, postgresJsExecutor, sqliteExecutor, sqlStore } from "./sql.ts";

const NOW = new Date("2026-11-17T10:20:30.123Z");
const file = (id: string, size: number) => ({
  id,
  route: "files",
  key: `users/${id}/ünïcode ../name.bin`,
  name: "name.bin",
  type: "application/octet-stream",
  size,
  metadata: '{"album":"summer"}',
});

describe("Postgres", () => {
  const db = usePostgresDatabase();
  let sql: PostgresJsSql & { end(): Promise<void> };
  beforeAll(() => {
    sql = postgres(db.url, { max: 10 });
  });
  afterAll(() => sql?.end());

  describeStoreContract(
    "sql adapter, node-postgres",
    sqlStoreTarget(db, (tables) => sqlStore(pgExecutor(db.pool), { tables, transaction: true })),
  );
  describeStoreContract(
    "sql adapter, postgres.js",
    sqlStoreTarget(db, (tables) => sqlStore(postgresJsExecutor(sql), { tables, transaction: true })),
  );

  const stores = [
    { name: "node-postgres", store: () => sqlStore(pgExecutor(db.pool)) },
    { name: "postgres.js", store: () => sqlStore(postgresJsExecutor(sql)) },
  ];

  describe.for(stores)("$name", ({ store }) => {
    beforeEach(async () => {
      await db.reset();
      await db.createTables();
    });
    driverRows(store);
  });
});

describe("SQLite", () => {
  const db = useSqliteDatabase();
  describeStoreContract(
    "sql adapter, node:sqlite",
    sqlStoreTarget(db, (tables) => sqlStore(sqliteExecutor(db.database), { tables }), {
      transaction:
        "node:sqlite is one synchronous connection; holding a transaction across onComplete's awaits would block every other call.",
    }),
  );

  describe("node:sqlite", () => {
    beforeEach(() => db.createTables());
    driverRows(() => sqlStore(sqliteExecutor(db.database)));

    test("the name filter folds ASCII letters only, even where lower() folds every letter, as under SQLite's ICU extension", async () => {
      // The ICU extension replaces lower() with one that folds every letter (measured with SQLite's ext/icu/icu.c
      // loaded into node:sqlite: lower('Ä') is 'ä'). A function registered under that name replaces the built-in the
      // same way. A filter through lower() then matched "Ärger" for "ä", which Postgres and the memory store do not,
      // and which api.files refuses as a page outside its filter (M11-R69).
      db.database.function("lower", { deterministic: true }, (text) => String(text).toLowerCase());
      const store = sqlStore(sqliteExecutor(db.database));
      const files = [
        { ...file("f-upper", 1), name: "Ärger.TXT" },
        { ...file("f-lower", 1), name: "ärger.txt" },
      ];
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, requestKey: null, files }, NOW);
      const found = async (name: string) => {
        const page = { route: null, type: null, order: "newest", limit: 10, cursor: null } as const;
        const { records } = await store.list({ ...page, owner: "u-1", statuses: ["pending"], name });
        return records.map((record) => record.id);
      };
      expect(await found("ä")).toEqual(["f-lower"]);
      // ASCII letters still match in either case, on both sides.
      expect(await found("RGER.t")).toEqual(["f-upper", "f-lower"]);
    });

    test("complete that fails at its files write rolls back the usage write that ran before it", async () => {
      const store = sqlStore(sqliteExecutor(db.database));
      await store.reserve(
        { owner: "u-1", limit: null, expiresAt: NOW, requestKey: null, files: [file("f-1", 10)] },
        NOW,
      );
      await store.claim("f-1", "claim-a", NOW, 60_000);
      // complete's batch writes usage first, then the files row; this fails the files write once.
      let armed = true;
      db.database.function("fail_files_once", { deterministic: false }, () => {
        const fire = armed;
        armed = false;
        return fire ? 1 : 0;
      });
      await db.query(`CREATE TRIGGER fail_files BEFORE UPDATE ON cloudrop_files WHEN fail_files_once()
        BEGIN SELECT RAISE(ABORT, 'Injected failure of the files write.'); END`);
      await expect(store.complete("f-1", "claim-a", null, NOW)).rejects.toThrow("Injected failure of the files write.");
      const raw = rawTables(db);
      expect(await raw.usage()).toEqual([
        {
          owner: "u-1",
          reservedBytes: 10,
          activeBytes: 0,
          files: 0,
          eraseRequestedAt: null,
          erasedAt: null,
          updatedAt: NOW,
        },
      ]);
      expect((await raw.files())[0]).toMatchObject({ status: "completing", claim: "claim-a", completedAt: null });
    });
  });
});
