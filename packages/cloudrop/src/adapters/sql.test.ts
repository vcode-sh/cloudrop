// sqlStore's construction-time checks (what it refuses before any statement runs) and the types of its route().
// Everything a store does is proven by the store contract on real databases (sql.db.integration.test.ts).

import postgres from "postgres";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { CloudropStore } from "../server/store.ts";
import { brandOf, storeOfRoute } from "../server/store-route.ts";
import { type PgQueryable, pgExecutor, postgresJsExecutor, type SqlExecutor, sqliteExecutor, sqlStore } from "./sql.ts";

const executor = (dialect: string): SqlExecutor =>
  ({
    dialect,
    query: async () => [],
    batch: async () => [],
  }) as SqlExecutor;

const NO_SQLITE_SCHEMA = "SQLite has no schemas: remove schema from { tables }.";

const NAME_RULE = 'is not allowed. Use letters, digits and "_", not starting with a digit:';

test.each([
  {
    name: "a quote",
    tables: { files: 'files"; DROP TABLE x; --' },
    message: `The files table name "files\\"; DROP TABLE x; --" ${NAME_RULE} { tables: { files: "..." } }.`,
  },
  {
    name: "a leading digit",
    tables: { usage: "1usage" },
    message: `The usage table name "1usage" ${NAME_RULE} { tables: { usage: "..." } }.`,
  },
  {
    name: "an empty name",
    tables: { files: "" },
    message: `The files table name "" ${NAME_RULE} { tables: { files: "..." } }.`,
  },
])("a table name with $name is refused with INVALID_CONFIG naming the option", ({ tables, message }) => {
  expect(() => sqlStore(executor("postgres"), { tables })).toThrow(
    expect.objectContaining({ code: "INVALID_CONFIG", message }),
  );
});

test("a schema name is checked like a table name", () => {
  expect(() => sqlStore(executor("postgres"), { tables: { schema: "app; DROP SCHEMA public" } })).toThrow(
    expect.objectContaining({
      code: "INVALID_CONFIG",
      message:
        'The schema name "app; DROP SCHEMA public" is not allowed. Use letters, digits and "_", not starting with a digit: { tables: { schema: "..." } }.',
    }),
  );
});

test("a schema is refused on SQLite, which has no schemas", () => {
  // Every SQLite executor (node:sqlite, D1, Drizzle's, Prisma's) reaches this one check through its dialect.
  expect(() => sqlStore(executor("sqlite"), { tables: { schema: "app" } })).toThrow(
    expect.objectContaining({ code: "INVALID_CONFIG", message: NO_SQLITE_SCHEMA }),
  );
});

test("an executor of another dialect is refused with INVALID_CONFIG", () => {
  expect(() => sqlStore(executor("mysql"))).toThrow(
    expect.objectContaining({
      code: "INVALID_CONFIG",
      message: 'The executor\'s dialect "mysql" is not supported. Use "postgres" or "sqlite".',
    }),
  );
});

const NEEDS_POSTGRES =
  "transaction: true needs Postgres. SQLite has one writer at a time, so a transaction held open while onComplete runs would stall every other upload; leave the option out and completions use a lease.";

describe("store.route", () => {
  // Executors over drivers that are never called: building a store and its routes runs no statement.
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({ ...pool, release() {} }) };
  const pgStore = sqlStore(pgExecutor(pool), { transaction: true });
  const postgresJs = postgresJsExecutor(postgres("postgres://127.0.0.1:1/never", { max: 1 }));
  const postgresJsStore = sqlStore(postgresJs, { transaction: true });
  const sqlite = sqliteExecutor({ exec() {}, prepare: () => ({ all: () => [] }) });
  const policy = { accept: "image/*", maxSize: 5_000_000, authorize: () => ({ userId: "u-1" }) };

  test("routes of a transactional store are branded with that store and type tx as the executor's handle", () => {
    const pgRoute = pgStore.route(policy, {
      onComplete: async ({ tx, userId }) => {
        expectTypeOf(tx).toEqualTypeOf<PgQueryable>();
        await tx.query("INSERT INTO photos (owner) VALUES ($1)", [userId]);
      },
    });
    postgresJsStore.route(policy, {
      onComplete: async ({ tx }) => {
        // postgres.js's own transaction type, so tagged templates work on tx.
        expectTypeOf(tx).toEqualTypeOf<postgres.TransactionSql>();
        await tx`SELECT 1`;
      },
    });
    expect(storeOfRoute(pgRoute.definition)).toBe(brandOf(pgStore));
  });

  test("without transaction: true even a Postgres store has no transaction and no route, so completions use a lease", () => {
    const stores = [sqlStore(pgExecutor(pool)), sqlStore(postgresJs, { transaction: false }), sqlStore(sqlite)];
    expect(stores.map((store) => [store.transaction, "route" in store])).toEqual([
      [undefined, false],
      [undefined, false],
      [undefined, false],
    ]);
    expectTypeOf(sqlStore(pgExecutor(pool))).toEqualTypeOf<CloudropStore>();
  });

  test.each([
    { name: "on SQLite", target: sqlite, message: NEEDS_POSTGRES },
    {
      name: "over a Postgres executor without transaction()",
      target: executor("postgres"),
      message:
        "transaction: true needs an executor with transaction(), such as pgExecutor or postgresJsExecutor. Add one to your executor, or leave the option out and completions use a lease.",
    },
  ])("refuses transaction: true $name with INVALID_CONFIG", ({ target, message }) => {
    // @ts-expect-error: only an executor that can hold a transaction takes transaction: true.
    expect(() => sqlStore(target, { transaction: true })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG", message }),
    );
  });
});
