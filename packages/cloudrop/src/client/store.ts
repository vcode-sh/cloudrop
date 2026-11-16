// The snapshot a page renders (spec §2.1): the same object until something changes, listeners at most every 100 ms
// while bytes flow and at once on a status change, and a refresh every second while a file uploads (ruling P7).

const THROTTLE_MS = 100;
const REFRESH_MS = 1000;

export interface Store<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
  /** Something changed: `urgent` (a status) publishes now; bytes publish at most every 100 ms. */
  changed(urgent: boolean): void;
}

export function createStore<T>(build: () => T, active: () => boolean): Store<T> {
  let snapshot = build();
  let lastMs = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueMs = Number.POSITIVE_INFINITY;
  const listeners = new Set<() => void>();

  const schedule = (atMs: number) => {
    if (timer !== undefined && dueMs <= atMs) return;
    clearTimeout(timer);
    dueMs = atMs;
    timer = setTimeout(publish, Math.max(0, atMs - Date.now()));
  };
  function publish() {
    clearTimeout(timer);
    timer = undefined;
    dueMs = Number.POSITIVE_INFINITY;
    snapshot = build();
    lastMs = Date.now();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        // The upload and the other listeners go on; the page still sees the error as uncaught (ruling P8).
        setTimeout(() => {
          throw error;
        });
      }
    }
    if (active()) schedule(lastMs + REFRESH_MS);
  }
  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    changed: (urgent) => (urgent ? publish() : schedule(lastMs + THROTTLE_MS)),
  };
}
