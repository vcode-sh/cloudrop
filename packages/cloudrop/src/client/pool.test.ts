// Contract: spec §4.4 and plan A ruling P9: a client's connection slots, granted lower rank first (element by element,
// equal ranks in arrival order), given up by a cancelled waiter, and freed once however often a release is called.
// Oracle: the orders and counts those rules give, worked by hand.

import { describe, expect, it } from "vitest";
import { createPool, type Release } from "./pool.ts";

const live = () => new AbortController().signal;

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Records whether `acquire` has resolved: "waiting", "granted" or "null". */
function track(acquired: Promise<Release | null>) {
  const state = { now: "waiting", release: (() => {}) as Release };
  acquired.then((release) => {
    state.now = release ? "granted" : "null";
    if (release) state.release = release;
  });
  return state;
}

describe("createPool", () => {
  it("grants as many slots as its size and the next one after a release", async () => {
    const pool = createPool(2);
    const [a, b, c] = [
      track(pool.acquire([1, 1], live())),
      track(pool.acquire([1, 2], live())),
      track(pool.acquire([1, 3], live())),
    ];
    await settle();
    const before = [a.now, b.now, c.now];
    a.release();
    await settle();
    expect({ before, after: c.now }).toEqual({ before: ["granted", "granted", "waiting"], after: "granted" });
  });

  it("grants the lowest rank first, compared element by element, equal ranks in arrival order", async () => {
    const pool = createPool(1);
    const hold = await pool.acquire([0], live());
    const order: string[] = [];
    // Each waiter records its turn and hands the slot on at once.
    const queue = (name: string, rank: number[]) =>
      pool.acquire(rank, live()).then((release) => {
        order.push(name);
        release?.();
      });
    const all = Promise.all([
      queue("[2, 1] first", [2, 1]),
      queue("[1, 3]", [1, 3]),
      queue("[1, 2]", [1, 2]),
      queue("[2, 1] second", [2, 1]),
    ]);
    hold?.();
    await all;
    expect(order).toEqual(["[1, 2]", "[1, 3]", "[2, 1] first", "[2, 1] second"]);
  });

  it("drops a waiter whose signal fires and gives the next release to the one behind it", async () => {
    const pool = createPool(1);
    const hold = await pool.acquire([1], live());
    const cancel = new AbortController();
    const [first, second] = [track(pool.acquire([2], cancel.signal)), track(pool.acquire([3], live()))];
    cancel.abort();
    hold?.();
    await settle();
    expect([first.now, second.now]).toEqual(["null", "granted"]);
  });

  it("frees one slot when a release is called twice", async () => {
    const pool = createPool(1);
    const release = await pool.acquire([1], live());
    release?.();
    release?.();
    const [a, b] = [track(pool.acquire([2], live())), track(pool.acquire([3], live()))];
    await settle();
    expect([a.now, b.now]).toEqual(["granted", "waiting"]);
  });

  it("answers null to a signal already fired without taking a slot", async () => {
    const pool = createPool(1);
    const cancelled = AbortSignal.abort();
    const refused = await pool.acquire([1], cancelled);
    const next = track(pool.acquire([2], live()));
    await settle();
    expect({ refused, next: next.now }).toEqual({ refused: null, next: "granted" });
  });
});
