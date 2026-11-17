// Postgres under real lock contention, through both shipped Postgres executors: transaction mode's lock timeout, a
// reconcile or a guarded transition that waits for another transaction, and what an app may do through `tx`. Each row
// holds a lock on purpose and lets go of it however the row ends, so a failure cannot leave a lock for the next one.

import pg from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { usePostgresDatabase } from "../testing/db/postgres.ts";
import { rawTables } from "../testing/db/raw-tables.ts";
import {
  type PgQueryable,
  type PostgresJsQueryable,
  type PostgresJsSql,
  pgExecutor,
  postgresJsExecutor,
  type SqlExecutor,
  sqlStore,
} from "./sql.ts";

const NOW = new Date("2026-11-17T10:20:30.123Z");
const LEASE = 60_000;
const PID = "SELECT pg_backend_pid() AS pid";
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

  /** Each executor, and how to ask its transaction handle for the backend it runs on. */
  const executors = [
    {
      name: "node-postgres",
      executor: () => pgExecutor(db.pool),
      backendPid: async (tx: unknown) => (await (tx as PgQueryable).query(PID)).rows[0]?.pid,
    },
    {
      name: "postgres.js",
      executor: () => postgresJsExecutor(sql),
      backendPid: async (tx: unknown) => (await (tx as PostgresJsQueryable).unsafe(PID))[0]?.pid,
    },
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

  /**
   * Waits until a statement is blocked by the backend `holder`, so the test knows its race is set up. Only that
   * backend's waiters count: other test files run against the same server at the same time.
   */
  async function untilBlockedBy(holder: unknown) {
    for (let polls = 0; polls < 500; polls++) {
      const [row] = await db.query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))",
        [holder],
      );
      if (row?.waiting === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Nothing ever waited for backend ${holder}.`);
  }

  test.for(executors)(
    "$name: a claim waiting on another transaction's row lock is busy after the 2 s lock timeout",
    async ({ executor }) => {
      // Takes 2 s by design: the lock timeout is what turns the wait into an answer. The waiting transaction then ends
      // normally, so the driver must also cope with committing a transaction the timeout aborted.
      const { store, transaction } = await transactionalStore(executor);
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 1)] }, NOW);
      const held = gate();
      const claimed = gate();
      const holder = transaction(async (_tx, inner) => {
        expect(await inner.claim("f-1", "claim-a", NOW, LEASE)).toEqual({ kind: "claimed" });
        claimed.open();
        await held.opened;
      });
      // The second transaction starts only once the first holds the claim, so it cannot claim first.
      await claimed.opened;
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
    async ({ executor, backendPid }) => {
      const { store, transaction } = await transactionalStore(executor);
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 10)] }, NOW);
      const held = gate();
      let holder: unknown;
      const completed = gate();
      const completing = transaction(async (tx, inner) => {
        holder = await backendPid(tx);
        await inner.claim("f-1", "claim-a", NOW, LEASE);
        await inner.complete("f-1", "claim-a", '{"id":1}', NOW);
        completed.open();
        await held.opened;
      });
      await completed.opened;
      // The refusal's guarded UPDATE waits for the transaction's row lock, then finds the row no longer pending.
      const refusing = store.end("f-1", "pending", "rejected", NOW);
      try {
        await untilBlockedBy(holder);
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

  test("after the claim, the app's statements through tx run at the lock timeout its session set", async () => {
    await db.reset();
    await db.createTables();
    // One connection, whose session sets its own lock timeout as an app's pool hook would.
    const pool = new pg.Pool({ connectionString: db.url, max: 1 });
    try {
      await pool.query("SET lock_timeout = '7s'");
      const store = sqlStore(pgExecutor(pool));
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 10)] }, NOW);
      const seen = await store.transaction(async (tx, inner) => {
        const during = await inner.claim("f-1", "claim-a", NOW, LEASE);
        return { during, after: (await tx.query("SHOW lock_timeout")).rows };
      });
      expect(seen).toEqual({ during: { kind: "claimed" }, after: [{ lock_timeout: "7s" }] });
    } finally {
      await pool.end();
    }
  });

  test("reconcile waits for a reserve that is still open, then counts it", async () => {
    const { store, transaction } = await transactionalStore(() => pgExecutor(db.pool));
    await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-0", 10)] }, NOW);
    await rawTables(db).putUsage({ owner: "u-1", reservedBytes: 999, activeBytes: 0, files: 0, updatedAt: NOW });
    const held = gate();
    const reserved = gate();
    let holder: unknown;
    const reserving = transaction(async (tx, inner) => {
      holder = await executors[0]?.backendPid(tx);
      await inner.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 5)] }, NOW);
      reserved.open();
      await held.opened;
    });
    await reserved.opened;
    const reconciling = store.reconcile("u-1");
    // Commit the reserve only once reconcile is blocked on the usage row, so a recount from a snapshot taken before
    // the commit would overwrite the reserve's 5 bytes.
    try {
      await untilBlockedBy(holder);
    } finally {
      held.open();
      await reserving;
    }
    expect(await reconciling).toBe(true);
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 15, activeBytes: 0, files: 0 });
  });

  test("reconcile after the usage row was deleted by hand keeps a reserve that created it meanwhile", async () => {
    const { store, transaction } = await transactionalStore(() => pgExecutor(db.pool));
    await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-0", 10)] }, NOW);
    await db.query("DELETE FROM cloudrop_usage");
    const held = gate();
    const reserved = gate();
    let holder: unknown;
    // This reserve finds no usage row, so it inserts one; it stays uncommitted until reconcile waits for it.
    const reserving = transaction(async (tx, inner) => {
      holder = await executors[0]?.backendPid(tx);
      await inner.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", 5)] }, NOW);
      reserved.open();
      await held.opened;
    });
    await reserved.opened;
    const reconciling = store.reconcile("u-1");
    try {
      await untilBlockedBy(holder);
    } finally {
      held.open();
      await reserving;
    }
    // The reserve's new row held only its own 5 bytes: the recount adds f-0's 10 and keeps f-1's 5.
    expect(await reconciling).toBe(true);
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 15, activeBytes: 0, files: 0 });
  });
});
