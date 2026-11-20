import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hello, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { SweepOptions } from "./sweep.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const HOUR = 3_600_000;
/** The token's deadline (24 h) plus the default grace (1 h), and one second more. */
const PAST_GRACE = new Date(NOW.getTime() + 25 * HOUR + 1000);

/** Three unfinished uploads, a stuck completion and a revoked upload whose object landed late: all sweep work. */
async function work() {
  const fixture = storeFixture({ owned });
  for (let index = 0; index < 3; index++) await fixture.single("owned", TEXT);
  // Half a second later, so its deadline sorts after the three others' and every page holds known rows.
  vi.setSystemTime(NOW.getTime() + 500);
  const stuck = await fixture.single("owned", TEXT);
  await fixture.store.claim(stuck.id, "crashed", NOW, 300_000);
  const revoked = await fixture.single("owned", TEXT);
  await fixture.store.end(revoked.id, "pending", "aborted", NOW);
  await fixture.send(revoked.put, hello);
  vi.setSystemTime(PAST_GRACE);
  return { fixture, stuck };
}

describe("api.sweep with all", () => {
  it("sweeps every page in one call, a page of limit rows at a time, and sums the reports", async () => {
    const { fixture, stuck } = await work();
    const { stale } = fixture.store;
    const limits: number[] = [];
    fixture.store.stale = (input) => {
      limits.push(input.limit);
      return stale(input);
    };
    const swept = await fixture.cloudrop.api.sweep({ all: true, limit: 2 });
    expect({ ...swept.data, reported: swept.data?.reported.map((record) => record.id) }).toEqual({
      expired: 3,
      cleaned: 1,
      failed: 0,
      reported: [stuck.id],
      cursor: null,
    });
    // Five rows, two per page at most: the sums above took several pages.
    expect(limits.filter((limit) => limit > 2)).toEqual([]);
    expect((await fixture.store.raw.files()).filter((row) => row.cleanedAt === null)).toEqual([]);
  });

  it("stops before the next page once its signal aborts, with a cursor that continues there", async () => {
    const { fixture } = await work();
    const controller = new AbortController();
    const { stale } = fixture.store;
    fixture.store.stale = (input) => {
      controller.abort();
      return stale(input);
    };
    const stopped = await fixture.cloudrop.api.sweep({ all: true, limit: 2, signal: controller.signal });
    expect([stopped.data?.expired, stopped.data?.cleaned]).toEqual([2, 0]);
    const rest = await fixture.cloudrop.api.sweep({ all: true, cursor: stopped.data?.cursor ?? undefined });
    expect([rest.data?.expired, rest.data?.cleaned, rest.data?.reported.length, rest.data?.cursor]).toEqual([
      1,
      1,
      1,
      null,
    ]);
  });

  it("answers an aborted signal before any page with a cursor that starts from the beginning", async () => {
    const { fixture } = await work();
    const stopped = await fixture.cloudrop.api.sweep({ all: true, signal: AbortSignal.abort() });
    expect(stopped.data).toEqual({ expired: 0, cleaned: 0, failed: 0, reported: [], cursor: "expire:" });
  });

  it("answers what the earlier pages did when a later listing fails, the listing counted and no cursor", async () => {
    const { fixture } = await work();
    const { stale } = fixture.store;
    let listings = 0;
    fixture.store.stale = (input) => {
      listings += 1;
      return listings === 2 ? Promise.reject(new Error("connection refused")) : stale(input);
    };
    const swept = await fixture.cloudrop.api.sweep({ all: true, limit: 2 });
    expect(swept.data).toEqual({ expired: 2, cleaned: 0, failed: 1, reported: [], cursor: null });
  });

  it("answers the store's error when the first listing fails", async () => {
    const { fixture } = await work();
    fixture.store.stale = () => Promise.reject(new Error("connection refused"));
    expect((await fixture.cloudrop.api.sweep({ all: true })).error).toMatchObject({
      code: "SERVER_ERROR",
      retryable: true,
    });
  });

  it.for<{ name: string; options: SweepOptions }>([
    { name: "a signal without all", options: { signal: AbortSignal.abort() } },
    { name: "a signal that is not an AbortSignal", options: { all: true, signal: {} as AbortSignal } },
    { name: "an all that is not true or false", options: { all: "yes" as unknown as boolean } },
  ])("answers INVALID_INPUT for $name", async ({ options }) => {
    const fixture = storeFixture({ owned });
    expect((await fixture.cloudrop.api.sweep(options)).error?.code).toBe("INVALID_INPUT");
  });
});
