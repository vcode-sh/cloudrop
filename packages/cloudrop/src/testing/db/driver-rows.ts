// The rows only a real driver can break, for every executor lane (the database lane and D1 in the Wrangler lane):
// its number and time encodings, and its connections racing.

import { expect, test } from "vitest";
import { type SqlExecutor, sqlStore } from "../../adapters/sql.ts";

const MAX_SAFE = 9007199254740991; // 2^53 - 1
export const NOW = new Date("2026-11-17T10:20:30.123Z");
export const file = (id: string, size: number) => ({
  id,
  route: "files",
  key: `users/${id}/ünïcode ../name.bin`,
  name: "name.bin",
  type: "application/octet-stream",
  size,
  metadata: '{"album":"summer"}',
});

/** Run after the tables exist, on an executor over them. */
export function driverRows(executor: () => SqlExecutor<unknown>) {
  test("a size of 2^53 - 1 and millisecond times come back exactly, counted in usage", async () => {
    const store = sqlStore(executor());
    expect(
      await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("f-1", MAX_SAFE)] }, NOW),
    ).toEqual(["reserved"]);
    expect(await store.get("f-1")).toMatchObject({
      size: MAX_SAFE,
      expiresAt: NOW,
      createdAt: NOW,
      key: file("f-1", 0).key,
    });
    expect(await store.usage("u-1")).toEqual({ reservedBytes: MAX_SAFE, activeBytes: 0, files: 0 });
  });

  test("concurrent reserves of one owner never overshoot the quota", async () => {
    const store = sqlStore(executor());
    await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, files: [file("q-0", 10)] }, NOW);
    // 10 bytes held, limit 60: room for exactly 5 of the 8 racing 10-byte files.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.reserve({ owner: "u-1", limit: 60, expiresAt: NOW, files: [file(`q-${index + 1}`, 10)] }, NOW),
      ),
    );
    expect(outcomes.flat().filter((outcome) => outcome === "reserved")).toHaveLength(5);
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 60, activeBytes: 0, files: 0 });
  });
}
