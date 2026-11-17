// The store contract through every executor cloudrop/adapters/sql ships, on real databases: node-postgres and
// postgres.js on Postgres 18 (pools of 10, so the concurrent cases race real connections), node:sqlite on a fresh
// database per case. D1 runs it in the Wrangler lane. Below the contract, the rows only these drivers can break.

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { usePostgresDatabase } from "../testing/db/postgres.ts";
import { rawTables } from "../testing/db/raw-tables.ts";
import { sqlStoreTarget } from "../testing/db/sql-target.ts";
import { useSqliteDatabase } from "../testing/db/sqlite.ts";
import { describeStoreContract } from "../testing/store-contract.ts";
import {
  type PostgresJsSql,
  pgExecutor,
  postgresJsExecutor,
  type SqlExecutor,
  sqliteExecutor,
  sqlStore,
} from "./sql.ts";

const MAX_SAFE = 9007199254740991; // 2^53 - 1
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

/** The rows only a real driver can break: its number and time encodings, and its connections racing. */
function driverRows(executor: () => SqlExecutor<unknown>) {
  test("a size of 2^53 - 1 and millisecond times come back exactly, counted in usage", async () => {
    const store = sqlStore(executor());
    expect(
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", MAX_SAFE)] }, NOW),
    ).toEqual(["reserved"]);
    expect(await store.get("f-1")).toMatchObject({
      size: MAX_SAFE,
      expiresAt: NOW,
      createdAt: NOW,
      key: file("f-1", 0).key,
    });
    expect(await store.usage("u-1")).toEqual({ reservedBytes: MAX_SAFE, activeBytes: 0, files: 0 });
  });

  test("concurrent reserves of one owner never overshoot the quota", async () => {
    const store = sqlStore(executor());
    await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("q-0", 10)] }, NOW);
    // 10 bytes held, limit 60: room for exactly 5 of the 8 racing 10-byte files.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.reserve({ owner: "u-1", limit: 60, expiresAt: NOW, files: [file(`q-${index + 1}`, 10)] }, NOW),
      ),
    );
    expect(outcomes.flat().filter((outcome) => outcome === "reserved")).toHaveLength(5);
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 60, activeBytes: 0, files: 0 });
  });

  // An owner with no usage row yet has nothing to lock, so racing first reserves meet at the row's creation. Three
  // owners per case, because one race may happen to run one call at a time.
  test.for([
    { limit: 50, reserved: 5 },
    { limit: null, reserved: 8 },
  ])(
    "concurrent first reserves of new owners (limit $limit) reserve exactly $reserved each and never throw",
    async ({ limit, reserved }) => {
      const store = sqlStore(executor());
      const owners = ["new-a", "new-b", "new-c"];
      const outcomes = await Promise.all(
        owners.flatMap((owner) =>
          Array.from({ length: 8 }, (_, index) =>
            store.reserve({ owner, limit, expiresAt: NOW, files: [file(`${owner}-${index}`, 10)] }, NOW),
          ),
        ),
      );
      expect(outcomes.flat().filter((outcome) => outcome === "reserved")).toHaveLength(3 * reserved);
      for (const owner of owners) {
        expect(await store.usage(owner)).toEqual({ reservedBytes: reserved * 10, activeBytes: 0, files: 0 });
      }
    },
  );
}

describe("Postgres", () => {
  const db = usePostgresDatabase();
  let sql: PostgresJsSql & { end(): Promise<void> };
  beforeAll(() => {
    sql = postgres(db.url, { max: 10 });
  });
  afterAll(() => sql?.end());

  describeStoreContract(
    "sql adapter, node-postgres",
    sqlStoreTarget(db, (tables) => sqlStore(pgExecutor(db.pool), { tables })),
  );
  describeStoreContract(
    "sql adapter, postgres.js",
    sqlStoreTarget(db, (tables) => sqlStore(postgresJsExecutor(sql), { tables })),
  );

  const executors = [
    { name: "node-postgres", executor: () => pgExecutor(db.pool) },
    { name: "postgres.js", executor: () => postgresJsExecutor(sql) },
  ];

  describe.for(executors)("$name", ({ executor }) => {
    beforeEach(async () => {
      await db.reset();
      await db.createTables();
    });
    driverRows(executor);
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
    driverRows(() => sqliteExecutor(db.database));

    test("complete that fails at its files write rolls back the usage write that ran before it", async () => {
      const store = sqlStore(sqliteExecutor(db.database));
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 10)] }, NOW);
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
        { owner: "u-1", reservedBytes: 10, activeBytes: 0, files: 0, updatedAt: NOW },
      ]);
      expect((await raw.files())[0]).toMatchObject({ status: "completing", claim: "claim-a", completedAt: null });
    });
  });
});
