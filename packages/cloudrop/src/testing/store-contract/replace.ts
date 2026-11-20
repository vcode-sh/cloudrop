// complete with replace: the owner's previous completed files on the route end as deleted in the completion's own unit,
// and two completions at once leave exactly one file.

import { expect, it } from "vitest";
import type { FileRecord, NewFile } from "../../server/store.ts";
import { at, LEASE, MINUTE, newFile, pendingRow, type StoreSuite, usageRow } from "./suite.ts";

const byId = (records: readonly FileRecord[]) => records.toSorted((a, b) => (a.id < b.id ? -1 : 1));

const onRoute = (id: string, size: number, route: string): NewFile => ({ ...newFile(id, size), route });

export function replaceCases(suite: StoreSuite): void {
  const { rawFile, seed, advance, skipWithout } = suite;

  it("complete with replace deletes the owner's other completed files on the route and answers them", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("old-1", 10), newFile("old-2", 20), newFile("new", 100), newFile("waiting", 5)]);
    await seed("u-1", [onRoute("doc", 7, "docs")]);
    await seed("u-2", [newFile("other-owner", 3)]);
    for (const id of ["old-1", "old-2", "doc", "other-owner"]) await advance(id, "completed", at(MINUTE));
    await advance("new", "completing", at(MINUTE));
    const done = await store.complete("new", "claim-new", null, at(2 * MINUTE), { replace: true });
    expect(done.changed).toBe(true);
    expect(done.record).toEqual(await store.get("new"));
    expect(byId(done.replaced)).toEqual([await store.get("old-1"), await store.get("old-2")]);
    expect(await rawFile("old-1")).toEqual(
      pendingRow(newFile("old-1", 10), "u-1", {
        status: "deleted",
        claim: "claim-old-1",
        claimedAt: at(MINUTE),
        completedAt: at(MINUTE),
        endedAt: at(2 * MINUTE),
        updatedAt: at(2 * MINUTE),
      }),
    );
    // Untouched: another route, another owner, an upload not yet completed.
    expect((await rawFile("doc"))?.status).toBe("completed");
    expect((await rawFile("other-owner"))?.status).toBe("completed");
    expect((await rawFile("waiting"))?.status).toBe("pending");
    expect(await raw.usage()).toEqual([
      usageRow("u-1", { reservedBytes: 5, activeBytes: 107, files: 2, updatedAt: at(2 * MINUTE) }),
      usageRow("u-2", { activeBytes: 3, files: 1, updatedAt: at(MINUTE) }),
    ]);
  });

  it("complete with replace of a file without an owner replaces nothing", async () => {
    const { store } = suite;
    await seed(null, [newFile("old", 10), newFile("new", 10)]);
    await advance("old", "completed", at(MINUTE));
    await advance("new", "completing", at(MINUTE));
    const done = await store.complete("new", "claim-new", null, at(2 * MINUTE), { replace: true });
    expect({ changed: done.changed, replaced: done.replaced }).toEqual({ changed: true, replaced: [] });
    expect((await rawFile("old"))?.status).toBe("completed");
  });

  it("complete with replace that changes nothing replaces nothing", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("old", 10), newFile("new", 10)]);
    await advance("old", "completed", at(MINUTE));
    await advance("new", "completing", at(MINUTE));
    const before = { files: await raw.files(), usage: await raw.usage() };
    const lost = await store.complete("new", "another-claim", null, at(2 * MINUTE), { replace: true });
    expect(lost).toEqual({ changed: false, record: await store.get("new"), replaced: [] });
    expect({ files: await raw.files(), usage: await raw.usage() }).toEqual(before);
  });

  it("complete without replace keeps the other completed files", async () => {
    const { store } = suite;
    await seed("u-1", [newFile("old", 10), newFile("new", 10)]);
    await advance("old", "completed", at(MINUTE));
    await advance("new", "completing", at(MINUTE));
    expect((await store.complete("new", "claim-new", null, at(2 * MINUTE))).replaced).toEqual([]);
    expect((await rawFile("old"))?.status).toBe("completed");
  });

  it("two replacing completions at once leave exactly one completed file per owner", async (ctx) => {
    const { store, raw } = suite;
    skipWithout(ctx, "concurrency");
    // Eight owners, each with two uploads completing at the same moment and one older file: many chances to interleave.
    const owners = Array.from({ length: 8 }, (_, index) => `u-${index}`);
    for (const owner of owners) {
      await seed(owner, [newFile(`${owner}-old`, 1), newFile(`${owner}-a`, 10), newFile(`${owner}-b`, 10)]);
      await advance(`${owner}-old`, "completed", at(0));
      await store.claim(`${owner}-a`, "a", at(0), LEASE);
      await store.claim(`${owner}-b`, "b", at(0), LEASE);
    }
    await Promise.all(
      owners.flatMap((owner) => [
        store.complete(`${owner}-a`, "a", null, at(MINUTE), { replace: true }),
        store.complete(`${owner}-b`, "b", null, at(MINUTE), { replace: true }),
      ]),
    );
    const completed = (await raw.files()).filter((row) => row.status === "completed").map((row) => row.owner);
    expect(completed.toSorted()).toEqual(owners);
    expect((await raw.usage()).map(({ owner, activeBytes, files }) => ({ owner, activeBytes, files }))).toEqual(
      owners.map((owner) => ({ owner, activeBytes: 10, files: 1 })),
    );
  });
}
