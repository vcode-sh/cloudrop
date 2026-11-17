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
import type { SqlContext, StoreMethods } from "./reads.ts";
import { RECORD_COLUMNS } from "./records.ts";

type GuardedWrites = Pick<StoreMethods, "reserve" | "claim" | "complete" | "end" | "revoke" | "reconcile">;

const INSERT_COLUMNS = "id, route, key, owner, status, name, type, size, metadata, expires_at, created_at, updated_at";

/** The database's clock in integer milliseconds, as reconcile is given no time. Valid on every SQLite version. */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export function sqliteWrites({ executor, tables }: SqlContext): GuardedWrites {
  const { files, usage } = tables;
  const select = (id: string) => {
    const b = binder("sqlite");
    return b.statement(`SELECT ${RECORD_COLUMNS} FROM ${files} WHERE id = ${b.text(id)}`);
  };

  /** Runs `[usage change?, files update, select]` and reads the transition from the last two. */
  async function transitionBatch(counted: SqlStatement | null, update: SqlStatement, id: string) {
    const statements = [{ sql: `${update.sql} RETURNING id`, params: update.params }, select(id)];
    const [updated, found] = (await executor.batch(counted ? [counted, ...statements] : statements)).slice(-2);
    return transition((updated?.length ?? 0) > 0, found?.[0]);
  }

  /** The usage `UPDATE` (or none, for `set` null) for the owner of file `id` while it is in `from`; f is that row. */
  function usageFor(set: string | null, id: string, from: string, now: Date, guard?: (b: Binder) => string) {
    if (set === null) return null;
    const b = binder("sqlite");
    return b.statement(`UPDATE ${usage} SET ${set}, updated_at = ${b.time(now)} FROM ${files} AS f
      WHERE f.id = ${b.text(id)} AND f.status = ${b.text(from)} ${guard?.(b) ?? ""} AND ${usage}.owner = f.owner`);
  }

  return {
    async reserve({ owner, limit, expiresAt, files: accepted }, now) {
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
            ${row.time(expiresAt)}, ${row.time(now)}, ${row.time(now)}
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
      const results = await executor.batch(statements);
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
      const [claimed, found] = await executor.batch([update, select(id)]);
      return claimOutcome((claimed?.length ?? 0) > 0, found?.[0]);
    },

    async complete(id, claim, result, now) {
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
      return transitionBatch(counted, update, id);
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
      const b = binder("sqlite");
      const sql = `INSERT INTO ${usage} (owner, reserved_bytes, active_bytes, files, updated_at)
        SELECT ${b.text(owner)}, ${RECOUNT.reserved}, ${RECOUNT.active}, ${RECOUNT.files}, ${NOW_MS}
        FROM ${files} WHERE owner = ${b.text(owner)}
        HAVING count(CASE WHEN status IN ('pending', 'completing', 'completed') THEN 1 END) > 0
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
