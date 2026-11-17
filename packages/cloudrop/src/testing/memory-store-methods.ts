// The memory store's methods over its two maps, one per table. Each writing method runs inside `atomic`, which records
// every row it writes so a failure can undo them (memory-store.ts).

import type { ClaimOutcome, CloudropStore, FileRecord, FileStatus, OwnerUsage, Transition } from "../server/store.ts";
import type { RawFileRow, RawUsageRow } from "./store-rows.ts";

export interface MemoryTables {
  files: Map<string, RawFileRow>;
  usage: Map<string, RawUsageRow>;
}

export interface Write {
  file(row: RawFileRow): void;
  usage(row: RawUsageRow): void;
}

type Atomic = <T>(method: string, body: (write: Write) => T) => Promise<T>;
type Methods = Omit<CloudropStore<never>, "transaction">;

const ZERO: OwnerUsage = { reservedBytes: 0, activeBytes: 0, files: 0 };
const RESERVING: ReadonlySet<FileStatus> = new Set(["pending", "completing"]);
const CLEANUP: ReadonlySet<FileStatus> = new Set(["aborted", "rejected", "failed", "deleted"]);

function toRecord(row: RawFileRow): FileRecord {
  const { claim: _claim, updatedAt: _updatedAt, ...record } = structuredClone(row);
  return record;
}

/** A keyset page of `rows`, already sorted by `sortKey`: the rows after `cursor`, and the cursor of the next page. */
function page<T>(rows: T[], sortKey: (row: T) => string, cursor: string | null, limit: number) {
  const after = cursor === null ? rows : rows.filter((row) => sortKey(row) > cursor);
  const records = after.slice(0, limit);
  const last = records.at(-1);
  return { records, cursor: after.length > limit && last ? sortKey(last) : null };
}

/** An owner's counters as its rows say they should be. */
function countRows(rows: Iterable<RawFileRow>, owner: string): OwnerUsage {
  const counted = { ...ZERO };
  for (const row of rows) {
    if (row.owner !== owner) continue;
    if (RESERVING.has(row.status)) counted.reservedBytes += row.size;
    if (row.status === "completed") {
      counted.activeBytes += row.size;
      counted.files += 1;
    }
  }
  return counted;
}

// Fixed-width milliseconds, so the cursor's string order is the time order (until the year 2286).
const timeKey = (time: Date | null, id: string): string => `${String(time?.getTime() ?? 0).padStart(13, "0")}:${id}`;

