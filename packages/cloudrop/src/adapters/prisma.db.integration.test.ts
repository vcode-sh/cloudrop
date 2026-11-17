// prismaStore on real databases through Prisma 7's driver adapters: the store contract on Postgres 18 (PrismaPg, a pool
// of 10, so the concurrent cases race real connections) and on SQLite (PrismaBetterSqlite3 on a fresh file per case).
// Below it, what only Prisma can break: its lock-timeout error, its models reading and writing the store's rows, and a
// migration of the shipped models against the shipped DDL.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { CloudropStore } from "../server/store.ts";
import { usePostgresDatabase } from "../testing/db/postgres.ts";
import { openPrismaClient, type PrismaTestClient, type SqliteFunctionHost } from "../testing/db/prisma.ts";
import { rawTables } from "../testing/db/raw-tables.ts";
import { sqlStoreTarget } from "../testing/db/sql-target.ts";
import { type SqliteTestDatabase, useSqliteDatabase } from "../testing/db/sqlite.ts";
import { describeStoreContract, type SetupStore } from "../testing/store-contract.ts";
import { prismaStore } from "./prisma.ts";

const MAX_SAFE = 9007199254740991; // 2^53 - 1
const SCRATCH = fileURLToPath(new URL("../../../../.superpowers/test-db/", import.meta.url));
const POSTGRES_MODELS = fileURLToPath(new URL("../testing/db/prisma/postgres", import.meta.url));
const NOW = new Date("2026-11-17T10:20:30.123Z");
const LATER = new Date("2026-11-17T10:21:30.456Z");
const file = (id: string, size: number) => ({
  id,
  route: "files",
  key: `users/${id}/ünïcode ../name.bin`,
  name: "name.bin",
  type: "application/octet-stream",
  size,
  metadata: '{"album":"summer"}',
});

/** A promise the test resolves when it is ready, to keep a transaction open until then. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * The models of the shipped snippet read what the store wrote and the store reads what the models wrote. `time` is
 * how the dialect's model holds a time: a Date on Postgres, BigInt milliseconds on SQLite.
 */
function modelRows(
  open: () => Promise<{ prisma: PrismaTestClient; store: CloudropStore }>,
  time: (at: Date) => unknown,
) {
  test("the Prisma models read the rows the store wrote", async () => {
    const { prisma, store } = await open();
    await store.reserve({ owner: "u-1", limit: null, expiresAt: LATER, files: [file("f-1", MAX_SAFE)] }, NOW);
    await store.claim("f-1", "claim-1", NOW, 60_000);
    await store.complete("f-1", "claim-1", '{"id":7}', LATER);
    expect(await prisma.cloudropFile.findUnique({ where: { id: "f-1" } })).toEqual({
      ...file("f-1", 0),
      size: BigInt(MAX_SAFE),
      owner: "u-1",
      status: "completed",
      uploadId: null,
      result: '{"id":7}',
      claim: "claim-1",
      claimedAt: time(NOW),
      expiresAt: time(LATER),
      createdAt: time(NOW),
      updatedAt: time(LATER),
      completedAt: time(LATER),
      endedAt: null,
      cleanedAt: null,
    });
    expect(await prisma.cloudropUsage.findUnique({ where: { owner: "u-1" } })).toEqual({
      owner: "u-1",
      reservedBytes: 0n,
      activeBytes: BigInt(MAX_SAFE),
      files: 1,
      updatedAt: time(LATER),
    });
  });

  test("the store reads a row the Prisma models wrote", async () => {
    const { prisma, store } = await open();
    const { metadata: _metadata, ...fields } = file("f-2", MAX_SAFE);
    await prisma.cloudropFile.create({
      data: {
        ...fields,
        size: BigInt(MAX_SAFE),
        status: "pending",
        expiresAt: time(LATER),
        createdAt: time(NOW),
        updatedAt: time(NOW),
      },
    });
    expect(await store.get("f-2")).toEqual({
      ...fields,
      metadata: null,
      owner: null,
      status: "pending",
      uploadId: null,
      result: null,
      expiresAt: LATER,
      createdAt: NOW,
      claimedAt: null,
      completedAt: null,
      endedAt: null,
      cleanedAt: null,
    });
  });
}

