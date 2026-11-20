// The store methods that are one statement on both dialects: they touch one table, so the only differences are the
// placeholders (the binder's) and the collation of keyset comparisons.

import type { CloudropStore, FileRecord } from "../../server/store.ts";
import { binder } from "./bind.ts";
import { runStatement, type SqlDialect, type SqlExecutor, type SqlStatement } from "./executor.ts";
import { decodeCursor, encodeCursor, RECORD_COLUMNS, toRecord, toUsage } from "./records.ts";
import type { QuotedTables } from "./tables.ts";

/** What every statement builder needs: where to run, in which dialect, over which tables. */
export interface SqlContext {
  executor: Omit<SqlExecutor<unknown>, "transaction">;
  dialect: SqlDialect;
  tables: QuotedTables;
}

export type StoreMethods = Omit<CloudropStore<never>, "transaction">;

type SingleStatementMethods = Pick<
  StoreMethods,
  "attach" | "get" | "release" | "cleaned" | "usage" | "stale" | "list" | "owners"
>;

const CLEANUP_STATUSES = "'aborted', 'rejected', 'failed', 'expired', 'deleted'";

/** A keyset page: `limit + 1` rows were asked for, so a row beyond the page means another page follows. */
function page<T>(rows: T[], limit: number, cursorOf: (last: T) => string) {
  const kept = rows.slice(0, limit);
  const last = kept.at(-1);
  return { kept, cursor: rows.length > limit && last !== undefined ? cursorOf(last) : null };
}

export function singleStatementMethods({ executor, dialect, tables }: SqlContext): SingleStatementMethods {
  const { files, usage } = tables;
  // Byte order on Postgres, whatever the database's collation, so ids and owners page in the same order everywhere;
  // SQLite's default collation already compares bytes.
  const byteOrder = (expression: string) => (dialect === "postgres" ? `${expression} COLLATE "C"` : expression);
  const run = (statement: SqlStatement) => runStatement(executor, statement);

  return {
    async attach(id, uploadId, now) {
      const b = binder(dialect);
      const sql = `UPDATE ${files} SET upload_id = ${b.text(uploadId)}, updated_at = ${b.time(now)}
        WHERE id = ${b.text(id)} AND status = 'pending' AND (upload_id IS NULL OR upload_id = ${b.text(uploadId)})
        RETURNING id`;
      return (await run(b.statement(sql))).length > 0;
    },

    async get(id) {
      const b = binder(dialect);
      const [row] = await run(b.statement(`SELECT ${RECORD_COLUMNS} FROM ${files} WHERE id = ${b.text(id)}`));
      return row ? toRecord(row) : null;
    },

    async release(id, claim, now) {
      const b = binder(dialect);
      const sql = `UPDATE ${files} SET status = 'pending', claim = NULL, claimed_at = NULL, updated_at = ${b.time(now)}
        WHERE id = ${b.text(id)} AND status = 'completing' AND claim = ${b.text(claim)} RETURNING id`;
      return (await run(b.statement(sql))).length > 0;
    },

    async cleaned(id, now) {
      const b = binder(dialect);
      const sql = `UPDATE ${files} SET cleaned_at = ${b.time(now)}, updated_at = ${b.time(now)}
        WHERE id = ${b.text(id)} AND cleaned_at IS NULL`;
      await run(b.statement(sql));
    },

    async usage(owner) {
      const b = binder(dialect);
      const sql = `SELECT reserved_bytes, active_bytes, files FROM ${usage} WHERE owner = ${b.text(owner)}`;
      return toUsage((await run(b.statement(sql)))[0]);
    },

    async stale({ kind, before, claimedBefore, limit, cursor }) {
      const b = binder(dialect);
      const time = kind === "expire" ? "expires_at" : "ended_at";
      const work =
        kind === "expire"
          ? `expires_at < ${b.time(before)}
            AND (status = 'pending' OR (status = 'completing' AND claimed_at < ${b.time(claimedBefore)}))`
          : `status IN (${CLEANUP_STATUSES}) AND cleaned_at IS NULL AND ended_at < ${b.time(before)}`;
      const start = cursor === null ? null : decodeCursor(cursor);
      const after = start ? `AND (${time}, ${byteOrder("id")}) > (${b.time(start.time)}, ${b.text(start.id)})` : "";
      const sql = `SELECT ${RECORD_COLUMNS} FROM ${files} WHERE ${work} ${after}
        ORDER BY ${time}, ${byteOrder("id")} LIMIT ${b.integer(limit + 1)}`;
      const records = (await run(b.statement(sql))).map(toRecord);
      const timeOf = (record: FileRecord) => (kind === "expire" ? record.expiresAt : (record.endedAt ?? new Date(0)));
      const { kept, cursor: next } = page(records, limit, (last) => encodeCursor(timeOf(last), last.id));
      return { records: kept, cursor: next };
    },

    async list({ owner, statuses, route, limit, cursor }) {
      // `IN ()` is not SQL: no status, no rows.
      if (statuses.length === 0) return { records: [], cursor: null };
      const b = binder(dialect);
      const start = cursor === null ? null : decodeCursor(cursor);
      // Bound in the order they appear: SQLite's `?` placeholders take their values by position.
      const sql = `SELECT ${RECORD_COLUMNS} FROM ${files} WHERE owner = ${b.text(owner)}
        AND status IN (${statuses.map((status) => b.text(status)).join(", ")})
        ${route === null ? "" : `AND route = ${b.text(route)}`}
        ${start ? `AND (created_at, ${byteOrder("id")}) < (${b.time(start.time)}, ${b.text(start.id)})` : ""}
        ORDER BY created_at DESC, ${byteOrder("id")} DESC LIMIT ${b.integer(limit + 1)}`;
      const records = (await run(b.statement(sql))).map(toRecord);
      const { kept, cursor: next } = page(records, limit, (last) => encodeCursor(last.createdAt, last.id));
      return { records: kept, cursor: next };
    },

    async owners(cursor, limit) {
      const b = binder(dialect);
      const after = cursor === null ? "" : `WHERE ${byteOrder("owner")} > ${b.text(cursor)}`;
      const sql = `SELECT owner FROM ${usage} ${after} ORDER BY ${byteOrder("owner")} LIMIT ${b.integer(limit + 1)}`;
      const owners = (await run(b.statement(sql))).map((row) => String(row.owner));
      const { kept, cursor: next } = page(owners, limit, (last) => last);
      return { owners: kept, cursor: next };
    },
  };
}