export function storeMethods(tables: MemoryTables, atomic: Atomic): Methods {
  const { files, usage } = tables;
  const countsOf = (owner: string): OwnerUsage => {
    const row = usage.get(owner);
    return row ? { reservedBytes: row.reservedBytes, activeBytes: row.activeBytes, files: row.files } : { ...ZERO };
  };

  /** Adds `delta` to an owner's counters in the same unit as the status change; rows without an owner count nowhere. */
  function adjust(write: Write, owner: string | null, delta: Partial<OwnerUsage>, now: Date): void {
    if (owner === null) return;
    const counts = countsOf(owner);
    write.usage({
      owner,
      reservedBytes: counts.reservedBytes + (delta.reservedBytes ?? 0),
      activeBytes: counts.activeBytes + (delta.activeBytes ?? 0),
      files: counts.files + (delta.files ?? 0),
      updatedAt: now,
    });
  }

  /** What leaving `from` takes off the owner's counters. */
  const releaseFrom = (from: FileStatus, size: number): Partial<OwnerUsage> => {
    if (RESERVING.has(from)) return { reservedBytes: -size };
    return from === "completed" ? { activeBytes: -size, files: -1 } : {};
  };

  const unchanged = (id: string): Transition => {
    const row = files.get(id);
    return { changed: false, record: row ? toRecord(row) : null };
  };

  return {
    reserve: ({ owner, limit, expiresAt, files: accepted }, now) =>
      atomic("reserve", (write) =>
        accepted.map((file) => {
          if (owner !== null && limit !== null) {
            const { reservedBytes, activeBytes } = countsOf(owner);
            if (reservedBytes + activeBytes + file.size > limit) return "over-quota";
          }
          if (files.has(file.id)) throw new Error(`A file row with the id "${file.id}" already exists.`);
          write.file({
            ...file,
            owner,
            status: "pending",
            uploadId: null,
            result: null,
            claim: null,
            claimedAt: null,
            expiresAt,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            endedAt: null,
            cleanedAt: null,
          });
          adjust(write, owner, { reservedBytes: file.size }, now);
          return "reserved";
        }),
      ),

    attach: (id, uploadId, now) =>
      atomic("attach", (write) => {
        const row = files.get(id);
        if (row?.status !== "pending" || (row.uploadId !== null && row.uploadId !== uploadId)) return false;
        write.file({ ...row, uploadId, updatedAt: now });
        return true;
      }),

    get: async (id) => {
      const row = files.get(id);
      return row ? toRecord(row) : null;
    },

    claim: (id, claim, now, leaseMs) =>
      atomic("claim", (write): ClaimOutcome => {
        const row = files.get(id);
        if (!row) return { kind: "missing" };
        if (row.status === "completed") return { kind: "completed", record: toRecord(row) };
        const leaseOver = (row.claimedAt?.getTime() ?? 0) < now.getTime() - leaseMs;
        if (row.status === "pending" || (row.status === "completing" && leaseOver)) {
          write.file({ ...row, status: "completing", claim, claimedAt: now, updatedAt: now });
          return { kind: "claimed" };
        }
        return row.status === "completing" ? { kind: "busy" } : { kind: "ended", record: toRecord(row) };
      }),

    release: (id, claim, now) =>
      atomic("release", (write) => {
        const row = files.get(id);
        if (row?.status !== "completing" || row.claim !== claim) return false;
        write.file({ ...row, status: "pending", claim: null, claimedAt: null, updatedAt: now });
        return true;
      }),

    complete: (id, claim, result, now) =>
      atomic("complete", (write): Transition => {
        const row = files.get(id);
        if (row?.status !== "completing" || row.claim !== claim) return unchanged(id);
        const done: RawFileRow = { ...row, status: "completed", result, completedAt: now, updatedAt: now };
        write.file(done);
        adjust(write, row.owner, { reservedBytes: -row.size, activeBytes: row.size, files: 1 }, now);
        return { changed: true, record: toRecord(done) };
      }),

    end: (id, from, to, now, options) =>
      atomic("end", (write): Transition => {
        const row = files.get(id);
        if (row?.status !== from) return unchanged(id);
        const cleanedAt = options?.cleaned ? now : row.cleanedAt;
        const ended: RawFileRow = { ...row, status: to, endedAt: now, cleanedAt, updatedAt: now };
        write.file(ended);
        adjust(write, row.owner, releaseFrom(from, row.size), now);
        return { changed: true, record: toRecord(ended) };
      }),

    revoke: (owner, now) =>
      atomic("revoke", (write) => {
        const revoked = [...files.values()].filter((row) => row.owner === owner && row.status === "pending");
        for (const row of revoked) {
          write.file({ ...row, status: "aborted", endedAt: now, updatedAt: now });
          adjust(write, owner, { reservedBytes: -row.size }, now);
        }
        return revoked.length;
      }),

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

    cleaned: (id, now) =>
      atomic("cleaned", (write) => {
        const row = files.get(id);
        if (row && row.cleanedAt === null) write.file({ ...row, cleanedAt: now, updatedAt: now });
      }),

    usage: async (owner) => countsOf(owner),

    reconcile: (owner) =>
      atomic("reconcile", (write) => {
        const counted = countRows(files.values(), owner);
        const current = countsOf(owner);
        const same = (Object.keys(ZERO) as (keyof OwnerUsage)[]).every((name) => counted[name] === current[name]);
        // The interface passes no time, so the store's own clock stamps the row (fake timers move it in tests).
        if (!same) write.usage({ owner, ...counted, updatedAt: new Date() });
        return !same;
      }),

    owners: async (cursor, limit) => {
      const found = page([...usage.keys()].sort(), (owner) => owner, cursor, limit);
      return { owners: found.records, cursor: found.cursor };
    },
  };
}
