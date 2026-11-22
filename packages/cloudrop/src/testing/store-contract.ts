// The store contract: one set of cases every CloudropStore runs unchanged (the memory store in the unit lane; every
// adapter and executor on real databases in `test:db`), each reading the result back from the tables themselves.

import { afterEach, beforeEach, describe } from "vitest";
import type { CloudropStore } from "../server/store.ts";
import { atomicityCases } from "./store-contract/atomicity.ts";
import { claimCases } from "./store-contract/claim.ts";
import { endCases } from "./store-contract/end.ts";
import { erasureCases } from "./store-contract/erasure.ts";
import { listCases } from "./store-contract/list.ts";
import { listAllCases } from "./store-contract/list-all.ts";
import { listAllPageCases } from "./store-contract/list-all-pages.ts";
import { listFilterCases } from "./store-contract/list-filters.ts";
import { replaceCases } from "./store-contract/replace.ts";
import { reserveCases } from "./store-contract/reserve.ts";
import { staleCases } from "./store-contract/stale.ts";
import { storeSuite } from "./store-contract/suite.ts";
import { supersedeCases } from "./store-contract/supersede.ts";
import { transactionCases } from "./store-contract/transaction.ts";
import { usageCases } from "./store-contract/usage.ts";
import { checkedStore, checkedTables } from "./store-contract/well-formed.ts";
import type { RawTables } from "./store-rows.ts";

/**
 * A capability some backend lacks; the cases that need it skip there, naming the reason.
 * - "transaction": no interactive transaction (SQLite, D1).
 * - "concurrency": the backend cannot take calls concurrently at all. A backend that only serialises them (one SQLite
 *   connection) should not declare it: its concurrent cases then pass without proving exclusivity (spec §8: stated,
 *   not counted as proof), and still catch `SQLITE_BUSY` or an async driver interleaving two calls.
 * - "failureInjection": no way to make a usage-table write fail (see `StoreTarget.injectFailure`).
 * - "tables": not a SQL table store.
 */
export type StoreGap = "transaction" | "concurrency" | "failureInjection" | "tables";

export interface StoreTarget {
  store: CloudropStore<unknown>;
  /** Reads the tables `store` writes, past the store. */
  raw: RawTables;
  /** Each present entry names what the backend lacks; the cases that need it skip with that reason. */
  gaps: Partial<Record<StoreGap, string>>;
  /**
   * Unless "failureInjection" is a gap: makes the **next write to the usage table** fail, once, whichever method makes
   * it, so the method's unit must roll back the files row it already changed. A SQL lane implements it with a trigger
   * on the usage table whose "armed" state survives the rollback of the failed statement: on Postgres a sequence
   * (`IF nextval('…') = 1 THEN RAISE EXCEPTION`), on SQLite a registered JS function in the trigger's `WHEN`. A trigger
   * that drops itself or clears a flag row does not work: the drop or the write rolls back with the failure. D1 has no
   * user functions, so it declares "failureInjection" as a gap.
   */
  injectFailure?: () => Promise<void>;
  /** Unless "tables" is a gap: stores built with other table options over the same database. */
  tables?: {
    /** A store over tables with custom names, and a reader of those tables. */
    renamed: { store: CloudropStore<unknown>; raw: RawTables };
    /** A store whose files table lacks `column`. */
    missingColumn: { store: CloudropStore<unknown>; table: string; column: string };
    /** A store over tables that were never created; `table` is its files table. */
    missingTable: { store: CloudropStore<unknown>; table: string };
  };
  /** Runs after every case, also a failed one: drop or empty what setup created. */
  teardown(): Promise<void>;
}

/**
 * Connects to the backend before each case. The tables it returns must be empty, so a case sees only its own rows.
 * The transaction cases call the store outside the transaction while it is open, so a pooled backend needs at least
 * two connections.
 */
export type SetupStore = () => Promise<StoreTarget>;

export function describeStoreContract(name: string, setup: SetupStore): void {
  describe(`store contract: ${name}`, () => {
    let target: StoreTarget | undefined;
    const suite = storeSuite(() => {
      if (!target) throw new Error("The store contract's setup did not finish.");
      return target;
    });

    // Every record a case reads, through the store or past it, is checked against the record table (M12-T1).
    beforeEach(async () => {
      const connected = await setup();
      target = { ...connected, store: checkedStore(connected.store), raw: checkedTables(connected.raw) };
    });

    afterEach(async () => {
      const finished = target;
      target = undefined;
      await finished?.teardown();
    });

    // Registered in this order, so every lane log lists the cases the same way.
    reserveCases(suite);
    supersedeCases(suite);
    claimCases(suite);
    endCases(suite);
    staleCases(suite);
    listCases(suite);
    listFilterCases(suite);
    listAllCases(suite);
    listAllPageCases(suite);
    replaceCases(suite);
    usageCases(suite);
    erasureCases(suite);
    atomicityCases(suite);
    transactionCases(suite);
  });
}
