// The Postgres statements of the methods that write both tables or must decide in one step. Each is one statement:
// data-modifying CTEs run with the statement, so the files change and its usage change commit together, and a guarded
// UPDATE that waited for a row lock re-reads the row before it applies (READ COMMITTED), which is what makes a claim
// exclusive. Two are more: reconcile is a batch, the usage row made to exist and locked first, so the recount takes a
// snapshot after it; revoke is a statement and then one for each row another transaction held (postgres-revoke.ts).

import type { FileRecordStatus, NewFile } from "../../server/store.ts";
import { type Binder, binder } from "./bind.ts";
import { isUniqueViolation, runStatement } from "./executor.ts";
import { claimOutcome, RECOUNT, releaseFrom, transition } from "./outcomes.ts";
import { replacingComplete } from "./postgres-replace.ts";
import { revoking } from "./postgres-revoke.ts";
import { type GuardedWrites, type SqlContext, selectRecord } from "./reads.ts";
import { INSERT_COLUMNS, RECORD_COLUMNS } from "./records.ts";

const INPUT_COLUMNS = "ord integer, id text, route text, key text, name text, type text, size bigint, metadata text";

/** The accepted files as one JSON parameter, numbered from 1 in the order the quota checks them. */
const inputJson = (files: readonly NewFile[]): string =>
  JSON.stringify(
    files.map(({ id, route, key, name, type, size, metadata }, index) => ({
      ord: index + 1,
      id,
      route,
      key,
      name,
      type,
      size,
      metadata,
    })),
  );

/**
 * The condition of the update that supersedes an attempt's pending rows: the rows that match `where`, each locked in
 * byte order of id before any is changed. Two statements that lock the same rows in different orders, one along an
 * index and one out of a hash join, deadlock (40P01); in one order the second waits at the first row they share
 * (M11-R61). It waits for a row another statement holds, such as the attempt's own attach, and so supersedes it too.
 */
const pendingInOrder = (files: string, where: string): string =>
  `status = 'pending' AND id IN (
    SELECT id FROM ${files} WHERE ${where} AND status = 'pending' ORDER BY id COLLATE "C" FOR UPDATE)`;

/**
 * A retry of a request whose answer was lost ends that attempt's pending rows in the reserve's statement: the CTE that
 * does it, and the bytes it frees. Every CTE reads one snapshot, so the counters read beside it still hold those bytes
 * and the freed sum is taken off them. `key` and `who` are bound placeholders (`who` may be `NULL`). No key: no CTE,
 * nothing freed. An owner whose mark the snapshot shows supersedes nothing (M12-O2). One marked after the snapshot
 * may still have an attempt superseded by the reserve the mark then refuses: its bytes are released with it, and the
 * erasure would have ended that attempt anyway.
 */
function superseding(tables: { files: string; usage: string }, key: string | null, who: string, at: string) {
  if (key === null) return { cte: "", freed: "0" };
  const { files, usage } = tables;
  const cte = `, superseded AS (
    UPDATE ${files} SET status = 'aborted', ended_at = ${at}, updated_at = ${at}
    WHERE ${pendingInOrder(
      files,
      `request_key = ${key} AND owner IS NOT DISTINCT FROM ${who} AND route IN (SELECT route FROM input)
        AND NOT EXISTS (SELECT 1 FROM ${usage} WHERE owner = ${who} AND erase_requested_at IS NOT NULL)`,
    )}
    RETURNING size
  )`;
  return { cte, freed: "(SELECT coalesce(sum(size), 0) FROM superseded)" };
}

