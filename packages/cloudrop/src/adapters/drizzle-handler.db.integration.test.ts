// The handler on a real database (spec M5 §8): the fake R2, createCloudrop with drizzleStore(…, { transaction: true })
// on Postgres, and a route from store.route whose onComplete writes an app row through Drizzle's tx. Each row is what
// only a real transaction can show: the app row and the completion commit together or not at all, and two completions
// of one file run onComplete once, held apart by Postgres's row lock.

import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle as nodePostgres } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle as postgresJs } from "drizzle-orm/postgres-js";
import pg from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CloudropError } from "../errors.ts";
import { complete } from "../testing/complete-fixture.ts";
import { untilOneWaits, usePostgresDatabase } from "../testing/db/postgres.ts";
import { rawTables } from "../testing/db/raw-tables.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { gate, hello, TEXT } from "../testing/store-fixture.ts";
import { drizzleStore } from "./drizzle.ts";

const appUploads = pgTable("app_uploads", { fileId: text("file_id").primaryKey(), owner: text("owner").notNull() });
const appOwners = pgTable("app_owners", { owner: text("owner").primaryKey(), files: integer("files").notNull() });

const RETRY = "The file was uploaded, but the server could not finish processing it. Try again in a moment.";
const BUSY = "Another request is completing this upload. Try again in a moment.";
const UNREACHABLE = "The server could not reach its upload records. Try again in a moment.";

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
const lockWaiter = () =>
  untilOneWaits(
    db,
    "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name = $1",
    [application],
    "No completion ever waited for the row lock.",
  );

