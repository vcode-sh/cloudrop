// The jobs every hook of one factory started, for useResumable (M4-B3, M4-B12): the client's resumable() leaves out the
// uploads this page holds (M4-F22), so the list is read again whenever that may have changed.

import type { UploadJob } from "../client.ts";

export interface JobTracker {
  /** Follows a job that start() or resume() just returned. */
  track(job: UploadJob<unknown>): void;
  /**
   * Calls `listener` when a tracked job starts, when one of its files ends or starts again, and when it settles;
   * returns the unsubscribe.
   */
  onChange(listener: () => void): () => void;
}

/** done + failed + aborted: it changes when a file ends, and when retry() sends a failed one again. */
const endedOf = (job: UploadJob<unknown>) => {
  const { done, failed, aborted } = job.getSnapshot().totals;
  return done + failed + aborted;
};

export function createJobTracker(): JobTracker {
  const listeners = new Set<() => void>();
  // In a microtask: a file cancelled while its /complete is in doubt settles, which publishes, and only then does the
  // client delete its record and release its claim (end() and letGo in client/file-run.ts and persist.ts). A read
  // started inside the publish would be queued before that removal and list the deleted record. One microtask per
  // burst: cancelling a job ends all its files at once, and each would cost a read of IndexedDB. A job whose every file
  // has settled but whose `done` has not yet calls changed() again when it does, so the burst's read waits for that.
  let queued = false;
  const finishing = new Set<UploadJob<unknown>>();
  const changed = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (finishing.size === 0) for (const listener of listeners) listener();
    });
  };
  return {
    track(job) {
      let ended = endedOf(job);
      let settled = false;
      const stop = job.subscribe(() => {
        const now = endedOf(job);
        if (now === ended) return;
        ended = now;
        const { done, aborted, count } = job.getSnapshot().totals;
        // Done and aborted files are final and keep no ticket: the job changes nothing more.
        if (done + aborted === count) stop();
        if (now === count && !settled) finishing.add(job);
        changed();
      });
      // A resume cancelled while its checks run ends at once, and lets the upload go only when they end, before it
      // settles.
      void job.done.then(() => {
        settled = true;
        finishing.delete(job);
        changed();
      });
      changed();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
