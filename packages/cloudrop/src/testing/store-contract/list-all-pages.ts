// listAll's order and pages (M11-L2): created_at, then id in byte order, both ways, with rows of one instant paged
// without a skip or a repeat, whatever arrives between two pages.

import { expect, it } from "vitest";
import type { NewFile } from "../../server/store.ts";
import { at, EXPIRES, type ListAllOptions, MINUTE, newFile, type StoreSuite } from "./suite.ts";

export function listAllPageCases(suite: StoreSuite): void {
  /** Reserves `files` for `owner` at `at(minutes * MINUTE)`, so each call gives its rows their own `created_at`. */
  async function reserveAt(owner: string | null, minutes: number, files: readonly NewFile[]): Promise<void> {
    const request = { owner, limit: null, expiresAt: EXPIRES, requestKey: null, files };
    await suite.store.reserve(request, at(minutes * MINUTE));
  }

  /** The ids of every page of a listing, in order, until a page answers no cursor. */
  async function pages(options: ListAllOptions): Promise<string[][]> {
    const read: string[][] = [];
    let cursor = options.cursor ?? null;
    // No listing here has more than 8 pages: a cursor that never ends fails the case instead of hanging it.
    for (let page = 0; page < 8; page++) {
      const answered = await suite.listAll({ ...options, cursor });
      read.push(answered.records.map((record) => record.id));
      cursor = answered.cursor;
      if (cursor === null) return read;
    }
    throw new Error("listAll still answered a cursor after 8 pages.");
  }

  it.for([
    { order: "newest", limit: 2, expected: [["f-new", "f-a"], ["f-C", "f-B"], ["f-old"]] },
    { order: "oldest", limit: 2, expected: [["f-old", "f-B"], ["f-C", "f-a"], ["f-new"]] },
    { order: "newest", limit: 1, expected: [["f-new"], ["f-a"], ["f-C"], ["f-B"], ["f-old"]] },
  ] as const)(
    "listAll $order first with limit $limit pages every owner's rows to the end, ties in byte order of id",
    async ({ order, limit, expected }) => {
      await reserveAt("u-1", 1, [newFile("f-old", 1)]);
      // One created_at across three owners: the id decides, in byte order ("B" 0x42, "C" 0x43, "a" 0x61), whatever
      // the collation. With limit 2 a page ends between two of them in either order.
      await reserveAt("u-1", 2, [newFile("f-a", 1)]);
      await reserveAt("u-2", 2, [newFile("f-B", 1)]);
      await reserveAt(null, 2, [newFile("f-C", 1)]);
      await reserveAt("u-2", 3, [newFile("f-new", 1)]);
      expect(await pages({ order, limit })).toEqual(expected);
    },
  );

  it("listAll skips and repeats nothing when rows of the same instant arrive between two pages", async () => {
    await reserveAt(
      "u-1",
      1,
      ["f-1", "f-3", "f-5", "f-7", "f-9"].map((id) => newFile(id, 1)),
    );
    const first = await suite.listAll({ limit: 2 });
    expect(first.records.map((record) => record.id)).toEqual(["f-9", "f-7"]);
    // Both at the instant of the page's last row: "f-4" comes after the cursor in this order, "f-8" before it.
    await reserveAt("u-2", 1, [newFile("f-4", 1), newFile("f-8", 1)]);
    expect(await pages({ limit: 2, cursor: first.cursor })).toEqual([
      ["f-5", "f-4"],
      ["f-3", "f-1"],
    ]);
  });

  // 1,001 rows on every backend, the slowest case of the contract (measured: 26 to 75 ms on Postgres and node:sqlite,
  // 0.4 to 0.7 s on the file-backed SQLite of Drizzle and Prisma): only a full page of the largest limit inside one
  // instant shows that limit 1000 answers 1,000 rows and that a tie of any size pages without a skip or a repeat.
  it("listAll with limit 1000 pages 1,001 rows of one instant: the first 1,000, then the last one", async () => {
    const all = Array.from({ length: 1001 }, (_, index) => `t-${String(index).padStart(4, "0")}`);
    for (let from = 0; from < all.length; from += 91) {
      const files = all.slice(from, from + 91).map((id) => newFile(id, 1));
      await reserveAt(from % 2 === 0 ? "u-1" : null, 1, files);
    }
    const first = await suite.listAll({ order: "oldest", limit: 1000 });
    expect(first.records.map((record) => record.id)).toEqual(all.slice(0, 1000));
    expect(await suite.listAll({ order: "oldest", limit: 1000, cursor: first.cursor })).toEqual({
      records: [await suite.store.get("t-1000")],
      cursor: null,
    });
  });
}
