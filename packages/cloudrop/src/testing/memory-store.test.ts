import { describe, expect, it } from "vitest";
import { memoryStore } from "./memory-store.ts";
import { describeStoreContract } from "./store-contract.ts";

describeStoreContract("memory store", async () => {
  const store = memoryStore();
  return {
    store,
    raw: store.raw,
    gaps: {
      tables: "the memory store keeps maps, not SQL tables",
    },
    injectFailure: store.injectFailure,
    teardown: async () => {},
  };
});

// What the handler's tests rely on beyond the contract: the recording transaction handle and app rows written through it.
describe("memory store transaction handle", () => {
  const T = new Date("2026-11-17T12:00:00.000Z");
  const file = { id: "f-1", route: "avatars", key: "a.png", name: "a.png", type: "image/png", size: 5, metadata: null };

  it("records the store calls made inside, in order, and commits app rows written through tx", async () => {
    const store = memoryStore();
    await store.reserve({ owner: "u-1", limit: null, expiresAt: T, files: [file] }, T);
    const calls = await store.transaction(async (tx, inner) => {
      await inner.get("f-1");
      await inner.claim("f-1", "claim-a", T, 60_000);
      tx.write("photo f-1");
      await inner.complete("f-1", "claim-a", null, T);
      return tx.calls;
    });
    expect(calls).toEqual(["get", "claim", "complete"]);
    expect(store.appRows()).toEqual(["photo f-1"]);
  });

  it("rolls back the app rows a failed transaction wrote and keeps those of a committed one", async () => {
    const store = memoryStore();
    await store.transaction(async (tx) => tx.write("kept"));
    const failing = store.transaction(async (tx) => {
      tx.write("rolled back");
      throw new Error("onComplete failed");
    });
    await expect(failing).rejects.toThrow("onComplete failed");
    expect(store.appRows()).toEqual(["kept"]);
  });
});
