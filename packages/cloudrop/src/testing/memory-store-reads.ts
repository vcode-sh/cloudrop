// The memory store's methods that only read: rows as records, and the keyset pages of `stale`, `list` and `owners`.

import type { CloudropStore, FileRecord, FileStatus } from "../server/store.ts";
import type { MemoryTables } from "./memory-store-methods.ts";
import type { RawFileRow } from "./store-rows.ts";

type ReadMethods = Pick<CloudropStore<never>, "get" | "stale" | "list" | "owners">;

const CLEANUP: ReadonlySet<FileStatus> = new Set(["aborted", "rejected", "failed", "expired", "deleted"]);

export function toRecord(row: RawFileRow): FileRecord {
  const { claim: _claim, updatedAt: _updatedAt, requestKey: _requestKey, ...record } = structuredClone(row);
  return record;
}

/** A keyset page of `rows`, already sorted by `sortKey`: the rows after `cursor`, and the cursor of the next page. */
function page<T>(rows: T[], sortKey: (row: T) => string, cursor: string | null, limit: number) {
  const after = cursor === null ? rows : rows.filter((row) => sortKey(row) > cursor);
  const records = after.slice(0, limit);
  const last = records.at(-1);
  return { records, cursor: after.length > limit && last ? sortKey(last) : null };
}

// Fixed-width milliseconds, so the cursor's string order is the time order (until the year 2286).
const timeKey = (time: Date | null, id: string): string => `${String(time?.getTime() ?? 0).padStart(13, "0")}:${id}`;

/** Newest first: `created_at`, then id, both descending. */
const newestFirst = (a: RawFileRow, b: RawFileRow): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Rows strictly after a `list` cursor, `<milliseconds>:<id>`, in newest-first order. */
function listedAfter(cursor: string): (row: RawFileRow) => boolean {
  const split = cursor.indexOf(":");
  const time = Number(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  return (row) => row.createdAt.getTime() < time || (row.createdAt.getTime() === time && row.id < id);
}

export function readMethods({ files, usage }: MemoryTables): ReadMethods {
  return {
    get: async (id) => {
      const row = files.get(id);
      return row ? toRecord(row) : null;
    },

    stale: async ({ kind, before, claimedBefore, limit, cursor }) => {
      const cutoff = before.getTime();
      const isWork =
        kind === "expire"
          ? (row: RawFileRow) =>
              row.expiresAt.getTime() < cutoff &&
              (row.status === "pending" ||
                (row.status === "completing" && (row.claimedAt?.getTime() ?? 0) < claimedBefore.getTime()))
          : (row: RawFileRow) =>
              CLEANUP.has(row.status) && row.cleanedAt === null && (row.endedAt?.getTime() ?? 0) < cutoff;
      const sortKey = (row: RawFileRow) => timeKey(kind === "expire" ? row.expiresAt : row.endedAt, row.id);
      const rows = [...files.values()].filter(isWork).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
      const found = page(rows, sortKey, cursor, limit);
      return { records: found.records.map(toRecord), cursor: found.cursor };
    },

    list: async ({ owner, status, route, limit, cursor }) => {
      const after = cursor === null ? () => true : listedAfter(cursor);
      const rows = [...files.values()]
        .filter((row) => row.owner === owner && row.status === status && (route === null || row.route === route))
        .filter(after)
        .sort(newestFirst);
      const kept = rows.slice(0, limit);
      const last = kept.at(-1);
      const next = rows.length > limit && last ? `${last.createdAt.getTime()}:${last.id}` : null;
      return { records: kept.map(toRecord), cursor: next };
    },

    owners: async (cursor, limit) => {
      const found = page([...usage.keys()].sort(), (owner) => owner, cursor, limit);
      return { owners: found.records, cursor: found.cursor };
    },
  };
}
