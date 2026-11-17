// reserve with a request key: a retry of an `/upload` whose answer was lost ends that attempt's pending rows and
// releases their bytes in the same unit, so the quota counts without them.

import { expect, it } from "vitest";
import type { NewFile } from "../../server/store.ts";
import { at, EXPIRES, MINUTE, newFile, pendingRow, type StoreSuite, usageRow } from "./suite.ts";

const KEY = "request-key-0000000001";
const OTHER_KEY = "request-key-0000000002";

export function supersedeCases(suite: StoreSuite): void {
  const { advance } = suite;
  const reserve = (owner: string | null, requestKey: string | null, files: NewFile[], limit: number | null, ms = 0) =>
    suite.store.reserve({ owner, limit, expiresAt: EXPIRES, requestKey, files }, at(ms));

  it("reserve with a request key ends the earlier attempt's pending rows, and the quota counts without them", async () => {
    // Limit 100: 60 held by the lost attempt plus 60 for the retry would be refused without superseding.
    expect(await reserve("u-1", KEY, [newFile("f-1", 60)], 100)).toEqual(["reserved"]);
    expect(await reserve("u-1", KEY, [newFile("f-2", 60)], 100, MINUTE)).toEqual(["reserved"]);
    expect(await suite.raw.files()).toEqual([
      pendingRow(newFile("f-1", 60), "u-1", {
        status: "aborted",
        endedAt: at(MINUTE),
        updatedAt: at(MINUTE),
        requestKey: KEY,
      }),
      pendingRow(newFile("f-2", 60), "u-1", { createdAt: at(MINUTE), updatedAt: at(MINUTE), requestKey: KEY }),
    ]);
    expect(await suite.raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 60, updatedAt: at(MINUTE) })]);
  });

  it("a different route, owner or key does not supersede, and a null owner matches only a null owner", async () => {
    await reserve("u-1", KEY, [{ ...newFile("other-route", 1), route: "documents" }], null);
    await reserve("u-2", KEY, [newFile("other-owner", 2)], null);
    await reserve(null, KEY, [newFile("no-owner", 4)], null);
    await reserve("u-1", OTHER_KEY, [newFile("other-key", 8)], null);
    expect(await reserve("u-1", KEY, [newFile("retry-u-1", 16)], null, MINUTE)).toEqual(["reserved"]);
    expect(await reserve(null, KEY, [newFile("retry-no-owner", 32)], null, 2 * MINUTE)).toEqual(["reserved"]);
    expect((await suite.raw.files()).map(({ id, status }) => [id, status])).toEqual([
      ["no-owner", "aborted"],
      ["other-key", "pending"],
      ["other-owner", "pending"],
      ["other-route", "pending"],
      ["retry-no-owner", "pending"],
      ["retry-u-1", "pending"],
    ]);
    expect(await suite.raw.usage()).toEqual([
      usageRow("u-1", { reservedBytes: 1 + 8 + 16, updatedAt: at(MINUTE) }),
      usageRow("u-2", { reservedBytes: 2 }),
    ]);
  });

  it("reserve with a request key leaves the key's rows that are no longer pending alone", async () => {
    await reserve("u-1", KEY, [newFile("f-1", 1), newFile("f-2", 2), newFile("f-3", 4)], null);
    await advance("f-1", "completing", at(0));
    await advance("f-2", "completed", at(0));
    await advance("f-3", "aborted", at(0));
    await reserve("u-1", KEY, [newFile("f-4", 8)], null, MINUTE);
    expect((await suite.raw.files()).map(({ id, status, endedAt }) => [id, status, endedAt])).toEqual([
      ["f-1", "completing", null],
      ["f-2", "completed", null],
      ["f-3", "aborted", at(0)],
      ["f-4", "pending", null],
    ]);
    expect(await suite.raw.usage()).toEqual([
      usageRow("u-1", { reservedBytes: 1 + 8, activeBytes: 2, files: 1, updatedAt: at(MINUTE) }),
    ]);
  });

  it("reserve with a request key supersedes even when every new file is over the quota", async () => {
    // The answer the retry gets is the only one the client will act on: the lost attempt's bytes go either way.
    await reserve("u-1", KEY, [newFile("f-1", 60)], 100);
    expect(await reserve("u-1", KEY, [newFile("f-2", 101)], 100, MINUTE)).toEqual(["over-quota"]);
    expect((await suite.raw.files()).map(({ id, status }) => [id, status])).toEqual([["f-1", "aborted"]]);
    expect(await suite.raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 0, updatedAt: at(MINUTE) })]);
  });

  it("reserve with a request key that fails on a reused id supersedes nothing", async () => {
    await reserve("u-1", KEY, [newFile("f-1", 10)], null);
    const before = { files: await suite.raw.files(), usage: await suite.raw.usage() };
    await expect(reserve("u-1", KEY, [newFile("f-2", 20), newFile("f-1", 30)], null, MINUTE)).rejects.toBeInstanceOf(
      Error,
    );
    expect({ files: await suite.raw.files(), usage: await suite.raw.usage() }).toEqual(before);
    expect(before.files.map(({ id, status }) => [id, status])).toEqual([["f-1", "pending"]]);
  });
}
