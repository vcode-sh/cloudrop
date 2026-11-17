import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MiB } from "../rules.ts";
import { complete } from "../testing/complete-fixture.ts";
import { gate, hello, leaseStore, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { FileApi } from "./api.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { route } from "./route.ts";

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
    expect((await fixture.cloudrop.api.usage("u1")).data).toEqual({ reservedBytes: 0, activeBytes: 5, files: 1 });
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
    // The sweep runs just past the deadline with no grace, and stops at its delete.
    const deleting = gate();
    const { fetch } = fixture.fake;
    fixture.fake.fetch = async (input, init) => {
      if (init?.method === "DELETE") await deleting.pass();
      return fetch(input, init);
    };
    vi.setSystemTime(at(24 * HOUR + 1000));
    const sweeping = fixture.cloudrop.api.sweep({ graceMs: 0 });
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
  it("removes a late PUT of a revoked upload once 15 minutes have passed, with no grace, and marks it cleaned", async () => {
    const fixture = storeFixture({ owned });
    const ticket = await fixture.single("owned", TEXT);
    await fixture.cloudrop.api.revokeUploads({ owner: "u1" });
    await fixture.send(ticket.put, hello);
    vi.setSystemTime(at(15 * 60_000));
    expect((await fixture.cloudrop.api.sweep({ graceMs: 0 })).data?.cleaned).toBe(0);
    vi.setSystemTime(at(15 * 60_000 + 1));
    expect((await fixture.cloudrop.api.sweep({ graceMs: 0 })).data?.cleaned).toBe(1);
    expect([(await fixture.storage.head(ticket.key)).data, (await statuses(fixture))[ticket.id]]).toEqual([
      null,
      ["aborted", at(15 * 60_000 + 1)],
    ]);
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

  it.for([
    { name: "a limit of 0", options: { limit: 0 } },
    { name: "a limit over 1000", options: { limit: 1001 } },
    { name: "a negative grace", options: { graceMs: -1 } },
    { name: "a cursor it did not issue", options: { cursor: "garbage" } },
  ] satisfies { name: string; options: Parameters<FileApi["sweep"]>[0] }[])(
    "answers INVALID_INPUT for $name",
    async ({ options }) => {
      const fixture = storeFixture({ owned });
      expect((await fixture.cloudrop.api.sweep(options)).error?.code).toBe("INVALID_INPUT");
    },
  );
});
