// Postgres under real lock contention, through both shipped Postgres executors: transaction mode's lock timeout, a
// reconcile or a guarded transition that waits for another transaction, and what an app may do through `tx`. Each row
// holds a lock on purpose and lets go of it however the row ends, so a failure cannot leave a lock for the next one.

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { usePostgresDatabase } from "../testing/db/postgres.ts";
import { rawTables } from "../testing/db/raw-tables.ts";
import {
  type PgQueryable,
  type PostgresJsSql,
  pgExecutor,
  postgresJsExecutor,
  type SqlExecutor,
  sqlStore,
} from "./sql.ts";

const NOW = new Date("2026-11-17T10:20:30.123Z");
const LEASE = 60_000;
const file = (id: string, size: number) => ({
  id,
  route: "files",
  key: `users/${id}.bin`,
  name: `${id}.bin`,
  type: "application/octet-stream",
  size,
  metadata: null,
});

/** A promise the test resolves when it is ready, to keep a transaction open until then. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("Postgres under lock contention", () => {
  const db = usePostgresDatabase();
  let sql: PostgresJsSql & { end(): Promise<void> };
  beforeAll(() => {
    sql = postgres(db.url, { max: 10 });
  });
  afterAll(() => sql?.end());

  const executors = [
    { name: "node-postgres", executor: () => pgExecutor(db.pool) },
    { name: "postgres.js", executor: () => postgresJsExecutor(sql) },
  ];

  /** A store over fresh tables, with its transaction. */
  async function transactionalStore(executor: () => SqlExecutor<unknown>) {
    await db.reset();
    await db.createTables();
    const store = sqlStore(executor());
    const transaction = store.transaction?.bind(store);
    if (!transaction) throw new Error("A Postgres store must offer transactions.");
    return { store, transaction };
  }

  /** Waits until a statement touching `table` is blocked on a lock, so the test knows the race is set up. */
  async function untilWaitingOn(table: string) {
    for (let polls = 0; polls < 500; polls++) {
      const [row] = await db.query(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${table}%`],
      );
      if (row?.waiting === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`No statement on ${table} ever waited for a lock.`);
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
        expect(await inner.claim("f-1", "claim-a", NOW, LEASE)).toEqual({ kind: "claimed" });
        await held.opened;
      });
      const started = Date.now();
      const waiting = await transaction((_tx, inner) => inner.claim("f-1", "claim-b", NOW, LEASE)).finally(held.open);
      await holder;
      expect(waiting).toEqual({ kind: "busy" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      expect((await rawTables(db).files())[0]).toMatchObject({ status: "completing", claim: "claim-a" });
    },
  );

  test.for(executors)(
    "$name: a refusal that waited for a transaction's completion answers the completed row",
    async ({ executor }) => {
      const { store, transaction } = await transactionalStore(executor);
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 10)] }, NOW);
      const held = gate();
      const completed = gate();
      const completing = transaction(async (_tx, inner) => {
        await inner.claim("f-1", "claim-a", NOW, LEASE);
        await inner.complete("f-1", "claim-a", '{"id":1}', NOW);
        completed.open();
        await held.opened;
      });
      await completed.opened;
      // The refusal's guarded UPDATE waits for the transaction's row lock, then finds the row no longer pending.
      const refusing = store.end("f-1", "pending", "rejected", NOW);
      try {
        await untilWaitingOn("cloudrop_files");
      } finally {
        held.open();
        await completing;
      }
      const refused = await refusing;
      expect(refused).toEqual({ changed: false, record: await store.get("f-1") });
      expect(refused.record).toMatchObject({ status: "completed", result: '{"id":1}', completedAt: NOW });
    },
  );

  test("an app statement through tx may wait longer than the claim's 2 s lock timeout", async () => {
    // Takes 2.5 s by design: the app's lock is held past the claim's timeout.
    const { store, transaction } = await transactionalStore(() => pgExecutor(db.pool));
    await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 10)] }, NOW);
    await db.query("CREATE TABLE app_rows (id integer PRIMARY KEY, note text)");
    await db.query("INSERT INTO app_rows VALUES (1, NULL)");
    const other = await db.pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT * FROM app_rows WHERE id = 1 FOR UPDATE");
      const letGo = setTimeout(() => void other.query("COMMIT"), 2500);
      const answer = await transaction(async (tx, inner) => {
        expect(await inner.claim("f-1", "claim-a", NOW, LEASE)).toEqual({ kind: "claimed" });
        await (tx as PgQueryable).query("UPDATE app_rows SET note = 'done' WHERE id = 1");
        return (await inner.complete("f-1", "claim-a", null, NOW)).changed;
      }).finally(() => clearTimeout(letGo));
      expect(answer).toBe(true);
      expect(await db.query("SELECT note FROM app_rows")).toEqual([{ note: "done" }]);
    } finally {
      await other.query("ROLLBACK").catch(() => undefined);
      other.release();
    }
  });

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
    try {
      await untilWaitingOn("cloudrop_usage");
    } finally {
      held.open();
      await reserving;
    }
    expect(await reconciling).toBe(true);
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 15, activeBytes: 0, files: 0 });
  });
});
