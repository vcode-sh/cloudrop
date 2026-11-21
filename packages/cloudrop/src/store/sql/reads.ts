// The store methods that are one statement on both dialects: they touch one table, so the only differences are the
// placeholders (the binder's) and the collation of keyset comparisons.

import type { CloudropStore, FileRecord, FileStatus } from "../../server/store.ts";
import { type Binder, binder } from "./bind.ts";
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
> &
  Required<Pick<StoreMethods, "listAll">>;

/** What `list` and `listAll` read: `owner` null is every owner, `statuses` null every status. */
type Listing = Omit<Parameters<StoreMethods["list"]>[0], "owner" | "statuses"> & {
  owner: string | null;
  statuses: readonly FileStatus[] | null;
};

/** The methods each dialect writes on its own: those that write both tables or must decide in one step. */
export type GuardedWrites = Omit<StoreMethods, keyof SingleStatementMethods>;

const CLEANUP_STATUSES = ["aborted", "rejected", "failed", "expired", "deleted"];
/** Postgres: the name with its ASCII letters in lower case and nothing else changed. */
const FOLD_NAME = "translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')";

const foldAscii = (text: string): string => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/** Reads file `id`'s row as it is now. */
export function selectRecord(dialect: SqlDialect, files: string, id: string): SqlStatement {
  const b = binder(dialect);
  return b.statement(`SELECT ${RECORD_COLUMNS} FROM ${files} WHERE id = ${b.text(id)}`);
}

/** One condition of a statement, or none when its value is null. */
const given = <T>(value: T | null, sql: (value: T) => string): string => (value === null ? "" : sql(value));

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
  // A substring search, not LIKE, so `%` and `_` in the name mean themselves. Both sides fold ASCII letters alone,
  // which neither dialect's `lower` promises: Postgres's folds other letters by the database's locale, and SQLite's
  // does once the ICU extension replaces it (M11-R69).
  const nameContains = (b: Binder, name: string) => {
    const folded = foldAscii(name);
    if (dialect === "postgres") return `strpos(${FOLD_NAME}, ${b.text(folded)}) > 0`;
    // SQLite has no `translate`. Only a letter the search has can match one in the name, so only those are folded
    // there, one `replace` each: `a` to `z` and nothing else reaches the statement's text.
    const letters = new Set(folded.match(/[a-z]/g));
    const foldedName = [...letters].reduce((sql, l) => `replace(${sql}, '${l.toUpperCase()}', '${l}')`, "name");
    return `instr(${foldedName}, ${b.text(folded)}) > 0`;
  };
  // `"image/"` is every type of that top-level type; types are ASCII, so lengths in characters are lengths in bytes.
  const typeMatches = (b: Binder, type: string) =>
    type.endsWith("/") ? `substr(type, 1, ${b.integer(type.length)}) = ${b.text(type)}` : `type = ${b.text(type)}`;

  // Every owner's rows are read along the `created_at` index, each row checked against the filters. SQLite has no
  // statistics to see that and would read every row of the status or the route and sort them: a `+` before the column
  // keeps it off their indexes (M11-L7). Postgres chooses by its statistics.
  const offItsIndex = (owner: string | null) => (owner === null && dialect === "sqlite" ? "+" : "");
  // One owner in several statuses is the opposite: Postgres would walk `created_at` past every other owner's rows to
  // fill the page. So the order is one no index has, and the owner's rows are found by owner and sorted (M11-L6).
  const listedBy = (owner: string | null, statuses: readonly FileStatus[] | null) => {
    if (owner === null || statuses?.length === 1) return "created_at";
    return dialect === "postgres" ? "created_at + interval '0'" : "+created_at";
  };

  async function list({ owner, statuses, route, name, type, order, limit, cursor }: Listing) {
    // `IN ()` is not SQL: no status, no rows.
    if (statuses?.length === 0) return { records: [], cursor: null };
    const b = binder(dialect);
    const [direction, after] = order === "newest" ? ["DESC", "<"] : ["ASC", ">"];
    const off = offItsIndex(owner);
    // Bound in the order they appear: SQLite's `?` placeholders take their values by position.
    const where = [
      given(owner, (value) => `owner = ${b.text(value)}`),
      given(statuses, (all) => `${off}status IN (${all.map((status) => b.text(status)).join(", ")})`),
      given(route, (value) => `${off}route = ${b.text(value)}`),
      given(name, (value) => nameContains(b, value)),
      given(type, (value) => typeMatches(b, value)),
      given(cursor, (value) => {
        const start = decodeCursor(value);
        return `(created_at, ${byteOrder("id")}) ${after} (${b.time(start.time)}, ${b.text(start.id)})`;
      }),
    ].filter(Boolean);
    const sql = `SELECT ${RECORD_COLUMNS} FROM ${files} ${where.length > 0 ? "WHERE" : ""} ${where.join(" AND ")}
      ORDER BY ${listedBy(owner, statuses)} ${direction}, ${byteOrder("id")} ${direction}
      LIMIT ${b.integer(limit + 1)}`;
    const records = (await run(b.statement(sql))).map(toRecord);
    const { kept, cursor: next } = page(records, limit, (last) => encodeCursor(last.createdAt, last.id));
    return { records: kept, cursor: next };
  }

  return {
    async attach(id, uploadId, now) {
      const b = binder(dialect);
      const sql = `UPDATE ${files} SET upload_id = ${b.text(uploadId)}, updated_at = ${b.time(now)}
        WHERE id = ${b.text(id)} AND status = 'pending' AND (upload_id IS NULL OR upload_id = ${b.text(uploadId)})
        RETURNING id`;
      return (await run(b.statement(sql))).length > 0;
    },

    async get(id) {
      const [row] = await run(selectRecord(dialect, files, id));
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
      const start = cursor === null ? null : decodeCursor(cursor);
      // One status at a time: its rows are a range of one index, already in the page's order, so each range stops
      // after a page of rows and the page is the first rows of them all. Asked as one condition over the statuses, the
      // database reads every matching row and sorts them, for every page (M11-R66). `lead` names an index column
      // before the time that is the same in every row of the range, which is how Postgres sees the index's order.
      const ordered = (lead = "") => `ORDER BY ${lead}${time}, ${byteOrder("id")} LIMIT ${b.integer(limit + 1)}`;
      const range = (work: string, lead?: string) =>
        `SELECT * FROM (SELECT ${RECORD_COLUMNS} FROM ${files} WHERE ${work} AND ${time} < ${b.time(before)} ${
          start ? `AND (${time}, ${byteOrder("id")}) > (${b.time(start.time)}, ${b.text(start.id)})` : ""
        } ${ordered(lead)}) AS part`;
      const ranges =
        kind === "expire"
          ? [range("status = 'pending'"), range(`status = 'completing' AND claimed_at < ${b.time(claimedBefore)}`)]
          : CLEANUP_STATUSES.map((status) => range(`status = '${status}' AND cleaned_at IS NULL`, "cleaned_at, "));
      const sql = `SELECT ${RECORD_COLUMNS} FROM (${ranges.join(" UNION ALL ")}) AS work ${ordered()}`;
      const records = (await run(b.statement(sql))).map(toRecord);
      const timeOf = (record: FileRecord) => (kind === "expire" ? record.expiresAt : (record.endedAt ?? new Date(0)));
      const { kept, cursor: next } = page(records, limit, (last) => encodeCursor(timeOf(last), last.id));
      return { records: kept, cursor: next };
    },

    list,
    listAll: ({ status, ...rest }) => list({ ...rest, statuses: status === null ? null : [status] }),

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
