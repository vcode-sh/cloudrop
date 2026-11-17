// The store contract through drizzleStore on real databases: node-postgres and postgres.js on Postgres 18 (pools of 10,
// so the concurrent cases race real connections, built with transaction: true so the transaction cases run), and
// better-sqlite3 and libsql on a fresh database file per case. Below each contract, the shared driver rows.

import { type Client, createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { drizzle as betterSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as libsql } from "drizzle-orm/libsql";
import { drizzle as nodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as postgresJs } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";
import { driverRows } from "../testing/db/driver-rows.ts";
import { usePostgresDatabase } from "../testing/db/postgres.ts";
import { sqlStoreTarget } from "../testing/db/sql-target.ts";
import { useSqliteDatabase } from "../testing/db/sqlite.ts";
import { describeStoreContract, type SetupStore } from "../testing/store-contract.ts";
import { drizzleStore } from "./drizzle.ts";

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

    describe("driver", () => {
      beforeEach(async () => {
        await db.reset();
        await db.createTables();
      });
      driverRows(() => drizzleStore(driver.db(), { dialect: "postgres" }));
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

  describe("driver", () => {
    beforeEach(() => db.createTables());
    driverRows(() => store());
  });
});

describe("libsql", () => {
  const db = useSqliteDatabase({ file: true });
  // A local file database through @libsql/client, the client Turso apps use; its batch is atomic.
  let client: Client | undefined;
  /** Runs once after the first statement or batch that fails, then forgets itself; set by injectFailure. */
  let afterFailure: (() => Promise<void>) | undefined;
  /** The client, with every failed batch or statement reported to `afterFailure` before it rejects. */
  const watched = (inner: Client): Client =>
    new Proxy(inner, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "batch" && property !== "execute")
          return typeof value === "function" ? value.bind(target) : value;
        return async (...args: unknown[]) => {
          try {
            return await value.apply(target, args);
          } catch (error) {
            const disarm = afterFailure;
            afterFailure = undefined;
            await disarm?.();
            throw error;
          }
        };
      },
    });
  const store = (tables?: { files: string; usage: string }) => {
    client ??= watched(createClient({ url: `file:${db.path}` }));
    return drizzleStore(libsql({ client }), { dialect: "sqlite", tables });
  };
  // Registered after the fixture's, so it runs before the fixture deletes the file.
  afterEach(() => {
    client?.close();
    client = undefined;
    afterFailure = undefined;
  });

  /**
   * libsql cannot register a JS function, so the one-shot state lives outside the database: a trigger on the usage
   * table that always fails, dropped (through the fixture's connection) right after the first write it failed. The
   * failed batch rolls back first, as SQLite ends it before the client rejects.
   */
  const failingOnce =
    (setup: SetupStore): SetupStore =>
    async () => {
      const target = await setup();
      return {
        ...target,
        injectFailure: async () => {
          for (const event of ["INSERT", "UPDATE"]) {
            await db.query(`CREATE TRIGGER cloudrop_fail_libsql_${event.toLowerCase()} BEFORE ${event} ON cloudrop_usage
              BEGIN SELECT RAISE(ABORT, 'Injected failure: the usage table refused this write.'); END`);
          }
          afterFailure = async () => {
            await db.query("DROP TRIGGER cloudrop_fail_libsql_insert");
            await db.query("DROP TRIGGER cloudrop_fail_libsql_update");
          };
        },
      };
    };

  describeStoreContract(
    "drizzle, libsql",
    failingOnce(
      sqlStoreTarget(db, store, {
        transaction:
          "libsql's batch is not interactive; a transaction held across onComplete would block every writer.",
      }),
    ),
  );

  describe("driver", () => {
    beforeEach(() => db.createTables());
    driverRows(() => store());
  });
});
