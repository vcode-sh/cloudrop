// sqlStore's construction-time checks: what it refuses before any statement runs. Everything a store does is proven
// by the store contract on real databases (sql.db.integration.test.ts).

import { expect, test } from "vitest";
import { type SqlExecutor, sqlStore } from "./sql.ts";

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
