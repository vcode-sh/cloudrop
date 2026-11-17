// reserve and attach: the rows written before anything is signed, the quota checked per file, and the upload id.

import { expect, it } from "vitest";
import { at, EXPIRES, MINUTE, newFile, pendingRow, type StoreSuite, usageRow } from "./suite.ts";

export function reserveCases(suite: StoreSuite): void {
  const { skipWithout, rawFile, seed, advance } = suite;

  it("reserve writes one pending row per file and adds their bytes to the owner's reserved bytes", async () => {
    const { store, raw } = suite;
    const first = { ...newFile("f-1", 1024), metadata: '{"album":"summer"}' };
    const second = newFile("f-2", 2048);
    const outcomes = await store.reserve(
      { owner: "u-1", limit: null, expiresAt: EXPIRES, files: [first, second] },
      at(0),
    );
    expect(outcomes).toEqual(["reserved", "reserved"]);
    expect(await raw.files()).toEqual([pendingRow(first, "u-1"), pendingRow(second, "u-1")]);
    expect(await raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 3072 })]);
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 3072, activeBytes: 0, files: 0 });
    expect(await store.usage("nobody")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
    expect(await store.get("f-1")).toEqual({
      ...first,
      owner: "u-1",
      status: "pending",
      uploadId: null,
      result: null,
      expiresAt: EXPIRES,
      createdAt: at(0),
      claimedAt: null,
      completedAt: null,
      endedAt: null,
      cleanedAt: null,
    });
    expect(await store.get("missing")).toBeNull();
  });

  it("reserve checks each file in order against reserved plus active bytes, exact to the byte", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("f-0", 30)]);
    await advance("f-0", "completed", at(0));
    // 30 active: 30 + 40 = 70 fits; 70 + 31 = 101 does not; 70 + 30 = 100 is exactly the limit and fits.
    const files = [newFile("f-1", 40), newFile("f-2", 31), newFile("f-3", 30)];
    const outcomes = await store.reserve({ owner: "u-1", limit: 100, expiresAt: EXPIRES, files }, at(MINUTE));
    expect(outcomes).toEqual(["reserved", "over-quota", "reserved"]);
    expect((await raw.files()).map((row) => row.id)).toEqual(["f-0", "f-1", "f-3"]);
    expect(await raw.usage()).toEqual([
      usageRow("u-1", { reservedBytes: 70, activeBytes: 30, files: 1, updatedAt: at(MINUTE) }),
    ]);
  });

  it("reserve without an owner writes the rows, counts no usage and applies no limit", async () => {
    const { store, raw } = suite;
    const file = newFile("f-1", 500);
    expect(await store.reserve({ owner: null, limit: 1, expiresAt: EXPIRES, files: [file] }, at(0))).toEqual([
      "reserved",
    ]);
    expect(await raw.files()).toEqual([pendingRow(file, null)]);
    expect(await raw.usage()).toEqual([]);
  });

  it("reserve that fails on one file writes none of the call's files", async () => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("f-1", 10)]);
    const before = { files: await raw.files(), usage: await raw.usage() };
    // The second file reuses an existing id, so the database refuses it after the first was written.
    const files = [newFile("f-2", 20), newFile("f-1", 30)];
    await expect(
      store.reserve({ owner: "u-1", limit: null, expiresAt: EXPIRES, files }, at(MINUTE)),
    ).rejects.toBeInstanceOf(Error);
    expect({ files: await raw.files(), usage: await raw.usage() }).toEqual(before);
  });

  it("reserve with a quota that fails after its first write leaves nothing written", async (ctx) => {
    const { store, raw, target } = suite;
    skipWithout(ctx, "failureInjection");
    target.injectFailure?.("reserve", 1);
    const files = [newFile("f-1", 10), newFile("f-2", 20)];
    await expect(store.reserve({ owner: "u-1", limit: 100, expiresAt: EXPIRES, files }, at(0))).rejects.toBeInstanceOf(
      Error,
    );
    expect({ files: await raw.files(), usage: await raw.usage() }).toEqual({ files: [], usage: [] });
    // The failure was injected once: the same call now succeeds.
    expect(await store.reserve({ owner: "u-1", limit: 100, expiresAt: EXPIRES, files }, at(0))).toEqual([
      "reserved",
      "reserved",
    ]);
  });

  it("attach stores the upload id on a pending row, again for the same id, and never another", async () => {
    const { store } = suite;
    await seed("u-1", [newFile("f-1", 10)]);
    expect(await store.attach("f-1", "upload-a", at(MINUTE))).toBe(true);
    expect(await store.attach("f-1", "upload-a", at(2 * MINUTE))).toBe(true);
    expect(await store.attach("f-1", "upload-b", at(3 * MINUTE))).toBe(false);
    expect(await rawFile("f-1")).toEqual(
      pendingRow(newFile("f-1", 10), "u-1", { uploadId: "upload-a", updatedAt: at(2 * MINUTE) }),
    );
    expect(await store.attach("missing", "upload-a", at(MINUTE))).toBe(false);
  });

  it("attach refuses a row that is no longer pending, as after a revoke", async () => {
    const { store } = suite;
    await seed("u-1", [newFile("f-1", 10)]);
    expect(await store.revoke("u-1", at(MINUTE))).toBe(1);
    expect(await store.attach("f-1", "upload-a", at(2 * MINUTE))).toBe(false);
    expect((await rawFile("f-1"))?.uploadId).toBeNull();
  });
}
