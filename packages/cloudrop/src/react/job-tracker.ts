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
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    track(job) {
      let ended = endedOf(job);
      const stop = job.subscribe(() => {
        const now = endedOf(job);
        if (now === ended) return;
        ended = now;
        const { done, aborted, count } = job.getSnapshot().totals;
        // Done and aborted files are final and keep no ticket: the job changes nothing more.
        if (done + aborted === count) stop();
        changed();
      });
      // A resume cancelled while its checks run ends at once, and lets the upload go only when they end, before it
      // settles.
      void job.done.then(changed);
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
