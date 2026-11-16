// The connection slots one client shares between all its uploads (spec §4.4). A slot is held by one bucket PUT;
// calls to the upload server take none.

/** Gives the slot back. Calling it more than once frees one slot. */
export type Release = () => void;

export interface Pool {
  /** Waits for a free slot, lower rank first (compared element by element, ties in arrival order); null when the
   * signal fires first. Calling the release more than once frees one slot. */
  acquire(rank: readonly number[], signal: AbortSignal): Promise<Release | null>;
}

interface Waiter {
  rank: readonly number[];
  grant(release: Release): void;
}

/** Whether rank `a` goes before rank `b`: the first element that differs decides; equal ranks keep arrival order. */
const before = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

export function createPool(size: number): Pool {
  let free = size;
  const waiting: Waiter[] = [];
  const releaser = (): Release => {
    let used = false;
    return () => {
      if (used) return;
      used = true;
      // The slot passes straight to the first waiter, so a new acquire cannot overtake the queue.
      const next = waiting.shift();
      if (next) next.grant(releaser());
      else free++;
    };
  };
  return {
    acquire(rank, signal) {
      if (signal.aborted) return Promise.resolve(null);
      if (free > 0) {
        free--;
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
  };
}
