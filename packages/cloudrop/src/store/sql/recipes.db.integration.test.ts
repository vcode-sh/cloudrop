// The SQL of the store guide's "Your own queries" (docs/guide/store.md), run as the page prints it, on Postgres and on
// SQLite (M12-Q1, M12-Q2). Each statement is read from the page by its `<!-- recipe:<name>[:<dialect>] -->` marker, so
// the guide and this file cannot drift; a marker without a row here fails too. The rows come from the store's own
// methods, the way the server writes them, and the oracle is the ids each recipe must answer, written by hand.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { pgExecutor, sqliteExecutor, sqlStore } from "../../adapters/sql.ts";
import type { CloudropStore, FileRecordStatus } from "../../server/store.ts";
import { usePostgresDatabase } from "../../testing/db/postgres.ts";
import { rawTables } from "../../testing/db/raw-tables.ts";
import type { Dialect, TestDatabase } from "../../testing/db/schema.ts";
import { useSqliteDatabase } from "../../testing/db/sqlite.ts";
import { at, LEASE, MINUTE, newFile, storeSuite } from "../../testing/store-contract/suite.ts";

const GUIDE = readFileSync(new URL("../../../../../docs/guide/store.md", import.meta.url), "utf8");
const DAY = 24 * 60 * MINUTE;

/** The ```sql block after the recipe's marker: the dialect's own, or one written for both. */
function recipe(name: string, dialect: Dialect): string {
  for (const marker of [`${name}:${dialect}`, name]) {
    const found = new RegExp(`<!-- recipe:${marker} -->\\n( *)\`\`\`sql\\n([\\s\\S]*?)\\n *\`\`\``).exec(GUIDE);
    if (found) return (found[2] ?? "").replace(new RegExp(`^${found[1] ?? ""}`, "gm"), "");
  }
  throw new Error(`docs/guide/store.md has no sql block after <!-- recipe:${name} --> for ${dialect}.`);
}

type Final = Exclude<FileRecordStatus, "completing"> | "stuck";

/** id, owner, name, size, the minute /upload accepted it, and where it ends; a minute later, unless noted. */
const FILES: readonly (readonly [string, string | null, string, number, number, Final])[] = [
  ["f-00", "u-2", "report-old.pdf", 80, -3 * 24 * 60, "rejected"],
  ["f-01", "u-1", "Q3 Report.pdf", 100, 1, "completed"],
  ["f-02", "u-2", "holiday.png", 2000, 2, "completed"],
  ["f-03", "u-1", "report_draft.pdf", 300, 3, "completed"],
  ["f-04", null, "report-public.pdf", 7, 3, "completed"],
  ["f-05", "u-3", "old.png", 50, 4, "completed"],
  ["f-06", "u-1", "stuck.png", 10, 5, "stuck"],
  ["f-07", "u-2", "never.png", 20, 6, "failed"],
  ["f-08", "u-2", "bad.png", 30, 7, "rejected"],
  ["f-09", "u-1", "pending.png", 40, 8, "pending"],
  ["f-10", "u-2", "report-deleted.pdf", 60, 9, "deleted"],
  ["f-11", "u-2", "cancelled.png", 70, 10, "aborted"],
  ["f-12", "u-2", "abandoned.png", 80, 11, "expired"],
  ["f-13", "u-2", "old-invoice.pdf", 90, 12, "deleted"],
];

/** When each ended row was proven clean; the stuck completion is cleaned as the sweep ends it. */
const CLEANED: Record<string, number> = {
  "f-00": -2 * DAY,
  "f-07": 12 * MINUTE,
  "f-10": 40 * MINUTE,
  "f-11": 15 * MINUTE,
  "f-12": 16 * MINUTE,
  "f-13": 20 * MINUTE,
};

const minutes = (count: number) => at(count * MINUTE);

/** The app's users table, and every row of FILES written through the store; u-3 owns files but has no account. */
async function seed(db: TestDatabase, store: CloudropStore<unknown>): Promise<void> {
  await db.query('CREATE TABLE "user" (id text NOT NULL PRIMARY KEY, email text NOT NULL)');
  await db.query(`INSERT INTO "user" (id, email) VALUES ('u-1', 'alice@example.com'), ('u-2', 'bob@example.com')`);
  const suite = storeSuite(() => ({ store, raw: rawTables(db), gaps: {}, teardown: async () => {} }));
  for (const [id, owner, name, size, minute, final] of FILES) {
    const files = [{ ...newFile(id, size), name }];
    const accepted = minutes(minute);
    const expiresAt = new Date(accepted.getTime() + DAY);
    await store.reserve({ owner, limit: null, expiresAt, requestKey: null, files }, accepted);
    const ends = minutes(minute + 1);
    if (final === "stuck") {
      await store.claim(id, `claim-${id}`, accepted, LEASE);
      await store.end(id, "completing", "failed", ends, { cleaned: true });
    } else {
      await suite.advance(id, final, ends);
    }
    const cleaned = CLEANED[id];
    if (cleaned !== undefined) await store.cleaned(id, at(cleaned));
  }
}

/** A recipe's answer, one array per row of the columns asked for, numbers read as the driver returns them. */
async function run(db: TestDatabase, name: string, params: readonly unknown[], columns: readonly string[]) {
  const rows = await db.query(recipe(name, db.dialect), params);
  return rows.map((row) => columns.map((column) => row[column]));
}

const idsOf = async (db: TestDatabase, name: string, params: readonly unknown[] = []) =>
  (await run(db, name, params, ["id"])).flat();

