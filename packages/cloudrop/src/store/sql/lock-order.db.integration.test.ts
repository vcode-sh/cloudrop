// Postgres row locks under the store's multi-row statements (M11-R61): a keyed reserve that supersedes an attempt's
// pending rows and a revoke of the same owner lock the same rows, so they must take them in one order, or Postgres
// ends one of them as a deadlock (40P01). And what the store does with a deadlock an app's own transaction causes.

import { drizzle } from "drizzle-orm/node-postgres";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzleStore } from "../../adapters/drizzle.ts";
import { prismaStore } from "../../adapters/prisma.ts";
import { type PostgresJsSql, pgExecutor, postgresJsExecutor, sqlStore } from "../../adapters/sql.ts";
import { untilOneWaits, usePostgresDatabase } from "../../testing/db/postgres.ts";
import { openPrismaClient, type PrismaTestClient } from "../../testing/db/prisma.ts";

const NOW = new Date("2026-11-21T10:20:30.123Z");
const RACES = 300;
const ROWS = 80;

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
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
    expect(await db.query("SELECT status, count(*)::int AS rows FROM cloudrop_files GROUP BY status")).toEqual([
      { status: "aborted", rows: RACES * ROWS * 3 },
    ]);
  }, 180_000);

  test.for([
    { name: "node-postgres", store: () => sqlStore(pgExecutor(db.pool)) },
    { name: "postgres.js", store: () => sqlStore(postgresJsExecutor(sql)) },
    { name: "Drizzle", store: () => drizzleStore(drizzle({ client: db.pool }), { dialect: "postgres" }) },
    { name: "Prisma", store: () => prismaStore(prisma, { dialect: "postgres" }) },
  ])("$name: a revoke that Postgres ends to break a deadlock with an app's transaction runs again", async (row) => {
    // Takes 1 s by design: Postgres looks for a deadlock once a statement has waited for its deadlock_timeout.
    await db.reset();
    await db.createTables();
    const store = row.store();
    await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, requestKey: null, files: files("f", 2) }, NOW);
    const app = await db.pool.connect();
    try {
      // The app's own transaction takes the usage row first, the order no statement of the store uses.
      await app.query("BEGIN");
      const { rows } = await app.query("SELECT pg_backend_pid() AS pid FROM cloudrop_usage FOR UPDATE");
      const revoking = store.revoke("u-1", NOW);
      // The revoke holds the file rows and waits for the usage row; the app now asks for a file row. The revoke has
      // waited longer, so its deadlock check runs first and Postgres ends it (40P01), which lets the app go on.
      await untilOneWaits(
        db,
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))",
        [rows[0]?.pid],
        "The revoke never waited for the app's transaction.",
      );
      await app.query("UPDATE cloudrop_files SET name = 'renamed' WHERE id = 'f-0'");
      await app.query("COMMIT");
      expect(await revoking).toBe(2);
      expect(await store.usage("u-1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
    } finally {
      await app.query("ROLLBACK").catch(() => undefined);
      app.release();
    }
  });
});