describe.for(drivers)("POST /complete on Postgres through Drizzle ($name), transaction: true", (driver) => {
  beforeEach(async () => {
    await db.reset();
    await db.createTables();
    await db.query("CREATE TABLE app_uploads (file_id text PRIMARY KEY, owner text NOT NULL)");
    await db.query("CREATE TABLE app_owners (owner text PRIMARY KEY, files integer NOT NULL)");
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

  test("an onComplete that swallows a failed tx statement records nothing, and every retry fails the same way", async () => {
    const store = drizzleStore(driver.db(), { dialect: "postgres", transaction: true });
    const files = store.route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onComplete: async ({ tx, userId, file }) => {
          // The app row exists already, so the insert fails and aborts the transaction; catching it undoes nothing.
          await tx
            .insert(appUploads)
            .values({ fileId: file.id, owner: userId })
            .catch(() => undefined);
          return { id: file.id };
        },
      },
    );
    const fixture = serverFixture({ files }, { store });
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, hello);
    await db.query("INSERT INTO app_uploads VALUES ($1, 'someone')", [ticket.id]);
    const failed = { code: "SERVER_ERROR", message: UNREACHABLE, retryable: true };
    // cloudrop's own record of the completion is refused in the aborted transaction, which then rolls back.
    expect([
      (await complete(fixture, ticket.token)).body.error,
      (await complete(fixture, ticket.token)).body.error,
    ]).toEqual([failed, failed]);
    expect((await rawTables(db).files())[0]).toMatchObject({ status: "pending", claim: null, completedAt: null });
    expect(fixture.logger.errors.map(({ message }) => message)).toEqual(
      Array(2).fill(`cloudrop: the store failed to complete file ${ticket.id} on route "files".`),
    );
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

  // onDelete runs before cloudrop locks the file's row and the owner's usage, as onComplete runs before the usage is
  // locked, so both take the app's owner row first. Run after the deletion instead, the two would deadlock here.
  test("onDelete and onComplete writing the same row of the owner take turns, and both commit", async () => {
    const store = drizzleStore(driver.db(), { dialect: "postgres", transaction: true });
    const held = gate();
    let completions = 0;
    const count = (delta: number) => sql`${appOwners.files} + ${delta}`;
    const files = store.route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onComplete: async ({ tx, userId }) => {
          await tx
            .update(appOwners)
            .set({ files: count(1) })
            .where(eq(appOwners.owner, userId));
          completions += 1;
          if (completions === 2) await held.pass();
        },
        onDelete: async ({ tx, owner }) => {
          await tx
            .update(appOwners)
            .set({ files: count(-1) })
            .where(eq(appOwners.owner, owner ?? ""));
        },
      },
    );
    await db.query("INSERT INTO app_owners VALUES ('u1', 0)");
    const fixture = serverFixture({ files }, { store });
    const upload = async () => {
      const ticket = await fixture.single("files", TEXT);
      await fixture.send(ticket.put, hello);
      return ticket;
    };
    const old = await upload();
    expect((await complete(fixture, old.token)).status).toBe(200);
    const next = await upload();
    // The second completion holds the owner's row inside onComplete while the deletion's onDelete waits for it.
    const completing = complete(fixture, next.token);
    await held.arrived;
    const deleting = fixture.cloudrop.api.deleteFile(old.id);
    await lockWaiter();
    held.open();
    expect([(await completing).status, (await deleting).error]).toEqual([200, null]);
    expect(await db.query("SELECT files FROM app_owners")).toEqual([{ files: 1 }]);
    expect(await store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 5, files: 1 });
  });

  // A replacing completion runs onDelete before it records the completion, so it too takes the app's row before the
  // replaced file's. Run after the record, it would hold that file while waiting for the row deleteFile's onDelete holds.
  test("a replacement and a deleteFile of the previous file take turns on the app's row of that file", async () => {
    const store = drizzleStore(driver.db(), { dialect: "postgres", transaction: true });
    const held = gate();
    const avatars = store.route(
      { accept: "*/*", maxSize: "1GB", replace: true, authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onComplete: async ({ tx, userId, file }) => {
          await tx.insert(appUploads).values({ fileId: file.id, owner: userId });
        },
        onDelete: async ({ tx, file, reason }) => {
          await tx.delete(appUploads).where(eq(appUploads.fileId, file.id));
          if (reason === "deleted") await held.pass();
        },
      },
    );
    const fixture = serverFixture({ avatars }, { store });
    const upload = async () => {
      const ticket = await fixture.single("avatars", TEXT);
      await fixture.send(ticket.put, hello);
      return ticket;
    };
    const previous = await upload();
    expect((await complete(fixture, previous.token)).status).toBe(200);
    const next = await upload();
    // deleteFile holds the previous file's app row inside onDelete while the replacement's onDelete waits for it.
    const deleting = fixture.cloudrop.api.deleteFile(previous.id);
    await held.arrived;
    const replacing = complete(fixture, next.token);
    await lockWaiter();
    held.open();
    expect(await deleting).toEqual({ data: { id: previous.id, deleted: true, cleaned: false }, error: null });
    // The replacement found its file deleted by then: it rolls back and asks for a retry, which completes.
    expect((await replacing).body.error).toEqual({ code: "SERVER_ERROR", message: RETRY, retryable: true });
    expect((await complete(fixture, next.token)).status).toBe(200);
    expect(fixture.logger.errors).toEqual([]);
    expect(await db.query("SELECT file_id FROM app_uploads")).toEqual([{ file_id: next.id }]);
    expect(await store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 5, files: 1 });
  });

  test("onDelete's writes through tx commit with the deletion, and a throw rolls them back and keeps the file", async () => {
    const store = drizzleStore(driver.db(), { dialect: "postgres", transaction: true });
    let failing = true;
    const files = store.route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onDelete: async ({ tx, file, owner }) => {
          await tx.insert(appUploads).values({ fileId: file.id, owner: `${owner} deleted` });
          if (failing) throw new Error("the audit service refused");
        },
      },
    );
    const fixture = serverFixture({ files }, { store });
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    const appRows = () => db.query("SELECT file_id, owner FROM app_uploads");
    expect((await fixture.cloudrop.api.deleteFile(ticket.id)).error?.code).toBe("SERVER_ERROR");
    expect([(await rawTables(db).files())[0]?.status, await appRows()]).toEqual(["completed", []]);
    failing = false;
    expect((await fixture.cloudrop.api.deleteFile(ticket.id)).error).toBeNull();
    expect([(await rawTables(db).files())[0]?.status, await appRows()]).toEqual([
      "deleted",
      [{ file_id: ticket.id, owner: "u1 deleted" }],
    ]);
  });

  // The deletion read the upload while unfinished and chose no hook; ending the row after that read deleted the file a
  // completion committed meanwhile (M11-R150). `end` never waits for a pending row's lock, so the read is held here.
  test("a deleteFile that read its file before the completion committed deletes nothing, and the file keeps its onDelete", async () => {
    const store = drizzleStore(driver.db(), { dialect: "postgres", transaction: true });
    const read = gate();
    const transaction = store.transaction.bind(store);
    store.transaction = (run) =>
      transaction((tx, scoped) =>
        run(tx, { ...scoped, get: (id) => scoped.get(id).then((row) => read.pass().then(() => row)) }),
      );
    const files = store.route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onDelete: async ({ tx, file, reason }) => {
          await tx.insert(appUploads).values({ fileId: file.id, owner: reason });
        },
      },
    );
    const fixture = serverFixture({ files }, { store });
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, hello);
    const audit = () => db.query("SELECT file_id, owner FROM app_uploads");
    const { api } = fixture.cloudrop;
    const early = api.deleteFile(ticket.id);
    await read.arrived;
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    read.open();
    expect((await early).error?.code).toBe("NOT_FOUND");
    expect([(await rawTables(db).files())[0]?.status, await audit()]).toEqual(["completed", []]);
    expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, deleted: true, cleaned: false });
    expect(await audit()).toEqual([{ file_id: ticket.id, owner: "deleted" }]);
  });

  // A returned CloudropError refuses (M11-D3): the rollback a throw gets, on a real transaction, with nothing logged.
  test("an onDelete that refuses rolls its writes back, for deleteFile and for a replacement, and answers its error", async () => {
    const store = drizzleStore(driver.db(), { dialect: "postgres", transaction: true });
    const refusal = new CloudropError("FORBIDDEN", "An administrator's file may not be deleted.");
    let refusing = true;
    const files = store.route(
      { accept: "*/*", maxSize: "1GB", replace: true, authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onComplete: async ({ tx, file }) => {
          await tx.insert(appUploads).values({ fileId: file.id, owner: "completed" });
        },
        onDelete: async ({ tx, file }) => {
          await tx
            .insert(appUploads)
            .values({ fileId: file.id, owner: "deleted" })
            .onConflictDoUpdate({
              target: appUploads.fileId,
              set: { owner: "deleted" },
            });
          return refusing ? refusal : undefined;
        },
      },
    );
    const fixture = serverFixture({ files }, { store });
    const upload = async () => {
      const ticket = await fixture.single("files", TEXT);
      await fixture.send(ticket.put, hello);
      return ticket;
    };
    const previous = await upload();
    expect((await complete(fixture, previous.token)).status).toBe(200);
    const next = await upload();
    /** Each file's status, then what the app's row of it says. */
    const state = async () => {
      const rows = await db.query("SELECT file_id, owner FROM app_uploads");
      const app = Object.fromEntries(rows.map((row) => [row.file_id, row.owner]));
      const status = Object.fromEntries((await rawTables(db).files()).map((row) => [row.id, row.status]));
      return [previous, next].map(({ id }) => [status[id], app[id]]);
    };
    expect((await fixture.cloudrop.api.deleteFile(previous.id)).error).toBe(refusal);
    const refused = await complete(fixture, next.token);
    expect([refused.status, refused.body.error]).toEqual([
      403,
      { code: "FORBIDDEN", message: "An administrator's file may not be deleted.", retryable: false },
    ]);
    // Neither hook's write stayed: not onDelete's change of the previous file's row, nor onComplete's row of the next.
    expect(await state()).toEqual([
      ["completed", "completed"],
      ["pending", undefined],
    ]);
    expect(fixture.logger.errors).toEqual([]);
    refusing = false;
    expect((await complete(fixture, next.token)).status).toBe(200);
    expect(await state()).toEqual([
      ["deleted", "deleted"],
      ["completed", "completed"],
    ]);
  });
});