/** A time as the dialect stores it: a Date on Postgres, integer milliseconds on SQLite. */
const time = (db: TestDatabase, date: Date) => (db.dialect === "postgres" ? date : date.getTime());

function recipeCases(db: TestDatabase, store: () => CloudropStore<unknown>): void {
  test("the inventory finds completed files by name or owner's email, newest first, owner-less ones kept", async () => {
    expect(await idsOf(db, "inventory", ["%report%"])).toEqual(["f-04", "f-03", "f-01"]);
    expect(await idsOf(db, "inventory", ["%bob%"])).toEqual(["f-02"]);
    // `_` matches any character, unless escaped as the guide says: then only itself.
    expect(await idsOf(db, "inventory", ["%y_p%"])).toEqual(["f-02"]);
    expect(await idsOf(db, "inventory", ["%y\\_p%"])).toEqual([]);
    expect(await idsOf(db, "inventory", ["%t\\_d%"])).toEqual(["f-03"]);
  });

  test("the inventory's next page goes on after the last row, also within one instant", async () => {
    const [last] = await db.query(recipe("inventory", db.dialect), ["%report%"]);
    expect(last?.id).toBe("f-04");
    // The driver's own value of created_at goes back as it came: a Date on Postgres, a number on SQLite.
    expect(await idsOf(db, "inventory-next", ["%report%", last?.created_at, last?.id])).toEqual(["f-03", "f-01"]);
    expect(await idsOf(db, "inventory-next", ["%report%", time(db, minutes(3)), "f-03"])).toEqual(["f-01"]);
  });

  test("stuck completions are the failed rows that were claimed, and only those", async () => {
    expect(await idsOf(db, "stuck")).toEqual(["f-06"]);
  });

  test("the failures of the last day are the rejected and failed rows ended since then, newest first", async () => {
    const dayAgo = new Date(minutes(60).getTime() - DAY);
    expect(await idsOf(db, "failures", [time(db, dayAgo)])).toEqual(["f-08", "f-07", "f-06"]);
  });

  test("usage per owner lists the counters the quota reads, largest first, a gone owner without an email", async () => {
    const rows = await run(db, "usage", [], ["owner", "email", "active_bytes", "reserved_bytes", "files"]);
    // Postgres drivers answer bigint as text, which the guide says to read with Number().
    const read = rows.map(([owner, email, active, reserved, files]) => [
      owner,
      email,
      Number(active),
      Number(reserved),
      Number(files),
    ]);
    expect(read).toEqual([
      ["u-2", "bob@example.com", 2000, 0, 1],
      ["u-1", "alice@example.com", 400, 40, 2],
      ["u-3", null, 50, 0, 1],
    ]);
  });

  test("gone owners are those without an account and without a mark, so a marked owner leaves the query", async () => {
    expect(await run(db, "gone-owners", [], ["owner"])).toEqual([["u-3"]]);
    await store().markErasure({ owner: "u-3", now: minutes(20) });
    expect(await run(db, "gone-owners", [], ["owner"])).toEqual([]);
  });

  test("the purge deletes only ended rows proven clean before its time, never a failed one", async () => {
    await db.query(recipe("purge", db.dialect), [time(db, minutes(30))]);
    // One row of each purged status goes: f-00 rejected, f-11 aborted, f-12 expired, f-13 deleted. f-06 and f-07 are
    // failed, f-08 is not cleaned, f-10 was cleaned after the cutoff.
    const purged = ["f-00", "f-11", "f-12", "f-13"];
    expect((await rawTables(db).files()).map((row) => row.id)).toEqual(
      FILES.map(([id]) => id).filter((id) => !purged.includes(id)),
    );
  });

  test("the erased owners' purge deletes their rows once the erasure finished, and keeps the usage row", async () => {
    // u-1 is marked too, but its erasure has not finished: its live rows must stay.
    await store().markErasure({ owner: "u-1", now: minutes(20) });
    const { requestedAt } = await store().markErasure({ owner: "u-3", now: minutes(20) });
    await store().end("f-05", "completed", "deleted", minutes(21), { cleaned: true });
    expect(await store().erased({ owner: "u-3", requestedAt, now: minutes(22) })).toBe(true);
    await db.query(recipe("purge-erased", db.dialect));
    expect((await rawTables(db).files()).map((row) => row.id)).toEqual(
      FILES.map(([id]) => id).filter((id) => id !== "f-05"),
    );
    expect((await rawTables(db).usage()).map((row) => [row.owner, row.erasedAt])).toContainEqual(["u-3", minutes(22)]);
  });
}

const COVERED = ["inventory", "inventory-next", "stuck", "failures", "usage", "gone-owners", "purge", "purge-erased"];

test("every recipe marker in the guide has its rows here", () => {
  const names = [...GUIDE.matchAll(/<!-- recipe:([a-z-]+)(?::(?:postgres|sqlite))? -->/g)].map(([, name]) => name);
  expect([...new Set(names)]).toEqual(COVERED);
});

describe("Postgres", () => {
  const db = usePostgresDatabase();
  let store: CloudropStore<unknown>;
  beforeEach(async () => {
    await db.reset();
    await db.createTables();
    store = sqlStore(pgExecutor(db.pool));
    await seed(db, store);
  });
  recipeCases(db, () => store);
});

describe("SQLite", () => {
  const db = useSqliteDatabase();
  let store: CloudropStore<unknown>;
  beforeEach(async () => {
    await db.createTables();
    store = sqlStore(sqliteExecutor(db.database));
    await seed(db, store);
  });
  recipeCases(db, () => store);
});
