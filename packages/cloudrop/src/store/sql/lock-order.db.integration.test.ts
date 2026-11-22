// Postgres row locks under the store's multi-row statements (M11-R61): a keyed reserve that supersedes an attempt's
// pending rows and a revoke of the same owner lock the same rows, so they must take them in one order, or Postgres
// ends one of them as a deadlock (40P01). A revoke beside completions in a transaction never waits for a row while it
// holds another (M11-R240). And what the store does with a deadlock an app's own transaction causes.

import { drizzle } from "drizzle-orm/node-postgres";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { drizzleStore } from "../../adapters/drizzle.ts";
import { prismaStore } from "../../adapters/prisma.ts";
import type { PgQueryable } from "../../adapters/sql/pg.ts";
import { type PostgresJsSql, pgExecutor, postgresJsExecutor, sqlStore } from "../../adapters/sql.ts";
import type { CloudropStore } from "../../server/store.ts";
import { type PostgresTestDatabase, untilOneWaits, usePostgresDatabase } from "../../testing/db/postgres.ts";
import { openPrismaClient, type PrismaTestClient } from "../../testing/db/prisma.ts";
import type { TransactionalSqlExecutor } from "./executor.ts";

const NOW = new Date("2026-11-21T10:20:30.123Z");
const RACES = 300;
const ROWS = 80;
const MIXED_RACES = 1000;

/** The executor, noting the code of every error a statement, a batch or a transaction of it ends with. */
function noting(executor: TransactionalSqlExecutor<PgQueryable>, codes: unknown[]): typeof executor {
  const note = <T>(running: Promise<T>) =>
    running.catch((error: { code?: unknown }) => {
      codes.push(error.code);
      throw error;
    });
  return {
    dialect: executor.dialect,
    query: (sql, params) => note(executor.query(sql, params)),
    batch: (statements) => note(executor.batch(statements)),
    transaction: (run) => note(executor.transaction(run)),
  };
}

const files = (prefix: string, rows = ROWS) =>
  Array.from({ length: rows }, (_, index) => ({
    id: `${prefix}-${index}`,
    route: "files",
    key: `users/u-1/${prefix}-${index}.bin`,
    name: `${index}.bin`,
    type: "application/octet-stream",
    size: 1,
    metadata: null,
  }));

/** A store built with `transaction: true`, whatever its adapter hands a callback as `tx`. */
type TransactionalStore = CloudropStore<unknown> & Required<Pick<CloudropStore<unknown>, "transaction">>;

const BLOCKED_BY = "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))";

/**
 * Runs `call` into a deadlock with an app's own transaction, which takes the usage row first, the order no statement
 * of the store uses, and then asks for file f-0, which `call` holds by then. `call` has waited longer, so its deadlock
 * check runs first and Postgres ends it (40P01), which lets the app go on. Answers what `call` answers in the end.
 */
async function deadlockedWithApp<T>(db: PostgresTestDatabase, call: () => Promise<T>): Promise<T> {
  const app = await db.pool.connect();
  try {
    await app.query("BEGIN");
    const { rows } = await app.query("SELECT pg_backend_pid() AS pid FROM cloudrop_usage FOR UPDATE");
    const calling = call();
    await untilOneWaits(db, BLOCKED_BY, [rows[0]?.pid], "The call never waited for the app's transaction.");
    await app.query("UPDATE cloudrop_files SET name = 'renamed' WHERE id = 'f-0'");
    await app.query("COMMIT");
    return await calling;
  } finally {
    await app.query("ROLLBACK").catch(() => undefined);
    app.release();
  }
}

