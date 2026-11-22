// An in-memory CloudropStore with the semantics the store contract demands of a database (spec M5 §4), so the handler's
// store paths, its transactional one included, run in the unit lane. Each method runs synchronously between awaits, so
// nothing interleaves inside it, and keeps an undo list so a failure, injected or real, leaves nothing written.

import type { CloudropStore } from "../server/store.ts";
// The published entry, not src/store/define-store.ts: cloudrop/testing imports ./store.js, so the store's code, and
// the CloudropError it raises, are the library's own (tsdown.config.ts).
import { defineStore } from "../store.ts";
import { type MemoryTables, storeMethods, type Write } from "./memory-store-methods.ts";
import type { RawFileRow, RawTables, RawUsageRow } from "./store-rows.ts";

/** The transaction handle the memory store passes to `onComplete`. */
export interface MemoryTx {
  /** The store methods called through the transaction's store, in order. */
  readonly calls: readonly string[];
  /** Writes one app row (an entry of `appRows()`), rolled back with the transaction: an app's own table, through `tx`. */
  write(entry: string): void;
}

/** The writing methods a failure can be injected into. */
export type MemoryWrite =
  | "reserve"
  | "attach"
  | "claim"
  | "release"
  | "complete"
  | "end"
  | "revoke"
  | "cleaned"
  | "reconcile";

export interface MemoryStore extends CloudropStore<MemoryTx> {
  transaction: NonNullable<CloudropStore<MemoryTx>["transaction"]>;
  listAll: NonNullable<CloudropStore<MemoryTx>["listAll"]>;
  /** The tables, read past the store. */
  readonly raw: RawTables;
  /**
   * Makes the next call of `method` throw once `afterWrites` of its row writes have been made (0: before any). The call
   * then undoes those writes, as a database rolls back a failed statement; later calls run normally.
   */
  injectFailure(method: MemoryWrite, afterWrites: number): void;
  /**
   * Makes the next write to the usage table fail, whichever method makes it; the call undoes what it wrote before. The
   * store contract's `injectFailure`, which a SQL lane implements with a one-shot trigger.
   */
  failNextUsageWrite(): void;
  /** The app rows committed through `tx.write`, in order. */
  appRows(): string[];
}

type Undo = () => void;

const COUNTERS = ["reservedBytes", "activeBytes", "files"] as const;

/**
 * Takes back one write to a usage row. A row nothing has rewritten since is restored as it was. A row a call outside
 * the transaction rewrote meanwhile keeps that call's change and loses only this write's: under a database the two
 * would have been ordered by the row's lock, and both of their changes would count.
 */
function undoUsage(usage: Map<string, RawUsageRow>, stored: RawUsageRow, before: RawUsageRow | undefined): void {
  const current = usage.get(stored.owner);
  if (current === stored || current === undefined) {
    if (before) usage.set(stored.owner, before);
    else usage.delete(stored.owner);
    return;
  }
  const taken = { ...current };
  for (const counter of COUNTERS) taken[counter] -= stored[counter] - (before?.[counter] ?? 0);
  usage.set(stored.owner, taken);
}

export function memoryStore(): MemoryStore {
  const tables: MemoryTables = { files: new Map(), usage: new Map() };
  const app: { entry: string }[] = [];
  let fault: { method: string; afterWrites: number } | null = null;
  let usageFault = false;

  /**
   * Runs one method as an atomic unit. Its writes are recorded in an undo list: on a throw they are undone; on success
   * they join `journal` when the call runs inside a transaction, so its rollback can undo them too.
   */
  function atomic<T>(method: string, journal: Undo[] | null, body: (write: Write) => T): Promise<T> {
    const armed = fault?.method === method ? fault : null;
    if (armed) fault = null;
    const undo: Undo[] = [];
    const checkFault = () => {
      if (armed && undo.length === armed.afterWrites) {
        throw new Error(`Injected failure in ${method} after ${armed.afterWrites} writes.`);
      }
    };
    const write: Write = {
      file(row) {
        checkFault();
        const before = tables.files.get(row.id);
        undo.push(() => (before ? tables.files.set(row.id, before) : tables.files.delete(row.id)));
        // A copy, so a caller that later changes the object or a Date it passed cannot change the stored row.
        tables.files.set(row.id, structuredClone(row));
      },
      usage(row) {
        if (usageFault) {
          usageFault = false;
          throw new Error("Injected failure writing the usage table.");
        }
        checkFault();
        const before = tables.usage.get(row.owner);
        const stored = structuredClone(row);
        tables.usage.set(row.owner, stored);
        undo.push(() => undoUsage(tables.usage, stored, before));
      },
    };
    try {
      const result = body(write);
      journal?.push(...undo);
      return Promise.resolve(result);
    } catch (error) {
      for (const step of undo.toReversed()) step();
      return Promise.reject(error);
    }
  }

  const store = storeMethods(tables, (method, body) => atomic(method, null, body));

  async function transaction<T>(
    run: (tx: MemoryTx, store: Omit<CloudropStore<MemoryTx>, "transaction">) => Promise<T>,
  ): Promise<T> {
    const journal: Undo[] = [];
    const calls: string[] = [];
    const tx: MemoryTx = {
      calls,
      write(entry) {
        const row = { entry };
        app.push(row);
        journal.push(() => app.splice(app.indexOf(row), 1));
      },
    };
    const inner = storeMethods(tables, (method, body) => atomic(method, journal, body));
    // A recording view: each method's name, then the method. `get`, `usage` and the other reads are recorded too.
    const recorded = Object.fromEntries(
      Object.entries(inner).map(([name, method]) => [
        name,
        (...args: unknown[]) => {
          calls.push(name);
          return (method as (...args: unknown[]) => unknown)(...args);
        },
      ]),
    ) as typeof inner;
    try {
      return await run(tx, recorded);
    } catch (error) {
      // Undoes this transaction's writes row by row, newest first: writes made outside it to other rows survive, as
      // under a database, and so do outside changes to a usage row it also wrote (undoUsage). An outside write to a
      // files row it wrote would have waited for its lock instead; the rollback overwrites it.
      for (const step of journal.toReversed()) step();
      throw error;
    }
  }

  const sorted = <V>(map: Map<string, V>): V[] =>
    [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => structuredClone(row));

  return defineStore({
    ...store,
    transaction,
    raw: {
      files: async (): Promise<RawFileRow[]> => sorted(tables.files),
      usage: async (): Promise<RawUsageRow[]> => sorted(tables.usage),
      putUsage: async (row) => void tables.usage.set(row.owner, structuredClone(row)),
      deleteUsage: async (owner) => void tables.usage.delete(owner),
    },
    injectFailure(method, afterWrites) {
      fault = { method, afterWrites };
    },
    failNextUsageWrite() {
      usageFault = true;
    },
    appRows: () => app.map((row) => row.entry),
  });
}
