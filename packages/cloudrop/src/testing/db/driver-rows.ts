// The rows only a real driver can break, for every SQL store (the sql adapter's executors, Drizzle, Prisma, D1):
// its number and time encodings, and its connections racing for one owner's quota. Call it inside a `describe` whose
// `beforeEach` gives each row empty tables; `storeOver` builds the store under test over them.

import { expect, test } from "vitest";
import type { CloudropStore } from "../../server/store.ts";

const MAX_SAFE = 9007199254740991; // 2^53 - 1
const NOW = new Date("2026-11-17T10:20:30.123Z");
const file = (id: string, size: number) => ({
  id,
  route: "files",
  key: `users/${id}/ünïcode ../name.bin`,
  name: "name.bin",
  type: "application/octet-stream",
  size,
  metadata: '{"album":"summer"}',
});

export function driverRows(storeOver: () => CloudropStore<unknown> | Promise<CloudropStore<unknown>>): void {
  test("a size of 2^53 - 1 and millisecond times come back exactly, counted in usage", async () => {
    const store = await storeOver();
    expect(
      await store.reserve(
        { owner: "u-1", limit: null, expiresAt: NOW, requestKey: null, files: [file("f-1", MAX_SAFE)] },
        NOW,
      ),
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
    const store = await storeOver();
    await store.reserve({ owner: "u-1", limit: null, expiresAt: NOW, requestKey: null, files: [file("q-0", 10)] }, NOW);
    // 10 bytes held, limit 60: room for exactly 5 of the 8 racing 10-byte files.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.reserve(
          { owner: "u-1", limit: 60, expiresAt: NOW, requestKey: null, files: [file(`q-${index + 1}`, 10)] },
          NOW,
        ),
      ),
    );
    expect(outcomes.flat().filter((outcome) => outcome === "reserved")).toHaveLength(5);
    expect(await store.usage("u-1")).toEqual({ reservedBytes: 60, activeBytes: 0, files: 0 });
  });
}
