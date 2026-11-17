// The Postgres statements of the methods that write both tables or must decide in one step. Each is one statement:
// data-modifying CTEs run with the statement, so the files change and its usage change commit together, and a guarded
// UPDATE that waited for a row lock re-reads the row before it applies (READ COMMITTED), which is what makes a claim
// exclusive. reconcile alone is a two-statement batch: the lock first, so the recount takes a snapshot after it.

import type { FileStatus, NewFile } from "../../server/store.ts";
import { type Binder, binder } from "./bind.ts";
import { isUniqueViolation, runStatement } from "./executor.ts";
import { claimOutcome, RECOUNT, releaseFrom, transition } from "./outcomes.ts";
import type { SqlContext, StoreMethods } from "./reads.ts";
import { RECORD_COLUMNS, toSafeInteger } from "./records.ts";

type GuardedWrites = Pick<StoreMethods, "reserve" | "claim" | "complete" | "end" | "revoke" | "reconcile">;

const INPUT_COLUMNS = "ord integer, id text, route text, key text, name text, type text, size bigint, metadata text";
const INSERT_COLUMNS = "id, route, key, owner, status, name, type, size, metadata, expires_at, created_at, updated_at";

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

export function postgresWrites({ executor, tables }: SqlContext): GuardedWrites {
  const { files, usage } = tables;

  /**
   * Files and usage of one guarded transition, then the row: changed, or unchanged as found. `from` is the status the
   * update requires.
   */
  async function transitionRow(update: string, set: string | null, id: string, from: FileStatus, b: Binder) {
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
    const again = binder("postgres");
    const [current] = await runStatement(
      executor,
      again.statement(`SELECT ${RECORD_COLUMNS} FROM ${files} WHERE id = ${again.text(id)}`),
    );
    return transition(false, current);
  }

  return {
    async reserve({ owner, limit, expiresAt, files: accepted }, now) {
      if (accepted.length === 0) return [];
      const b = binder("postgres");
      const [input, expires, at] = [b.json(inputJson(accepted)), b.time(expiresAt), b.time(now)];
      if (owner === null) {
        await runStatement(
          executor,
          b.statement(`INSERT INTO ${files} (${INSERT_COLUMNS})
            SELECT id, route, key, NULL, 'pending', name, type, size, metadata, ${expires}, ${at}, ${at}
            FROM json_to_recordset(${input}) AS input(${INPUT_COLUMNS})`),
        );
        return accepted.map(() => "reserved" as const);
      }
      const who = b.text(owner);
      const fits = limit === null ? "true" : `decided.used + input.size <= ${b.bigint(limit)}`;
      // Without a limit, a first reserve racing another for the same new owner adds to the row the other created. With
      // one it cannot: its quota decisions assumed no row, so the insert fails on the unique owner and is run again.
      const onConflict =
        limit === null
          ? `ON CONFLICT (owner) DO UPDATE SET reserved_bytes = ${usage}.reserved_bytes + EXCLUDED.reserved_bytes,
              updated_at = EXCLUDED.updated_at`
          : "";
      // The usage row is locked before any decision, so concurrent reserves of one owner queue and each sees the
      // counters the previous one committed. `decided` walks the files in order, adding each that fits.
      const sql = `WITH RECURSIVE
        input AS (SELECT * FROM json_to_recordset(${input}) AS input(${INPUT_COLUMNS})),
        locked AS (SELECT reserved_bytes + active_bytes AS used FROM ${usage} WHERE owner = ${who} FOR UPDATE),
        decided (ord, used, reserved) AS (
          SELECT 0, coalesce((SELECT used FROM locked), 0), false
          UNION ALL
          SELECT input.ord, decided.used + CASE WHEN ${fits} THEN input.size ELSE 0 END, ${fits}
          FROM decided JOIN input ON input.ord = decided.ord + 1
        ),
        inserted AS (
          INSERT INTO ${files} (${INSERT_COLUMNS})
          SELECT input.id, input.route, input.key, ${who}, 'pending', input.name, input.type, input.size,
            input.metadata, ${expires}, ${at}, ${at}
          FROM input JOIN decided ON decided.ord = input.ord WHERE decided.reserved
          RETURNING size
        ),
        total AS (SELECT coalesce(sum(size), 0) AS bytes, count(*) AS reserved FROM inserted),
        counted AS (
          UPDATE ${usage} SET reserved_bytes = reserved_bytes + total.bytes, updated_at = ${at}
          FROM total WHERE owner = ${who} AND total.reserved > 0
        ),
        created AS (
          INSERT INTO ${usage} (owner, reserved_bytes, active_bytes, files, updated_at)
          SELECT ${who}, total.bytes, 0, 0, ${at} FROM total
          WHERE total.reserved > 0 AND NOT EXISTS (SELECT 1 FROM locked)
          ${onConflict}
        )
        SELECT reserved FROM decided WHERE ord > 0 ORDER BY ord`;
      const statement = b.statement(sql);
      const rows = await runStatement(executor, statement).catch((error: unknown) => {
        // A first reserve of this owner raced ours and created the usage row after our snapshot (see onConflict). The
        // failed statement rolled back whole; run again, it takes a new snapshot and its FOR UPDATE locks that row. A
        // duplicate file id fails the same way again and is thrown.
        if (limit === null || !isUniqueViolation(error)) throw error;
        return runStatement(executor, statement);
      });
      return rows.map((row) => (row.reserved === true ? "reserved" : "over-quota"));
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

    async complete(id, claim, result, now) {
      const b = binder("postgres");
      const at = b.time(now);
      const update = `UPDATE ${files} SET status = 'completed', result = ${b.text(result)}, completed_at = ${at},
        updated_at = ${at} WHERE id = ${b.text(id)} AND status = 'completing' AND claim = ${b.text(claim)}`;
      const set = `reserved_bytes = reserved_bytes - changed.size, active_bytes = active_bytes + changed.size,
        files = files + 1, updated_at = ${at}`;
      return transitionRow(update, set, id, "completing", b);
    },

    async end(id, from, to, now, options) {
      const b = binder("postgres");
      const at = b.time(now);
      const cleaned = options?.cleaned ? `, cleaned_at = ${at}` : "";
      const update = `UPDATE ${files} SET status = ${b.text(to)}, ended_at = ${at}, updated_at = ${at}${cleaned}
        WHERE id = ${b.text(id)} AND status = ${b.text(from)}`;
      const released = releaseFrom(from, "changed.size");
      return transitionRow(update, released && `${released}, updated_at = ${at}`, id, from, b);
    },

    async revoke(owner, now) {
      const b = binder("postgres");
      const [who, at] = [b.text(owner), b.time(now)];
      const sql = `WITH revoked AS (
          UPDATE ${files} SET status = 'aborted', ended_at = ${at}, updated_at = ${at}
          WHERE owner = ${who} AND status = 'pending' RETURNING size
        ),
        counted AS (
          UPDATE ${usage} SET reserved_bytes = reserved_bytes - (SELECT sum(size) FROM revoked), updated_at = ${at}
          WHERE owner = ${who} AND EXISTS (SELECT 1 FROM revoked)
        )
        SELECT count(*) AS revoked FROM revoked`;
      const [row] = await runStatement(executor, b.statement(sql));
      return toSafeInteger(row?.revoked, "revoked");
    },

    async reconcile(owner) {
      const lock = binder("postgres");
      const b = binder("postgres");
      const who = b.text(owner);
      // In READ COMMITTED each statement takes a new snapshot, so the recount, run after the lock, sees every reserve
      // committed before it; a reserve that starts later waits for the lock and adds to the recounted row.
      const recount = `INSERT INTO ${usage} (owner, reserved_bytes, active_bytes, files, updated_at)
        SELECT ${who}, ${RECOUNT.reserved}, ${RECOUNT.active}, ${RECOUNT.files}, now() FROM ${files} WHERE owner = ${who}
        HAVING count(CASE WHEN status IN ('pending', 'completing', 'completed') THEN 1 END) > 0
          OR EXISTS (SELECT 1 FROM ${usage} WHERE owner = ${who})
        ON CONFLICT (owner) DO UPDATE SET reserved_bytes = EXCLUDED.reserved_bytes,
          active_bytes = EXCLUDED.active_bytes, files = EXCLUDED.files, updated_at = EXCLUDED.updated_at
        WHERE (${usage}.reserved_bytes, ${usage}.active_bytes, ${usage}.files)
          IS DISTINCT FROM (EXCLUDED.reserved_bytes, EXCLUDED.active_bytes, EXCLUDED.files)
        RETURNING owner`;
      const [, changed] = await executor.batch([
        lock.statement(`SELECT 1 FROM ${usage} WHERE owner = ${lock.text(owner)} FOR UPDATE`),
        b.statement(recount),
      ]);
      return (changed?.length ?? 0) > 0;
    },
  };
}
