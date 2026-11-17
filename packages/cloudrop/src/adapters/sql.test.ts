// sqlStore's construction-time checks (what it refuses before any statement runs) and the types of its route(). Everything a store does is proven
// by the store contract on real databases (sql.db.integration.test.ts).

import postgres from "postgres";
import { describe, expect, expectTypeOf, test } from "vitest";
import { storeOfRoute } from "../server/route.ts";
import type { CloudropStore } from "../server/store.ts";
import { type PgQueryable, pgExecutor, postgresJsExecutor, type SqlExecutor, sqliteExecutor, sqlStore } from "./sql.ts";

const executor = (dialect: string): SqlExecutor =>
  ({
    dialect,
    query: async () => [],
    batch: async () => [],
  }) as SqlExecutor;

test.each([
  { name: "a quote", tables: { files: 'files"; DROP TABLE x; --' } },
  { name: "a leading digit", tables: { usage: "1usage" } },
  { name: "an empty name", tables: { files: "" } },
])("a table name with $name is refused with INVALID_CONFIG naming the option", ({ tables }) => {
  const option = Object.keys(tables)[0];
  expect(() => sqlStore(executor("postgres"), { tables })).toThrow(
    expect.objectContaining({ code: "INVALID_CONFIG", message: expect.stringContaining(`{ tables: { ${option}`) }),
  );
});

test("an executor of another dialect is refused with INVALID_CONFIG", () => {
  expect(() => sqlStore(executor("mysql"))).toThrow(
    expect.objectContaining({ code: "INVALID_CONFIG", message: expect.stringContaining('"mysql"') }),
  );
});

describe("store.route", () => {
  // Executors over drivers that are never called: building a store and its routes runs no statement.
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({ ...pool, release() {} }) };
  const pgStore = sqlStore(pgExecutor(pool));
  const postgresJsStore = sqlStore(postgresJsExecutor(postgres("postgres://127.0.0.1:1/never", { max: 1 })));
  const sqliteStore = sqlStore(sqliteExecutor({ exec() {}, prepare: () => ({ all: () => [] }) }));
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
    expect(storeOfRoute(pgRoute.definition)).toBe(pgStore);
  });

  test("a store without transactions has no route", () => {
    expect("route" in sqliteStore).toBe(false);
    expectTypeOf(sqliteStore).not.toHaveProperty("route");
    expectTypeOf(sqliteStore).toEqualTypeOf<CloudropStore<never>>();
  });
});
