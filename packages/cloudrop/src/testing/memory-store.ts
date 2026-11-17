// An in-memory CloudropStore with the semantics the store contract demands of a database (spec M5 §4), so the handler's
// store paths, its transactional one included, run in the unit lane. Each method runs synchronously between awaits, so
// nothing interleaves inside it, and keeps an undo list so a failure, injected or real, leaves nothing written.

import type { CloudropStore } from "../server/store.ts";
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
  /** The tables, read past the store. */
  readonly raw: RawTables;
  /**
   * Makes the next call of `method` throw once `afterWrites` of its row writes have been made (0: before any). The call
   * then undoes those writes, as a database rolls back a failed statement; later calls run normally.
   */
  injectFailure(method: MemoryWrite, afterWrites: number): void;
  /** The app rows committed through `tx.write`, in order. */
  appRows(): string[];
}

type Undo = () => void;

export function memoryStore(): MemoryStore {
  const tables: MemoryTables = { files: new Map(), usage: new Map() };
  const app: { entry: string }[] = [];
  let fault: { method: string; afterWrites: number } | null = null;

  /**
   * Runs one method as an atomic unit. Its writes are recorded in an undo list: on a throw they are undone; on success
   * they join `journal` when the call runs inside a transaction, so its rollback can undo them too.
   */
  function atomic<T>(method: string, journal: Undo[] | null, body: (write: Write) => T): Promise<T> {
    const armed = fault?.method === method ? fault : null;
    if (armed) fault = null;
    const undo: Undo[] = [];
    const record = <V>(map: Map<string, V>, key: string, value: V) => {
      if (armed && undo.length === armed.afterWrites) {
        throw new Error(`Injected failure in ${method} after ${armed.afterWrites} writes.`);
      }
      const had = map.has(key);
      const before = map.get(key);
      undo.push(() => (had ? map.set(key, before as V) : map.delete(key)));
      // A copy, so a caller that later changes the object or a Date it passed cannot change the stored row.
      map.set(key, structuredClone(value));
    };
    const write: Write = {
      file: (row) => record(tables.files, row.id, row),
      usage: (row) => record(tables.usage, row.owner, row),
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
      // Undoes this transaction's writes key by key, newest first: writes made outside it to other rows survive, as
      // under a database. An outside write to a row the transaction wrote would have waited for its lock instead.
      for (const step of journal.toReversed()) step();
      throw error;
    }
  }

  const sorted = <V>(map: Map<string, V>): V[] =>
    [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => structuredClone(row));

  return {
    ...store,
    transaction,
    raw: {
      files: async (): Promise<RawFileRow[]> => sorted(tables.files),
      usage: async (): Promise<RawUsageRow[]> => sorted(tables.usage),
      putUsage: async (row) => void tables.usage.set(row.owner, structuredClone(row)),
    },
    injectFailure(method, afterWrites) {
      fault = { method, afterWrites };
    },
    appRows: () => app.map((row) => row.entry),
  };
}