describe("Postgres lock order", () => {
  const db = usePostgresDatabase();
  let sql: PostgresJsSql & { end(): Promise<void> };
  let prisma: PrismaTestClient;
  beforeAll(async () => {
    sql = postgres(db.url, { max: 2 });
    prisma = await openPrismaClient(db);
  });
  afterAll(async () => {
    await sql?.end();
    await prisma?.$disconnect();
  });

  // 300 races of three statements over the same 80 rows. Before the fix half of them deadlocked, each costing
  // Postgres's 1 s deadlock_timeout, which is why the limit is wide.
  test("two keyed reserves that supersede 80 pending rows and a revoke of their owner never deadlock", async () => {
    await db.reset();
    await db.createTables();
    const store = sqlStore(pgExecutor(db.pool));
    const reserve = (round: number, attempt: string) =>
      store.reserve(
        {
          owner: "u-1",
          limit: null,
          expiresAt: NOW,
          requestKey: `request-key-${round}`,
          files: files(`${attempt}-${round}`),
        },
        NOW,
      );
    const failed: unknown[] = [];
    for (let round = 0; round < RACES; round++) {
      await reserve(round, "lost");
      const race = await Promise.allSettled([
        reserve(round, "retry"),
        reserve(round, "again"),
        store.revoke("u-1", NOW),
      ]);
      failed.push(...race.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason.code] : [])));
      // Whatever the race left pending (a retry's rows, when the revoke ran before it) ends here, so every round
      // races over exactly the lost attempt's 80 rows.
      await store.revoke("u-1", NOW);
    }
    expect(failed).toEqual([]);
    // Every row ended, and each statement moved the usage with its rows.
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0, erasure: null });
    expect(await db.query("SELECT status, count(*)::int AS rows FROM cloudrop_files GROUP BY status")).toEqual([
      { status: "aborted", rows: RACES * ROWS * 3 },
    ]);
  }, 180_000);

  // Transaction mode on a replacing route (M11-R240), 1,000 races in under 3 s. Before the fix a revoke that waited
  // for one completion's row kept the lock of the row it then passed over, and the other completion wanted that row
  // as one to replace: 38 of 600 races ended one of the three with 40P01, each after the 1 s deadlock_timeout.
  test("two replacing completions in a transaction and a revoke of their owner never deadlock", async () => {
    await db.reset();
    await db.createTables();
    const ended: unknown[] = [];
    const store = sqlStore(noting(pgExecutor(db.pool), ended), { transaction: true });
    const complete = (id: string) =>
      store.transaction(async (tx, inner) => {
        const claimed = await inner.claim(id, `claim-${id}`, NOW, 60_000);
        if (claimed.kind !== "claimed") return;
        // onComplete's own statement, through tx.
        await tx.query("SELECT 1");
        await inner.complete(id, `claim-${id}`, null, NOW, { replace: true });
      });
    const failed: unknown[] = [];
    for (let round = 0; round < MIXED_RACES; round++) {
      const input = { owner: "u-1", limit: null, expiresAt: NOW, requestKey: null, files: files(`r${round}`, 2) };
      await store.reserve(input, NOW);
      const race = await Promise.allSettled([
        complete(`r${round}-0`),
        complete(`r${round}-1`),
        store.revoke("u-1", NOW),
      ]);
      failed.push(...race.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason.code] : [])));
    }
    // No call failed, and Postgres ended no statement that the store then ran again.
    expect(failed).toEqual([]);
    expect(ended).toEqual([]);
    // Each row was completed, replaced or revoked, and each of the three moved the usage with its rows.
    expect(
      await db.query(
        "SELECT count(*)::int AS rows FROM cloudrop_files WHERE status NOT IN ('completed', 'deleted', 'aborted')",
      ),
    ).toEqual([{ rows: 0 }]);
    expect(await store.reconcile("u-1")).toBe(false);
  }, 180_000);

  test("a revoke waits for a completion in a transaction, and ends its row when the completion rolls back", async () => {
    await db.reset();
    await db.createTables();
    const store = sqlStore(pgExecutor(db.pool), { transaction: true });
    await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, requestKey: null, files: files("f", 2) }, NOW);
    let failOnComplete = () => {};
    const claimed = new Promise<unknown>((resolve) => {
      void store
        .transaction(async (tx, inner) => {
          await inner.claim("f-0", "claim-a", NOW, 60_000);
          resolve((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
          await new Promise((_, reject) => {
            failOnComplete = () => reject(new Error("onComplete failed"));
          });
        })
        .catch(() => undefined);
    });
    // Once the completion holds f-0: a revoke sent before could end both rows first and wait for nothing.
    const pid = await claimed;
    const revoking = store.revoke("u-1", NOW);
    try {
      await untilOneWaits(db, BLOCKED_BY, [pid], "The revoke never waited for the completion.");
      // The file nobody held is ended already; the sign-out waits only for the one being completed.
      expect((await store.get("f-1"))?.status).toBe("aborted");
    } finally {
      failOnComplete();
    }
    expect(await revoking).toBe(2);
    expect((await store.get("f-0"))?.status).toBe("aborted");
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0, erasure: null });
  });

  // Each row takes 1 s by design: Postgres looks for a deadlock once a statement has waited for its deadlock_timeout.
  describe.for<{ name: string; store: () => TransactionalStore }>([
    { name: "node-postgres", store: () => sqlStore(pgExecutor(db.pool), { transaction: true }) },
    { name: "postgres.js", store: () => sqlStore(postgresJsExecutor(sql), { transaction: true }) },
    {
      name: "Drizzle",
      store: () => drizzleStore(drizzle({ client: db.pool }), { dialect: "postgres", transaction: true }),
    },
    { name: "Prisma", store: () => prismaStore(prisma, { dialect: "postgres", transaction: true }) },
  ])("$name: a call that Postgres ends to break a deadlock with an app's transaction runs again", (row) => {
    let store: TransactionalStore;
    beforeEach(async () => {
      await db.reset();
      await db.createTables();
      store = row.store();
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, requestKey: null, files: files("f", 2) }, NOW);
    });

    test("a revoke", async () => {
      // The revoke holds the file rows and waits for the usage row.
      expect(await deadlockedWithApp(db, () => store.revoke("u-1", NOW))).toBe(2);
      expect(await store.usage("u-1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0, erasure: null });
    });

    test("a completion in a transaction, from its claim", async () => {
      let runs = 0;
      const completing = () =>
        store.transaction(async (_tx, inner) => {
          runs += 1;
          // Holds the file row from here, then waits for the usage row to count the completion.
          await inner.claim("f-0", "claim-a", NOW, 60_000);
          return (await inner.complete("f-0", "claim-a", null, NOW)).changed;
        });
      expect(await deadlockedWithApp(db, completing)).toBe(true);
      expect(runs).toBe(2);
      expect(await store.usage("u-1")).toEqual({ reservedBytes: 1, activeBytes: 1, files: 1, erasure: null });
    });
  });
});
