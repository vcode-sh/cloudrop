// The store contract on Cloudflare D1: `sqlStore(d1Executor(env.DB))` over Wrangler's local D1, the binding a Worker
// gets, reached from Node (src/testing/db/d1.ts). Run it with `scripts/test-wrangler.sh`.

import { beforeEach, describe } from "vitest";
import { useD1Database } from "../testing/db/d1.ts";
import { driverRows } from "../testing/db/driver-rows.ts";
import { sqlStoreTarget } from "../testing/db/sql-target.ts";
import { describeStoreContract } from "../testing/store-contract.ts";
import { d1Executor, sqlStore } from "./sql.ts";

describe("D1", () => {
  const db = useD1Database();
  describeStoreContract(
    "sql adapter, D1",
    sqlStoreTarget(db, (tables) => sqlStore(d1Executor(db.binding), { tables }), {
      transaction:
        "D1 has no interactive transaction: a batch is the only atomic unit, so onComplete cannot share one with the claim.",
      failureInjection:
        "D1 cannot register a user function, so no trigger can fail one usage write and then let the next one through.",
    }),
  );

  describe("d1Executor", () => {
    beforeEach(async () => {
      await db.reset();
      await db.createTables();
    });
    driverRows(() => d1Executor(db.binding));
  });
});
