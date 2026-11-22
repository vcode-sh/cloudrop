import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MiB } from "../rules.ts";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { gate, hello, leaseStore, NOW, owned, recordCalls, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { route } from "./route.ts";
import type { StoreFileApi } from "./store-api.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 3_600_000;
/** The token's deadline (24 h) plus the default grace (1 h), and one second more. */
const PAST_GRACE = at(25 * HOUR + 1000);

const statuses = async (fixture: ReturnType<typeof storeFixture>) =>
  Object.fromEntries((await fixture.store.raw.files()).map((row) => [row.id, [row.status, row.cleanedAt]]));

describe("api.sweep: expire", () => {
  it("ends unfinished uploads past their deadline and the grace, removing only what each one left", async () => {
    const fixture = storeFixture({ owned }, { multipartThreshold: 6 * MiB });
    const multipart = await fixture.multipart("owned", { name: "big.bin", size: 9 * MiB, type: "" });
    const landed = await fixture.single("owned", TEXT);
    await fixture.send(landed.put, hello);
    const foreign = await fixture.single("owned", TEXT);
    await fixture.storage.put(foreign.key, "other", { metadata: { "cloudrop-id": "another-upload" } });
    const done = await fixture.single("owned", TEXT);
    await fixture.send(done.put, hello);
    await complete(fixture, done.token);
    await fixture.storage.put("no-row/file.txt", "x");
    vi.setSystemTime(at(25 * HOUR));
    expect((await fixture.cloudrop.api.sweep()).data).toEqual({
      expired: 0,
      cleaned: 0,
      failed: 0,
      reported: [],
      cursor: null,
    });
    vi.setSystemTime(PAST_GRACE);
    expect((await fixture.cloudrop.api.sweep()).data).toEqual({
      expired: 3,
      cleaned: 0,
      failed: 0,
      reported: [],
      cursor: null,
    });
    expect(await statuses(fixture)).toEqual({
      [multipart.id]: ["expired", PAST_GRACE],
      [landed.id]: ["expired", PAST_GRACE],
      [foreign.id]: ["expired", PAST_GRACE],
      [done.id]: ["completed", null],
    });
    const heads = await Promise.all(
      [landed.key, foreign.key, done.key, "no-row/file.txt"].map(
        async (key) => (await fixture.storage.head(key)).data?.size,
      ),
    );
    expect([heads, fixture.fake.pendingUploads()]).toEqual([[undefined, 5, 5, 1], 0]);
    expect((await fixture.cloudrop.api.usage("u1")).data).toEqual({
      reservedBytes: 0,
      activeBytes: 5,
      files: 1,
      erasure: null,
    });
  });

  it("marks a row cleaned at the time its check started, not when the storage answered", async () => {
    const fixture = storeFixture({ owned });
    const landed = await fixture.single("owned", TEXT);
    await fixture.send(landed.put, hello);
    vi.setSystemTime(PAST_GRACE);
    // The storage takes a minute to answer the HEAD: a PUT could have landed in that minute, after the look.
    const { fetch } = fixture.fake;
    fixture.fake.fetch = async (input, init) => {
      if (init?.method === "HEAD") vi.setSystemTime(Date.now() + 60_000);
      return fetch(input, init);
    };
    expect((await fixture.cloudrop.api.sweep()).data?.expired).toBe(1);
    expect((await statuses(fixture))[landed.id]).toEqual(["expired", PAST_GRACE]);
  });

  it("ends a completion stuck past its lease and deadline as failed, keeps its object and reports it once", async () => {
    const fixture = storeFixture({ owned });
    const stuck = await fixture.single("owned", TEXT);
    await fixture.send(stuck.put, hello);
    // A /complete that claimed the row and then crashed.
    await fixture.store.claim(stuck.id, "crashed", NOW, 300_000);
    vi.setSystemTime(at(HOUR));
    const live = await fixture.single("owned", TEXT);
    await fixture.store.claim(live.id, "crashed", at(HOUR), 300_000);
    vi.setSystemTime(PAST_GRACE);
    const first = await fixture.cloudrop.api.sweep();
    expect([first.data?.expired, first.data?.reported.map((record) => [record.id, record.status])]).toEqual([
      0,
      [[stuck.id, "failed"]],
    ]);
    expect((await fixture.cloudrop.api.sweep()).data?.reported).toEqual([]);
    expect((await statuses(fixture))[stuck.id]).toEqual(["failed", PAST_GRACE]);
    expect((await fixture.storage.head(stuck.key)).data?.size).toBe(5);
    // Its onComplete may have recorded the file, so even the client's own /abort keeps the object.
    expect((await fixture.post("abort", { token: stuck.token })).status).toBe(200);
    expect((await fixture.storage.head(stuck.key)).data?.size).toBe(5);
    // Its lease has passed, but its token is still within the grace: a resumed client may still complete it.
    expect((await statuses(fixture))[live.id]).toEqual(["completing", null]);
  });

  it("takes the row before it deletes, so a completion that verified in time can never lose its object", async () => {
    const verifying = gate();
    let paused = false;
    const slowCheck: CloudropPlugin = {
      id: "slow-check",
      server: {
        afterVerify: async () => {
          if (paused) return;
          paused = true;
          await verifying.pass();
        },
      },
    };
    const fixture = storeFixture({ owned }, { store: leaseStore(), plugins: [slowCheck] });
    const ticket = await fixture.single("owned", TEXT);
    await fixture.send(ticket.put, hello);
    const completing = complete(fixture, ticket.token);
    await verifying.arrived;
    // The sweep runs just past the deadline and the shortest grace, and stops at its delete.
    const deleting = gate();
    const { fetch } = fixture.fake;
    fixture.fake.fetch = async (input, init) => {
      if (init?.method === "DELETE") await deleting.pass();
      return fetch(input, init);
    };
    vi.setSystemTime(at(24 * HOUR + 15 * 60_000 + 1000));
    const sweeping = fixture.cloudrop.api.sweep({ graceMs: 15 * 60_000 });
    await deleting.arrived;
    verifying.open();
    const answer = await completing;
    deleting.open();
    await sweeping;
    expect([
      answer.status,
      (await statuses(fixture))[ticket.id]?.[0],
      (await fixture.storage.head(ticket.key)).data,
    ]).toEqual([410, "expired", null]);
  });

  it("leaves alone a completion it races while that completion's lease is live", async () => {
    const paused = gate();
    const slow = route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      { owner: ({ userId }) => userId, onComplete: () => paused.pass() },
    );
    const fixture = storeFixture({ slow }, { store: leaseStore(), completionLeaseMs: 26 * HOUR });
    const ticket = await fixture.single("slow", TEXT);
    await fixture.send(ticket.put, hello);
    const completing = complete(fixture, ticket.token);
    await paused.arrived;
    vi.setSystemTime(PAST_GRACE);
    expect((await fixture.cloudrop.api.sweep()).data?.reported).toEqual([]);
    paused.open();
    expect((await completing).status).toBe(200);
    expect([(await statuses(fixture))[ticket.id], (await fixture.storage.head(ticket.key)).data?.size]).toEqual([
      ["completed", null],
      5,
    ]);
  });
});

