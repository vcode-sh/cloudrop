// The store contract's `RawTables` over a test database: C0's raw reader for the reads, plus the two writes past the
// store that the contract needs (counters made to drift, a usage row deleted).

import type { FileStatus } from "../../server/store.ts";
import type { RawFileRow, RawTables } from "../store-rows.ts";
import { type FileRow, rawReader } from "./raw-reader.ts";
import { qualified, resolveTables, type TableNames, type TestDatabase } from "./schema.ts";

const STATUSES: ReadonlySet<string> = new Set<FileStatus>([
  "pending",
  "completing",
  "completed",
  "aborted",
  "rejected",
  "failed",
  "expired",
  "deleted",
]);

function withStatus(row: FileRow): RawFileRow {
  if (!STATUSES.has(row.status)) throw new Error(`Column status holds "${row.status}", which is not a file status.`);
  return { ...row, status: row.status as FileStatus };
}

export function rawTables(db: TestDatabase, tables?: Partial<TableNames>): RawTables {
  const reader = rawReader(db, tables);
  const { usage: name, schema } = resolveTables(tables);
  const usage = qualified(schema, name);
  const marks = (count: number) =>
    Array.from({ length: count }, (_, index) => (db.dialect === "postgres" ? `$${index + 1}` : "?")).join(", ");
  return {
    files: async () => (await reader.files()).map(withStatus),
    usage: () => reader.usages(),
    async putUsage(row) {
      const time = db.dialect === "postgres" ? row.updatedAt : row.updatedAt.getTime();
      await db.query(
        `INSERT INTO ${usage} (owner, reserved_bytes, active_bytes, files, updated_at) VALUES (${marks(5)})
         ON CONFLICT (owner) DO UPDATE SET reserved_bytes = excluded.reserved_bytes,
           active_bytes = excluded.active_bytes, files = excluded.files, updated_at = excluded.updated_at`,
        [row.owner, row.reservedBytes, row.activeBytes, row.files, time],
      );
    },
    async deleteUsage(owner) {
      await db.query(`DELETE FROM ${usage} WHERE owner = ${marks(1)}`, [owner]);
    },
  };
}
