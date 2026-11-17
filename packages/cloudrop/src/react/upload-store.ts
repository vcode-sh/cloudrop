// What one useUpload renders, kept outside React for useSyncExternalStore: the files of every job the hook started, in
// start order, each with its file's controls, and totals across those jobs. It listens to the jobs only while React
// listens to it, so an unmounted hook holds nothing, and it never cancels a job: the client owns them (M4-B4).

import type { FileHandle, FileSnapshot, FileStatus, JobSnapshot, UploadJob } from "../client.ts";
import type { UploadItem } from "./types.ts";

type Totals = JobSnapshot<unknown>["totals"];

export interface UploadView<R> {
  files: readonly UploadItem<R>[];
  totals: Totals;
  isUploading: boolean;
}

/** The state before any upload, and React's server snapshot: one constant, so hydration renders the same. */
export const EMPTY_VIEW: UploadView<never> = {
  files: [],
  totals: { bytes: 0, size: 0, progress: 0, speed: 0, eta: null, done: 0, failed: 0, aborted: 0, count: 0 },
  isUploading: false,
};

const UPLOADING: ReadonlySet<FileStatus> = new Set(["queued", "uploading", "completing"]);
const SUMMED = ["bytes", "size", "speed", "done", "failed", "aborted", "count"] as const;

/** As the client's job totals (job-snapshot.ts), summed over jobs: failed and aborted files hold no job below 1. */
function sumTotals(snapshots: readonly JobSnapshot<unknown>[]): Totals {
  const sum: Totals = { ...EMPTY_VIEW.totals };
  for (const { totals } of snapshots) for (const key of SUMMED) sum[key] += totals[key];
  const isFinished = sum.done > 0 && sum.done === sum.count - sum.failed - sum.aborted;
  sum.progress = sum.size > 0 ? sum.bytes / sum.size : isFinished ? 1 : 0;
  sum.eta = sum.speed > 0 ? (sum.size - sum.bytes) / sum.speed : null;
  return sum;
}

/** True when every field is the same: the client builds a new snapshot of every file of a job when one file changes. */
function isSameFile(previous: FileSnapshot<unknown>, next: FileSnapshot<unknown>): boolean {
  for (const key of Object.keys(next) as (keyof FileSnapshot<unknown>)[]) if (previous[key] !== next[key]) return false;
  return true;
}

export interface UploadStore<R> {
  add(job: UploadJob<R>): void;
  jobs(): readonly UploadJob<R>[];
  /** Drops the jobs whose every file ended done or aborted. */
  clear(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): UploadView<R>;
}

export function createUploadStore<R>(): UploadStore<R> {
  let jobs: readonly UploadJob<R>[] = [];
  const listeners = new Set<() => void>();
  const stops = new Map<UploadJob<R>, () => void>();
  // Rebuilt on every change, so getSnapshot returns the same object until the next one.
  let view: UploadView<R> = EMPTY_VIEW;
  const notify = () => {
    view = build();
    for (const listener of listeners) listener();
  };
  const watch = (job: UploadJob<R>) => stops.set(job, job.subscribe(notify));
  const unwatch = (job: UploadJob<R>) => {
    stops.get(job)?.();
    stops.delete(job);
  };

  // Each file's last snapshot and the object made from it, by handle: the object stays while the fields do.
  const made = new WeakMap<FileHandle<R>, { snapshot: FileSnapshot<R>; file: UploadItem<R> }>();
  function fileOf(handle: FileHandle<R>, snapshot: FileSnapshot<R>): UploadItem<R> {
    const previous = made.get(handle);
    if (previous && isSameFile(previous.snapshot, snapshot)) return previous.file;
    const file = {
      ...snapshot,
      pause: () => handle.pause(),
      resume: () => handle.resume(),
      abort: () => handle.abort(),
      retry: () => handle.retry(),
    };
    made.set(handle, { snapshot, file });
    return file;
  }

  function build(): UploadView<R> {
    if (jobs.length === 0) return EMPTY_VIEW;
    const snapshots = jobs.map((job) => job.getSnapshot());
    // A job's handles and its snapshot's files are in the same order: the order the files were passed.
    const files = jobs.flatMap((job, index) =>
      (snapshots[index]?.files ?? []).map((snapshot, at) => fileOf(job.files[at] as FileHandle<R>, snapshot)),
    );
    return { files, totals: sumTotals(snapshots), isUploading: files.some((file) => UPLOADING.has(file.status)) };
  }

  return {
    add(job) {
      jobs = [...jobs, job];
      if (listeners.size > 0) watch(job);
      notify();
    },
    jobs: () => jobs,
    clear() {
      // A failed file stays: retry() can still send it, and the client keeps its ticket and parts for that.
      const kept = jobs.filter((job) => {
        const { done, aborted, count } = job.getSnapshot().totals;
        return done + aborted < count;
      });
      for (const job of jobs) if (!kept.includes(job)) unwatch(job);
      jobs = kept;
      notify();
    },
    subscribe(listener) {
      if (listeners.size === 0) {
        for (const job of jobs) watch(job);
        // Nobody heard what the jobs did meanwhile, such as under a hidden <Activity>.
        view = build();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) for (const job of jobs) unwatch(job);
      };
    },
    getSnapshot: () => view,
  };
}
