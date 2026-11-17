// The jobs every hook of one factory started, for useResumable (M4-B3, M4-B12): it reads the list again when a job
// starts and whenever one of its files ends or starts again, and leaves out the uploads this page holds.

import type { ResumableUpload, UploadJob } from "../client.ts";

export interface JobTracker {
  /** Follows `job`, whose `files` are the ones passed to start() or resume(), in order, under `route`. */
  track(job: UploadJob<unknown>, route: string, files: readonly unknown[]): void;
  /** Calls `listener` when a tracked job starts, or one of its files ends or starts again; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  /**
   * True when a tracked file that has not ended done or aborted is the record's file: one that is queued, uploading,
   * paused, completing, or failed and kept for retry(). Its record is this page's, and resume() of it is refused.
   */
  holds(upload: ResumableUpload): boolean;
}

interface Tracked {
  job: UploadJob<unknown>;
  route: string;
  files: readonly unknown[];
}

/** done + failed + aborted: it changes when a file ends, and when retry() sends a failed one again. */
const endedOf = (job: UploadJob<unknown>) => {
  const { done, failed, aborted } = job.getSnapshot().totals;
  return done + failed + aborted;
};

/** The fields a record keeps of its file; resume() also checks the file's edges, which a list cannot read. */
const isRecordOf = (upload: ResumableUpload, route: string, file: unknown) =>
  file instanceof File &&
  upload.route === route &&
  upload.name === file.name &&
  upload.size === file.size &&
  upload.type === file.type &&
  upload.lastModified === file.lastModified;

export function createJobTracker(): JobTracker {
  const tracked = new Set<Tracked>();
  const listeners = new Set<() => void>();
  // In a microtask: a file that ends aborted publishes before the client queues its record's removal (letGo in
  // client/persist.ts), and a read queued after that removal no longer finds the record.
  const changed = () =>
    queueMicrotask(() => {
      for (const listener of listeners) listener();
    });
  return {
    track(job, route, files) {
      const entry = { job, route, files };
      tracked.add(entry);
      let ended = endedOf(job);
      const stop = job.subscribe(() => {
        const now = endedOf(job);
        if (now === ended) return;
        ended = now;
        const { done, aborted, count } = job.getSnapshot().totals;
        // Done and aborted files are final and keep no record: the job holds nothing more.
        if (done + aborted === count) {
          stop();
          tracked.delete(entry);
        }
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
    holds(upload) {
      for (const { job, route, files } of tracked) {
        const statuses = job.getSnapshot().files.map((file) => file.status);
        const isHeld = (index: number) => statuses[index] !== "done" && statuses[index] !== "aborted";
        if (files.some((file, index) => isHeld(index) && isRecordOf(upload, route, file))) return true;
      }
      return false;
    },
  };
}
