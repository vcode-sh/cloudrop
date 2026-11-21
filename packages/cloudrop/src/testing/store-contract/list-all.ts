// listAll (M11-L): the rows of every owner, in any status, narrowed by an owner, a status and the filters of list.
// Every backend must answer the same rows, so these run on Postgres, SQLite, D1 and the memory store.

import { expect, it } from "vitest";
import type { FileRecord, NewFile } from "../../server/store.ts";
import { at, MINUTE, newFile, type StoreSuite } from "./suite.ts";

const ids = (page: { records: FileRecord[] }) => page.records.map((record) => record.id);

/** A file of `id` with this name and type. */
const named = (id: string, name: string, type = "text/plain"): NewFile => ({ ...newFile(id, 1), name, type });

export function listAllCases(suite: StoreSuite): void {
  it("listAll answers every owner's rows, those without an owner included, or one owner's in any status", async () => {
    expect(await suite.listAll()).toEqual({ records: [], cursor: null });
    await suite.seed("u-1", [newFile("f-1", 1), newFile("f-2", 1)]);
    await suite.seed("u-2", [newFile("g-1", 1)]);
    await suite.seed(null, [newFile("h-1", 1)]);
    await suite.advance("f-1", "completed", at(MINUTE));
    await suite.advance("g-1", "deleted", at(MINUTE));
    const every = await suite.listAll();
    // One created_at for all, so the ids decide, descending.
    expect(ids(every)).toEqual(["h-1", "g-1", "f-2", "f-1"]);
    expect(every.records).toEqual([
      await suite.store.get("h-1"),
      await suite.store.get("g-1"),
      await suite.store.get("f-2"),
      await suite.store.get("f-1"),
    ]);
    expect(every.cursor).toBeNull();
    // The owner's pending row beside the completed one: no status was asked for.
    expect(ids(await suite.listAll({ owner: "u-1" }))).toEqual(["f-2", "f-1"]);
    expect(ids(await suite.listAll({ owner: "u-2" }))).toEqual(["g-1"]);
    expect(await suite.listAll({ owner: "u-3" })).toEqual({ records: [], cursor: null });
  });

  it("listAll with a status answers the rows in that status alone, for each of the eight", async () => {
    const statuses = [
      "pending",
      "completing",
      "completed",
      "aborted",
      "rejected",
      "failed",
      "expired",
      "deleted",
    ] as const;
    await suite.seed(
      "u-1",
      statuses.map((status) => newFile(`f-${status}`, 1)),
    );
    await suite.seed(null, [newFile("g-completed", 1)]);
    for (const status of statuses) await suite.advance(`f-${status}`, status, at(MINUTE));
    await suite.advance("g-completed", "completed", at(MINUTE));
    const listed: Record<string, string[]> = {};
    for (const status of statuses) listed[status] = ids(await suite.listAll({ status }));
    expect(listed).toEqual({
      pending: ["f-pending"],
      completing: ["f-completing"],
      completed: ["g-completed", "f-completed"],
      aborted: ["f-aborted"],
      rejected: ["f-rejected"],
      failed: ["f-failed"],
      expired: ["f-expired"],
      deleted: ["f-deleted"],
    });
    expect(ids(await suite.listAll({ status: "completed", owner: "u-1" }))).toEqual(["f-completed"]);
  });

  it("listAll with a route, a name or a type narrows the rows of every owner as list narrows one owner's", async () => {
    await suite.seed("u-1", [
      { ...named("f-1", "Q3 Report.pdf", "application/pdf"), route: "docs" },
      named("f-2", "100%_done.png", "image/png"),
    ]);
    await suite.seed("u-2", [
      named("g-1", "report-ÄRGER.JPG", "image/jpeg"),
      // What LIKE would also match for "%_" or "_d", where `%` and `_` are wildcards.
      { ...named("g-2", "100x-done.txt"), route: "docs" },
    ]);
    await suite.seed(null, [named("h-1", "ärger_report.txt")]);
    const read = async (filters: { route?: string; name?: string; type?: string }) =>
      ids(await suite.listAll({ order: "oldest", ...filters }));
    expect({
      route: await read({ route: "docs" }),
      mixedCase: await read({ name: "rEPORT" }),
      percent: await read({ name: "%_" }),
      underscore: await read({ name: "_d" }),
      // Only ASCII letters fold, on every backend: Postgres's lower() would fold Ä by the database's locale.
      upperUmlaut: await read({ name: "Ä" }),
      lowerUmlaut: await read({ name: "ä" }),
      topLevelType: await read({ type: "image/" }),
      exactType: await read({ type: "image/png" }),
      // Without its slash a type is exact: not a prefix of "image/png".
      typePrefix: await read({ type: "image/pn" }),
    }).toEqual({
      route: ["f-1", "g-2"],
      mixedCase: ["f-1", "g-1", "h-1"],
      percent: ["f-2"],
      underscore: ["f-2"],
      upperUmlaut: ["g-1"],
      lowerUmlaut: ["h-1"],
      topLevelType: ["f-2", "g-1"],
      exactType: ["f-2"],
      typePrefix: [],
    });
  });

  it("listAll applies an owner, a status and every filter together, in either order, beside a cursor", async () => {
    const photo = (id: string): NewFile => ({ ...named(id, `${id} Photo.png`, "image/png"), route: "docs" });
    await suite.seed("u-1", [
      photo("f-1"),
      photo("f-2"),
      photo("f-3"),
      // Each of the rest misses the listing by one option alone.
      photo("f-pending"),
      { ...photo("f-route"), route: "avatars" },
      { ...photo("f-name"), name: "f-name scan.png" },
      { ...photo("f-type"), type: "application/pdf" },
    ]);
    await suite.seed("u-2", [photo("f-owner")]);
    for (const id of ["f-1", "f-2", "f-3", "f-route", "f-name", "f-type", "f-owner"]) {
      await suite.advance(id, "completed", at(MINUTE));
    }
    // Every option beside the cursor, so SQLite's positional parameters must bind in the order they appear.
    const listing = {
      owner: "u-1",
      status: "completed",
      route: "docs",
      name: "PHOTO",
      type: "image/",
      limit: 2,
    } as const;
    const oldest = await suite.listAll({ ...listing, order: "oldest" });
    expect(ids(oldest)).toEqual(["f-1", "f-2"]);
    expect(await suite.listAll({ ...listing, order: "oldest", cursor: oldest.cursor })).toEqual({
      records: [await suite.store.get("f-3")],
      cursor: null,
    });
    const newest = await suite.listAll({ ...listing, order: "newest" });
    expect(ids(newest)).toEqual(["f-3", "f-2"]);
    expect(ids(await suite.listAll({ ...listing, order: "newest", cursor: newest.cursor }))).toEqual(["f-1"]);
  });
}
