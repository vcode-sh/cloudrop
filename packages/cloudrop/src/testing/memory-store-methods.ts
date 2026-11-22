// The memory store's methods over its two maps, one per table. Each writing method runs inside `atomic`, which records
// every row it writes so a failure can undo them (memory-store.ts).

import type {
  ClaimOutcome,
  CloudropStore,
  Completion,
  FileRecordStatus,
  OwnerUsage,
  ReserveOutcome,
  Transition,
} from "../server/store.ts";
import { erasureMethods } from "./memory-store-erasure.ts";
import { readMethods, toRecord } from "./memory-store-reads.ts";
import type { RawFileRow, RawUsageRow } from "./store-rows.ts";

export interface MemoryTables {
  files: Map<string, RawFileRow>;
  usage: Map<string, RawUsageRow>;
}

export interface Write {
  file(row: RawFileRow): void;
  usage(row: RawUsageRow): void;
}

export type Atomic = <T>(method: string, body: (write: Write) => T) => Promise<T>;
type Methods = Omit<CloudropStore<never>, "transaction"> & Required<Pick<CloudropStore<never>, "listAll">>;

/** The counters alone, without the erase mark. */
type Counters = Omit<OwnerUsage, "erasure">;

const ZERO: Counters = { reservedBytes: 0, activeBytes: 0, files: 0 };
const RESERVING: ReadonlySet<FileRecordStatus> = new Set(["pending", "completing"]);

/** An owner's counters as its rows say they should be. */
function countRows(rows: Iterable<RawFileRow>, owner: string): Counters {
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

export function storeMethods(tables: MemoryTables, atomic: Atomic): Methods {
  const { files, usage } = tables;
  /** The owner's usage row, or the zero row with no mark that stands for a missing one. */
  const rowOf = (owner: string, now: Date): RawUsageRow =>
    usage.get(owner) ?? { owner, ...ZERO, eraseRequestedAt: null, erasedAt: null, updatedAt: now };
  const countsOf = (owner: string): Counters => {
    const { reservedBytes, activeBytes, files } = rowOf(owner, new Date(0));
    return { reservedBytes, activeBytes, files };
  };

  /** Adds `delta` to an owner's counters in the same unit as the status change; rows without an owner count nowhere. */
  function adjust(write: Write, owner: string | null, delta: Partial<Counters>, now: Date): void {
    // Nothing to move (an owner-less row, or leaving an ended status): the usage row is not written at all.
    if (owner === null || Object.keys(delta).length === 0) return;
    const counts = countsOf(owner);
    write.usage({
      ...rowOf(owner, now),
      reservedBytes: counts.reservedBytes + (delta.reservedBytes ?? 0),
      activeBytes: counts.activeBytes + (delta.activeBytes ?? 0),
      files: counts.files + (delta.files ?? 0),
      updatedAt: now,
    });
  }

  /** What leaving `from` takes off the owner's counters. */
  const releaseFrom = (from: FileRecordStatus, size: number): Partial<Counters> => {
    if (RESERVING.has(from)) return { reservedBytes: -size };
    return from === "completed" ? { activeBytes: -size, files: -1 } : {};
  };

  const unchanged = (id: string): Transition => {
    const row = files.get(id);
    return { changed: false, record: row ? toRecord(row) : null };
  };

  return {
    ...readMethods(tables),
    ...erasureMethods(tables, atomic, rowOf),
    reserve: ({ owner, limit, expiresAt, requestKey, files: accepted }, now) =>
      atomic("reserve", (write): ReserveOutcome[] => {
        if (accepted.length === 0) return [];
        // An owner being erased gets nothing written, not even the superseding of an earlier attempt (M12-O2).
        if (owner !== null && usage.get(owner)?.eraseRequestedAt) return accepted.map(() => "erased");
        // A retry of a request whose answer was lost: its earlier attempt's pending rows end first, freeing their
        // bytes.
        const routes = new Set(accepted.map((file) => file.route));
        const superseded =
          requestKey === null
            ? []
            : [...files.values()].filter(
                (row) =>
                  row.requestKey === requestKey &&
                  row.owner === owner &&
                  routes.has(row.route) &&
                  row.status === "pending",
              );
        for (const row of superseded) {
          write.file({ ...row, status: "aborted", endedAt: now, updatedAt: now });
          adjust(write, owner, { reservedBytes: -row.size }, now);
        }
        return accepted.map((file) => {
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
            requestKey,
          });
          adjust(write, owner, { reservedBytes: file.size }, now);
          return "reserved";
        });
      }),

    attach: (id, uploadId, now) =>
      atomic("attach", (write) => {
        const row = files.get(id);
        if (row?.status !== "pending" || (row.uploadId !== null && row.uploadId !== uploadId)) return false;
        write.file({ ...row, uploadId, updatedAt: now });
        return true;
      }),

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

    complete: (id, claim, result, now, options) =>
      atomic("complete", (write): Completion => {
        const row = files.get(id);
        if (row?.status !== "completing" || row.claim !== claim) return { ...unchanged(id), replaced: [] };
        const replaced =
          options?.replace && row.owner !== null
            ? [...files.values()].filter(
                (other) =>
                  other.owner === row.owner &&
                  other.route === row.route &&
                  other.status === "completed" &&
                  other.id !== id,
              )
            : [];
        const deleted = replaced.map(
          (other): RawFileRow => ({ ...other, status: "deleted", endedAt: now, updatedAt: now }),
        );
        for (const other of deleted) write.file(other);
        const done: RawFileRow = { ...row, status: "completed", result, completedAt: now, updatedAt: now };
        write.file(done);
        const freed = replaced.reduce((sum, other) => sum + other.size, 0);
        const delta = { reservedBytes: -row.size, activeBytes: row.size - freed, files: 1 - replaced.length };
        adjust(write, row.owner, delta, now);
        return { changed: true, record: toRecord(done), replaced: deleted.map(toRecord) };
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

    cleaned: (id, now) =>
      atomic("cleaned", (write) => {
        const row = files.get(id);
        if (row && row.cleanedAt === null) write.file({ ...row, cleanedAt: now, updatedAt: now });
      }),

    usage: async (owner) => {
      const { eraseRequestedAt, erasedAt } = rowOf(owner, new Date(0));
      return { ...countsOf(owner), erasure: eraseRequestedAt ? { requestedAt: eraseRequestedAt, erasedAt } : null };
    },

    reconcile: (owner) =>
      atomic("reconcile", (write) => {
        const counted = countRows(files.values(), owner);
        const current = countsOf(owner);
        const same = (Object.keys(ZERO) as (keyof Counters)[]).every((name) => counted[name] === current[name]);
        // The interface passes no time, so the store's own clock stamps the row (fake timers move it in tests).
        if (!same) write.usage({ ...rowOf(owner, new Date()), ...counted, updatedAt: new Date() });
        return !same;
      }),
  };
}