describe("api.sweep: cleanup", () => {
  it("removes a revoked upload's late PUTs until none can land, and only then marks it cleaned", async () => {
    const fixture = storeFixture({ owned });
    const ticket = await fixture.single("owned", TEXT);
    await fixture.cloudrop.api.revokeUploads("u1");
    await fixture.send(ticket.put, hello);
    const sweep = async () => (await fixture.cloudrop.api.sweep({ graceMs: 15 * 60_000 })).data?.cleaned;
    /** A sweep's count, then what the key holds and the row's status and cleaned_at after it. */
    const sweepAndLook = async () => [
      await sweep(),
      (await fixture.storage.head(ticket.key)).data,
      (await statuses(fixture))[ticket.id],
    ];
    vi.setSystemTime(at(15 * 60_000));
    expect(await sweep()).toBe(0);
    // Past the grace after the revoke, but a URL signed just before it could start a PUT until 15 minutes after it,
    // and that PUT has the grace to land: the check is final 30 minutes after the revoke (M8-A4).
    vi.setSystemTime(at(15 * 60_000 + 1));
    const early = await sweepAndLook();
    await fixture.storage.put(ticket.key, "late", { type: "text/plain", metadata: { "cloudrop-id": ticket.id } });
    vi.setSystemTime(at(30 * 60_000));
    const settled = await sweepAndLook();

    expect({ early, settled }).toEqual({
      early: [0, null, ["aborted", null]],
      settled: [1, null, ["aborted", at(30 * 60_000)]],
    });
  });

  it("does nothing the second time, and two sweeps at once end each row once", async () => {
    const fixture = storeFixture({ owned });
    for (let index = 0; index < 3; index++) await fixture.single("owned", TEXT);
    vi.setSystemTime(PAST_GRACE);
    const [first, second] = await Promise.all([fixture.cloudrop.api.sweep(), fixture.cloudrop.api.sweep()]);
    expect((first.data?.expired ?? 0) + (second.data?.expired ?? 0)).toBe(3);
    const callsBefore = fixture.storageCalls.length;
    expect((await fixture.cloudrop.api.sweep()).data).toEqual({
      expired: 0,
      cleaned: 0,
      failed: 0,
      reported: [],
      cursor: null,
    });
    expect([fixture.storageCalls.length - callsBefore, fixture.logger.errors]).toEqual([0, []]);
  });
});

