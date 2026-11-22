// The erase mark's writes (M12-O1), the same statements on both dialects but for their placeholders. The mark is two
// columns of the owner's usage row, so marking takes the row lock every reserve of the owner takes first: a reserve
// either commits before the mark or reads it and refuses.

import type { StoreErasure } from "../../server/store.ts";
import { binder } from "./bind.ts";
import { runStatement } from "./executor.ts";
import type { SqlContext } from "./reads.ts";
import { toErasure } from "./records.ts";

/** The mark's writes; `erasing`, a read of one table, is in reads.ts beside `owners`. */
export function erasureMethods({ executor, dialect, tables }: SqlContext): Omit<StoreErasure, "erasing"> {
  const { usage } = tables;

  return {
    async markErasure({ owner, now }) {
      // Two statements in one batch. The upsert creates a zero row or locks the one there, and sets a mark only where
      // there is none. The read after it takes its own snapshot on Postgres, so it sees the mark whoever set it, also
      // one a concurrent call committed after the upsert's snapshot.
      // Bound inline, each time: SQLite's `?` placeholders take one value each, in the order they appear.
      const b = binder(dialect);
      const mark = b.statement(`INSERT INTO ${usage}
          (owner, reserved_bytes, active_bytes, files, updated_at, erase_requested_at, erased_at)
        VALUES (${b.text(owner)}, 0, 0, 0, ${b.time(now)}, ${b.time(now)}, NULL)
        ON CONFLICT (owner) DO UPDATE SET erase_requested_at = excluded.erase_requested_at, erased_at = NULL,
          updated_at = excluded.updated_at
        WHERE ${usage}.erase_requested_at IS NULL`);
      const r = binder(dialect);
      const read = r.statement(`SELECT erase_requested_at, erased_at FROM ${usage} WHERE owner = ${r.text(owner)}`);
      const [, rows] = await executor.batch([mark, read]);
      const erasure = toErasure(rows?.[0]);
      if (!erasure) throw new Error(`The usage row of ${owner} has no erase mark right after it was marked.`);
      return erasure;
    },

    async erased({ owner, requestedAt, now }) {
      const b = binder(dialect);
      const finish = b.statement(`UPDATE ${usage} SET erased_at = ${b.time(now)}, updated_at = ${b.time(now)}
        WHERE owner = ${b.text(owner)} AND erase_requested_at = ${b.time(requestedAt)} AND erased_at IS NULL`);
      const r = binder(dialect);
      const finished = r.statement(`SELECT 1 AS finished FROM ${usage}
        WHERE owner = ${r.text(owner)} AND erase_requested_at = ${r.time(requestedAt)} AND erased_at IS NOT NULL`);
      const [, rows] = await executor.batch([finish, finished]);
      return (rows?.length ?? 0) > 0;
    },

    async reopen({ owner, now }) {
      const b = binder(dialect);
      const sql = `UPDATE ${usage} SET erase_requested_at = NULL, erased_at = NULL, updated_at = ${b.time(now)}
        WHERE owner = ${b.text(owner)} AND erase_requested_at IS NOT NULL RETURNING owner`;
      return (await runStatement(executor, b.statement(sql))).length > 0;
    },
  };
}
