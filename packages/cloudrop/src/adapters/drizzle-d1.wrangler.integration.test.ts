// The store contract on Cloudflare D1 through Drizzle: `drizzleStore(drizzle(env.DB), { dialect: "sqlite" })` over
// Wrangler's local D1, the binding a Worker gets, reached from Node (src/testing/db/d1.ts). Drizzle's D1 driver is
// asynchronous, so the store's batches go through `db.batch`. Run it with `scripts/test-wrangler.sh`.

import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe } from "vitest";
import { useD1Database } from "../testing/db/d1.ts";
import { driverRows } from "../testing/db/driver-rows.ts";
import { sqlStoreTarget } from "../testing/db/sql-target.ts";
import { describeStoreContract } from "../testing/store-contract.ts";
import { drizzleStore } from "./drizzle.ts";

describe("D1 through Drizzle", () => {
  const db = useD1Database();
  describeStoreContract(
    "drizzle, D1",
    sqlStoreTarget(db, (tables) => drizzleStore(drizzle(db.binding), { dialect: "sqlite", tables }), {
      transaction:
        "D1 has no interactive transaction: a batch is the only atomic unit, so onComplete cannot share one with the claim.",
      failureInjection:
        "D1 cannot register a user function, so no trigger can fail one usage write and then let the next one through.",
    }),
  );

  describe("drizzleStore", () => {
    beforeEach(async () => {
      await db.reset();
      await db.createTables();
    });
    driverRows(() => drizzleStore(drizzle(db.binding), { dialect: "sqlite" }));
  });
});
