// list's filters and order (M10-D1): a name substring with ASCII case folding only, an exact type or a top-level type,
// and oldest first. Every backend must answer the same rows, so these run on Postgres, SQLite, D1 and the memory store.

import { expect, it } from "vitest";
import type { FileRecord, NewFile } from "../../server/store.ts";
import { at, MINUTE, newFile, type StoreSuite } from "./suite.ts";

const ids = (page: { records: FileRecord[] }) => page.records.map((record) => record.id);

/** A file of `id` with this name and type. */
const named = (id: string, name: string, type = "text/plain"): NewFile => ({ ...newFile(id, 1), name, type });

export function listFilterCases(suite: StoreSuite): void {
  /** Seeds `files` for "u-1" and completes each, so the listing below reads them. */
  async function completed(files: readonly NewFile[]): Promise<void> {
    await suite.seed("u-1", files);
    for (const file of files) await suite.advance(file.id, "completed", at(MINUTE));
  }

  const read = (filters: { name?: string; type?: string }) =>
    suite.store.list({
      owner: "u-1",
      statuses: ["completed"],
      route: null,
      name: filters.name ?? null,
      type: filters.type ?? null,
      order: "oldest",
      limit: 10,
      cursor: null,
    });

  it("list with a name answers names containing it, ASCII letters in either case, every other character as itself", async () => {
    await completed([
      named("f-1", "Q3 Report.pdf"),
      named("f-2", "report-final.PDF"),
      named("f-3", "100%_done.txt"),
      // What LIKE would also match for "%_" or "_d", where `%` and `_` are wildcards.
      named("f-4", "100x-done.txt"),
      named("f-5", "Ärger.txt"),
      named("f-6", "ärger.txt"),
    ]);
    expect(ids(await read({ name: "rEPORT" }))).toEqual(["f-1", "f-2"]);
    expect(ids(await read({ name: "%_" }))).toEqual(["f-3"]);
    expect(ids(await read({ name: "_d" }))).toEqual(["f-3"]);
    // Only ASCII letters fold, on every backend: Postgres's lower() would fold Ä by the database's locale.
    expect(ids(await read({ name: "ä" }))).toEqual(["f-6"]);
    expect(ids(await read({ name: "Ä" }))).toEqual(["f-5"]);
    expect(ids(await read({ name: ".TXT" }))).toEqual(["f-3", "f-4", "f-5", "f-6"]);
  });

  it("list with a type answers that exact type, or with a trailing slash every type under it", async () => {
    await completed([
      named("f-png", "a.png", "image/png"),
      named("f-jpeg", "b.jpg", "image/jpeg"),
      named("f-pdf", "c.pdf", "application/pdf"),
      named("f-imagex", "d.bin", "imagex/raw"),
    ]);
    // One created_at for all, so the ids decide the order.
    expect(ids(await read({ type: "image/" }))).toEqual(["f-jpeg", "f-png"]);
    expect(ids(await read({ type: "image/png" }))).toEqual(["f-png"]);
    // Without its slash a type is exact: not a prefix of "image/png".
    expect(ids(await read({ type: "image/pn" }))).toEqual([]);
  });

  it("list filters only rows in the statuses asked for, by route, name and type together", async () => {
    await suite.seed("u-1", [
      { ...named("f-match", "photo.png", "image/png"), route: "docs" },
      { ...named("f-route", "photo.png", "image/png"), route: "avatars" },
      { ...named("f-pending", "photo.png", "image/png"), route: "docs" },
    ]);
    await suite.advance("f-match", "completed", at(MINUTE));
    await suite.advance("f-route", "completed", at(MINUTE));
    const page = await suite.store.list({
      owner: "u-1",
      statuses: ["completed"],
      route: "docs",
      name: "PHOTO",
      type: "image/",
      order: "newest",
      limit: 10,
      cursor: null,
    });
    expect(ids(page)).toEqual(["f-match"]);
  });

  it("list oldest first answers created_at ascending, ties in byte order of id, and pages forward with filters", async () => {
    const reserve = (minutes: number, files: NewFile[]) =>
      suite.store.reserve(
        { owner: "u-1", limit: null, expiresAt: at(24 * 60 * MINUTE), requestKey: null, files },
        at(minutes * MINUTE),
      );
    await reserve(1, [newFile("f-old", 1)]);
    // Same created_at: "B" (0x42) sorts before "a" (0x61) in byte order, whatever the collation.
    await reserve(2, [newFile("f-a", 1), newFile("f-B", 1), { ...newFile("f-doc", 1), type: "text/plain" }]);
    await reserve(3, [newFile("f-new", 1)]);
    const page = (cursor: string | null) =>
      suite.store.list({
        owner: "u-1",
        statuses: ["pending"],
        route: "avatars",
        // Every filter beside the cursor, so SQLite's positional parameters must bind in the order they appear.
        name: ".PNG",
        type: "image/",
        order: "oldest",
        limit: 2,
        cursor,
      });
    const first = await page(null);
    expect(ids(first)).toEqual(["f-old", "f-B"]);
    // The page ends between two rows of one created_at: the next starts after the cursor's id, not its time.
    const second = await page(first.cursor);
    expect(ids(second)).toEqual(["f-a", "f-new"]);
    expect(second.cursor).toBeNull();
  });
}
