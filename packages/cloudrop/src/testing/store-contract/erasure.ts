// The erase mark (M12-O1, M12-O2): markErasure, erased, reopen and erasing on the usage row, and reserve refusing every
// file of a marked owner without writing anything.

import { expect, it } from "vitest";
import type { NewFile } from "../../server/store.ts";
import { at, EXPIRES, MINUTE, newFile, pendingRow, type StoreSuite, usageRow } from "./suite.ts";

const KEY = "request-key-0000000001";

export function erasureCases(suite: StoreSuite): void {
  const { seed } = suite;
  const reserve = (requestKey: string | null, files: NewFile[], limit: number | null, ms: number) =>
    suite.store.reserve({ owner: "u-1", limit, expiresAt: EXPIRES, requestKey, files }, at(ms));
  const mark = (owner: string, ms: number) => suite.store.markErasure({ owner, now: at(ms) });

  it("markErasure gives an owner without a usage row a zero row carrying the mark", async () => {
    expect(await mark("u-1", 0)).toEqual({ requestedAt: at(0), erasedAt: null });
    expect(await suite.raw.usage()).toEqual([usageRow("u-1", { eraseRequestedAt: at(0) })]);
    expect(await suite.store.usage("u-1")).toEqual({
      reservedBytes: 0,
      activeBytes: 0,
      files: 0,
      erasure: { requestedAt: at(0), erasedAt: null },
    });
  });

  it("markErasure keeps an owner's counters, and a second mark keeps the first time and writes nothing", async () => {
    await seed("u-1", [newFile("f-1", 30)]);
    expect(await mark("u-1", MINUTE)).toEqual({ requestedAt: at(MINUTE), erasedAt: null });
    const marked = [usageRow("u-1", { reservedBytes: 30, eraseRequestedAt: at(MINUTE), updatedAt: at(MINUTE) })];
    expect(await suite.raw.usage()).toEqual(marked);
    expect(await mark("u-1", 2 * MINUTE)).toEqual({ requestedAt: at(MINUTE), erasedAt: null });
    expect(await suite.raw.usage()).toEqual(marked);
  });

  // The third reserve carries the key of a pending attempt, which an unmarked owner's retry would end (supersede.ts).
  it.for([
    { name: "without a limit", limit: null, requestKey: null },
    { name: "with a limit the files fit", limit: 1000, requestKey: null },
    { name: "with a request key that would supersede", limit: null, requestKey: KEY },
  ])(
    "reserve after the mark answers erased for every file and writes nothing, $name",
    async ({ limit, requestKey }) => {
      await reserve(KEY, [newFile("f-0", 8)], null, 0);
      await mark("u-1", MINUTE);
      const before = { files: await suite.raw.files(), usage: await suite.raw.usage() };
      const outcomes = await reserve(requestKey, [newFile("f-1", 1), newFile("f-2", 2)], limit, 2 * MINUTE);
      expect(outcomes).toEqual(["erased", "erased"]);
      expect({ files: await suite.raw.files(), usage: await suite.raw.usage() }).toEqual(before);
      expect(before.files).toEqual([pendingRow(newFile("f-0", 8), "u-1", { requestKey: KEY })]);
    },
  );

  it("erased finishes only the mark it was given, and a repeat keeps the first finish", async () => {
    await mark("u-1", 0);
    expect(await suite.store.erased({ owner: "u-1", requestedAt: at(1), now: at(MINUTE) })).toBe(false);
    expect(await suite.store.erased({ owner: "u-2", requestedAt: at(0), now: at(MINUTE) })).toBe(false);
    expect(await suite.raw.usage()).toEqual([usageRow("u-1", { eraseRequestedAt: at(0) })]);
    expect(await suite.store.erased({ owner: "u-1", requestedAt: at(0), now: at(MINUTE) })).toBe(true);
    expect(await suite.store.erased({ owner: "u-1", requestedAt: at(0), now: at(2 * MINUTE) })).toBe(true);
    const finished = usageRow("u-1", { eraseRequestedAt: at(0), erasedAt: at(MINUTE), updatedAt: at(MINUTE) });
    expect(await suite.raw.usage()).toEqual([finished]);
    expect(await mark("u-1", 3 * MINUTE)).toEqual({ requestedAt: at(0), erasedAt: at(MINUTE) });
  });

  it("reopen clears the mark and keeps the counters, and reserve reserves again", async () => {
    await seed("u-1", [newFile("f-1", 30)]);
    await mark("u-1", MINUTE);
    await suite.store.erased({ owner: "u-1", requestedAt: at(MINUTE), now: at(MINUTE) });
    expect(await suite.store.reopen({ owner: "u-1", now: at(2 * MINUTE) })).toBe(true);
    expect(await suite.raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 30, updatedAt: at(2 * MINUTE) })]);
    expect(await suite.store.reopen({ owner: "u-1", now: at(3 * MINUTE) })).toBe(false);
    expect(await suite.store.reopen({ owner: "u-2", now: at(3 * MINUTE) })).toBe(false);
    expect(await reserve(null, [newFile("f-2", 2)], 100, 4 * MINUTE)).toEqual(["reserved"]);
    expect(await suite.raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 32, updatedAt: at(4 * MINUTE) })]);
  });

  // Byte order, as owners() pages: "B" (0x42) before "a", and "é" (0xC3 0xA9) after every ASCII letter, whatever the
  // database's collation says.
  it("erasing pages the owners whose erasure is unfinished, in byte order of owner, each once", async () => {
    for (const owner of ["é", "b", "a", "B", "done"]) await mark(owner, 0);
    await seed("unmarked", [newFile("f-1", 1)]);
    await suite.store.erased({ owner: "done", requestedAt: at(0), now: at(MINUTE) });
    const first = await suite.store.erasing({ cursor: null, limit: 2 });
    expect(first).toEqual({ owners: ["B", "a"], cursor: "a" });
    const second = await suite.store.erasing({ cursor: first.cursor, limit: 2 });
    expect(second).toEqual({ owners: ["b", "é"], cursor: null });
    expect(await suite.store.erasing({ cursor: null, limit: 4 })).toEqual({
      owners: ["B", "a", "b", "é"],
      cursor: null,
    });
  });
}
