// The files a replacing completion runs onDelete for (M10-D5, M10-D6): the owner's completed files on its own route,
// every page of them, and none for a file without an owner.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { type MemoryStore, memoryStore } from "../testing/memory-store.ts";
import { hello, leaseStore, NOW, storeFixture, TEXT } from "../testing/store-fixture.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const policy = { accept: "*/*", maxSize: 1024, authorize: () => ({ userId: "u1" }) };

/**
 * A server on `store` whose "avatar" route keeps one file per owner when `replace` is set, beside a "docs" route of the
 * same owner. `hooks` lists the files either route's onDelete ran for, in order.
 */
function replacing(store: MemoryStore | Omit<MemoryStore, "transaction">, owner: string | null, replace = true) {
  const hooks: string[] = [];
  const callbacks = { owner: () => owner, onDelete: ({ file }: { file: { id: string } }) => void hooks.push(file.id) };
  const fixture = storeFixture(
    { avatar: route({ ...policy, replace }, callbacks), docs: route(policy, callbacks) },
    { store },
  );
  const upload = async (name: "avatar" | "docs") => {
    const ticket = await fixture.single(name, TEXT);
    await fixture.send(ticket.put, hello);
    return ticket;
  };
  const uploaded = async (name: "avatar" | "docs") => {
    const ticket = await upload(name);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    return ticket;
  };
  const statuses = async () => (await fixture.store.raw.files()).map((row) => row.status).sort();
  return { fixture, hooks, upload, uploaded, statuses };
}

describe("the files a replacement runs onDelete for", () => {
  it("only the owner's files on its own route", async () => {
    const { hooks, uploaded, statuses } = replacing(memoryStore(), "u1");
    await uploaded("docs");
    const previous = await uploaded("avatar");
    await uploaded("avatar");
    expect([hooks, await statuses()]).toEqual([[previous.id], ["completed", "completed", "deleted"]]);
  });

  it("none for a file without an owner, which replaces nothing", async () => {
    const { hooks, uploaded, statuses } = replacing(memoryStore(), null);
    await uploaded("avatar");
    await uploaded("avatar");
    expect([hooks, await statuses()]).toEqual([[], ["completed", "completed"]]);
  });

  // An owner has several files on a route from before it got `replace`: the first replacement deletes them all. A page
  // is 100 files; this store answers one a page, in the completion's transaction too. A replacement that listed only
  // the first page would roll back for ever: the files it replaced would never be the ones it ran onDelete for.
  it("every page of them", async () => {
    const base = memoryStore();
    const onePerPage =
      (list: MemoryStore["list"]): MemoryStore["list"] =>
      (input) =>
        list({ ...input, limit: 1 });
    const store: MemoryStore = {
      ...base,
      list: onePerPage(base.list),
      transaction: (run) => base.transaction((tx, scoped) => run(tx, { ...scoped, list: onePerPage(scoped.list) })),
    };
    const before = replacing(store, "u1", false);
    const older = await before.uploaded("avatar");
    vi.setSystemTime(NOW.getTime() + 1000);
    const newer = await before.uploaded("avatar");
    const { hooks, uploaded, statuses } = replacing(store, "u1");
    await uploaded("avatar");
    expect([hooks, await statuses()]).toEqual([
      [newer.id, older.id],
      ["completed", "deleted", "deleted"],
    ]);
  });

  it("a listing that fails keeps the previous file and fails /complete, which a retry finishes", async () => {
    const base = leaseStore();
    let down = false;
    const store = {
      ...base,
      list: (input: Parameters<MemoryStore["list"]>[0]) =>
        down ? Promise.reject(new Error("The database is down.")) : base.list(input),
    };
    const { fixture, hooks, upload, uploaded, statuses } = replacing(store, "u1");
    const previous = await uploaded("avatar");
    const next = await upload("avatar");
    down = true;
    const failed = await complete(fixture, next.token);
    expect([failed.status, failed.body.error]).toEqual([
      500,
      {
        code: "SERVER_ERROR",
        message: "The server could not reach its upload records. Try again in a moment.",
        retryable: true,
      },
    ]);
    expect([hooks, await statuses()]).toEqual([[], ["completed", "pending"]]);
    down = false;
    expect((await complete(fixture, next.token)).status).toBe(200);
    expect([hooks, await statuses()]).toEqual([[previous.id], ["completed", "deleted"]]);
  });
});