export function postgresWrites(context: SqlContext): GuardedWrites {
  const { executor, tables } = context;
  const { files, usage } = tables;
  const completeReplacing = replacingComplete(context);

  /**
   * Files and usage of one guarded transition, then the row: changed, or unchanged as found. `from` is the status the
   * update requires.
   */
  async function transitionRow(update: string, set: string | null, id: string, from: FileRecordStatus, b: Binder) {
    const counted = set
      ? `, counted AS (UPDATE ${usage} SET ${set} FROM changed WHERE ${usage}.owner = changed.owner)`
      : "";
    const sql = `WITH changed AS (${update} RETURNING ${RECORD_COLUMNS})${counted}
      SELECT true AS changed, ${RECORD_COLUMNS} FROM changed
      UNION ALL
      SELECT false, ${RECORD_COLUMNS} FROM ${files} WHERE id = ${b.text(id)} AND NOT EXISTS (SELECT 1 FROM changed)`;
    const [row] = await runStatement(executor, b.statement(sql));
    const found = transition(row?.changed === true, row);
    // Unchanged, yet the row still shows the status the update wanted: the update waited for another transaction's
    // lock and found the row changed, while this statement's snapshot still holds it as it was. Read it as it is now.
    if (found.changed || found.record?.status !== from) return found;
    const [current] = await runStatement(executor, selectRecord("postgres", files, id));
    return transition(false, current);
  }

  const end: GuardedWrites["end"] = async (id, from, to, now, options) => {
    const b = binder("postgres");
    const at = b.time(now);
    const cleaned = options?.cleaned ? `, cleaned_at = ${at}` : "";
    const update = `UPDATE ${files} SET status = ${b.text(to)}, ended_at = ${at}, updated_at = ${at}${cleaned}
      WHERE id = ${b.text(id)} AND status = ${b.text(from)}`;
    const released = releaseFrom(from, "changed.size");
    return transitionRow(update, released && `${released}, updated_at = ${at}`, id, from, b);
  };

  return {
    async reserve({ owner, limit, expiresAt, requestKey, files: accepted }, now) {
      if (accepted.length === 0) return [];
      const b = binder("postgres");
      const [input, expires, at, key] = [
        b.json(inputJson(accepted)),
        b.time(expiresAt),
        b.time(now),
        b.text(requestKey),
      ];
      const who = owner === null ? "NULL" : b.text(owner);
      const { cte, freed } = superseding(tables, requestKey === null ? null : key, who, at);
      const head = `input AS (SELECT * FROM json_to_recordset(${input}) AS input(${INPUT_COLUMNS}))${cte}`;
      const values = `input.id, input.route, input.key, ${who}, 'pending', input.name, input.type, input.size,
        input.metadata, ${expires}, ${at}, ${at}, ${key}`;
      if (owner === null) {
        await runStatement(
          executor,
          b.statement(`WITH ${head} INSERT INTO ${files} (${INSERT_COLUMNS}) SELECT ${values} FROM input`),
        );
        return accepted.map(() => "reserved" as const);
      }
      // An owner the locked row marks for erasure gets no file, whatever the limit (M12-O2).
      const open = "NOT coalesce((SELECT erased FROM locked), false)";
      const fits = limit === null ? open : `${open} AND decided.used + input.size <= ${b.bigint(limit)}`;
      // The usage row is locked before any decision, so concurrent reserves of one owner queue and each sees the
      // counters and the erase mark the previous one committed: a FOR UPDATE that waited reads the row as it is now.
      // `decided` walks the files in order, adding each that fits.
      // Lock order: file rows, then the usage row, as in every other writer (end, complete, revoke). The freed sum sits
      // in `locked`'s projection, which the scan computes before FOR UPDATE locks the row, so `superseded` waits for a
      // row another transaction holds before this statement takes the usage row; the other order deadlocks (40P01).
      // With no usage row the owner has no reserved bytes to free.
      const sql = `WITH RECURSIVE ${head},
        locked AS (
          SELECT reserved_bytes + active_bytes - ${freed} AS used, erase_requested_at IS NOT NULL AS erased
          FROM ${usage} WHERE owner = ${who} FOR UPDATE
        ),
        decided (ord, used, reserved) AS (
          SELECT 0, coalesce((SELECT used FROM locked), 0), false
          UNION ALL
          SELECT input.ord, decided.used + CASE WHEN ${fits} THEN input.size ELSE 0 END, ${fits}
          FROM decided JOIN input ON input.ord = decided.ord + 1
        ),
        inserted AS (
          INSERT INTO ${files} (${INSERT_COLUMNS})
          SELECT ${values} FROM input JOIN decided ON decided.ord = input.ord WHERE decided.reserved
          RETURNING size
        ),
        total AS (SELECT coalesce(sum(size), 0) AS bytes, count(*) AS reserved, ${freed} AS freed FROM inserted),
        counted AS (
          UPDATE ${usage} SET reserved_bytes = reserved_bytes + total.bytes - total.freed, updated_at = ${at}
          FROM total WHERE owner = ${who} AND (total.reserved > 0 OR total.freed > 0)
        ),
        created AS (
          INSERT INTO ${usage} (owner, reserved_bytes, active_bytes, files, updated_at)
          SELECT ${who}, total.bytes, 0, 0, ${at} FROM total
          WHERE total.reserved > 0 AND NOT EXISTS (SELECT 1 FROM locked)
        )
        SELECT reserved, coalesce((SELECT erased FROM locked), false) AS erased FROM decided WHERE ord > 0 ORDER BY ord`;
      const statement = b.statement(sql);
      const rows = await runStatement(executor, statement).catch((error: unknown) => {
        // Another call created this owner's usage row after our snapshot: a first reserve, or an erase mark. Our
        // decisions assumed no row, counters or mark, so the insert fails on the unique owner instead of adding to the
        // row (an upsert would reserve past a mark it never read). The failed statement rolled back whole; run again,
        // it takes a new snapshot and its FOR UPDATE locks that row. A duplicate file id fails again and is thrown.
        if (!isUniqueViolation(error)) throw error;
        return runStatement(executor, statement);
      });
      return rows.map((row) => (row.erased === true ? "erased" : row.reserved === true ? "reserved" : "over-quota"));
    },

    async claim(id, claim, now, leaseMs) {
      const b = binder("postgres");
      const [key, at] = [b.text(id), b.time(now)];
      const sql = `WITH claimed AS (
          UPDATE ${files} SET status = 'completing', claim = ${b.text(claim)}, claimed_at = ${at}, updated_at = ${at}
          WHERE id = ${key} AND (status = 'pending'
            OR (status = 'completing' AND claimed_at < ${b.time(new Date(now.getTime() - leaseMs))}))
          RETURNING id
        )
        SELECT EXISTS (SELECT 1 FROM claimed) AS claimed, ${RECORD_COLUMNS} FROM ${files} WHERE id = ${key}`;
      const [row] = await runStatement(executor, b.statement(sql));
      return claimOutcome(row?.claimed === true, row);
    },

    async complete(id, claim, result, now, options) {
      if (options?.replace) return completeReplacing(id, claim, result, now);
      const b = binder("postgres");
      const at = b.time(now);
      const update = `UPDATE ${files} SET status = 'completed', result = ${b.text(result)}, completed_at = ${at},
        updated_at = ${at} WHERE id = ${b.text(id)} AND status = 'completing' AND claim = ${b.text(claim)}`;
      const set = `reserved_bytes = reserved_bytes - changed.size, active_bytes = active_bytes + changed.size,
        files = files + 1, updated_at = ${at}`;
      return { ...(await transitionRow(update, set, id, "completing", b)), replaced: [] };
    },

    end,
    revoke: revoking(context, end),

    async reconcile(owner) {
      /** A statement whose one parameter is the owner. */
      const forOwner = (sql: (who: string) => string) => {
        const b = binder("postgres");
        return b.statement(sql(b.text(owner)));
      };
      // One transaction. The usage row is made to exist first (a zero row marked -infinity, which nobody else sees
      // before the commit), then locked, so every reserve of this owner either committed before the recount or waits
      // behind it: in READ COMMITTED the recount takes its snapshot after the lock. An upsert recount would compute its
      // values before waiting for a reserve that inserted the row meanwhile, and drop that reserve's bytes. The marked
      // row is removed again when the recount left it at zeros: an owner counted as all zeros gets no row.
      const [, , changed] = await executor.batch([
        forOwner(
          (who) => `INSERT INTO ${usage} (owner, reserved_bytes, active_bytes, files, updated_at)
            VALUES (${who}, 0, 0, 0, '-infinity') ON CONFLICT (owner) DO NOTHING`,
        ),
        forOwner((who) => `SELECT 1 FROM ${usage} WHERE owner = ${who} FOR UPDATE`),
        forOwner(
          (who) => `UPDATE ${usage} SET reserved_bytes = counted.reserved, active_bytes = counted.active,
              files = counted.files, updated_at = now()
            FROM (SELECT ${RECOUNT.reserved} AS reserved, ${RECOUNT.active} AS active, ${RECOUNT.files} AS files
              FROM ${files} WHERE owner = ${who}) AS counted
            WHERE ${usage}.owner = ${who} AND (${usage}.reserved_bytes, ${usage}.active_bytes, ${usage}.files)
              IS DISTINCT FROM (counted.reserved, counted.active, counted.files)
            RETURNING ${usage}.owner`,
        ),
        forOwner((who) => `DELETE FROM ${usage} WHERE owner = ${who} AND updated_at = '-infinity'`),
      ]);
      return (changed?.length ?? 0) > 0;
    },
  };
}
