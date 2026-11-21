// One owner's listings answer the rows 0.5.0 answered, in its order (M11-R190). Since 0.6 the statement is written
// another way on Postgres, to keep its plan beside the `created_at` index; here every page of it is compared with
// 0.5.0's own statement, read whole, on rows whose ids sort differently in byte order and in a language's order and
// whose `created_at` is shared by six files at a time, so every page boundary falls inside a tie.

import { describe, expect, test } from "vitest";
import { pgExecutor, sqliteExecutor, sqlStore } from "../../adapters/sql.ts";
import type { CloudropStore, FileStatus } from "../../server/store.ts";
import { usePostgresDatabase } from "../../testing/db/postgres.ts";
import type { Dialect, TestDatabase } from "../../testing/db/schema.ts";
import { useSqliteDatabase } from "../../testing/db/sqlite.ts";

const START = Date.parse("2026-11-17T12:00:00.000Z");
const STATUSES = ["completed", "completed", "completed", "pending", "completed", "deleted", "completed", "aborted"];
const TYPES = ["image/png", "image/jpeg", "text/plain", "application/pdf", "image/png"];
const LIVE = ["pending", "completing", "completed"] as const;
const EVERY: readonly FileStatus[] = [...LIVE, "aborted", "rejected", "failed", "expired", "deleted"];

/** 900 files of "u-1" (most), "u-2" and nobody, six to an instant, ids "f-<n>" and "F-<n>". */
async function seed(db: TestDatabase): Promise<void> {
  const text = (value: string | null) => (value === null ? "NULL" : `'${value}'`);
  const time = (ms: number) => (db.dialect === "postgres" ? `'${new Date(ms).toISOString()}'` : String(ms));
  const rows = Array.from({ length: 900 }, (_, index) => {
    const n = index + 1;
    const owner = n % 4 === 0 ? "u-2" : n % 9 === 0 ? null : "u-1";
    const created = time(START + Math.floor(n / 6) * 60_000);
    const values = [
      text(`${n % 3 === 0 ? "F" : "f"}-${n}`),
      text(n % 5 < 3 ? "docs" : "images"),
      text(`k-${n}`),
      text(owner),
      text(STATUSES[n % STATUSES.length] ?? "completed"),
      text(n % 7 < 2 ? `Report-${n}.PDF` : `file-${n}.txt`),
      text(TYPES[n % TYPES.length] ?? "text/plain"),
      "1",
      created,
      created,
      created,
    ];
    return `(${values.join(", ")})`;
  });
  await db.query(`INSERT INTO cloudrop_files
    (id, route, key, owner, status, name, type, size, expires_at, created_at, updated_at) VALUES ${rows.join(", ")}`);
}

const FOLDED = "translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')";
const completed = { statuses: ["completed"], order: "newest" } as const;
type Listing = Partial<Parameters<CloudropStore["list"]>[0]> & Pick<Parameters<CloudropStore["list"]>[0], "statuses">;

/**
 * Each caller of `list`: the conditions 0.5.0 wrote after the owner (from
 * `git show v0.5.0:packages/cloudrop/src/store/sql/reads.ts`), and the call that must answer the same rows.
 */
const LISTINGS: [name: string, before: (dialect: Dialect) => string, listing: Listing][] = [
  ["api.files", () => "status IN ('completed')", completed],
  ["api.files, oldest first", () => "status IN ('completed')", { ...completed, order: "oldest" }],
  ["a status few files are in", () => "status IN ('deleted')", { ...completed, statuses: ["deleted"] }],
  [
    "on a route, as replace reads it",
    () => "status IN ('completed') AND route = 'docs'",
    { ...completed, route: "docs" },
  ],
  ["by type", () => "status IN ('completed') AND type = 'image/png'", { ...completed, type: "image/png" }],
  [
    "by a type's family",
    () => "status IN ('completed') AND substr(type, 1, 6) = 'image/'",
    { ...completed, type: "image/" },
  ],
  [
    "by name",
    (dialect) =>
      `status IN ('completed') AND ${dialect === "postgres" ? `strpos(${FOLDED}, 'report')` : "instr(lower(name), 'report')"} > 0`,
    { ...completed, name: "report" },
  ],
  [
    "live statuses, oldest first",
    () => "status IN ('pending', 'completing', 'completed')",
    { statuses: LIVE, order: "oldest" },
  ],
  [
    "eraseOwner's statuses",
    () => "status IN ('pending', 'completing', 'completed', 'aborted', 'rejected', 'failed', 'expired', 'deleted')",
    { statuses: EVERY },
  ],
];

/** Every id of 0.5.0's statement for "u-1", in its order. */
async function idsBefore(db: TestDatabase, conditions: string, order: "newest" | "oldest"): Promise<string[]> {
  const direction = order === "newest" ? "DESC" : "ASC";
  const id = db.dialect === "postgres" ? 'id COLLATE "C"' : "id";
  const rows = await db.query(`SELECT id FROM cloudrop_files WHERE owner = 'u-1' AND ${conditions}
    ORDER BY created_at ${direction}, ${id} ${direction}`);
  return rows.map((row) => String(row.id));
}

/** Every id the store answers for the listing, read in pages of 25 from each page's cursor. */
async function idsNow(store: CloudropStore, listing: Listing): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await store.list({
      ...{ owner: "u-1", route: null, name: null, type: null, order: "newest", limit: 25 },
      ...listing,
      cursor,
    });
    ids.push(...page.records.map((record) => record.id));
    cursor = page.cursor;
  } while (cursor !== null);
  return ids;
}

function answersAsBefore(open: () => Promise<{ db: TestDatabase; store: CloudropStore }>): void {
  test.each(LISTINGS)("%s: the pages are 0.5.0's rows in 0.5.0's order", async (_name, before, listing) => {
    const { db, store } = await open();
    await seed(db);
    const expected = await idsBefore(db, before(db.dialect), listing.order ?? "newest");
    // More than one page, or the cursor is never read.
    expect(expected.length).toBeGreaterThan(25);
    expect(await idsNow(store, listing)).toEqual(expected);
  });
}

describe("Postgres", () => {
  const db = usePostgresDatabase();
  answersAsBefore(async () => {
    await db.reset();
    await db.createTables();
    return { db, store: sqlStore(pgExecutor(db.pool)) };
  });
});

describe("SQLite", () => {
  const db = useSqliteDatabase();
  answersAsBefore(async () => {
    await db.createTables();
    return { db, store: sqlStore(sqliteExecutor(db.database)) };
  });
});