describe("Postgres", () => {
  const db = usePostgresDatabase();
  let prisma: PrismaTestClient;
  beforeAll(async () => {
    prisma = await openPrismaClient(db);
  });
  afterAll(() => prisma?.$disconnect());

  describeStoreContract(
    "prisma, postgres",
    sqlStoreTarget(db, (tables) => prismaStore(prisma, { dialect: "postgres", tables, transaction: true })),
  );

  describe("models", () => {
    modelRows(
      async () => {
        await db.reset();
        await db.createTables();
        return { prisma, store: prismaStore(prisma, { dialect: "postgres" }) };
      },
      (at) => at,
    );
  });

  test("a claim waiting on another transaction's row lock is busy after the 2 s lock timeout", async () => {
    // Takes 2 s by design: the lock timeout is what turns the wait into an answer. Prisma reports it as P2010 with the
    // Postgres code inside, and then commits the transaction the timeout aborted.
    await db.reset();
    await db.createTables();
    const store = prismaStore(prisma, { dialect: "postgres", transaction: true });
    await store.reserve({ owner: "u-1", limit: null, expiresAt: LATER, files: [file("f-1", 1)] }, NOW);
    const held = gate();
    const holder = store.transaction(async (_tx, inner) => {
      expect(await inner.claim("f-1", "claim-a", NOW, 60_000)).toEqual({ kind: "claimed" });
      await held.opened;
    });
    const started = Date.now();
    // The holder is let go however the wait ends, so a failure here leaves no lock behind for the next row.
    const waiting = await store
      .transaction((_tx, inner) => inner.claim("f-1", "claim-b", NOW, 60_000))
      .finally(held.open);
    await holder;
    expect(waiting).toEqual({ kind: "busy" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect((await rawTables(db).files())[0]).toMatchObject({ status: "completing", claim: "claim-a" });
  });

  test("a Prisma migration of the shipped models finds nothing to change in the shipped DDL", async () => {
    // About 2 s: it runs Prisma's CLI, whose schema engine introspects this file's schema and diffs it with the models.
    await db.reset();
    await db.createTables();
    await mkdir(SCRATCH, { recursive: true });
    const folder = await mkdtemp(join(SCRATCH, "prisma-diff-"));
    try {
      const url = new URL(process.env.CLOUDROP_POSTGRES_URL ?? "");
      url.searchParams.set("schema", db.schema);
      // The lane's disposable database; the file is deleted below.
      const config = join(folder, "prisma.config.mjs");
      await writeFile(
        config,
        `export default ${JSON.stringify({ schema: POSTGRES_MODELS, datasource: { url: url.href } })};`,
      );
      const diff = ["migrate", "diff", "--config", config, "--from-config-datasource", "--to-schema", POSTGRES_MODELS];
      const { stdout } = await promisify(execFile)("bunx", ["prisma", ...diff, "--exit-code"]);
      expect(stdout).toContain("No difference detected.");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

/** Arms a one-shot failure on Prisma's own connection, as sql-target.ts does on the fixture's node:sqlite one. */
function armOn(connection: SqliteFunctionHost | undefined): void {
  if (!connection) throw new Error("Prisma has not opened its SQLite connection yet; seed a row before arming.");
  let armed = true;
  connection.function("cloudrop_fail_once", { deterministic: false }, () => {
    const fire = armed;
    armed = false;
    return fire ? 1 : 0;
  });
}

/** The contract's target with a Prisma client per case: SQLite gives each case a new database file. */
function prismaSqliteTarget(db: SqliteTestDatabase): SetupStore {
  return async () => {
    let connection: SqliteFunctionHost | undefined;
    const prisma = await openPrismaClient(db, {
      onSqliteConnection: (opened) => {
        connection = opened;
      },
    });
    try {
      const target = await sqlStoreTarget(db, (tables) => prismaStore(prisma, { dialect: "sqlite", tables }), {
        transaction:
          "Prisma on SQLite has no transaction mode: one writer at a time cannot hold a transaction across onComplete.",
      })();
      return {
        ...target,
        // The fixture creates the triggers; their WHEN calls the function on whichever connection writes, Prisma's.
        injectFailure: async () => {
          await target.injectFailure?.();
          armOn(connection);
        },
        teardown: () => prisma.$disconnect(),
      };
    } catch (error) {
      await prisma.$disconnect();
      throw error;
    }
  };
}

describe("SQLite", () => {
  const db = useSqliteDatabase({ file: true });
  describeStoreContract("prisma, sqlite", prismaSqliteTarget(db));

  describe("models", () => {
    let prisma: PrismaTestClient | undefined;
    beforeEach(async () => {
      await db.createTables();
      return () => prisma?.$disconnect();
    });
    modelRows(
      async () => {
        prisma = await openPrismaClient(db);
        return { prisma, store: prismaStore(prisma, { dialect: "sqlite" }) };
      },
      (at) => BigInt(at.getTime()),
    );
  });
});
