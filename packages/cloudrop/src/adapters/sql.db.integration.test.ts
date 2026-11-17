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

  /** A store over fresh tables, with its transaction. */
  async function transactionalStore(executor: () => SqlExecutor<unknown>) {
    await db.reset();
    await db.createTables();
    const store = sqlStore(executor());
    const transaction = store.transaction?.bind(store);
    if (!transaction) throw new Error("A Postgres store must offer transactions.");
    return { store, transaction };
  }

  /** A promise the test resolves when it is ready, to keep a transaction open until then. */
  function gate() {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  test.for(executors)(
    "$name: a claim waiting on another transaction's row lock is busy after the 2 s lock timeout",
    async ({ executor }) => {
      // Takes 2 s by design: the lock timeout is what turns the wait into an answer. The waiting transaction then ends
      // normally, so the driver must also cope with committing a transaction the timeout aborted.
      const { store, transaction } = await transactionalStore(executor);
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 1)] }, NOW);
      const held = gate();
      const holder = transaction(async (_tx, inner) => {
        expect(await inner.claim("f-1", "claim-a", NOW, 60_000)).toEqual({ kind: "claimed" });
        await held.opened;
      });
      const started = Date.now();
      // The holder is let go however the wait ends, so a failure here leaves no lock behind for the next row.
      const waiting = await transaction((_tx, inner) => inner.claim("f-1", "claim-b", NOW, 60_000)).finally(held.open);
      await holder;
      expect(waiting).toEqual({ kind: "busy" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      expect((await rawTables(db).files())[0]).toMatchObject({ status: "completing", claim: "claim-a" });
    },
  );

  test("reconcile waits for a reserve that is still open, then counts it", async () => {
    const { store, transaction } = await transactionalStore(() => pgExecutor(db.pool));
    await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-0", 10)] }, NOW);
    await rawTables(db).putUsage({ owner: "u-1", reservedBytes: 999, activeBytes: 0, files: 0, updatedAt: NOW });
    const held = gate();
    const reserved = gate();
    const reserving = transaction(async (_tx, inner) => {
      await inner.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 5)] }, NOW);
      reserved.open();
      await held.opened;
    });
    await reserved.opened;
    const reconciling = store.reconcile("u-1");
    // Commit the reserve only once reconcile is blocked on the usage row, so a recount from a snapshot taken before
    // the commit would overwrite the reserve's 5 bytes.
    for (let polls = 0; ; polls++) {
      const [row] = await db.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%cloudrop_usage%'`);
      if (row?.waiting === 1) break;
      if (polls > 500) throw new Error("reconcile never waited for the usage row lock.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    held.open();
    await reserving;
    expect(await reconciling).toBe(true);
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 15, activeBytes: 0, files: 0 });
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
  });
});
