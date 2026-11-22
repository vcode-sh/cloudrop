import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { hello, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";

// Contract: M12-O4 and M12-R3. The sweep's erase pass carries on every erasure eraseOwner started and has not finished,
// with the sweep's grace, signal and context; it never sets a mark, so an owner reopened meanwhile stays reopened.
// Oracles: the sweep's report, the fake bucket's objects and the memory store's erase marks.

const HOUR = 3_600_000;
const at = (ms: number) => vi.setSystemTime(NOW.getTime() + ms);
const time = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Uploads one file of u1's and completes it. */
async function completed(fixture: ReturnType<typeof storeFixture>) {
  const ticket = await fixture.single("owned", TEXT);
  await fixture.send(ticket.put, hello);
  expect((await complete(fixture, ticket.token)).status).toBe(200);
  return ticket;
}

describe("the sweep's erase pass", () => {
  it("finishes an erasure its call stopped after the first file, with the sweep's grace", async () => {
    const base = memoryStore();
    const controller = new AbortController();
    const fixture = storeFixture(
      { owned },
      {
        store: {
          ...base,
          // The signal aborts as the run records its first deletion; the run handles no file after it.
          end: async (...call) => {
            const ended = await base.end(...call);
            controller.abort();
            return ended;
          },
        },
      },
    );
    const tickets = [await completed(fixture), await completed(fixture)];
    const { api } = fixture.cloudrop;
    const stopped = await api.eraseOwner("u1", { signal: controller.signal });
    expect(stopped.data).toMatchObject({ deleted: 1, done: false });
    at(2 * HOUR);
    expect((await api.sweep()).data).toMatchObject({ erasing: 1, erased: 1, failed: 0, cursor: null });
    const left = await Promise.all(tickets.map(async (ticket) => (await fixture.storage.head(ticket.key)).data));
    expect(left).toEqual([null, null]);
    expect((await api.usage("u1")).data?.erasure).toEqual({ requestedAt: NOW, erasedAt: time(2 * HOUR) });
    // Finished: the next sweep has nobody to erase.
    expect((await api.sweep()).data).toMatchObject({ erasing: 0, erased: 0 });
  });

  it("starts no further owner once its signal aborts", async () => {
    const base = memoryStore();
    const controller = new AbortController();
    let armed = false;
    const fixture = storeFixture(
      { owned },
      {
        store: {
          ...base,
          // The signal aborts while the sweep runs its first owner.
          revoke: (...call) => {
            if (armed) controller.abort();
            return base.revoke(...call);
          },
        },
      },
    );
    const { api } = fixture.cloudrop;
    for (const owner of ["u1", "u2"]) await api.eraseOwner(owner, { signal: AbortSignal.abort() });
    armed = true;
    const swept = await api.sweep({ all: true, signal: controller.signal });
    expect(swept.data).toMatchObject({ erasing: 1, erased: 0 });
  });

  it("answers the last owner it ran when stopped mid-page, so continuing from it skips no owner", async () => {
    const base = memoryStore();
    const controller = new AbortController();
    let armed = false;
    const fixture = storeFixture(
      { owned },
      {
        store: {
          ...base,
          revoke: (...call) => {
            if (armed) controller.abort();
            return base.revoke(...call);
          },
        },
      },
    );
    const { api } = fixture.cloudrop;
    for (const owner of ["u1", "u2", "u3"]) await api.eraseOwner(owner, { signal: AbortSignal.abort() });
    armed = true;
    // A page of two owners, u1 and u2; the signal aborts while u1 runs, so u2 never runs.
    const stopped = await api.sweep({ all: true, limit: 2, signal: controller.signal });
    // u1 ran but did not finish: its run saw the signal abort too.
    expect(stopped.data).toMatchObject({ erasing: 1, erased: 0, cursor: "erase:u1" });
    armed = false;
    const rest = await api.sweep({ cursor: stopped.data?.cursor, limit: 2 });
    expect(rest.data).toMatchObject({ erasing: 2, erased: 2 });
  });

  it("answers the pass's start when stopped before its first owner ran, not the cleanup pass", async () => {
    const base = memoryStore();
    const controller = new AbortController();
    const fixture = storeFixture(
      { owned },
      {
        store: {
          ...base,
          // The signal aborts while the erase pass reads its page.
          erasing: (page) => {
            controller.abort();
            return base.erasing(page);
          },
        },
      },
    );
    const { api } = fixture.cloudrop;
    await api.eraseOwner("u1", { signal: AbortSignal.abort() });
    const stopped = await api.sweep({ all: true, signal: controller.signal });
    expect(stopped.data).toMatchObject({ erasing: 0, cursor: "erase:" });
    expect((await api.sweep({ cursor: "erase:" })).data).toMatchObject({ erasing: 1, erased: 1 });
  });

  it("counts an erasure it cannot finish as failed, logs it, and finishes it once storage is back", async () => {
    const fixture = storeFixture({ owned }, { erase: { prefixes: (owner) => [`exports/${owner}/`] } });
    const { api } = fixture.cloudrop;
    const { fetch } = fixture.fake;
    fixture.fake.fetch = () => Promise.reject(new TypeError("network down"));
    expect((await api.eraseOwner("u1")).data).toMatchObject({ failed: 1, done: false });
    expect((await api.sweep()).data).toMatchObject({ erasing: 1, erased: 0, failed: 1 });
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      "cloudrop: eraseOwner could not empty exports/u1/. Run eraseOwner again.",
      "cloudrop: eraseOwner could not empty exports/u1/. Run eraseOwner again.",
    ]);
    fixture.fake.fetch = fetch;
    expect((await api.sweep()).data).toMatchObject({ erasing: 1, erased: 1, failed: 0 });
  });

  // Review finding F1: the pass read u2 on its page, then marked it again after the app reopened it, and finished it.
  it("skips an owner reopened while it runs an earlier owner of the page, and never marks it again", async () => {
    const base = memoryStore();
    let reopen = async () => {};
    const revoke: typeof base.revoke = async (...call) => {
      await reopen();
      return base.revoke(...call);
    };
    const fixture = storeFixture({ owned }, { store: { ...base, revoke } });
    const { api } = fixture.cloudrop;
    for (const owner of ["u1", "u2"]) await api.eraseOwner(owner, { signal: AbortSignal.abort() });
    at(HOUR);
    reopen = async () => {
      reopen = async () => {};
      expect((await api.reopenOwner("u2")).data).toEqual({ reopened: true });
    };
    expect((await api.sweep()).data).toMatchObject({ erasing: 1, erased: 1 });
    expect([(await api.usage("u1")).data?.erasure, (await api.usage("u2")).data?.erasure]).toEqual([
      { requestedAt: NOW, erasedAt: time(HOUR) },
      null,
    ]);
  });

  // Review finding F3: without a cursor every sweep starts the pass at the first owner, so an owner that keeps failing
  // holds the page's place ahead of the owners after it. The guide documents it; each failed run warns once.
  it("warns once per owner whose run fails, and an owner after it waits while the failing one fills the limit", async () => {
    const base = memoryStore();
    const revoke: typeof base.revoke = (owner, now) =>
      owner === "a" ? Promise.reject(new Error("connection reset")) : base.revoke(owner, now);
    const fixture = storeFixture({ owned }, { store: { ...base, revoke } });
    const { api } = fixture.cloudrop;
    for (const owner of ["a", "b"]) await api.eraseOwner(owner, { signal: AbortSignal.abort() });
    for (let sweep = 0; sweep < 3; sweep++) await api.sweep({ limit: 1 });
    expect((await api.usage("b")).data?.erasure).toEqual({ requestedAt: NOW, erasedAt: null });
    const warning =
      "cloudrop: the sweep could not finish erasing a (The server could not reach its upload records. Try again in a moment.). The next sweep tries again, and until one succeeds this owner takes one row of each sweep's limit ahead of the owners after it: fix the cause, or continue each sweep from the cursor the last one answered.";
    expect(fixture.logger.warnings).toEqual([warning, warning, warning]);
  });
});
