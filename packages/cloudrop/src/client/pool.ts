// The connection slots one client shares between all its uploads (spec §4.4). A slot is held by one bucket PUT;
// calls to the upload server take none. An automatic pool sizes itself from the bytes the bucket accepts: it weighs a
// window of at least 2 s whenever it is used, never on a timer, so an idle client holds none (plan B, ruling Q1).

/** Gives the slot back. Calling it more than once frees one slot. */
export type Release = () => void;

export interface Pool {
  /** Waits for a free slot, lower rank first (compared element by element, ties in arrival order); null when the
   * signal fires first. Calling the release more than once frees one slot. */
  acquire(rank: readonly number[], signal: AbortSignal): Promise<Release | null>;
  /** Bytes the bucket accepted; an automatic pool grows on them. */
  sent(bytes: number): void;
  /** A network error, a stall or a 429/503: an automatic pool halves (at least 1) and does not grow in the next
   * window (rulings Q2, Q3). */
  slowDown(): void;
}

interface Waiter {
  rank: readonly number[];
  grant(release: Release): void;
}

/** Measured on R2 on 2026-11-16: 4 connections sent 60 MiB/s and 16 sent 71 MiB/s (spec §4.4). */
const AUTO_START = 4;
const AUTO_MAX = 8;
const WINDOW_MS = 2000;
/** A longer window means PUTs held their slots without sending: it says nothing about speed and is not compared. */
const LONGEST_WINDOW_MS = 4000;
/** The rise in bytes per millisecond over the previous window that adds a slot. */
const RISE = 1.1;

/** Whether rank `a` goes before rank `b`: the first element that differs decides; equal ranks keep arrival order. */
const before = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

export function createPool(size: number | "auto", now: () => number = () => Date.now()): Pool {
  const auto = size === "auto";
  let slots = auto ? AUTO_START : size;
  let inUse = 0;
  const waiting: Waiter[] = [];
  // The window being measured; the first acquire starts the first one. `lastRate` is the previous window's bytes per
  // millisecond, 0 when there is none to compare with.
  let windowStart = 0;
  let windowBytes = 0;
  let lastRate = 0;
  // Set by slowDown until its window closes (ruling Q2).
  let hold = false;

  const restart = (rate: number) => {
    lastRate = rate;
    windowStart = now();
    windowBytes = 0;
    hold = false;
  };

  /** Closes a window that is due, one slot more when work waits and bytes per ms rose; then fills the free slots. */
  const update = () => {
    const elapsed = now() - windowStart;
    if (auto && elapsed >= WINDOW_MS) {
      const rate = elapsed > LONGEST_WINDOW_MS ? 0 : windowBytes / elapsed;
      // `lastRate > 0` also keeps a pool that sends nothing from reading 0 after 0 as a rise.
      if (!hold && waiting.length > 0 && lastRate > 0 && rate >= lastRate * RISE && slots < AUTO_MAX) slots++;
      restart(rate);
    }
    while (inUse < slots) {
      const next = waiting.shift();
      if (!next) return;
      inUse++;
      next.grant(releaser());
    }
  };

  const releaser = (): Release => {
    let used = false;
    return () => {
      if (used) return;
      used = true;
      inUse--;
      update();
    };
  };

  return {
    acquire(rank, signal) {
      if (signal.aborted) return Promise.resolve(null);
      // A window that began while nothing was sending would read as slow, and the next one as a rise. Nobody waits
      // when no slot is in use: every release grants the waiters it can.
      if (inUse === 0) restart(0);
      // update() grants the waiters first, so a free slot left after it means nobody waits: no overtaking.
      update();
      if (inUse < slots) {
        inUse++;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve) => {
        const drop = () => {
          waiting.splice(waiting.indexOf(entry), 1);
          resolve(null);
        };
        const entry: Waiter = {
          rank,
          grant: (release) => {
            signal.removeEventListener("abort", drop);
            resolve(release);
          },
        };
        const at = waiting.findIndex((other) => before(rank, other.rank));
        waiting.splice(at === -1 ? waiting.length : at, 0, entry);
        signal.addEventListener("abort", drop, { once: true });
      });
    },
    sent(bytes) {
      // Weighed before these bytes count: they belong to the window that starts now if one closed.
      update();
      windowBytes += bytes;
    },
    slowDown() {
      if (!auto || hold) return;
      slots = Math.max(1, Math.floor(slots / 2));
      restart(lastRate);
      hold = true;
    },
  };
}
