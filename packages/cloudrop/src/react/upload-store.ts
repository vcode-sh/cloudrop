// What the useUpload hooks of one route render, kept in the factory for useSyncExternalStore: the files of every job
// started on the route, in start order, each with its file's controls, and totals across those jobs. A component that
// mounts again finds its jobs here (M4-B2). It listens to the jobs only while React listens to it, so a route no
// component shows subscribes to nothing, and it never cancels a job: the client owns them (M4-B4). It tells the
// route's hooks when a file ends done or failed, and when a start is refused before it has a file (M12-H1 to M12-H3).

import {
  CloudropError,
  type FileHandle,
  type FileOutcome,
  type FileSnapshot,
  type FileStatus,
  type JobSnapshot,
  type UploadJob,
} from "../client.ts";
import type { UploadItem } from "./types.ts";

type Totals = JobSnapshot<unknown>["totals"];

export interface UploadView<R> {
  files: readonly UploadItem<R>[];
  totals: Totals;
  isUploading: boolean;
  startError: CloudropError | null;
}

/** A file that ended done, or the error of a file that ended failed or of a start refused before it had a file. */
export type EndEvent<R> =
  | { kind: "done"; file: Extract<FileOutcome<R>, { status: "done" }> }
  | { kind: "failed"; error: CloudropError };

/** The state before any upload, and React's server snapshot: one constant, so hydration renders the same. */
export const EMPTY_VIEW: UploadView<never> = {
  files: [],
  totals: { bytes: 0, size: 0, progress: 0, speed: 0, eta: null, done: 0, failed: 0, aborted: 0, count: 0 },
  isUploading: false,
  startError: null,
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

/** The event of a file whose status became `done` or `failed` since `before`; none for any other change. */
function endOf<R>(snapshot: FileSnapshot<R>, before: FileStatus | undefined): EndEvent<R> | undefined {
  const { id, name, status, result, error } = snapshot;
  if (status === before) return undefined;
  // A done file always has its result (file-run.ts sets both at once).
  if (status === "done")
    return { kind: "done", file: { id, name, status, result: result as NonNullable<typeof result> } };
  if (status !== "failed" || !error) return undefined;
  // A refusal of the whole /upload fails every file with the job's error, which names no file (launch.ts).
  const named = error.file
    ? error
    : new CloudropError(error.code, error.message, { ...error, file: { id, name }, cause: error });
  return { kind: "failed", error: named };
}

/** True when every field is the same: the client builds a new snapshot of every file of a job when one file changes. */
function isSameFile(previous: FileSnapshot<unknown>, next: FileSnapshot<unknown>): boolean {
  for (const key of Object.keys(next) as (keyof FileSnapshot<unknown>)[]) if (previous[key] !== next[key]) return false;
  return true;
}

export interface UploadStore<R> {
  add(job: UploadJob<R>): void;
  jobs(): readonly UploadJob<R>[];
  /** Drops the jobs whose every file ended done or aborted, and the start error. */
  clear(): void;
  /** A start through this route's hooks: clears the start error and returns the start's number for refuse(). */
  begin(): number;
  /** Start `seq` was refused before it had a file: tells onEnd, and sets the start error when no start followed. */
  refuse(seq: number, error: CloudropError): void;
  /**
   * Calls `listener` with each file of the route that ends done or failed while React listens to the store, and each
   * refused start, in a microtask after the view's listeners ran; returns the unsubscribe.
   */
  onEnd(listener: (event: EndEvent<R>) => void): () => void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): UploadView<R>;
}

export function createUploadStore<R>(): UploadStore<R> {
  let jobs: readonly UploadJob<R>[] = [];
  const listeners = new Set<() => void>();
  const ends = new Set<(event: EndEvent<R>) => void>();
  const stops = new Map<UploadJob<R>, () => void>();
  let startError: CloudropError | null = null;
  let starts = 0;
  // Rebuilt on every change, so getSnapshot returns the same object until the next one.
  let view: UploadView<R> = EMPTY_VIEW;
  const notify = (events: EndEvent<R>[] = []) => {
    view = build(events);
    for (const listener of listeners) listener();
    // After React heard the new view, and outside this call, so a callback may start or retry an upload.
    if (events.length > 0) queueMicrotask(() => tell(events));
  };
  /** Every listener hears every event; one that throws is thrown again in a task and stops nothing (M3-U8). */
  function tell(events: EndEvent<R>[]) {
    for (const event of events)
      for (const listener of ends) {
        try {
          listener(event);
        } catch (error) {
          setTimeout(() => {
            throw error;
          });
        }
      }
  }
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

  /** Without `events`, a baseline: what changed since the last build is shown and reported to nobody. */
  function build(events?: EndEvent<R>[]): UploadView<R> {
    if (jobs.length === 0) return startError ? { ...EMPTY_VIEW, startError } : EMPTY_VIEW;
    const snapshots = jobs.map((job) => job.getSnapshot());
    // A job's handles and its snapshot's files are in the same order: the order the files were passed.
    const files = jobs.flatMap((job, index) =>
      (snapshots[index]?.files ?? []).map((snapshot, at) => {
        const handle = job.files[at] as FileHandle<R>;
        const end = events && endOf(snapshot, made.get(handle)?.snapshot.status);
        if (end) events.push(end);
        return fileOf(handle, snapshot);
      }),
    );
    const isUploading = files.some((file) => UPLOADING.has(file.status));
    return { files, totals: sumTotals(snapshots), isUploading, startError };
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
      startError = null;
      notify();
    },
    begin() {
      if (startError) {
        startError = null;
        notify();
      }
      return ++starts;
    },
    refuse(seq, error) {
      if (seq === starts) startError = error;
      notify([{ kind: "failed", error }]);
    },
    onEnd(listener) {
      ends.add(listener);
      return () => {
        ends.delete(listener);
      };
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
