// The memory store's methods that only read: rows as records, and the keyset pages of `stale`, `list`, `listAll` and
// `owners`, ordered as a database orders them: ids and owners by their bytes.

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

/**
 * The order of two texts by their UTF-8 bytes, which is their order by code point: how every database compares ids and
 * owners. A JavaScript `<` compares UTF-16 units instead, and puts a character past U+FFFF before U+E000 to U+FFFF.
 */
function byBytes(a: string, b: string): number {
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return (a.codePointAt(at) ?? -1) - (b.codePointAt(at) ?? -1);
}

type TimeOf = (row: RawFileRow) => number;

/** Rows by `time`, then by id in byte order, both ascending: the order of every keyset page of rows. */
const ordered =
  (time: TimeOf) =>
  (a: RawFileRow, b: RawFileRow): number =>
    time(a) - time(b) || byBytes(a.id, b.id);

/** Where a row stands against a cursor, `<milliseconds>:<id>`, in that order: negative before it, positive after. */
function against(cursor: string, time: TimeOf): (row: RawFileRow) => number {
  const split = cursor.indexOf(":");
  const last = { time: Number(cursor.slice(0, split)), id: cursor.slice(split + 1) };
  return (row) => time(row) - last.time || byBytes(row.id, last.id);
}

/** The first `limit` of `rows`, already filtered and sorted, and the cursor of the next page or null. */
function page(rows: RawFileRow[], limit: number, time: TimeOf) {
  const last = rows[limit - 1];
  const cursor = rows.length > limit && last ? `${time(last)}:${last.id}` : null;
  return { records: rows.slice(0, limit).map(toRecord), cursor };
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
    const created: TimeOf = (row) => row.createdAt.getTime();
    // Newest first is the same order backwards: `created_at`, then id, both descending.
    const direction = order === "newest" ? -1 : 1;
    const position = cursor === null ? () => direction : against(cursor, created);
    const rows = [...files.values()]
      .filter((row) => (owner === null || row.owner === owner) && (statuses?.includes(row.status) ?? true))
      .filter((row) => (route === null || row.route === route) && matchesFilters(row, name, type))
      .filter((row) => position(row) * direction > 0)
      .sort((a, b) => ordered(created)(a, b) * direction);
    return page(rows, limit, created);
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
      const time: TimeOf = (row) => (kind === "expire" ? row.expiresAt : row.endedAt)?.getTime() ?? 0;
      const position = cursor === null ? () => 1 : against(cursor, time);
      const rows = [...files.values()].filter((row) => isWork(row) && position(row) > 0).sort(ordered(time));
      return page(rows, limit, time);
    },

    list,
    listAll: ({ status, ...rest }) => list({ ...rest, statuses: status === null ? null : [status] }),

    owners: async (cursor, limit) => {
      const after = [...usage.keys()].filter((owner) => cursor === null || byBytes(owner, cursor) > 0).sort(byBytes);
      const last = after[limit - 1];
      return { owners: after.slice(0, limit), cursor: after.length > limit && last !== undefined ? last : null };
    },
  };
}
