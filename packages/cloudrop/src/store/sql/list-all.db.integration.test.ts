// listAll on real tables, beyond the store contract (M11-L5 to M11-L8): a database that has not created the
// `created_at` index yet answers the same pages, and with the index each listing is read the way it was measured for:
// every owner's along `created_at`, one owner's by owner, whatever the planner would rather do.

import { beforeEach, describe, expect, test } from "vitest";
import { pgExecutor, sqliteExecutor, sqlStore } from "../../adapters/sql.ts";
import type { CloudropStore } from "../../server/store.ts";
import { usePostgresDatabase } from "../../testing/db/postgres.ts";
import type { TestDatabase } from "../../testing/db/schema.ts";
import { useSqliteDatabase } from "../../testing/db/sqlite.ts";
import type { SqlExecutor, SqlStatement } from "./executor.ts";

const T0 = Date.parse("2026-11-17T12:00:00.000Z");
const EVERY = {
  owner: null,
  status: null,
  route: null,
  name: null,
  type: null,
  order: "newest",
  cursor: null,
} as const;
const LIVE = ["pending", "completing", "completed"] as const;

type ListAll = NonNullable<CloudropStore["listAll"]>;

/** The store over `executor`, and the statement its last call ran. */
function recorded(executor: Omit<SqlExecutor<unknown>, "transaction">): {
  store: CloudropStore;
  listAll: ListAll;
  last(): SqlStatement;
} {
  const statements: SqlStatement[] = [];
  const store = sqlStore({
    dialect: executor.dialect,
    batch: (batch) => executor.batch(batch),
    query: (sql, params) => {
      statements.push({ sql, params });
      return executor.query(sql, params);
    },
  });
  const listAll: ListAll = (input) => {
    if (!store.listAll) throw new Error("sqlStore has no listAll.");
    return store.listAll(input);
  };
  return {
    store,
    listAll,
    last() {
      const statement = statements.at(-1);
      if (!statement) throw new Error("The store ran no statement.");
      return statement;
    },
  };
}

/** Three files a minute apart, of "u-1", "u-2" and nobody, and a fourth of "u-1" at the third one's instant. */
async function seed(store: CloudropStore): Promise<void> {
  const file = (id: string) => ({ id, route: "docs", key: id, name: `${id}.txt`, type: "text/plain", size: 1 });
  const rows = [
    ["f-1", "u-1", 1],
    ["f-2", "u-2", 2],
    ["f-3", null, 3],
    ["f-4", "u-1", 3],
  ] as const;
  for (const [id, owner, minutes] of rows) {
    const now = new Date(T0 + minutes * 60_000);
    const files = [{ ...file(id), metadata: null }];
    await store.reserve({ owner, limit: null, expiresAt: new Date(T0 + 86_400_000), requestKey: null, files }, now);
  }
}

/** The pages a database of 0.5, which has no `created_at` index, must still answer. */
async function pagesWithoutTheIndex(db: TestDatabase, { store, listAll }: ReturnType<typeof recorded>) {
  // Fails if the tables never had the index: then this would prove nothing.
  await db.query('DROP INDEX "cloudrop_files_created_at_idx"');
  await seed(store);
  const ids = async (options: Partial<Parameters<ListAll>[0]>) => {
    const page = await listAll({ ...EVERY, limit: 2, ...options });
    return { ids: page.records.map((record) => record.id), next: page.cursor !== null };
  };
  const first = await listAll({ ...EVERY, limit: 2 });
  return {
    first: first.records.map((record) => record.id),
    second: await ids({ cursor: first.cursor }),
    oldest: await ids({ order: "oldest" }),
    owner: await ids({ owner: "u-1" }),
    status: await ids({ status: "completed" }),
  };
}

const WITHOUT_THE_INDEX = {
  first: ["f-4", "f-3"],
  second: { ids: ["f-2", "f-1"], next: false },
  oldest: { ids: ["f-1", "f-2"], next: true },
  owner: { ids: ["f-4", "f-1"], next: false },
  status: { ids: [], next: false },
};

