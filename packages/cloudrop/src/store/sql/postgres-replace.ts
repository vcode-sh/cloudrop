// complete with `replace` on Postgres: one batch of two statements. The first takes a transaction-scoped advisory lock
// on the file's owner and route, so replacing completions of one owner and route take turns; the second, run with a
// snapshot taken after the lock, completes the file, ends the owner's other completed files on the route as deleted
// and moves the usage in one statement. A single statement could not do it: its snapshot would predate the other
// completion's commit, so neither would see the other's file as completed and both would keep theirs.

import type { Completion } from "../../server/store.ts";
import { binder } from "./bind.ts";
import { runStatement } from "./executor.ts";
import { type SqlContext, selectRecord } from "./reads.ts";
import { RECORD_COLUMNS, toRecord } from "./records.ts";

/** The record columns qualified with `alias`, for a statement that joins two copies of the files table. */
const qualifiedColumns = (alias: string): string =>
  RECORD_COLUMNS.split(", ")
    .map((column) => `${alias}.${column}`)
    .join(", ");

export function replacingComplete({ executor, tables }: SqlContext) {
  const { files, usage } = tables;

  return async (id: string, claim: string, result: string | null, now: Date): Promise<Completion> => {
    // Lock order: the advisory lock, then the file rows (the new one, then the replaced ones), then the usage row. Only
    // replacing completions take the advisory lock, and every other writer locks file rows before the usage row.
    const lock = binder("postgres");
    // The lock function returns void, which some drivers cannot read (Prisma): the statement answers a count instead.
    const locked = lock.statement(`WITH locked AS (
        SELECT pg_advisory_xact_lock(hashtextextended(
          'cloudrop replace ' || ${lock.text(files)} || ' ' || owner || ' ' || route, 0))
        FROM ${files} WHERE id = ${lock.text(id)} AND status = 'completing' AND claim = ${lock.text(claim)}
          AND owner IS NOT NULL
      )
      SELECT count(*) AS locked FROM locked`);
    const b = binder("postgres");
    const [key, at] = [b.text(id), b.time(now)];
    // The replaced files' sum and count sit in the usage update's SET list, which is computed before that update locks
    // the usage row, so the replaced rows are locked first, as in every other writer.
    const sql = `WITH changed AS (
        UPDATE ${files} SET status = 'completed', result = ${b.text(result)}, completed_at = ${at}, updated_at = ${at}
        WHERE id = ${key} AND status = 'completing' AND claim = ${b.text(claim)}
        RETURNING ${RECORD_COLUMNS}
      ),
      replaced AS (
        UPDATE ${files} AS f SET status = 'deleted', ended_at = ${at}, updated_at = ${at}
        FROM changed WHERE f.owner = changed.owner AND f.route = changed.route AND f.status = 'completed'
          AND f.id <> changed.id
        RETURNING ${qualifiedColumns("f")}
      ),
      counted AS (
        UPDATE ${usage} SET reserved_bytes = reserved_bytes - changed.size,
          active_bytes = active_bytes + changed.size - (SELECT coalesce(sum(size), 0) FROM replaced),
          files = files + 1 - (SELECT count(*) FROM replaced), updated_at = ${at}
        FROM changed WHERE ${usage}.owner = changed.owner
      )
      SELECT 'changed' AS part, ${RECORD_COLUMNS} FROM changed
      UNION ALL
      SELECT 'replaced', ${RECORD_COLUMNS} FROM replaced
      UNION ALL
      SELECT 'found', ${RECORD_COLUMNS} FROM ${files} WHERE id = ${key} AND NOT EXISTS (SELECT 1 FROM changed)`;
    const [, rows = []] = await executor.batch([locked, b.statement(sql)]);
    const changed = rows.find((row) => row.part === "changed");
    if (changed) {
      const replaced = rows.filter((row) => row.part === "replaced").map(toRecord);
      return { changed: true, record: toRecord(changed), replaced };
    }
    const found = rows.find((row) => row.part === "found");
    if (found?.status !== "completing") return { changed: false, record: found ? toRecord(found) : null, replaced: [] };
    // Unchanged, yet still completing: the update waited for another transaction that took the row over, while this
    // statement's snapshot still shows the row as it was. Read it as it is now.
    const [current] = await runStatement(executor, selectRecord("postgres", files, id));
    return { changed: false, record: current ? toRecord(current) : null, replaced: [] };
  };
}
