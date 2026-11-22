// What both dialects share once their statements have run: reading a claim's outcome or a transition from the row, and
// the usage change each status gives back when a row leaves it.

import type { ClaimOutcome, FileRecordStatus, Transition } from "../../server/store.ts";
import type { SqlRow } from "./executor.ts";
import { toRecord } from "./records.ts";

/** `row` is the file as the claim statement found it, read in the same unit. */
export function claimOutcome(claimed: boolean, row: SqlRow | undefined): ClaimOutcome {
  if (claimed) return { kind: "claimed" };
  if (!row) return { kind: "missing" };
  const record = toRecord(row);
  if (record.status === "completed") return { kind: "completed", record };
  // A pending row the update did not take was claimed by a concurrent call after this statement's snapshot: Postgres
  // re-reads a row it waited for before updating it, while the snapshot still shows the row as it was.
  if (record.status === "pending" || record.status === "completing") return { kind: "busy" };
  return { kind: "ended", record };
}

export function transition(changed: boolean, row: SqlRow | undefined): Transition {
  if (changed && row) return { changed: true, record: toRecord(row) };
  return { changed: false, record: row ? toRecord(row) : null };
}

/**
 * The `SET` list that takes a row of `size` bytes off its owner's counters as it leaves `from`, or null when `from`
 * holds no bytes (an ended status), in which case the usage row is not written at all.
 */
export function releaseFrom(from: FileRecordStatus, size: string): string | null {
  if (from === "pending" || from === "completing") return `reserved_bytes = reserved_bytes - ${size}`;
  if (from === "completed") return `active_bytes = active_bytes - ${size}, files = files - 1`;
  return null;
}

/** The columns reconcile recounts, as one aggregate over the owner's files rows. */
export const RECOUNT = {
  reserved: "coalesce(sum(CASE WHEN status IN ('pending', 'completing') THEN size END), 0)",
  active: "coalesce(sum(CASE WHEN status = 'completed' THEN size END), 0)",
  files: "count(CASE WHEN status = 'completed' THEN 1 END)",
};
