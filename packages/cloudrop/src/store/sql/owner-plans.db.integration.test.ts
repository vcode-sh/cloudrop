// What the `created_at` index of 0.6 may cost the statements that were there before it (M11-R190). Postgres plans each
// statement from its statistics, and ANALYZE reads a different sample every time, so a statement that is priced about
// the same on two indexes changes its plan from one ANALYZE to the next. Every plan here is therefore read again after
// each of 20 ANALYZE runs, on a table large enough for the planner to weigh its indexes as it does in production.

import { beforeAll, describe, expect, test } from "vitest";
import { pgExecutor, sqliteExecutor, sqlStore } from "../../adapters/sql.ts";
import type { CloudropStore } from "../../server/store.ts";
import { type PostgresTestDatabase, usePostgresDatabase } from "../../testing/db/postgres.ts";
import { useSqliteDatabase } from "../../testing/db/sqlite.ts";
import type { SqlExecutor, SqlStatement } from "./executor.ts";

const ROUNDS = 20;
const OWNER_INDEX = "cloudrop_files_owner_status_created_at_idx";
const TIME_INDEX = "cloudrop_files_created_at_idx";
const START = Date.parse("2026-01-01T00:00:00.000Z");
/** The cursor after file `n`: files are a minute apart. */
const after = (n: number) => `${START + n * 60_000}:f-${n}`;

// 310,000 files a minute apart. "u-churned" holds the oldest 10,000, all completed: its newest file is 300,000 rows
// deep in `created_at`. Of the rest, every twentieth is "u-big"'s and the others are spread over 5,000 owners, in five
// statuses, on three routes (one with 1% of the files), an eighth of them PDFs named "Report-<n>.pdf".
const FILES = `INSERT INTO cloudrop_files
    (id, route, key, owner, status, name, type, size, expires_at, created_at, updated_at, ended_at)
  SELECT 'f-' || n, CASE WHEN n % 100 < 60 THEN 'docs' WHEN n % 100 < 99 THEN 'images' ELSE 'rare' END, 'k-' || n,
    CASE WHEN n <= 10000 THEN 'u-churned' WHEN n % 20 = 0 THEN 'u-big' ELSE 'u-' || (n % 5000) END, status,
    CASE WHEN n % 8 = 0 THEN 'Report-' || n || '.pdf' ELSE 'f-' || n || '.txt' END,
    CASE WHEN n % 8 = 0 THEN 'application/pdf' ELSE 'text/plain' END, 1, at + interval '1 hour', at, at,
    CASE WHEN status IN ('deleted', 'aborted', 'expired') THEN at END
  FROM generate_series(1, 310000) AS n,
    LATERAL (SELECT timestamptz '2026-01-01' + n * interval '1 minute' AS at,
      CASE WHEN n <= 10000 OR n % 50 < 40 THEN 'completed' WHEN n % 50 < 44 THEN 'deleted'
        WHEN n % 50 < 47 THEN 'aborted' WHEN n % 50 < 49 THEN 'pending' ELSE 'expired' END AS status) AS row`;

const PAGE = { route: null, name: null, type: null, order: "newest", limit: 100, cursor: null } as const;
const COMPLETED = { ...PAGE, statuses: ["completed"] } as const;
const EVERY_STATUS = [
  "pending",
  "completing",
  "completed",
  "aborted",
  "rejected",
  "failed",
  "expired",
  "deleted",
] as const;

type Call = (store: CloudropStore) => Promise<unknown>;
const listAll = (input: Parameters<NonNullable<CloudropStore["listAll"]>>[0]): Call => {
  return (store) => {
    if (!store.listAll) throw new Error("sqlStore has no listAll.");
    return store.listAll(input);
  };
};

/**
 * Every listing that names an owner, with the most buffers a page may read. A page of 100 in one status is a range of
 * the owner index: 0.5.0 read 3 to 49 buffers for these, and 169 on the rare route (two indexes joined). By a type's
 * family 0.5.0 read every file of the owner and sorted them (228 and 5,102 buffers); that is a page now (M11-R192).
 * In several statuses or none the owner's rows are read and sorted, as in 0.5.0: 228 buffers for the 10,000 files of
 * "u-churned". A walk of `created_at` to that owner's first file reads 5,900.
 */
