// Listing by prefix in pages and deleting many keys.

import { expect, it } from "vitest";
import type { ContractSuite } from "./suite.ts";

export function listCases(suite: ContractSuite): void {
  const { key } = suite;

  it("lists by prefix in pages and deletes many keys with per-key results", async () => {
    const { driver } = suite;
    const keys = ["list/a", "list/b", "list/c"].map(key);
    const stored = await Promise.all(keys.map((k) => driver.put(k, "x")));
    expect(stored.map((result) => result.error)).toEqual([null, null, null]);
    const first = await driver.list(key("list/"), { limit: 2 });
    expect(first.data?.items.map((item) => item.key)).toEqual(keys.slice(0, 2));
    // Passing the backend's continuation token back also proves it passes the driver's cursor validation.
    const second = await driver.list(key("list/"), { limit: 2, cursor: first.data?.nextCursor ?? "" });
    expect(second.error).toBeNull();
    expect(second.data?.items.map((item) => item.key)).toEqual(keys.slice(2));
    expect(second.data?.nextCursor).toBeNull();
    const everything = [...keys, key("list/never-existed")];
    const removed = await driver.deleteMany(everything);
    expect(removed.data?.failed).toEqual([]);
    expect(removed.data?.deleted.toSorted()).toEqual(everything.toSorted());
    expect((await driver.list(key("list/"))).data?.items).toEqual([]);
  });
}
