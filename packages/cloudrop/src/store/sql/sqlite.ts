// The SQLite statements of the methods that write both tables or must decide in one step. SQLite has no writing CTEs,
// so each method is one atomic batch (D1's `batch()`, `BEGIN IMMEDIATE … COMMIT` on node:sqlite) whose statements each
// check their own condition and never read the previous one's row count, which D1 does not report reliably. Where a
// usage change depends on a files change, the usage statement runs first, guarded on the files row's state before the
// change: both statements then test the same unchanged condition, so they apply together or not at all, and a replay
// with the same claim cannot count twice.

import type { NewFile } from "../../server/store.ts";
import { type Binder, binder } from "./bind.ts";
import { runStatement, type SqlStatement } from "./executor.ts";
import { claimOutcome, RECOUNT, releaseFrom, transition } from "./outcomes.ts";
import { type GuardedWrites, type SqlContext, selectRecord } from "./reads.ts";
import { INSERT_COLUMNS, RECORD_COLUMNS, toRecord } from "./records.ts";

/** The database's clock in integer milliseconds, as reconcile is given no time. Valid on every SQLite version. */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export function sqliteWrites({ executor, tables }: SqlContext): GuardedWrites {
  const { files, usage } = tables;

  /** `[usage change?, files update returning its id, select]`: a transition's statements. */
  const completion = (counted: SqlStatement | null, update: SqlStatement, id: string): SqlStatement[] => [
    ...(counted ? [counted] : []),
    { sql: `${update.sql} RETURNING id`, params: update.params },
    selectRecord("sqlite", files, id),
  ];

  /** Runs a transition's statements and reads the transition from the last two. */
  async function transitionBatch(counted: SqlStatement | null, update: SqlStatement, id: string) {
    const [updated, found] = (await executor.batch(completion(counted, update, id))).slice(-2);
    return transition((updated?.length ?? 0) > 0, found?.[0]);
  }

  /**
   * complete's `replace`: the owner's other completed files on the route end as deleted, their usage first while they
   * are still completed. Both statements require the new file to be completing with this claim, as the completion's
   * own statements after them do, so the batch applies whole or not at all. A file without an owner matches nothing.
   */
  function replacedStatements(id: string, claim: string, now: Date): SqlStatement[] {
    // The other completed files of f's owner on f's route.
    const others = (what: string) => `(SELECT ${what} FROM ${files} AS o
      WHERE o.owner = f.owner AND o.route = f.route AND o.status = 'completed' AND o.id <> f.id)`;
    const counter = binder("sqlite");
    const count = counter.statement(`UPDATE ${usage}
      SET active_bytes = active_bytes - ${others("sum(o.size)")}, files = files - ${others("count(*)")},
        updated_at = ${counter.time(now)}
      FROM ${files} AS f WHERE f.id = ${counter.text(id)} AND f.status = 'completing' AND f.claim = ${counter.text(claim)}
        AND ${usage}.owner = f.owner AND EXISTS ${others("1")}`);
    const b = binder("sqlite");
    const completing = (column: string) =>
      `(SELECT ${column} FROM ${files} WHERE id = ${b.text(id)} AND status = 'completing' AND claim = ${b.text(claim)})`;
    const end = b.statement(`UPDATE ${files} SET status = 'deleted', ended_at = ${b.time(now)},
        updated_at = ${b.time(now)}
      WHERE status = 'completed' AND id <> ${b.text(id)} AND owner = ${completing("owner")}
        AND route = ${completing("route")}
      RETURNING ${RECORD_COLUMNS}`);
    return [count, end];
  }

  /** The usage `UPDATE` (or none, for `set` null) for the owner of file `id` while it is in `from`; f is that row. */
  function usageFor(set: string | null, id: string, from: string, now: Date, guard?: (b: Binder) => string) {
    if (set === null) return null;
    const b = binder("sqlite");
    return b.statement(`UPDATE ${usage} SET ${set}, updated_at = ${b.time(now)} FROM ${files} AS f
      WHERE f.id = ${b.text(id)} AND f.status = ${b.text(from)} ${guard?.(b) ?? ""} AND ${usage}.owner = f.owner`);
  }

  /**
   * A retry of a request whose answer was lost: the statements that end that attempt's pending rows and release their
   * bytes, the usage first while the rows are still pending, so the quota checks after them count without those bytes.
   */
  function supersede(key: string, owner: string | null, accepted: readonly NewFile[], now: Date): SqlStatement[] {
    const routes = [...new Set(accepted.map((file) => file.route))];
    const superseded = (b: Binder) =>
      // `IS` is SQLite's null-safe equality: a null owner matches only null.
      `request_key = ${b.text(key)} AND owner IS ${b.text(owner)}
        AND route IN (${routes.map((route) => b.text(route)).join(", ")}) AND status = 'pending'`;
    const b = binder("sqlite");
    const end = b.statement(`UPDATE ${files} SET status = 'aborted', ended_at = ${b.time(now)},
      updated_at = ${b.time(now)} WHERE ${superseded(b)}`);
    if (owner === null) return [end];
    const counter = binder("sqlite");
    const rows = (c: Binder) => `FROM ${files} WHERE ${superseded(c)}`;
    const count = counter.statement(`UPDATE ${usage}
      SET reserved_bytes = reserved_bytes - (SELECT sum(size) ${rows(counter)}), updated_at = ${counter.time(now)}
      WHERE owner = ${counter.text(owner)} AND EXISTS (SELECT 1 ${rows(counter)})`);
    return [count, end];
  }

  return {
    async reserve({ owner, limit, expiresAt, requestKey, files: accepted }, now) {
      // The quota check reads the usage row as the earlier files of this batch left it; the same check guards the usage
      // write, which runs before anything else changes that row, so the two always agree.
      const fits = (b: Binder, file: NewFile) =>
        owner === null || limit === null
          ? "1"
          : `coalesce((SELECT reserved_bytes + active_bytes FROM ${usage} WHERE owner = ${b.text(owner)}), 0)
              + ${b.bigint(file.size)} <= ${b.bigint(limit)}`;
      const statements = accepted.flatMap((file) => {
        const row = binder("sqlite");
        const insert = row.statement(`INSERT INTO ${files} (${INSERT_COLUMNS})
          SELECT ${row.text(file.id)}, ${row.text(file.route)}, ${row.text(file.key)}, ${row.text(owner)}, 'pending',
            ${row.text(file.name)}, ${row.text(file.type)}, ${row.bigint(file.size)}, ${row.text(file.metadata)},
            ${row.time(expiresAt)}, ${row.time(now)}, ${row.time(now)}, ${row.text(requestKey)}
          WHERE ${fits(row, file)} RETURNING id`);
        if (owner === null) return [insert];
        const counter = binder("sqlite");
        // SQLite needs the WHERE before an upsert's ON CONFLICT, so the bare `1` stays when there is no limit.
        const count = counter.statement(`INSERT INTO ${usage} (owner, reserved_bytes, active_bytes, files, updated_at)
          SELECT ${counter.text(owner)}, ${counter.bigint(file.size)}, 0, 0, ${counter.time(now)}
          WHERE ${fits(counter, file)}
          ON CONFLICT (owner) DO UPDATE SET reserved_bytes = reserved_bytes + excluded.reserved_bytes,
            updated_at = excluded.updated_at`);
        return [insert, count];
      });
      if (statements.length === 0) return [];
      const superseded = requestKey === null ? [] : supersede(requestKey, owner, accepted, now);
      const results = (await executor.batch([...superseded, ...statements])).slice(superseded.length);
      const step = owner === null ? 1 : 2;
      return accepted.map((_, index) => ((results[index * step]?.length ?? 0) > 0 ? "reserved" : "over-quota"));
    },

    async claim(id, claim, now, leaseMs) {
      const b = binder("sqlite");
      const update = b.statement(`UPDATE ${files}
        SET status = 'completing', claim = ${b.text(claim)}, claimed_at = ${b.time(now)}, updated_at = ${b.time(now)}
        WHERE id = ${b.text(id)} AND (status = 'pending'
          OR (status = 'completing' AND claimed_at < ${b.time(new Date(now.getTime() - leaseMs))}))
        RETURNING id`);
      const [claimed, found] = await executor.batch([update, selectRecord("sqlite", files, id)]);
      return claimOutcome((claimed?.length ?? 0) > 0, found?.[0]);
    },

    async complete(id, claim, result, now, options) {
      const replacing = options?.replace ? replacedStatements(id, claim, now) : [];
      const counted = usageFor(
        "reserved_bytes = reserved_bytes - f.size, active_bytes = active_bytes + f.size, files = files + 1",
        id,
        "completing",
        now,
        (b) => `AND f.claim = ${b.text(claim)}`,
      );
      const b = binder("sqlite");
      const update = b.statement(`UPDATE ${files} SET status = 'completed', result = ${b.text(result)},
        completed_at = ${b.time(now)}, updated_at = ${b.time(now)}
        WHERE id = ${b.text(id)} AND status = 'completing' AND claim = ${b.text(claim)}`);
      if (replacing.length === 0) return { ...(await transitionBatch(counted, update, id)), replaced: [] };
      const [, replaced = [], ...rest] = await executor.batch([...replacing, ...completion(counted, update, id)]);
      const [updated, found] = rest.slice(-2);
      const done = transition((updated?.length ?? 0) > 0, found?.[0]);
      return { ...done, replaced: done.changed ? replaced.map(toRecord) : [] };
    },

    async end(id, from, to, now, options) {
      const counted = usageFor(releaseFrom(from, "f.size"), id, from, now);
      const b = binder("sqlite");
      // Bound inline: `?` placeholders take their values in the order the template evaluates them.
      const update = b.statement(`UPDATE ${files}
        SET status = ${b.text(to)}${options?.cleaned ? `, cleaned_at = ${b.time(now)}` : ""}, ended_at = ${b.time(now)},
        updated_at = ${b.time(now)} WHERE id = ${b.text(id)} AND status = ${b.text(from)}`);
      return transitionBatch(counted, update, id);
    },

    async revoke(owner, now) {
      const counter = binder("sqlite");
      const pending = (b: Binder) => `FROM ${files} WHERE owner = ${b.text(owner)} AND status = 'pending'`;
      const count = counter.statement(`UPDATE ${usage}
        SET reserved_bytes = reserved_bytes - (SELECT sum(size) ${pending(counter)}), updated_at = ${counter.time(now)}
        WHERE owner = ${counter.text(owner)} AND EXISTS (SELECT 1 ${pending(counter)})`);
      const b = binder("sqlite");
      const revoke = b.statement(`UPDATE ${files} SET status = 'aborted', ended_at = ${b.time(now)},
        updated_at = ${b.time(now)} WHERE owner = ${b.text(owner)} AND status = 'pending' RETURNING id`);
      const [, revoked] = await executor.batch([count, revoke]);
      return revoked?.length ?? 0;
    },

    async reconcile(owner) {
      // One statement, and SQLite runs one writer at a time, so nothing can change the rows between count and write.
      // An owner without a row whose rows count nothing gets none: a missing row already counts as zeros.
      const b = binder("sqlite");
      const sql = `INSERT INTO ${usage} (owner, reserved_bytes, active_bytes, files, updated_at)
        SELECT ${b.text(owner)}, ${RECOUNT.reserved}, ${RECOUNT.active}, ${RECOUNT.files}, ${NOW_MS}
        FROM ${files} WHERE owner = ${b.text(owner)}
        HAVING ${RECOUNT.reserved} + ${RECOUNT.active} + ${RECOUNT.files} > 0
          OR EXISTS (SELECT 1 FROM ${usage} WHERE owner = ${b.text(owner)})
        ON CONFLICT (owner) DO UPDATE SET reserved_bytes = excluded.reserved_bytes,
          active_bytes = excluded.active_bytes, files = excluded.files, updated_at = excluded.updated_at
        WHERE reserved_bytes <> excluded.reserved_bytes OR active_bytes <> excluded.active_bytes
          OR files <> excluded.files
        RETURNING owner`;
      return (await runStatement(executor, b.statement(sql))).length > 0;
    },
  };
}