describe("Postgres", () => {
  const db = usePostgresDatabase();
  beforeEach(async () => {
    await db.reset();
    await db.createTables();
  });

  test("listAll answers the same pages on tables without the created_at index", async () => {
    expect(await pagesWithoutTheIndex(db, recorded(pgExecutor(db.pool)))).toEqual(WITHOUT_THE_INDEX);
  });

  /** The indexes the planner reads for the store's last statement. */
  async function indexesOf({ sql, params }: SqlStatement): Promise<string[]> {
    const [row] = await db.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return [...JSON.stringify(row).matchAll(/"Index Name":\s*"([^"]+)"/g)].map(([, name = ""]) => name);
  }

  // 22,000 rows and an ANALYZE, about 150 ms: the planner reads a small table whole, and only statistics of many
  // owners make it weigh the two indexes as it does in production.
  test("one owner's rows in several statuses are found by owner, never by walking created_at past every other owner", async () => {
    // 20,000 rows of a thousand owners, then 2,000 older ones of "u-churned": the newest of them is 20,000 rows deep
    // in created_at, which is what a walk of that index would read before its first row (M11-L6).
    await db.query(`INSERT INTO cloudrop_files (id, route, key, owner, status, name, type, size, expires_at, created_at, updated_at)
      SELECT 'f-' || n, 'docs', 'k-' || n, CASE WHEN n <= 2000 THEN 'u-churned' ELSE 'u-' || (n % 1000) END, 'completed',
        'f.txt', 'text/plain', 1, now(), timestamptz '2026-01-01' + n * interval '1 minute', now()
      FROM generate_series(1, 22000) AS n`);
    await db.query("ANALYZE cloudrop_files");
    const { store, listAll, last } = recorded(pgExecutor(db.pool));
    const page = { route: null, name: null, type: null, order: "newest", limit: 100, cursor: null } as const;

    const live = await store.list({ ...page, owner: "u-churned", statuses: LIVE });
    expect(live.records[0]?.id).toBe("f-2000");
    expect(await indexesOf(last())).toEqual(["cloudrop_files_owner_status_created_at_idx"]);
    await listAll({ ...page, owner: "u-churned", status: null });
    expect(await indexesOf(last())).toEqual(["cloudrop_files_owner_status_created_at_idx"]);
    // Every owner's rows are the listing the new index is for.
    await listAll({ ...page, owner: null, status: "completed" });
    expect(await indexesOf(last())).toEqual(["cloudrop_files_created_at_idx"]);
  });
});

describe("SQLite", () => {
  const db = useSqliteDatabase();
  beforeEach(() => db.createTables());

  test("listAll answers the same pages on tables without the created_at index", async () => {
    expect(await pagesWithoutTheIndex(db, recorded(sqliteExecutor(db.database)))).toEqual(WITHOUT_THE_INDEX);
  });

  test("every owner's rows are read along created_at with any filter, one owner's by owner", async () => {
    const { store, listAll, last } = recorded(sqliteExecutor(db.database));
    const page = { route: null, name: null, type: null, order: "newest", limit: 100, cursor: null } as const;
    /** The index SQLite reads the table by for the store's last statement, with the columns it searches. */
    const readBy = async () => {
      const { sql, params } = last();
      const [first] = await db.query(`EXPLAIN QUERY PLAN ${sql}`, params);
      return String(first?.detail).replace(/^(?:SCAN|SEARCH) cloudrop_files USING INDEX cloudrop_files_/, "");
    };
    // SQLite has no statistics here and would rather search the status or the route index and sort every match.
    await listAll({ ...page, owner: null, status: "completed", route: "docs" });
    expect(await readBy()).toBe("created_at_idx");
    await listAll({ ...page, owner: null, status: null, cursor: `${T0}:f-1` });
    expect(await readBy()).toBe("created_at_idx (created_at<?)");
    await listAll({ ...page, owner: "u-1", status: null });
    expect(await readBy()).toBe("owner_status_created_at_idx (owner=?)");
    await store.list({ ...page, owner: "u-1", statuses: LIVE });
    expect(await readBy()).toBe("owner_status_created_at_idx (owner=? AND status=?)");
  });
});
