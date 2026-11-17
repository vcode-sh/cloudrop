// The store contract: one set of cases every CloudropStore runs unchanged (the memory store in the unit lane; every
// adapter and executor on real databases in `test:db`), each reading the result back from the tables themselves.

import { afterEach, beforeEach, describe } from "vitest";
import type { CloudropStore } from "../server/store.ts";
import { claimCases } from "./store-contract/claim.ts";
import { endCases } from "./store-contract/end.ts";
import { reserveCases } from "./store-contract/reserve.ts";
import { staleCases } from "./store-contract/stale.ts";
import { storeSuite } from "./store-contract/suite.ts";
import { transactionCases } from "./store-contract/transaction.ts";
import { usageCases } from "./store-contract/usage.ts";
import type { RawTables } from "./store-rows.ts";

/**
 * A capability some backend lacks; the cases that need it skip there, naming the reason. "transaction": no interactive
 * transaction (SQLite, D1). "concurrency": one connection runs one call at a time (SQLite), so the concurrent cases run
 * but prove nothing. "failureInjection": no way to fail a call halfway. "tables": not a SQL table store.
 */
export type StoreGap = "transaction" | "concurrency" | "failureInjection" | "tables";

export interface StoreTarget {
  store: CloudropStore<unknown>;
  /** Reads the tables `store` writes, past the store. */
  raw: RawTables;
  /** Each present entry names what the backend lacks; the cases that need it skip with that reason. */
  gaps: Partial<Record<StoreGap, string>>;
  /** Unless "failureInjection" is a gap: makes the next call of `method` throw after `afterWrites` row writes. */
  injectFailure?: (method: "reserve" | "complete", afterWrites: number) => void;
  /** Unless "tables" is a gap: stores built with other table options over the same database. */
  tables?: {
    /** A store over tables with custom names, and a reader of those tables. */
    renamed: { store: CloudropStore<unknown>; raw: RawTables };
    /** A store whose files table lacks `column`. */
    missingColumn: { store: CloudropStore<unknown>; table: string; column: string };
  };
  /** Runs after every case, also a failed one: drop or empty what setup created. */
  teardown(): Promise<void>;
}

/** Connects to the backend before each case. The tables it returns must be empty, so a case sees only its own rows. */
export type SetupStore = () => Promise<StoreTarget>;

export function describeStoreContract(name: string, setup: SetupStore): void {
  describe(`store contract: ${name}`, () => {
    let target: StoreTarget | undefined;
    const suite = storeSuite(() => {
      if (!target) throw new Error("The store contract's setup did not finish.");
      return target;
    });

    beforeEach(async () => {
      target = await setup();
    });

    afterEach(async () => {
      const finished = target;
      target = undefined;
      await finished?.teardown();
    });

    // Registered in this order, so every lane log lists the cases the same way.
    reserveCases(suite);
    claimCases(suite);
    endCases(suite);
    staleCases(suite);
    usageCases(suite);
    transactionCases(suite);
  });
}
