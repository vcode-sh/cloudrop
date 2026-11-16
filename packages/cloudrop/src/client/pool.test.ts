// Contract: spec §4.4 and ruling M3-U9: a client's connection slots, granted lower rank first (element by element,
// equal ranks in arrival order), given up by a cancelled waiter, and freed once however often a release is called.
// An automatic pool (rulings M3-U23 to M3-U25) starts at 4, adds one slot when a 2 s window's bytes per millisecond
// rose by 10 % over the previous window's while work waits, up to 8, and halves once per window on slowDown.
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

/**
 * A pool on a clock the test moves. `held` are the slots granted and not given back: with work still waiting, its
 * length is the pool's size.
 */
function clocked(size: number | "auto") {
  let time = 0;
  const pool = createPool(size, () => time);
  const held: Release[] = [];
  return {
    pool,
    held,
    at(ms: number) {
      time = ms;
    },
    /** Queues `count` acquires, in the order given. */
    ask(count: number) {
      for (let i = 0; i < count; i++) {
        pool.acquire([i], live()).then((release) => {
          if (release) held.push(release);
        });
      }
    },
    /** At `ms`, the bucket accepted `bytes`: the call closes a window that is due before it counts them. */
    send(ms: number, bytes: number) {
      time = ms;
      pool.sent(bytes);
    },
    /** Gives back the `count` oldest slots. */
    release(count: number) {
      for (const release of held.splice(0, count)) release();
    },
  };
}

/** With 20 acquires waiting, windows of 2 s whose bytes double each time, from 1000 bytes at t = 0. */
function climbed(windows: number) {
  const run = clocked("auto");
  run.ask(20);
  run.send(0, 1000);
  for (let window = 1; window <= windows; window++) run.send(window * 2000, 1000 * 2 ** window);
  return run;
}

describe("createPool('auto')", () => {
  it("starts with 4 slots", async () => {
    const { ask, held } = clocked("auto");
    ask(5);
    await settle();
    expect(held.length).toBe(4);
  });

  it.each([
    { name: "a rise of 10.1 % adds a slot", second: 1101, size: 5 },
    { name: "a rise of 9.9 % does not", second: 1099, size: 4 },
  ])("compares a window's bytes with the previous window's: $name", async ({ second, size }) => {
    const { ask, send, at, held } = clocked("auto");
    ask(5);
    send(0, 1000);
    send(2000, second);
    at(4000);
    // This acquire weighs the window; the fifth one, waiting since t = 0, is the work that lets the pool grow.
    ask(1);
    await settle();
    expect(held.length).toBe(size);
  });

  it("compares bytes per millisecond, so a longer window's larger total is no rise", async () => {
    const { ask, send, at, held } = clocked("auto");
    ask(5);
    send(0, 1000);
    // 2100 bytes in 4000 ms is 0.525 bytes per ms against 0.5: a 5 % rise.
    send(2000, 2100);
    at(6000);
    ask(1);
    await settle();
    expect(held.length).toBe(4);
  });

  it("does not grow when no work waits", async () => {
    const { ask, send, at, held } = clocked("auto");
    ask(4);
    send(0, 1000);
    send(2000, 2000);
    at(4000);
    // Weighed before it queues: nothing waited while the window ran.
    ask(1);
    await settle();
    expect(held.length).toBe(4);
  });

  it("grows one slot a window, to 8 at most", async () => {
    const [four, seven] = [climbed(4), climbed(7)];
    await settle();
    expect({ afterFour: four.held.length, afterSeven: seven.held.length }).toEqual({ afterFour: 7, afterSeven: 8 });
  });

  it.each([
    {
      name: "a window that began while the pool was idle",
      steps: async ({ ask, send, at, release }: ReturnType<typeof clocked>) => {
        ask(1);
        send(0, 1000);
        await settle();
        at(2000);
        release(1);
        // Idle from 2000 to 3500: the window from 2000 would read as slow and the next one as a rise.
        at(3500);
        ask(5);
        send(3500, 10_000);
        at(5500);
        ask(1);
      },
    },
    {
      name: "a window over 4000 ms, where PUTs held their slots and sent nothing",
      steps: ({ ask, send, at }: ReturnType<typeof clocked>) => {
        ask(5);
        send(0, 1000);
        send(2000, 1);
        send(7000, 10_000);
        at(9000);
        ask(1);
      },
    },
    {
      name: "a window of 0 bytes after another of 0 bytes",
      steps: ({ ask, send, at }: ReturnType<typeof clocked>) => {
        ask(5);
        send(2000, 0);
        at(4000);
        ask(1);
      },
    },
  ])("compares nothing with $name", async ({ steps }) => {
    const run = clocked("auto");
    await steps(run);
    await settle();
    expect(run.held.length).toBe(4);
  });

  it("halves on slowDown once per window and does not grow in the next one", async () => {
    const run = climbed(5);
    await settle();
    const climbedTo = run.held.length;
    run.pool.slowDown();
    run.pool.slowDown();
    run.release(8);
    await settle();
    const halved = run.held.length;
    // The window after the halving rises 50 % over the one before it (12 against 8 bytes per ms) and is held.
    run.send(10_000, 24_000);
    run.send(12_000, 36_000);
    await settle();
    const held = run.held.length;
    run.at(14_000);
    run.ask(1);
    await settle();
    expect({ climbedTo, halved, held, after: run.held.length }).toEqual({ climbedTo: 8, halved: 4, held: 4, after: 5 });
  });

  it("halves 1 to 1", async () => {
    const run = clocked("auto");
    run.ask(6);
    await settle();
    run.pool.slowDown();
    run.send(2000, 0);
    run.pool.slowDown();
    run.send(4000, 0);
    run.pool.slowDown();
    run.release(4);
    await settle();
    expect(run.held.length).toBe(1);
  });

  it("grants nothing after shrinking below the slots in use until enough are given back", async () => {
    const run = clocked("auto");
    run.ask(6);
    await settle();
    run.pool.slowDown();
    run.release(2);
    await settle();
    const afterTwo = run.held.length;
    run.release(1);
    await settle();
    expect({ afterTwo, afterThree: run.held.length }).toEqual({ afterTwo: 2, afterThree: 2 });
  });

  it("keeps a fixed size whatever is sent and however often it is told to slow down", async () => {
    const run = clocked(2);
    run.ask(5);
    run.send(0, 1000);
    run.send(2000, 5000);
    run.at(4000);
    run.ask(1);
    await settle();
    const afterRise = run.held.length;
    run.pool.slowDown();
    run.release(2);
    await settle();
    expect({ afterRise, afterSlowDown: run.held.length }).toEqual({ afterRise: 2, afterSlowDown: 2 });
  });
});