const OWNER_LISTINGS: [name: string, atMost: number, call: Call][] = [
  ["api.files", 150, (store) => store.list({ ...COMPLETED, owner: "u-churned" })],
  ["oldest first", 150, (store) => store.list({ ...COMPLETED, owner: "u-churned", order: "oldest" })],
  ["after a cursor", 150, (store) => store.list({ ...COMPLETED, owner: "u-churned", cursor: after(5000) })],
  ["on a route, as replace reads it", 150, (store) => store.list({ ...COMPLETED, owner: "u-churned", route: "docs" })],
  ["on a route few files have", 250, (store) => store.list({ ...COMPLETED, owner: "u-churned", route: "rare" })],
  ["by name", 150, (store) => store.list({ ...COMPLETED, owner: "u-churned", name: "report" })],
  ["by type", 150, (store) => store.list({ ...COMPLETED, owner: "u-churned", type: "application/pdf" })],
  ["by a type's family", 150, (store) => store.list({ ...COMPLETED, owner: "u-churned", type: "text/" })],
  ["a status the owner has no file in", 150, listAll({ ...PAGE, owner: "u-churned", status: "pending" })],
  ["a recent owner of 15,000", 150, (store) => store.list({ ...COMPLETED, owner: "u-big" })],
  [
    "a recent owner, after a cursor",
    150,
    (store) => store.list({ ...COMPLETED, owner: "u-big", cursor: after(160000) }),
  ],
  [
    "a recent owner, oldest first, the last page",
    150,
    (store) => store.list({ ...COMPLETED, owner: "u-big", order: "oldest", cursor: after(309000) }),
  ],
  ["a recent owner, by a type's family", 150, (store) => store.list({ ...COMPLETED, owner: "u-big", type: "text/" })],
  ["an owner of 60", 150, (store) => store.list({ ...COMPLETED, owner: "u-42" })],
  ["an owner without files", 150, (store) => store.list({ ...COMPLETED, owner: "u-nobody" })],
  ["eraseOwner's statuses", 400, (store) => store.list({ ...PAGE, owner: "u-churned", statuses: EVERY_STATUS })],
  [
    "several statuses, after a cursor",
    400,
    (store) => store.list({ ...PAGE, owner: "u-churned", statuses: EVERY_STATUS, cursor: after(5000) }),
  ],
  ["api.allFiles with an owner", 400, listAll({ ...PAGE, owner: "u-churned", status: null })],
];

/** The listings the index is for: they must keep reading it. */
const EVERY_OWNER_LISTINGS: [name: string, call: Call][] = [
  ["api.allFiles", listAll({ ...PAGE, owner: null, status: null })],
  ["api.allFiles in a status", listAll({ ...PAGE, owner: null, status: "completed" })],
  ["api.allFiles after a cursor", listAll({ ...PAGE, owner: null, status: null, cursor: after(160000) })],
];

const NOW = new Date(START + 400_000 * 60_000);
const NEW_FILE = { id: "f-new", route: "docs", key: "k-new", name: "a.txt", type: "text/plain", size: 1 };
const RESERVE = {
  owner: "u-new",
  limit: 1_000_000,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  requestKey: "request-1",
  files: [{ ...NEW_FILE, metadata: null }],
};
const SWEEP = { before: NOW, claimedBefore: NOW, limit: 100, cursor: null };

/**
 * Every other call of the store that reads the files table, run for real, in this order, for an owner the table does
 * not know: a reserve that supersedes, the transitions of its file, revoke, reconcile, the owners page and the sweep's
 * pages.
 */
const OTHER_CALLS: [name: string, call: Call][] = [
  ["reserve superseding", (store) => store.reserve(RESERVE, NOW)],
  ["attach", (store) => store.attach("f-new", "upload-1", NOW)],
  ["claim", (store) => store.claim("f-new", "claim-1", NOW, 60_000)],
  ["release", (store) => store.release("f-new", "claim-1", NOW)],
  ["claim again", (store) => store.claim("f-new", "claim-2", NOW, 60_000)],
  ["complete replacing", (store) => store.complete("f-new", "claim-2", null, NOW, { replace: true })],
  ["get", (store) => store.get("f-new")],
  ["end", (store) => store.end("f-new", "completed", "deleted", NOW)],
  ["cleaned", (store) => store.cleaned("f-new", NOW)],
  ["revoke", (store) => store.revoke("u-new", NOW)],
  ["reconcile", (store) => store.reconcile("u-new")],
  ["usage", (store) => store.usage("u-new")],
  ["owners", (store) => store.owners("u-1", 100)],
  ["sweep expire", (store) => store.stale({ ...SWEEP, kind: "expire" })],
  ["sweep expire, after a cursor", (store) => store.stale({ ...SWEEP, kind: "expire", cursor: after(200000) })],
  ["sweep cleanup", (store) => store.stale({ ...SWEEP, kind: "cleanup" })],
  ["sweep cleanup, after a cursor", (store) => store.stale({ ...SWEEP, kind: "cleanup", cursor: after(200000) })],
];

