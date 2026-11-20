// Turns driver rows into the store's types. Drivers disagree on numbers and times (spec review I9): node-postgres and
// postgres.js return int8 and numeric sums as decimal text, Prisma returns BigInt and Decimal, node:sqlite and D1
// return numbers; Postgres times arrive as Dates, SQLite times are the integer milliseconds the core wrote.

import type { FileRecord, FileStatus, OwnerUsage } from "../../server/store.ts";
import type { SqlRow } from "./executor.ts";

/** Every column of the files table, in the order of spec §3. */
export const FILE_COLUMNS: readonly string[] = [
  "id",
  "route",
  "key",
  "owner",
  "status",
  "name",
  "type",
  "size",
  "upload_id",
  "metadata",
  "result",
  "claim",
  "claimed_at",
  "expires_at",
  "created_at",
  "updated_at",
  "completed_at",
  "ended_at",
  "cleaned_at",
  "request_key",
];

/** The columns a reserve writes, in the order its statements list the values. */
export const INSERT_COLUMNS =
  "id, route, key, owner, status, name, type, size, metadata, expires_at, created_at, updated_at, request_key";

/** The files columns a `FileRecord` is read from: every column except `claim`, `updated_at` and `request_key`. */
export const RECORD_COLUMNS: string = FILE_COLUMNS.filter(
  (column) => column !== "claim" && column !== "updated_at" && column !== "request_key",
).join(", ");

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : `${typeof value} ${String(value)}`;
}

/**
 * A whole number within 2^53 from a number, a decimal string, a bigint or a decimal-like object (Prisma's Decimal
 * prints as its digits). Throws on fractions and larger values rather than round: a byte count must stay exact.
 */
export function toSafeInteger(value: unknown, column: string): number {
  const digits = typeof value === "bigint" || (typeof value === "object" && value !== null) ? String(value) : value;
  const number = typeof digits === "string" && /^-?\d+$/.test(digits) ? Number(digits) : digits;
  if (typeof number === "number" && Number.isSafeInteger(number)) return number;
  throw new Error(`The database returned ${describe(value)} for ${column}; expected a whole number up to 2^53.`);
}

/** A time from a Date, an ISO string or milliseconds since the epoch. */
export function toDate(value: unknown, column: string): Date {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string" && !/^-?\d+$/.test(value)
        ? Date.parse(value)
        : toSafeInteger(value, column);
  if (Number.isNaN(ms)) throw new Error(`The database returned ${describe(value)} for ${column}; expected a time.`);
  return new Date(ms);
}

const text = (row: SqlRow, column: string): string => {
  const value = row[column];
  if (typeof value === "string") return value;
  throw new Error(`The database returned ${describe(value)} for ${column}; expected text.`);
};
const optionalText = (row: SqlRow, column: string): string | null => (row[column] == null ? null : text(row, column));
const optionalDate = (row: SqlRow, column: string): Date | null =>
  row[column] == null ? null : toDate(row[column], column);

export function toRecord(row: SqlRow): FileRecord {
  return {
    id: text(row, "id"),
    route: text(row, "route"),
    key: text(row, "key"),
    name: text(row, "name"),
    type: text(row, "type"),
    size: toSafeInteger(row.size, "size"),
    metadata: optionalText(row, "metadata"),
    owner: optionalText(row, "owner"),
    // Only the store writes this column, always one of the FileStatus values.
    status: text(row, "status") as FileStatus,
    uploadId: optionalText(row, "upload_id"),
    result: optionalText(row, "result"),
    expiresAt: toDate(row.expires_at, "expires_at"),
    createdAt: toDate(row.created_at, "created_at"),
    claimedAt: optionalDate(row, "claimed_at"),
    completedAt: optionalDate(row, "completed_at"),
    endedAt: optionalDate(row, "ended_at"),
    cleanedAt: optionalDate(row, "cleaned_at"),
  };
}

export function toUsage(row: SqlRow | undefined): OwnerUsage {
  if (!row) return { reservedBytes: 0, activeBytes: 0, files: 0 };
  return {
    reservedBytes: toSafeInteger(row.reserved_bytes, "reserved_bytes"),
    activeBytes: toSafeInteger(row.active_bytes, "active_bytes"),
    files: toSafeInteger(row.files, "files"),
  };
}

/** A `stale` or `list` cursor: the last row's time in milliseconds and its id, so the next page starts strictly after both. */
export function encodeCursor(time: Date, id: string): string {
  return `${time.getTime()}:${id}`;
}

export function decodeCursor(cursor: string): { time: Date; id: string } {
  const match = /^(\d+):(.*)$/s.exec(cursor);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error("This cursor was not made by the store. Start again with cursor null.");
  }
  return { time: new Date(Number(match[1])), id: match[2] };
}
