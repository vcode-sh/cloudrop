// What sqlStore does around its statements, over an executor that fails on purpose: a call Postgres ended to break a
// deadlock runs once more (M11-R61), and a schema check that failed is blamed on the schema only when the database said
// so (M11-R62). The statements themselves are proven on real databases by the store contract.

import { expect, test } from "vitest";
import type { SqlExecutor } from "./executor.ts";
import { sqlStore } from "./store.ts";

/** An executor whose first `failures` statements after the schema check fail with `code`; later ones answer no rows. */
function failingExecutor(failures: number, code: string) {
  const state = { statements: 0 };
  const run = async (sql: string) => {
    if (sql.includes("WHERE 1 = 0")) return [];
    state.statements += 1;
    if (state.statements <= failures) throw Object.assign(new Error("deadlock detected"), { code });
    return [];
  };
  const executor: SqlExecutor = { dialect: "postgres", query: run, batch: async () => [] };
  return { executor, state };
}

test.each([
  { name: "a deadlock", code: "40P01" },
  { name: "a serialization failure", code: "40001" },
])("a call Postgres ended as $name runs once more and answers", async ({ code }) => {
  const { executor, state } = failingExecutor(1, code);
  expect(await sqlStore(executor).usage("u-1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
  expect(state.statements).toBe(2);
});

test("a call that is ended as a deadlock twice throws the second error, and no third attempt is made", async () => {
  const { executor, state } = failingExecutor(2, "40P01");
  await expect(sqlStore(executor).usage("u-1")).rejects.toMatchObject({ code: "40P01" });
  expect(state.statements).toBe(2);
});

test("a call that fails for another reason is not run again", async () => {
  // 57014: the statement was cancelled. Whether it is safe to repeat is the caller's to decide.
  const { executor, state } = failingExecutor(1, "57014");
  await expect(sqlStore(executor).usage("u-1")).rejects.toMatchObject({ code: "57014" });
  expect(state.statements).toBe(1);
});

test("a schema check that fails for a reason that is not the schema throws the driver's error as it is", async () => {
  // Every read of the tables is cancelled, as under a statement timeout, while the database answers `SELECT 1`: a
  // check that took any failure for a missing table would say "The table does not exist".
  const cancelled = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  let overloaded = true;
  const executor: SqlExecutor = {
    dialect: "postgres",
    query: async (sql) => {
      if (overloaded && sql.includes("cloudrop_")) throw cancelled;
      return [];
    },
    batch: async () => [],
  };
  const store = sqlStore(executor);
  await expect(store.get("f-1")).rejects.toBe(cancelled);
  // The failure was not kept: the next call checks the tables again and answers.
  overloaded = false;
  expect(await store.get("f-1")).toBeNull();
});
