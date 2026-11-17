// The handler on a real database (spec M5 §8): the fake R2, createCloudrop with drizzleStore(…, { transaction: true })
// on Postgres, and a route from store.route whose onComplete writes an app row through Drizzle's tx. Each row is what
// only a real transaction can show: the app row and the completion commit together or not at all, and two completions
// of one file run onComplete once, held apart by Postgres's row lock.

import { randomBytes } from "node:crypto";
import { drizzle as nodePostgres } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle as postgresJs } from "drizzle-orm/postgres-js";
import pg from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { usePostgresDatabase } from "../testing/db/postgres.ts";
import { rawTables } from "../testing/db/raw-tables.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { gate, hello, TEXT } from "../testing/store-fixture.ts";
import { drizzleStore } from "./drizzle.ts";

const appUploads = pgTable("app_uploads", { fileId: text("file_id").primaryKey(), owner: text("owner").notNull() });

const RETRY = "The file was uploaded, but the server could not finish processing it. Try again in a moment.";
const BUSY = "Another request is completing this upload. Try again in a moment.";

const db = usePostgresDatabase();
// Connections of this file only, so a lock wait can be told apart from other files' on the same server.
const application = `cloudrop-drizzle-${randomBytes(4).toString("hex")}`;
let pool: pg.Pool | undefined;
let client: ReturnType<typeof postgres> | undefined;
beforeAll(() => {
  pool = new pg.Pool({ connectionString: db.url, application_name: application, max: 10 });
  client = postgres(db.url, { max: 10, connection: { application_name: application } });
});
afterAll(async () => {
  await pool?.end();
  await client?.end();
});

const opened = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("The database clients are created in beforeAll.");
  return value;
};
const drivers = [
  { name: "node-postgres", db: () => nodePostgres({ client: opened(pool) }) },
  { name: "postgres.js", db: () => postgresJs({ client: opened(client) }) },
];

/** Resolves once one of this file's connections waits for a lock, as a second claim of a held row does. */
async function lockWaiter(): Promise<void> {
  for (let polls = 0; polls < 400; polls++) {
    const [row] = await db.query(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name = $1",
      [application],
    );
    if (row?.waiting === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("No completion ever waited for the row lock.");
}

describe.for(drivers)("POST /complete on Postgres through Drizzle ($name), transaction: true", (driver) => {
  beforeEach(async () => {
    await db.reset();
    await db.createTables();
    await db.query("CREATE TABLE app_uploads (file_id text PRIMARY KEY, owner text NOT NULL)");
  });

  /** An uploaded file whose route writes an app row through tx, then answers `after(run)`. */
  async function uploaded(after: (run: number) => unknown = (run) => ({ run })) {
    const store = drizzleStore(driver.db(), { dialect: "postgres", transaction: true });
    let runs = 0;
    const files = store.route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onComplete: async ({ tx, userId, file }) => {
          runs += 1;
          await tx.insert(appUploads).values({ fileId: file.id, owner: userId });
          return after(runs);
        },
      },
    );
    const fixture = serverFixture({ files }, { store });
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, hello);
    const appRows = () => db.query("SELECT file_id, owner FROM app_uploads");
    return { fixture, ticket, store, appRows, runs: () => runs };
  }

  test("commits the app row and the completed file together", async () => {
    const { fixture, ticket, store, appRows } = await uploaded();
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 1 });
    expect(await appRows()).toEqual([{ file_id: ticket.id, owner: "u1" }]);
    expect((await rawTables(db).files())[0]).toMatchObject({ status: "completed", result: '{"run":1}' });
    expect(await store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 5, files: 1 });
  });

  test("a throw in onComplete leaves no app row and the file pending, and the retry completes it", async () => {
    const { fixture, ticket, appRows, runs } = await uploaded((run) => {
      if (run === 1) throw new Error("the app's insert failed");
      return { run };
    });
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "SERVER_ERROR",
      message: RETRY,
      retryable: true,
    });
    expect(await appRows()).toEqual([]);
    expect((await rawTables(db).files())[0]).toMatchObject({ status: "pending", claim: null, claimedAt: null });
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 2 });
    expect([runs(), await appRows()]).toEqual([2, [{ file_id: ticket.id, owner: "u1" }]]);
  });

  test("two concurrent completions run onComplete once: the second waits for the row, then answers busy", async () => {
    const held = gate();
    const { fixture, ticket, appRows, runs } = await uploaded(async (run) => {
      await held.pass();
      return { run };
    });
    // The first holds the row inside onComplete until the second is queued behind its lock, then commits.
    const [first, second] = await Promise.all([
      complete(fixture, ticket.token),
      held.arrived.then(async () => {
        const waiting = complete(fixture, ticket.token);
        await lockWaiter();
        held.open();
        return waiting;
      }),
    ]);
    expect(first.body.data).toEqual({ run: 1 });
    expect(second.body.error).toEqual({ code: "SERVER_ERROR", message: BUSY, retryable: true });
    expect([runs(), await appRows()]).toEqual([1, [{ file_id: ticket.id, owner: "u1" }]]);
    // The client's retry then gets the stored answer without running onComplete again.
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 1 });
    expect(runs()).toBe(1);
  });

  test("a completion still waiting for the row after the 2 s lock timeout answers busy", async () => {
    // Takes 2 s by design: the lock timeout is what ends the wait. On postgres.js the transaction it aborted also
    // rejects, and the busy answer must survive that.
    const held = gate();
    const { fixture, ticket, appRows, runs } = await uploaded(async (run) => {
      await held.pass();
      return { run };
    });
    const first = complete(fixture, ticket.token);
    await held.arrived;
    const started = Date.now();
    const second = await complete(fixture, ticket.token).finally(held.open);
    expect(second.body.error).toEqual({ code: "SERVER_ERROR", message: BUSY, retryable: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect((await first).body.data).toEqual({ run: 1 });
    expect([runs(), await appRows()]).toEqual([1, [{ file_id: ticket.id, owner: "u1" }]]);
  });
});
