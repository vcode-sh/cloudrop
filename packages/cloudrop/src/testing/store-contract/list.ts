// list: one owner's rows in one status, newest first, on one route or all, keyset-paged so the caller's own deletes
// between pages skip nothing.

import { expect, it } from "vitest";
import type { FileRecord, NewFile } from "../../server/store.ts";
import { at, EXPIRES, MINUTE, newFile, type StoreSuite } from "./suite.ts";

const ids = (page: { records: FileRecord[] }) => page.records.map((record) => record.id);

/** No name or type filter, newest first: the listing every case here reads. */
const UNFILTERED = { name: null, type: null, order: "newest" } as const;

const onRoute = (id: string, route: string): NewFile => ({ ...newFile(id, 1), route });

export function listCases(suite: StoreSuite): void {
  const { advance } = suite;

  /** Reserves `files` for `owner` at `at(minutes * MINUTE)`, so each call gives its rows their own `created_at`. */
  async function reserveAt(owner: string | null, minutes: number, files: readonly NewFile[]): Promise<void> {
    const request = { owner, limit: null, expiresAt: EXPIRES, requestKey: null, files };
    await suite.store.reserve(request, at(minutes * MINUTE));
  }

  it("list answers one owner's rows in one status, newest first, with ties in byte order of id", async () => {
    const { store } = suite;
    await reserveAt("u-1", 1, [newFile("f-old", 1)]);
    // Same created_at: the id decides, descending, in byte order ("B" is 0x42, "a" 0x61), whatever the collation.
    await reserveAt("u-1", 2, [newFile("f-B", 1), newFile("f-a", 1)]);
    await reserveAt("u-1", 3, [newFile("f-new", 1), newFile("f-pending", 1)]);
    await reserveAt("u-2", 4, [newFile("g-other-owner", 1)]);
    await reserveAt(null, 4, [newFile("g-no-owner", 1)]);
    for (const id of ["f-old", "f-B", "f-a", "f-new", "g-other-owner", "g-no-owner"]) {
      await advance(id, "completed", at(5 * MINUTE));
    }
    const page = await store.list({
      owner: "u-1",
      statuses: ["completed"],
      route: null,
      ...UNFILTERED,
      limit: 10,
      cursor: null,
    });
    expect(ids(page)).toEqual(["f-new", "f-a", "f-B", "f-old"]);
    expect(page.records[0]).toEqual(await store.get("f-new"));
    expect(page.cursor).toBeNull();
    const pending = await store.list({
      owner: "u-1",
      statuses: ["pending"],
      route: null,
      ...UNFILTERED,
      limit: 10,
      cursor: null,
    });
    expect(ids(pending)).toEqual(["f-pending"]);
  });

  it("list with several statuses answers the rows in any of them, in one newest-first order", async () => {
    const { store } = suite;
    await reserveAt("u-1", 1, [newFile("f-done", 1)]);
    await reserveAt("u-1", 2, [newFile("f-claimed", 1)]);
    await reserveAt("u-1", 3, [newFile("f-open", 1), newFile("f-ended", 1)]);
    await advance("f-done", "completed", at(5 * MINUTE));
    await advance("f-claimed", "completing", at(5 * MINUTE));
    await advance("f-ended", "aborted", at(5 * MINUTE));
    const statuses = ["pending", "completing", "completed"] as const;
    const page = await store.list({ owner: "u-1", statuses, route: null, ...UNFILTERED, limit: 10, cursor: null });
    expect(ids(page)).toEqual(["f-open", "f-claimed", "f-done"]);
    const none = await store.list({ owner: "u-1", statuses: [], route: null, ...UNFILTERED, limit: 10, cursor: null });
    expect(none).toEqual({ records: [], cursor: null });
  });

  it("list with a route answers only that route's rows", async () => {
    const { store } = suite;
    await reserveAt("u-1", 1, [onRoute("f-avatar", "avatars"), onRoute("f-doc", "docs")]);
    await advance("f-avatar", "completed", at(MINUTE));
    await advance("f-doc", "completed", at(MINUTE));
    const page = await store.list({
      owner: "u-1",
      statuses: ["completed"],
      route: "docs",
      ...UNFILTERED,
      limit: 10,
      cursor: null,
    });
    expect(ids(page)).toEqual(["f-doc"]);
  });

  it("list pages after its cursor, skips nothing when rows leave the status between pages, and ends with null", async () => {
    const { store } = suite;
    for (const [minutes, id] of [
      [1, "f-1"],
      [2, "f-2"],
      [3, "f-3"],
      [4, "f-4"],
      [5, "f-5"],
    ] as const) {
      await reserveAt("u-1", minutes, [newFile(id, 1)]);
      await advance(id, "completed", at(10 * MINUTE));
    }
    const read = (cursor: string | null) =>
      store.list({ owner: "u-1", statuses: ["completed"], route: null, ...UNFILTERED, limit: 2, cursor });
    const first = await read(null);
    expect(ids(first)).toEqual(["f-5", "f-4"]);
    // The caller deletes what it read, as an erasure does: the next page starts after the cursor all the same.
    await store.end("f-5", "completed", "deleted", at(11 * MINUTE));
    await store.end("f-4", "completed", "deleted", at(11 * MINUTE));
    const second = await read(first.cursor);
    expect(ids(second)).toEqual(["f-3", "f-2"]);
    const last = await read(second.cursor);
    expect(last).toEqual({ records: [await store.get("f-1")], cursor: null });
  });

  it("list answers a null cursor when the last page is exactly full", async () => {
    const { store } = suite;
    await reserveAt("u-1", 1, [newFile("f-1", 1), newFile("f-2", 1)]);
    const page = await store.list({
      owner: "u-1",
      statuses: ["pending"],
      route: null,
      ...UNFILTERED,
      limit: 2,
      cursor: null,
    });
    expect(ids(page)).toEqual(["f-2", "f-1"]);
    expect(page.cursor).toBeNull();
  });
}
