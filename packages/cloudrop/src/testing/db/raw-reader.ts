// The store contract's oracle: reads the store's rows straight through the test database's driver, never through an
// adapter, and decodes them the same way for both dialects (bigint text or numbers to numbers; timestamptz or integer
// milliseconds to Dates). A value of the wrong type fails loudly, naming the column, so an adapter that writes a time
// as ISO text on SQLite, or a size beyond 2^53, cannot pass unnoticed.

import { resolveTables, type TableNames, type TestDatabase } from "./schema.ts";

export interface FileRow {
  id: string;
  route: string;
  key: string;
  owner: string | null;
  status: string;
  name: string;
  type: string;
  size: number;
  uploadId: string | null;
  metadata: string | null;
  result: string | null;
  claim: string | null;
  claimedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  endedAt: Date | null;
  cleanedAt: Date | null;
  requestKey: string | null;
}

export interface UsageRow {
  owner: string;
  reservedBytes: number;
  activeBytes: number;
  files: number;
  updatedAt: Date;
}

export interface RawReader {
  file(id: string): Promise<FileRow | null>;
  /** Every file row, by id. */
  files(): Promise<FileRow[]>;
  usage(owner: string): Promise<UsageRow | null>;
  /** Every usage row, by owner. */
  usages(): Promise<UsageRow[]>;
}

type Row = Record<string, unknown>;

function fail(column: string, value: unknown, expected: string): never {
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  throw new Error(`Column ${column} holds ${typeof value} ${shown}; expected ${expected}.`);
}

function text(row: Row, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : fail(column, value, "text");
}

function integer(row: Row, column: string): number {
  const value = row[column];
  // node-postgres and postgres.js return bigint columns as decimal text, node:sqlite numbers; a driver set to read
  // bigints gives a bigint.
  const decimal = typeof value === "string" && /^-?\d+$/.test(value);
  const number = decimal || typeof value === "bigint" ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number)) return number;
  return fail(column, value, "an integer within 2^53");
}

function time(row: Row, column: string): Date {
  const value = row[column];
  if (value instanceof Date) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return new Date(value);
  return fail(column, value, "a timestamptz, or integer milliseconds on SQLite");
}

function nullable<T>(read: (row: Row, column: string) => T): (row: Row, column: string) => T | null {
  return (row, column) => (row[column] === null ? null : read(row, column));
}

const optionalText = nullable(text);
const optionalTime = nullable(time);

function fileRow(row: Row): FileRow {
  return {
    id: text(row, "id"),
    route: text(row, "route"),
    key: text(row, "key"),
    owner: optionalText(row, "owner"),
    status: text(row, "status"),
    name: text(row, "name"),
    type: text(row, "type"),
    size: integer(row, "size"),
    uploadId: optionalText(row, "upload_id"),
    metadata: optionalText(row, "metadata"),
    result: optionalText(row, "result"),
    claim: optionalText(row, "claim"),
    claimedAt: optionalTime(row, "claimed_at"),
    expiresAt: time(row, "expires_at"),
    createdAt: time(row, "created_at"),
    updatedAt: time(row, "updated_at"),
    completedAt: optionalTime(row, "completed_at"),
    endedAt: optionalTime(row, "ended_at"),
    cleanedAt: optionalTime(row, "cleaned_at"),
    requestKey: optionalText(row, "request_key"),
  };
}

function usageRow(row: Row): UsageRow {
  return {
    owner: text(row, "owner"),
    reservedBytes: integer(row, "reserved_bytes"),
    activeBytes: integer(row, "active_bytes"),
    files: integer(row, "files"),
    updatedAt: time(row, "updated_at"),
  };
}

const FILE_COLUMNS =
  "id, route, key, owner, status, name, type, size, upload_id, metadata, result, claim, claimed_at, expires_at, " +
  "created_at, updated_at, completed_at, ended_at, cleaned_at, request_key";
const USAGE_COLUMNS = "owner, reserved_bytes, active_bytes, files, updated_at";

/** A reader of the tables under these names (defaults `cloudrop_files`, `cloudrop_usage`). */
export function rawReader(db: TestDatabase, tables?: Partial<TableNames>): RawReader {
  const { files, usage } = resolveTables(tables);
  const placeholder = db.dialect === "postgres" ? "$1" : "?";
  const select = async (columns: string, table: string, where: string, params: unknown[]) =>
    db.query(`SELECT ${columns} FROM "${table}" ${where}`, params);
  return {
    async file(id) {
      const [row] = await select(FILE_COLUMNS, files, `WHERE id = ${placeholder}`, [id]);
      return row ? fileRow(row) : null;
    },
    async files() {
      return (await select(FILE_COLUMNS, files, "ORDER BY id", [])).map(fileRow);
    },
    async usage(owner) {
      const [row] = await select(USAGE_COLUMNS, usage, `WHERE owner = ${placeholder}`, [owner]);
      return row ? usageRow(row) : null;
    },
    async usages() {
      return (await select(USAGE_COLUMNS, usage, "ORDER BY owner", [])).map(usageRow);
    },
  };
}
