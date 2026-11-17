// A fake navigator.locks for the client's unit tests: the one request client/locks.ts makes (an exclusive lock asked
// for with ifAvailable), locks another tab holds, and a page that may not take locks. As in a browser, a lock this page
// holds refuses this page's next request for it too. It fakes only that and is never shipped.

export interface FakeLocks {
  /** For vi.stubGlobal("navigator", { locks: fake.locks }). */
  locks: unknown;
  /** The names this page holds now, sorted. */
  held(): string[];
  /** Holds `name` as another tab would, until the returned function is called. */
  holdElsewhere(name: string): () => void;
  /** Lets go of every lock this page holds, as the browser does when the page unloads. */
  releaseAll(): void;
  /** From now on every request rejects, as for a document that is no longer active. */
  refuse(): void;
}

type Callback = (lock: { name: string; mode: "exclusive" } | null) => unknown;

export function fakeLocks(): FakeLocks {
  // Each hold is its own token: a hold let go by releaseAll() never ends a later one of the same name.
  const mine = new Map<string, symbol>();
  const elsewhere = new Set<string>();
  let refused = false;
  const locks = {
    // As LockManager.request: the callback runs after request() returns, gets null when the lock is taken, and the
    // lock is held until the promise the callback returned settles. request() resolves with that promise's value.
    async request(name: string, options: { ifAvailable?: boolean }, callback: Callback): Promise<unknown> {
      // A request without ifAvailable would wait for the holder; client/locks.ts must never wait.
      if (options.ifAvailable !== true) throw new TypeError("fakeLocks only grants requests made with ifAvailable.");
      if (refused) throw new DOMException("The document is not fully active.", "InvalidStateError");
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
    refuse() {
      refused = true;
    },
  };
}