type Ran = (call: Call) => Promise<SqlStatement[]>;

/** A store over `executor`, as a function that makes one call and answers the statements the call ran. */
function recording(executor: Omit<SqlExecutor<unknown>, "transaction">): Ran {
  const recorded: SqlStatement[] = [];
  const store = sqlStore({
    dialect: executor.dialect,
    query: (sql, params) => {
      recorded.push({ sql, params });
      return executor.query(sql, params);
    },
    batch: (statements) => {
      recorded.push(...statements);
      return executor.batch(statements);
    },
  });
  return async (call) => {
    const before = recorded.length;
    await call(store);
    return recorded.slice(before);
  };
}

interface PlanNode {
  "Index Name"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

const indexesOf = (node: PlanNode): string[] => [
  ...(node["Index Name"] === undefined ? [] : [node["Index Name"]]),
  ...(node.Plans ?? []).flatMap(indexesOf),
];

/** The indexes Postgres reads for a statement, and, when it is run, the buffers it read. */
async function planOf(db: PostgresTestDatabase, { sql, params }: SqlStatement, run: boolean) {
  const rows = await db.query(`EXPLAIN (${run ? "ANALYZE, BUFFERS, " : ""}FORMAT JSON) ${sql}`, params);
  // node-postgres parses the json column: one row, one plan tree per statement.
  const [{ Plan: plan }] = (rows as [{ "QUERY PLAN": [{ Plan: PlanNode }] }])[0]["QUERY PLAN"];
  return { indexes: indexesOf(plan), buffers: (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0) };
}

/** One statement of a named call, and whether its plan is read by running it. */
interface Planned {
  name: string;
  statement: SqlStatement;
  run: boolean;
}

/** The statements of every call in `calls`, each under its call's name. */
async function statementsOf(ran: Ran, calls: [name: string, call: Call][], run: boolean): Promise<Planned[]> {
  const planned: Planned[] = [];
  for (const [name, call] of calls) {
    for (const statement of await ran(call)) planned.push({ name, statement, run });
  }
  return planned;
}

/** For each call by name: every index a round's plan read, and the most buffers a round read. */
async function plansOverRounds(db: PostgresTestDatabase, planned: Planned[]) {
  const seen = new Map<string, { indexes: Set<string>; buffers: number }>();
  for (let round = 0; round < ROUNDS; round++) {
    await db.query("ANALYZE cloudrop_files");
    for (const { name, statement, run } of planned) {
      const plan = await planOf(db, statement, run);
      const entry = seen.get(name) ?? { indexes: new Set<string>(), buffers: 0 };
      for (const index of plan.indexes) entry.indexes.add(index);
      seen.set(name, { indexes: entry.indexes, buffers: Math.max(entry.buffers, plan.buffers) });
    }
  }
  return seen;
}

describe("Postgres, over 20 rounds of ANALYZE", () => {
  const db = usePostgresDatabase();
  let seen: Awaited<ReturnType<typeof plansOverRounds>>;
  let others: string[];

  // About 6 seconds: 310,000 rows through seven indexes, then 20 times an ANALYZE and 60 plans.
  beforeAll(async () => {
    await db.createTables();
    await db.query(FILES);
    const ran = recording(pgExecutor(db.pool));
    // The first call also checks the schema: those statements are not the store's work.
    await ran((first) => first.usage("u-new"));
    const listings = OWNER_LISTINGS.map(([name, , call]): [string, Call] => [name, call]);
    // Writes are planned, not run again: EXPLAIN without ANALYZE changes nothing.
    const other = await statementsOf(ran, OTHER_CALLS, false);
    others = [...new Set(other.map(({ name }) => name))];
    seen = await plansOverRounds(db, [
      ...(await statementsOf(ran, listings, true)),
      ...(await statementsOf(ran, EVERY_OWNER_LISTINGS, true)),
      ...other,
    ]);
  }, 120_000);

  const read = (name: string) => {
    const entry = seen.get(name);
    if (!entry) throw new Error(`No plan was read for "${name}".`);
    return { name, indexes: [...entry.indexes].sort(), buffers: entry.buffers };
  };

  test("a listing that names an owner never reads the created_at index, and reads what 0.5.0 read", () => {
    const listings = OWNER_LISTINGS.map(([name, atMost]) => ({ ...read(name), atMost }));
    expect(listings.filter(({ indexes }) => indexes.includes(TIME_INDEX))).toEqual([]);
    expect(listings.filter(({ indexes }) => !indexes.includes(OWNER_INDEX))).toEqual([]);
    expect(listings.filter(({ buffers, atMost }) => buffers > atMost)).toEqual([]);
  });

  test("a listing of every owner still reads along the created_at index", () => {
    expect(EVERY_OWNER_LISTINGS.map(([name]) => read(name)).map(({ name, indexes }) => ({ name, indexes }))).toEqual(
      EVERY_OWNER_LISTINGS.map(([name]) => ({ name, indexes: [TIME_INDEX] })),
    );
  });

  test("no other statement of the store reads the created_at index", () => {
    expect(others).toEqual(OTHER_CALLS.map(([name]) => name));
    expect(others.map(read).filter(({ indexes }) => indexes.includes(TIME_INDEX))).toEqual([]);
  });
});

// SQLite plans by rule and by the averages ANALYZE keeps in sqlite_stat1, never by one owner's share, so there is no
// round to repeat: the same shape at a tenth of the size, read without statistics and again with them.
describe("SQLite", () => {
  const db = useSqliteDatabase();
  const SEARCH = "SEARCH cloudrop_files USING INDEX cloudrop_files_owner_status_created_at_idx";
  const LISTINGS: [name: string, readBy: string, call: Call][] = [
    ["api.files", `${SEARCH} (owner=? AND status=?)`, (store) => store.list({ ...COMPLETED, owner: "u-churned" })],
    [
      "after a cursor",
      `${SEARCH} (owner=? AND status=? AND created_at<?)`,
      (store) => store.list({ ...COMPLETED, owner: "u-churned", cursor: after(500) }),
    ],
    [
      "on a route, as replace reads it",
      `${SEARCH} (owner=? AND status=?)`,
      (store) => store.list({ ...COMPLETED, owner: "u-churned", route: "docs" }),
    ],
    [
      "eraseOwner's statuses",
      `${SEARCH} (owner=? AND status=?)`,
      (store) => store.list({ ...PAGE, owner: "u-churned", statuses: EVERY_STATUS }),
    ],
    ["api.allFiles with an owner", `${SEARCH} (owner=?)`, listAll({ ...PAGE, owner: "u-churned", status: null })],
    [
      "api.allFiles",
      "SCAN cloudrop_files USING INDEX cloudrop_files_created_at_idx",
      listAll({ ...PAGE, owner: null, status: "completed" }),
    ],
  ];

  test("one owner's rows are found by owner with and without statistics, every owner's along created_at", async () => {
    await db.createTables();
    await db.query(`WITH RECURSIVE numbers (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 31000)
      INSERT INTO cloudrop_files (id, route, key, owner, status, name, type, size, expires_at, created_at, updated_at)
      SELECT 'f-' || n, CASE WHEN n % 100 < 60 THEN 'docs' ELSE 'images' END, 'k-' || n,
        CASE WHEN n <= 1000 THEN 'u-churned' ELSE 'u-' || (n % 500) END,
        CASE WHEN n <= 1000 OR n % 50 < 40 THEN 'completed' WHEN n % 50 < 45 THEN 'deleted' ELSE 'pending' END,
        'f.txt', 'text/plain', 1, 0, ${START} + n * 60000, 0 FROM numbers`);
    const ran = recording(sqliteExecutor(db.database));
    await ran((first) => first.usage("u-churned"));
    /** What SQLite reads the table by, for each listing. */
    const readBy = async () => {
      const plans: [string, string][] = [];
      for (const [name, , call] of LISTINGS) {
        const [statement] = await ran(call);
        const [first] = await db.query(`EXPLAIN QUERY PLAN ${statement?.sql}`, statement?.params);
        plans.push([name, String(first?.detail)]);
      }
      return plans;
    };
    const expected = LISTINGS.map(([name, plan]) => [name, plan]);

    expect(await readBy()).toEqual(expected);
    await db.query("ANALYZE");
    expect(await db.query("SELECT count(*) AS indexes FROM sqlite_stat1")).toEqual([{ indexes: 9 }]);
    expect(await readBy()).toEqual(expected);
  });
});
