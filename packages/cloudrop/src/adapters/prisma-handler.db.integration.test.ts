// The handler on a real database (spec M5 §8): cloudrop on the fake R2 with prismaStore on Postgres in transaction
// mode, and a route from store.route whose onComplete writes the app's own row through Prisma's tx. These rows prove
// what the memory store can only simulate: the app's row and the completion commit or roll back together, and two
// overlapping /complete calls run onComplete once.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { untilOneWaits, usePostgresDatabase } from "../testing/db/postgres.ts";
import { openPrismaClient, type PrismaTestClient } from "../testing/db/prisma.ts";
import { rawTables } from "../testing/db/raw-tables.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { hello, TEXT } from "../testing/store-fixture.ts";
import { type PrismaTransactionOptions, prismaStore } from "./prisma.ts";

const db = usePostgresDatabase();
let prisma: PrismaTestClient;
beforeAll(async () => {
  prisma = await openPrismaClient(db);
});
afterAll(() => prisma?.$disconnect());
beforeEach(async () => {
  await db.reset();
  await db.createTables();
  await db.query("CREATE TABLE app_rows (file_id text PRIMARY KEY, run integer NOT NULL)");
});

/** Resolves once some transaction waits on a files row that another holds locked. */
const rowLockWaiter = () =>
  // A transaction waiting for a row lock first takes the row's tuple lock; regclass resolves in this file's schema.
  untilOneWaits(
    db,
    "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'tuple' AND relation = 'cloudrop_files'::regclass",
    [],
    "No /complete ever waited for the files row lock.",
  );

const FAILED = {
  code: "SERVER_ERROR",
  message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
  retryable: true,
};

/** An uploaded file on a route whose onComplete inserts an app row through tx, then runs `after`. */
async function uploaded(
  after: (run: number) => unknown = (run) => ({ run }),
  transactionOptions?: PrismaTransactionOptions,
) {
  const store = prismaStore(prisma, { dialect: "postgres", transaction: true, transactionOptions });
  let runs = 0;
  const files = store.route(
    { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
    {
      owner: ({ userId }) => userId,
      onComplete: async ({ tx, file }) => {
        runs += 1;
        await tx.$executeRawUnsafe("INSERT INTO app_rows (file_id, run) VALUES ($1, $2)", file.id, runs);
        return after(runs);
      },
    },
  );
  const fixture = serverFixture({ files }, { store });
  const ticket = await fixture.single("files", TEXT);
  await fixture.send(ticket.put, hello);
  const state = async () => ({
    file: (await rawTables(db).files()).map(({ status, claim, result }) => ({ status, claim, result })),
    appRows: await db.query("SELECT file_id, run FROM app_rows"),
    usage: await store.usage("u1"),
  });
  return { fixture, ticket, state, runs: () => runs };
}

describe("prismaStore with transaction: true behind the handler", () => {
  test("a completion commits the app's row, the completed file and its usage together", async () => {
    const { fixture, ticket, state } = await uploaded();
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 1 });
    expect(await state()).toEqual({
      file: [{ status: "completed", claim: expect.any(String), result: '{"run":1}' }],
      appRows: [{ file_id: ticket.id, run: 1 }],
      usage: { reservedBytes: 0, activeBytes: 5, files: 1 },
    });
  });

  test("a throw in onComplete rolls back the app's row it wrote and leaves the file pending for the retry", async () => {
    const { fixture, ticket, state } = await uploaded((run) => {
      if (run === 1) throw new Error("The app refused this file.");
      return { run };
    });
    expect((await complete(fixture, ticket.token)).body.error).toEqual(FAILED);
    expect(await state()).toEqual({
      file: [{ status: "pending", claim: null, result: null }],
      appRows: [],
      usage: { reservedBytes: 5, activeBytes: 0, files: 0 },
    });
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 2 });
    expect((await state()).appRows).toEqual([{ file_id: ticket.id, run: 2 }]);
  });

  test("two overlapping /complete calls run onComplete once: the other is busy, and its retry replays", async () => {
    // The first onComplete holds its transaction open until the second /complete waits on the row lock, so the two
    // really overlap on separate pooled connections. The waiting claim's snapshot still shows the row pending once the
    // lock is released, which the store answers as busy (outcomes.ts), never as a second claim.
    const { fixture, ticket, state, runs } = await uploaded(async (run) => {
      await rowLockWaiter();
      return { run };
    });
    const answers = await Promise.all([complete(fixture, ticket.token), complete(fixture, ticket.token)]);
    const busy = {
      code: "SERVER_ERROR",
      message: "Another request is completing this upload. Try again in a moment.",
      retryable: true,
    };
    expect(answers.map(({ body }) => body.data ?? body.error)).toEqual(expect.arrayContaining([{ run: 1 }, busy]));
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 1 });
    expect([runs(), (await state()).appRows]).toEqual([1, [{ file_id: ticket.id, run: 1 }]]);
  });

  test("an onComplete that outlasts transactionOptions.timeout is rolled back and answered as retryable", async () => {
    // About 300 ms: onComplete outlives a 100 ms timeout, after which Prisma rolls the transaction back.
    const { fixture, ticket, state } = await uploaded(
      async (run) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { run };
      },
      { timeout: 100 },
    );
    // The store's complete runs on the transaction Prisma already closed: a store failure, retryable like any.
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "SERVER_ERROR",
      message: "The server could not reach its upload records. Try again in a moment.",
      retryable: true,
    });
    expect(await state()).toEqual({
      file: [{ status: "pending", claim: null, result: null }],
      appRows: [],
      usage: { reservedBytes: 5, activeBytes: 0, files: 0 },
    });
  });
});
