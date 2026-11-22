// The memory store's erase-mark writes (M12-O1): the mark lives on the owner's usage row beside the counters, and each
// write runs inside `atomic`, like every other method, so an injected failure leaves nothing written.

import type { StoreErasure } from "../server/store.ts";
import type { Atomic, MemoryTables } from "./memory-store-methods.ts";
import type { RawUsageRow } from "./store-rows.ts";

type Writes = Omit<StoreErasure, "erasing">;

export function erasureMethods(
  { usage }: MemoryTables,
  atomic: Atomic,
  rowOf: (owner: string, now: Date) => RawUsageRow,
): Writes {
  return {
    markErasure: ({ owner, now }) =>
      atomic("markErasure", (write) => {
        const row = rowOf(owner, now);
        if (row.eraseRequestedAt) return { requestedAt: row.eraseRequestedAt, erasedAt: row.erasedAt };
        write.usage({ ...row, eraseRequestedAt: now, erasedAt: null, updatedAt: now });
        return { requestedAt: now, erasedAt: null };
      }),

    erased: ({ owner, requestedAt, now }) =>
      atomic("erased", (write) => {
        const row = usage.get(owner);
        if (row?.eraseRequestedAt?.getTime() !== requestedAt.getTime()) return false;
        if (row.erasedAt === null) write.usage({ ...row, erasedAt: now, updatedAt: now });
        return true;
      }),

    reopen: ({ owner, now }) =>
      atomic("reopen", (write) => {
        const row = usage.get(owner);
        if (!row?.eraseRequestedAt) return false;
        write.usage({ ...row, eraseRequestedAt: null, erasedAt: null, updatedAt: now });
        return true;
      }),
  };
}