describe("api.sweep: paging and failures", () => {
  it("handles at most limit rows per call and continues from the cursor", async () => {
    const fixture = storeFixture({ owned });
    for (let index = 0; index < 3; index++) await fixture.single("owned", TEXT);
    vi.setSystemTime(PAST_GRACE);
    const first = await fixture.cloudrop.api.sweep({ limit: 2 });
    expect([first.data?.expired, typeof first.data?.cursor]).toEqual([2, "string"]);
    const second = await fixture.cloudrop.api.sweep({ limit: 2, cursor: first.data?.cursor ?? undefined });
    expect(second.data).toEqual({ expired: 1, cleaned: 0, failed: 0, reported: [], cursor: null });
    // The null a finished sweep answers starts the next one from the beginning: nothing is left to do (M11-R64).
    const again = await fixture.cloudrop.api.sweep({ cursor: second.data?.cursor });
    expect(again).toEqual({ data: { expired: 0, cleaned: 0, failed: 0, reported: [], cursor: null }, error: null });
  });

  it("logs a row that fails every time, goes on past it and still reports what it ended", async () => {
    const fixture = storeFixture({ owned });
    const stuck = await fixture.single("owned", TEXT);
    await fixture.store.claim(stuck.id, "crashed", NOW, 300_000);
    vi.setSystemTime(at(1000));
    const poison = await fixture.single("owned", TEXT);
    vi.setSystemTime(at(2000));
    const later = await fixture.single("owned", TEXT);
    await fixture.send(later.put, hello);
    // Every storage request for the poison row's key fails; the rows are swept oldest first: stuck, poison, later.
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) =>
      String(input instanceof Request ? input.url : input).includes(poison.key)
        ? Promise.reject(new TypeError("network down"))
        : fetch(input, init);
    vi.setSystemTime(at(25 * HOUR + 3000));
    const first = await fixture.cloudrop.api.sweep();
    expect({ ...first.data, reported: first.data?.reported.map((record) => record.id) }).toEqual({
      expired: 1,
      cleaned: 0,
      failed: 1,
      reported: [stuck.id],
      cursor: null,
    });
    expect([(await statuses(fixture))[later.id], (await fixture.storage.head(later.key)).data]).toEqual([
      ["expired", at(25 * HOUR + 3000)],
      null,
    ]);
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      `cloudrop: the sweep could not finish file ${poison.id}. The next sweep tries again.`,
    ]);
    // Ended but not cleaned: the cleanup pass finishes it once the storage answers.
    fixture.fake.fetch = fetch;
    vi.setSystemTime(at(26 * HOUR + 4000));
    expect((await fixture.cloudrop.api.sweep()).data).toEqual({
      expired: 0,
      cleaned: 1,
      failed: 0,
      reported: [],
      cursor: null,
    });
    expect((await statuses(fixture))[poison.id]).toEqual(["expired", at(26 * HOUR + 4000)]);
  });

  it("answers the store's error when it cannot list any work, so a caller's loop stops", async () => {
    const fixture = storeFixture({ owned });
    await fixture.single("owned", TEXT);
    fixture.store.stale = () => Promise.reject(new Error("connection refused"));
    vi.setSystemTime(PAST_GRACE);
    expect(await fixture.cloudrop.api.sweep()).toEqual({
      data: null,
      error: expect.objectContaining({ code: "SERVER_ERROR", retryable: true }),
    });
  });

  it("answers what it did, the failed listing counted and no cursor, when a listing fails after some rows", async () => {
    const fixture = storeFixture({ owned });
    const ticket = await fixture.single("owned", TEXT);
    const { stale } = fixture.store;
    fixture.store.stale = (input) =>
      input.kind === "cleanup" ? Promise.reject(new Error("connection refused")) : stale(input);
    vi.setSystemTime(PAST_GRACE);
    expect((await fixture.cloudrop.api.sweep()).data).toEqual({
      expired: 1,
      cleaned: 0,
      failed: 1,
      reported: [],
      cursor: null,
    });
    expect((await statuses(fixture))[ticket.id]?.[0]).toBe("expired");
  });

  it("refuses a grace under 15 minutes, the life of an upload URL, and takes exactly 15", async () => {
    const fixture = storeFixture({ owned });
    const ticket = await fixture.single("owned", TEXT);
    vi.setSystemTime(at(24 * HOUR + 15 * 60_000 + 1));
    expect(await fixture.cloudrop.api.sweep({ graceMs: 14 * 60_000 })).toEqual({
      data: null,
      error: expect.objectContaining({
        code: "INVALID_INPUT",
        message: "graceMs must be from 900000 (15 minutes, the life of an upload URL) to 2592000000 (30 days).",
      }),
    });
    expect((await fixture.cloudrop.api.sweep({ graceMs: 15 * 60_000 })).data?.expired).toBe(1);
    expect((await statuses(fixture))[ticket.id]?.[0]).toBe("expired");
  });

  it("takes the longest lease and the longest grace, 30 days each", async () => {
    const fixture = storeFixture({ owned }, { completionLeaseMs: 2_592_000_000 });
    await fixture.single("owned", TEXT);
    // 31 days on, the upload is a day past its deadline and the 30 days of grace.
    vi.setSystemTime(at(31 * 24 * HOUR + 1));
    expect((await fixture.cloudrop.api.sweep({ graceMs: 2_592_000_000 })).data).toEqual({
      expired: 1,
      cleaned: 0,
      failed: 0,
      reported: [],
      cursor: null,
    });
  });

  it.for([
    { name: "a limit of 0", options: { limit: 0 } },
    { name: "a limit over 1000", options: { limit: 1001 } },
    { name: "a limit that is not a whole number", options: { limit: 1.5 } },
    // The sweep subtracts the grace from the time: one this long gave a date no database stores (M11-R63).
    { name: "a grace of the largest safe integer", options: { graceMs: Number.MAX_SAFE_INTEGER } },
    { name: "a grace one millisecond over 30 days", options: { graceMs: 2_592_000_001 } },
    { name: "a grace that is not a number", options: { graceMs: Number.POSITIVE_INFINITY } },
    { name: "a cursor it did not issue", options: { cursor: "garbage" } },
    { name: "an expire cursor whose position was edited", options: { cursor: "expire:not-a-cursor" } },
    { name: "a cleanup cursor without the row's id", options: { cursor: "cleanup:1763380800000:" } },
  ] satisfies { name: string; options: Parameters<StoreFileApi["sweep"]>[0] }[])(
    "answers INVALID_INPUT for $name, before any store call",
    async ({ options }) => {
      const { store, calls } = recordCalls(memoryStore());
      const fixture = storeFixture({ owned }, { store });
      expect((await fixture.cloudrop.api.sweep(options)).error?.code).toBe("INVALID_INPUT");
      expect(calls).toEqual([]);
    },
  );
});
