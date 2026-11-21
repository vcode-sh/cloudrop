// stale on real tables, beyond the store contract (M11-R66): each page of sweep work is read as index ranges that stop
// after a page of rows, however many rows wait. Read as one condition over the statuses, Postgres found every matching
// row and sorted them for each page (6,996 buffers for 101 rows of 58,750, measured on 360,000 rows).

import { beforeEach, describe, expect, test } from "vitest";
import { pgExecutor, sqliteExecutor, sqlStore } from "../../adapters/sql.ts";
import { usePostgresDatabase } from "../../testing/db/postgres.ts";
import { useSqliteDatabase } from "../../testing/db/sqlite.ts";
import type { SqlExecutor, SqlStatement } from "./executor.ts";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const HOUR = 3_600_000;
const KINDS = ["expire", "cleanup"] as const;

/** Runs the store's `stale` for a page of 100 and answers the statement it ran. */
async function staleStatement(
  executor: Omit<SqlExecutor<unknown>, "transaction">,
  kind: "expire" | "cleanup",
): Promise<SqlStatement> {
  const statements: SqlStatement[] = [];
  const store = sqlStore({
    dialect: executor.dialect,
    batch: (batch) => executor.batch(batch),
    query: (sql, params) => {
      statements.push({ sql, params });
      return executor.query(sql, params);
    },
  });
  const before = new Date(NOW - HOUR);
  const page = await store.stale({ kind, before, claimedBefore: new Date(NOW), limit: 100, cursor: null });
  expect(page.records).toHaveLength(100);
  const statement = statements.at(-1);
  if (!statement) throw new Error("The store ran no statement.");
  return statement;
}

describe("Postgres", () => {
  const db = usePostgresDatabase();
  beforeEach(async () => {
    await db.reset();
    await db.createTables();
  });

  // 24,000 rows and an ANALYZE, about 200 ms: the planner reads a small table whole, whatever the statement.
  test.for(KINDS)("a page of %s work reads a page of rows from each status, not every waiting row", async (kind) => {
    // Every row waits: 12,000 unfinished uploads past their deadline, half of them claimed long ago, and 12,000 ended
    // ones not yet cleaned, in four statuses.
    await db.query(`INSERT INTO cloudrop_files (id, route, key, owner, status, name, type, size, claimed_at,
        expires_at, created_at, updated_at, ended_at)
      SELECT 'f-' || md5(n::text), 'docs', 'k-' || n, 'u-' || (n % 100),
        (ARRAY['pending', 'completing', 'aborted', 'expired', 'failed', 'deleted', 'pending', 'completing'])[n % 8 + 1],
        'f.txt', 'text/plain', 1, CASE WHEN n % 8 IN (1, 7) THEN timestamptz '2026-11-01' END,
        timestamptz '2026-11-20' - n % 5000 * interval '1 second', now(), now(),
        CASE WHEN n % 8 BETWEEN 2 AND 5 THEN timestamptz '2026-11-20' - n % 5000 * interval '1 second' END
      FROM generate_series(1, 24000) AS n`);
    await db.query("ANALYZE cloudrop_files");
    const { sql, params } = await staleStatement(pgExecutor(db.pool), kind);
    const [row] = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
    const plan = JSON.stringify(row);
    const scans = [...plan.matchAll(/"Node Type":\s*"([^"]*Scan)"/g)].map(([, node]) => node);
    // Only index and subquery scans: a bitmap or sequential scan would read every waiting row before sorting.
    expect(scans.filter((node) => node !== "Index Scan" && node !== "Subquery Scan")).toEqual([]);
    const index = kind === "expire" ? "status_expires_at" : "status_cleaned_at_ended_at";
    const indexes = [...plan.matchAll(/"Index Name":\s*"cloudrop_files_([^"]+)_idx"/g)].map(([, name]) => name);
    expect(indexes).toEqual(Array.from({ length: kind === "expire" ? 2 : 5 }, () => index));
    // Each range hands on at most a page and the row that shows another follows, plus the ties it had to read to
    // order by id: far from the 12,000 rows that wait.
    const read = [...plan.matchAll(/"Node Type":\s*"Index Scan".*?"Actual Rows":\s*([\d.]+)/g)].map(([, rows]) =>
      Number(rows),
    );
    expect(read.filter((rows) => rows > 150)).toEqual([]);
  });
});

describe("SQLite", () => {
  const db = useSqliteDatabase();
  beforeEach(() => db.createTables());

  test.for(KINDS)(
    "a page of %s work is read along each status's index, sorting only rows of one time",
    async (kind) => {
      const insert = `INSERT INTO cloudrop_files (id, route, key, status, name, type, size, claimed_at, expires_at,
      created_at, updated_at, ended_at) VALUES (?, 'docs', 'k', ?, 'f.txt', 'text/plain', 1, 0, ?, 0, 0, ?)`;
      for (let n = 0; n < 600; n++) {
        const status = ["pending", "completing", "aborted", "expired", "failed", "deleted"][n % 6];
        await db.query(insert, [`f-${n}`, status, n, n % 6 > 1 ? n : null]);
      }
      const { sql, params } = await staleStatement(sqliteExecutor(db.database), kind);
      const steps = (await db.query(`EXPLAIN QUERY PLAN ${sql}`, params)).map((step) => String(step.detail));
      const index =
        kind === "expire"
          ? "status_expires_at_idx (status=? AND expires_at<?)"
          : "status_cleaned_at_ended_at_idx (status=? AND cleaned_at=? AND ended_at<?)";
      expect(steps.filter((step) => step.startsWith("SEARCH"))).toEqual(
        Array.from(
          { length: kind === "expire" ? 2 : 5 },
          () => `SEARCH cloudrop_files USING INDEX cloudrop_files_${index}`,
        ),
      );
      // "LAST TERM": the index gives the time order and only the ids of one time are sorted, so a range stops after a
      // page. A range that sorted all its rows would say "FOR ORDER BY" directly under its SEARCH.
      const underSearch = steps.filter((_, at) => steps[at - 1]?.startsWith("SEARCH"));
      expect([...new Set(underSearch)]).toEqual(["USE TEMP B-TREE FOR LAST TERM OF ORDER BY"]);
    },
  );
});
