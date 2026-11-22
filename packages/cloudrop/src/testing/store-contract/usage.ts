// Usage across calls: counters repaired from the rows without losing a concurrent reserve, racing first reserves of
// new owners, and every owner paged.

import { expect, it } from "vitest";
import { at, EXPIRES, MINUTE, newFile, type StoreSuite, usageRow } from "./suite.ts";

export function usageCases(suite: StoreSuite): void {
  const { skipWithout, seed, advance } = suite;

  it("reconcile recounts drifted counters from the owner's rows and reports whether anything changed", async () => {
    const { store, raw } = suite;
    const sizes = { "f-1": 1, "f-2": 2, "f-3": 4, "f-4": 8, "f-5": 16 };
    await seed(
      "u-1",
      Object.entries(sizes).map(([id, size]) => newFile(id, size)),
    );
    await seed("u-2", [newFile("f-6", 32)]);
    await advance("f-2", "completing", at(MINUTE));
    await advance("f-3", "completed", at(MINUTE));
    await advance("f-4", "deleted", at(MINUTE));
    await advance("f-5", "aborted", at(MINUTE));
    await raw.putUsage(usageRow("u-1", { reservedBytes: 999, activeBytes: 0, files: 7 }));
    expect(await store.reconcile("u-1")).toBe(true);
    // Reserved: pending f-1 and completing f-2. Active: completed f-3 only; deleted and aborted rows count nowhere.
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 3, activeBytes: 4, files: 1, erasure: null });
    expect(await store.reconcile("u-1")).toBe(false);
    expect(await store.usage("u-2")).toEqual({ reservedBytes: 32, activeBytes: 0, files: 0, erasure: null });
    expect(await store.reconcile("u-2")).toBe(false);
  });

  it("reconcile of an owner whose rows count nothing, or who has none, creates no usage row", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("f-1", 0)]);
    await raw.deleteUsage("u-1");
    // An empty pending file counts zero bytes and no file, and a missing row already counts as zeros.
    expect(await store.reconcile("u-1")).toBe(false);
    expect(await store.reconcile("nobody")).toBe(false);
    expect(await raw.usage()).toEqual([]);
  });

  it("reconcile of an owner with rows but no usage row creates the row from the rows", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("f-1", 10), newFile("f-2", 20)]);
    await raw.deleteUsage("u-1");
    expect(await store.reconcile("u-1")).toBe(true);
    // reconcile takes no time, so the store's clock stamps the row.
    expect(await raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 30, updatedAt: expect.any(Date) })]);
  });

  it("reconcile running beside reserves loses none of them", async (ctx) => {
    const { store } = suite;
    skipWithout(ctx, "concurrency");
    await seed("u-1", [newFile("f-0", 1)]);
    await suite.raw.putUsage(usageRow("u-1", { reservedBytes: 500 }));
    const reserves = Array.from({ length: 8 }, (_, index) =>
      store.reserve(
        { owner: "u-1", limit: null, expiresAt: EXPIRES, requestKey: null, files: [newFile(`f-${index + 1}`, 2)] },
        at(0),
      ),
    );
    await Promise.all([store.reconcile("u-1"), ...reserves]);
    // 1 + 8 × 2, whichever order the calls ran in.
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 17, activeBytes: 0, files: 0, erasure: null });
  });

  // An owner with no usage row yet has nothing to lock, so racing first reserves meet at the row's creation; a Postgres
  // store reruns the loser (M5-T74), which needs its driver's unique violation recognised. Five owners per case, because
  // one race may happen to run one call at a time.
  it.for([
    { limit: 50, reserved: 5 },
    { limit: null, reserved: 8 },
  ])(
    "concurrent first reserves of new owners (limit $limit) reserve exactly $reserved each and never throw",
    async ({ limit, reserved }, ctx) => {
      const { store } = suite;
      skipWithout(ctx, "concurrency");
      const owners = ["new-a", "new-b", "new-c", "new-d", "new-e"];
      const outcomes = await Promise.all(
        owners.flatMap((owner) =>
          Array.from({ length: 8 }, (_, index) =>
            store.reserve(
              { owner, limit, expiresAt: EXPIRES, requestKey: null, files: [newFile(`${owner}-${index}`, 10)] },
              at(0),
            ),
          ),
        ),
      );
      expect(outcomes.flat().filter((outcome) => outcome === "reserved")).toHaveLength(owners.length * reserved);
      const usages = await Promise.all(owners.map((owner) => store.usage(owner)));
      expect(usages).toEqual(
        owners.map(() => ({ reservedBytes: reserved * 10, activeBytes: 0, files: 0, erasure: null })),
      );
    },
  );

  it("owners pages every owner with counters, a page at a time, and ends with null", async () => {
    const { store } = suite;
    for (const owner of ["owner-c", "owner-a", "owner-e", "owner-b", "owner-d"]) {
      await seed(owner, [newFile(`file-${owner}`, 1)]);
    }
    await seed(null, [newFile("file-anonymous", 1)]);
    const first = await store.owners(null, 2);
    expect(first.owners).toEqual(["owner-a", "owner-b"]);
    const second = await store.owners(first.cursor, 2);
    expect(second.owners).toEqual(["owner-c", "owner-d"]);
    expect(await store.owners(second.cursor, 2)).toEqual({ owners: ["owner-e"], cursor: null });
  });

  it("owners pages in byte order: a character past U+FFFF comes after every character before it", async () => {
    const { store } = suite;
    // U+1F600 is the surrogates D83D DE00 in a JavaScript string, which sort before U+E000 there; its bytes (F0 …)
    // sort after U+E000's (EE …), and bytes are what every database compares.
    const [emoji, privateUse] = ["owner-\u{1f600}", "owner-\ue000"];
    for (const owner of [emoji, privateUse, "owner-z"]) await seed(owner, [newFile(`file-${owner}`, 1)]);
    const first = await store.owners(null, 2);
    expect(first.owners).toEqual(["owner-z", privateUse]);
    expect(await store.owners(first.cursor, 2)).toEqual({ owners: [emoji], cursor: null });
  });
}
