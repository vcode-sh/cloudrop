// A fake navigator.locks for the client's unit tests: the one request client/locks.ts makes (an exclusive lock asked
// for with ifAvailable) and locks another tab holds. It fakes only that and is never shipped.

export interface FakeLocks {
  /** For vi.stubGlobal("navigator", { locks: fake.locks }). */
  locks: unknown;
  /** The names this page holds now, sorted. */
  held(): string[];
  /** Holds `name` as another tab would, until the returned function is called. */
  holdElsewhere(name: string): () => void;
  /** Lets go of every lock this page holds, as the browser does when the page unloads. */
  releaseAll(): void;
}

type Callback = (lock: { name: string; mode: "exclusive" } | null) => unknown;

export function fakeLocks(): FakeLocks {
  // Each hold is its own token: a hold let go by releaseAll() never ends a later one of the same name.
  const mine = new Map<string, symbol>();
  const elsewhere = new Set<string>();
  const locks = {
    // As LockManager.request: the callback runs after request() returns, gets null when the lock is taken, and the
    // lock is held until the promise the callback returned settles. request() resolves with that promise's value.
    async request(name: string, options: { ifAvailable?: boolean }, callback: Callback): Promise<unknown> {
      // A request without ifAvailable would wait for the holder; client/locks.ts must never wait.
      if (options.ifAvailable !== true) throw new TypeError("fakeLocks only grants requests made with ifAvailable.");
      await Promise.resolve();
      if (mine.has(name) || elsewhere.has(name)) return callback(null);
      const hold = Symbol(name);
      mine.set(name, hold);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        if (mine.get(name) === hold) mine.delete(name);
      }
    },
  };
  return {
    locks,
    held: () => [...mine.keys()].sort(),
    holdElsewhere(name) {
      elsewhere.add(name);
      return () => elsewhere.delete(name);
    },
    releaseAll: () => mine.clear(),
  };
}
