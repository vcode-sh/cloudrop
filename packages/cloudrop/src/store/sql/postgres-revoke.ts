// revoke on Postgres (M11-R240): one statement for the owner's pending rows that no other transaction holds, then one
// statement for each row that was held. Postgres keeps the lock of a row a statement waited for and then passed over
// because the row had changed, until the statement's transaction ends. A revoke that held such a lock while it waited
// for the next row deadlocked with a replacing completion in a transaction, which holds its own row and wants the
// passed-over one as a row to replace (40P01). So no statement of a revoke waits for a file row while it holds another.

import { binder } from "./bind.ts";
import { onceMoreAfterConflict, runStatement } from "./executor.ts";
import type { GuardedWrites, SqlContext } from "./reads.ts";
import { toSafeInteger } from "./records.ts";

export function revoking({ executor, tables }: SqlContext, end: GuardedWrites["end"]): GuardedWrites["revoke"] {
  const { files, usage } = tables;
  return async (owner, now) => {
    const b = binder("postgres");
    const [who, at] = [b.text(owner), b.time(now)];
    // SKIP LOCKED: the update takes the pending rows nobody holds and waits for none. The answer is the count, in the
    // row without an id, and beside it the owner's pending rows the update left: those another transaction held,
    // which this statement's snapshot still shows as they were.
    const sql = `WITH revoked AS (
        UPDATE ${files} SET status = 'aborted', ended_at = ${at}, updated_at = ${at}
        WHERE id IN (SELECT id FROM ${files} WHERE owner = ${who} AND status = 'pending' FOR UPDATE SKIP LOCKED)
        RETURNING id, size
      ),
      counted AS (
        UPDATE ${usage} SET reserved_bytes = reserved_bytes - (SELECT sum(size) FROM revoked), updated_at = ${at}
        WHERE owner = ${who} AND EXISTS (SELECT 1 FROM revoked)
      )
      SELECT count(*) AS revoked, NULL AS id FROM revoked
      UNION ALL
      SELECT NULL, id FROM ${files}
      WHERE owner = ${who} AND status = 'pending' AND id NOT IN (SELECT id FROM revoked)`;
    const rows = await runStatement(executor, b.statement(sql));
    let revoked = toSafeInteger(rows.find((row) => row.id === null)?.revoked, "revoked");
    // Each held row in a statement of its own, which waits for the row's holder (a completion in a transaction, until
    // it commits or rolls back) and ends the row only if it is still pending then.
    for (const { id } of rows) {
      if (id === null) continue;
      const ended = await onceMoreAfterConflict(() => end(String(id), "pending", "aborted", now));
      if (ended.changed) revoked += 1;
    }
    return revoked;
  };
}
