// The memory store's methods that only read: rows as records, and the keyset pages of `stale`, `list`, `listAll` and
// `owners`.

import type { CloudropStore, FileRecord, FileStatus } from "../server/store.ts";
import type { MemoryTables } from "./memory-store-methods.ts";
import type { RawFileRow } from "./store-rows.ts";

type Store = CloudropStore<never>;
type ReadMethods = Pick<Store, "get" | "stale" | "list" | "owners"> & Required<Pick<Store, "listAll">>;

/** What `list` and `listAll` read: `owner` null is every owner, `statuses` null every status. */
type Listing = Omit<Parameters<Store["list"]>[0], "owner" | "statuses"> & {
  owner: string | null;
  statuses: readonly FileStatus[] | null;
};

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

/** Rows strictly after a `list` cursor, `<milliseconds>:<id>`, in the listing's order. */
function listedAfter(cursor: string, newest: boolean): (row: RawFileRow) => boolean {
  const split = cursor.indexOf(":");
  const time = Number(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  return (row) => {
    const order = row.createdAt.getTime() - time || (row.id < id ? -1 : row.id > id ? 1 : 0);
    return newest ? order < 0 : order > 0;
  };
}

/** ASCII letters in lower case, every other character as it is: the case folding `list`'s name filter uses. */
const foldAscii = (text: string): string => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/** `list`'s name and type filters; null lets every row through. */
function matchesFilters(row: RawFileRow, name: string | null, type: string | null): boolean {
  if (name !== null && !foldAscii(row.name).includes(foldAscii(name))) return false;
  return type === null || (type.endsWith("/") ? row.type.startsWith(type) : row.type === type);
}

export function readMethods({ files, usage }: MemoryTables): ReadMethods {
  const list = async ({ owner, statuses, route, name, type, order, limit, cursor }: Listing) => {
    const newest = order === "newest";
    const after = cursor === null ? () => true : listedAfter(cursor, newest);
    const rows = [...files.values()]
      .filter((row) => (owner === null || row.owner === owner) && (statuses?.includes(row.status) ?? true))
      .filter((row) => (route === null || row.route === route) && matchesFilters(row, name, type) && after(row))
      .sort(newest ? newestFirst : (a, b) => newestFirst(b, a));
    const kept = rows.slice(0, limit);
    const last = kept.at(-1);
    const next = rows.length > limit && last ? `${last.createdAt.getTime()}:${last.id}` : null;
    return { records: kept.map(toRecord), cursor: next };
  };

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

    list,
    listAll: ({ status, ...rest }) => list({ ...rest, statuses: status === null ? null : [status] }),

    owners: async (cursor, limit) => {
      const found = page([...usage.keys()].sort(), (owner) => owner, cursor, limit);
      return { owners: found.records, cursor: found.cursor };
    },
  };
}
