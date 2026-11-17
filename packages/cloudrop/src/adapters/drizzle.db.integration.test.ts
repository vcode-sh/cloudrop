// The store contract through drizzleStore on real databases: node-postgres and postgres.js on Postgres 18 (pools of 10,
// so the concurrent cases race real connections, built with transaction: true so the transaction cases run), and
// better-sqlite3 on a fresh database file per case. Below the contract, the row only a driver's encodings can break.

import Database from "better-sqlite3";
import { drizzle as betterSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as nodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as postgresJs } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { CloudropStore } from "../server/store.ts";
import { usePostgresDatabase } from "../testing/db/postgres.ts";
import { sqlStoreTarget } from "../testing/db/sql-target.ts";
import { useSqliteDatabase } from "../testing/db/sqlite.ts";
import { describeStoreContract, type SetupStore } from "../testing/store-contract.ts";
import { drizzleStore } from "./drizzle.ts";

const MAX_SAFE = 9007199254740991; // 2^53 - 1
const NOW = new Date("2026-11-17T10:20:30.123Z");

/**
 * Drizzle's drivers pass Postgres times through as text and SQLite integers as numbers, so a size at the edge of
 * exactness and a time with milliseconds must come back unchanged.
 */
function encodingRow(storeOver: () => CloudropStore<unknown>) {
  test("a size of 2^53 - 1 and millisecond times come back exactly, counted in usage", async () => {
    const store = storeOver();
    const file = { id: "f-1", route: "files", key: "users/ünïcode ../name.bin", name: "name.bin", metadata: null };
    await store.reserve(
      {
        owner: "u-1",
        limit: null,
        expiresAt: NOW,
        files: [{ ...file, type: "application/octet-stream", size: MAX_SAFE }],
      },
      NOW,
    );
    expect(await store.get("f-1")).toMatchObject({ ...file, size: MAX_SAFE, expiresAt: NOW, createdAt: NOW });
    expect(await store.usage("u-1")).toEqual({ reservedBytes: MAX_SAFE, activeBytes: 0, files: 0 });
  });
}

describe("Postgres", () => {
  const db = usePostgresDatabase();
  // postgres.js gets a client of its own: Drizzle rewrites the client's type parsers.
  let client: ReturnType<typeof postgres> | undefined;
  beforeAll(() => {
    client = postgres(db.url, { max: 10 });
  });
  afterAll(() => client?.end());

  const drivers = [
    { name: "node-postgres", db: () => nodePostgres({ client: db.pool }) },
    {
      name: "postgres.js",
      db: () => {
        if (!client) throw new Error("The postgres.js client is created in beforeAll.");
        return postgresJs({ client });
      },
    },
  ];

  describe.for(drivers)("drizzle, $name", (driver) => {
    describeStoreContract(
      `drizzle, ${driver.name}`,
      sqlStoreTarget(db, (tables) => drizzleStore(driver.db(), { dialect: "postgres", tables, transaction: true })),
    );

    describe("encodings", () => {
      beforeEach(async () => {
        await db.reset();
        await db.createTables();
      });
      encodingRow(() => drizzleStore(driver.db(), { dialect: "postgres" }));
    });
  });
});

describe("SQLite", () => {
  const db = useSqliteDatabase({ file: true });
  // Drizzle has no node:sqlite driver, so the store runs on its own better-sqlite3 connection to the fixture's file.
  let connection: Database.Database | undefined;
  const store = (tables?: { files: string; usage: string }) => {
    connection ??= new Database(db.path ?? ":memory:");
    return drizzleStore(betterSqlite({ client: connection }), { dialect: "sqlite", tables });
  };
  // Registered after the fixture's, so it runs before the fixture deletes the file.
  afterEach(() => {
    connection?.close();
    connection = undefined;
  });

  /**
   * The contract's failure trigger calls a function the fixture registers on its node:sqlite connection; a trigger
   * runs on the connection whose statement fired it, so the same one-shot function is registered on the store's.
   */
  const failingOnTheStoresConnection =
    (setup: SetupStore): SetupStore =>
    async () => {
      const target = await setup();
      return {
        ...target,
        injectFailure: async () => {
          let armed = true;
          connection?.function("cloudrop_fail_once", { deterministic: false }, () => {
            const fire = armed;
            armed = false;
            return fire ? 1 : 0;
          });
          await target.injectFailure?.();
        },
      };
    };

  describeStoreContract(
    "drizzle, better-sqlite3",
    failingOnTheStoresConnection(
      sqlStoreTarget(db, store, {
        transaction:
          "SQLite has a single writer; a transaction held across onComplete's awaits would block every other call.",
      }),
    ),
  );

  describe("encodings", () => {
    beforeEach(() => db.createTables());
    encodingRow(() => store());
  });
});
