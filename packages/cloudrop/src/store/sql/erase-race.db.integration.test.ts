// A reserve and an erase mark of the same owner on two Postgres connections (M12-O2). The mark and the quota live on
// one usage row, so whichever takes its lock first decides: a reserve that holds the row commits its files before the
// mark is set, and the erasure's row passes then see them; a reserve that waits for the mark reads it and writes
// nothing. Each side is started only once the other holds the lock (the lesson of e475c18e: started together, the
// second can win the race and the row proves nothing).

import { describe, expect, test } from "vitest";
import { pgExecutor, sqlStore } from "../../adapters/sql.ts";
import type { NewFile } from "../../server/store.ts";
import { untilOneWaits, usePostgresDatabase } from "../../testing/db/postgres.ts";
import { rawTables } from "../../testing/db/raw-tables.ts";
import { gate } from "../../testing/store-fixture.ts";

const NOW = new Date("2026-11-22T10:20:30.123Z");
const LATER = new Date("2026-11-22T10:21:30.123Z");

const file = (id: string, size: number): NewFile => ({
  id,
  route: "files",
  key: `users/u-1/${id}.bin`,
  name: `${id}.bin`,
  type: "application/octet-stream",
  size,
  metadata: null,
});

const BLOCKED_BY = "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))";

describe("Postgres: a reserve and an erase mark of one owner", () => {
  const db = usePostgresDatabase();
  /** A fresh database and a store over it whose transaction holds one connection while another runs the store. */
  async function freshStore() {
    await db.reset();
    await db.createTables();
    return sqlStore(pgExecutor(db.pool), { transaction: true });
  }
  type Store = Awaited<ReturnType<typeof freshStore>>;

  const reserve = (target: Pick<Store, "reserve">, id: string, at: Date) =>
    target.reserve({ owner: "u-1", limit: null, expiresAt: LATER, requestKey: null, files: [file(id, 5)] }, at);

  /**
   * Runs `hold` in a transaction that stays open until `waiting`, started once `hold` has run, is blocked by it. The
   * holder is let go however the wait ends, so a failure leaves no lock behind for the next row.
   */
  async function whileHeld<T>(
    store: Store,
    hold: (inner: Pick<Store, "reserve" | "markErasure">) => Promise<unknown>,
    waiting: () => Promise<T>,
  ): Promise<T> {
    // `held.arrived` once `hold` has run and the transaction holds its lock; `held.open()` lets it commit.
    const held = gate();
    let holder: unknown;
    const transaction = store.transaction(async (tx, inner) => {
      holder = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      await hold(inner);
      await held.pass();
    });
    await held.arrived;
    const waited = waiting();
    // Its failure is awaited below; until then it must not count as unhandled.
    waited.catch(() => undefined);
    try {
      await untilOneWaits(db, BLOCKED_BY, [holder], "The second connection never waited for the first.");
    } finally {
      held.open();
      await transaction;
    }
    return await waited;
  }

  // A usage row there or not: with none, the reserve that holds the lock inserts it, and the mark waits on the key.
  test.for([
    { name: "with a usage row", existing: true },
    { name: "without a usage row", existing: false },
  ])("a mark waits for a reserve that holds the row, which commits first, $name", async ({ existing }) => {
    const store = await freshStore();
    if (existing) await reserve(store, "f-0", NOW);
    const marking = await whileHeld(
      store,
      (inner) => reserve(inner, "f-1", NOW),
      () => store.markErasure({ owner: "u-1", now: LATER }),
    );
    expect(marking).toEqual({ requestedAt: LATER, erasedAt: null });
    // The reserve's bytes and the mark are both on the row, and no reserve gets in after it.
    const [usage] = await rawTables(db).usage();
    expect(usage).toMatchObject({ reservedBytes: existing ? 10 : 5, eraseRequestedAt: LATER, erasedAt: null });
    expect(await reserve(store, "f-2", LATER)).toEqual(["erased"]);
    expect((await rawTables(db).files()).map((row) => row.id)).toEqual(existing ? ["f-0", "f-1"] : ["f-1"]);
  });

  // Without a usage row the waiting reserve meets the mark's new row on the unique owner: it fails and runs again on a
  // new snapshot, where it reads the mark. An upsert there would have added its bytes to the marked row.
  test.for([
    { name: "with a usage row", existing: true },
    { name: "without a usage row", existing: false },
  ])(
    "a reserve waits for a mark that holds the row, then answers erased and writes nothing, $name",
    async ({ existing }) => {
      const store = await freshStore();
      if (existing) await reserve(store, "f-0", NOW);
      const reserving = await whileHeld(
        store,
        (inner) => inner.markErasure({ owner: "u-1", now: NOW }),
        () => reserve(store, "f-1", LATER),
      );
      expect(reserving).toEqual(["erased"]);
      const [usage] = await rawTables(db).usage();
      expect(usage).toMatchObject({ reservedBytes: existing ? 5 : 0, eraseRequestedAt: NOW, erasedAt: null });
      expect((await rawTables(db).files()).map((row) => row.id)).toEqual(existing ? ["f-0"] : []);
    },
  );
});
