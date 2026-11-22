import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRoute } from "../adapters/transactional.ts";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { gate, hello, NOW, storeFixture, TEXT } from "../testing/store-fixture.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A store with a transaction and a route whose onComplete writes an app row through `tx`, then runs `after`. */
async function transactional(after: (run: number) => unknown = (run) => ({ run })) {
  const store = memoryStore();
  const txRoute = withRoute(store).route;
  const seen: string[][] = [];
  let runs = 0;
  const files = txRoute(
    { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
    {
      owner: ({ userId }) => userId,
      onComplete: async ({ tx, userId, file }) => {
        runs += 1;
        tx.write(`${userId}:${file.id}:${runs}`);
        seen.push([...tx.calls]);
        return after(runs);
      },
    },
  );
  const fixture = storeFixture({ files }, { store });
  const ticket = await fixture.single("files", TEXT);
  await fixture.send(ticket.put, hello);
  return { fixture, ticket, store, seen, runs: () => runs };
}

describe("POST /complete with a transactional store", () => {
  it("claims, runs onComplete with tx and completes in one transaction that commits the app's row", async () => {
    const { fixture, ticket, store, seen } = await transactional();
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 1 });
    expect(seen).toEqual([["claim"]]);
    expect(store.appRows()).toEqual([`u1:${ticket.id}:1`]);
    const [row] = await store.raw.files();
    expect([row?.status, row?.result]).toEqual(["completed", '{"run":1}']);
    expect(await store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 5, files: 1, erasure: null });
  });

  it.for([
    {
      name: "onComplete throws",
      after: () => {
        throw new Error("constraint violated");
      },
    },
    { name: "the result is over 16 KiB", after: () => "x".repeat(16 * 1024) },
  ])("rolls back the claim and the app's row when $name, and the retry runs it again", async ({ after }) => {
    const { fixture, ticket, store, runs } = await transactional((run) => (run === 1 ? after() : { run }));
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "SERVER_ERROR",
      message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
      retryable: true,
    });
    const [row] = await store.raw.files();
    expect([row?.status, row?.claim, store.appRows(), await store.usage("u1")]).toEqual([
      "pending",
      null,
      [],
      { reservedBytes: 5, activeBytes: 0, files: 0, erasure: null },
    ]);
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 2 });
    expect([runs(), store.appRows()]).toEqual([2, [`u1:${ticket.id}:2`]]);
  });

  it("answers busy to a completion that overlaps a running transaction, and commits one app row", async () => {
    const paused = gate();
    const { fixture, ticket, store, runs } = await transactional(async (run) => {
      await paused.pass();
      return { run };
    });
    const first = complete(fixture, ticket.token);
    await paused.arrived;
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "SERVER_ERROR",
      message: "Another request is completing this upload. Try again in a moment.",
      retryable: true,
    });
    paused.open();
    expect((await first).body.data).toEqual({ run: 1 });
    expect([runs(), store.appRows()]).toEqual([1, [`u1:${ticket.id}:1`]]);
  });

  it("answers busy when the store reports the row lock timed out", async () => {
    const { fixture, ticket, store, runs } = await transactional();
    const { transaction } = store;
    store.transaction = (run) =>
      transaction((tx, inner) => run(tx, { ...inner, claim: async () => ({ kind: "busy" }) }));
    expect((await complete(fixture, ticket.token)).body.error?.message).toBe(
      "Another request is completing this upload. Try again in a moment.",
    );
    expect([runs(), (await store.raw.files())[0]?.status]).toEqual([0, "pending"]);
  });

  it("gives tx only to routes from the store's own route(), not to a plain route on the same store", async () => {
    const store = memoryStore();
    const seen: unknown[] = [];
    // An authorize result may not name a field tx (M12-A8), so a plain route's context has none at all.
    const plain = route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      { owner: ({ userId }) => userId, onComplete: (context) => void seen.push("tx" in context) },
    );
    const fixture = storeFixture({ plain }, { store });
    const ticket = await fixture.single("plain", TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    expect(seen).toEqual([false]);
  });
});
