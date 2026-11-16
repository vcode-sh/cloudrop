// start(): several files through one /upload, each file run on its own through the client's pool (job-run.ts), and the
// snapshot a page renders meanwhile (job-snapshot.ts). The handles pause, resume and cancel one file or all of them.

import { readArguments } from "./arguments.ts";
import { type Entry, pauseFile, resumeFile } from "./file-run.ts";
import { run, watchedRuns } from "./job-run.ts";
import { snapshotOf } from "./job-snapshot.ts";
import { createMeter, createProgress } from "./progress.ts";
import { createStore } from "./store.ts";
import type { UploadJob, UploadResult } from "./types.ts";
import type { UploadContext } from "./upload.ts";

export function startJob(context: UploadContext, route: unknown, files: unknown, options: unknown): UploadJob<unknown> {
  const args = readArguments(route, files, options);
  // A job refused for its arguments has no files, and a snapshot that says so.
  const entries = (args.error ? [] : args.data.files).map((file): Entry => {
    const rank = context.nextRank();
    return {
      id: String(rank),
      file,
      rank,
      status: "queued",
      result: null,
      error: null,
      progress: createProgress(),
      meter: createMeter(Date.now()),
      cancel: new AbortController(),
      pass: null,
      wake: null,
      networkPaused: false,
      landed: new Set(),
      // Only called once the job runs, after the store below exists.
      changed: (urgent) => store.changed(urgent),
    };
  });
  const store = createStore(
    () => snapshotOf(entries),
    () => entries.some((entry) => entry.status === "uploading"),
  );
  // The caller's signal and job.abort() both cancel every file.
  const job = new AbortController();
  job.signal.addEventListener("abort", () => {
    for (const entry of entries) entry.cancel.abort();
  });
  const abort = () => job.abort();
  let done: Promise<UploadResult<unknown>>;
  if (args.error) done = Promise.resolve(args);
  else {
    const { signal } = args.data;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // The caller's signal may outlive the job: drop the listener that holds it.
    done = run(context, args.data, entries, job.signal, watchedRuns(entries)).finally(() =>
      signal.removeEventListener("abort", abort),
    );
  }
  return {
    files: entries.map((entry) => ({
      id: entry.id,
      name: entry.file.name,
      pause: () => pauseFile(entry),
      resume: () => resumeFile(entry),
      abort: () => entry.cancel.abort(),
    })),
    done,
    abort,
    pause: () => {
      for (const entry of entries) pauseFile(entry);
    },
    resume: () => entries.forEach(resumeFile),
    // Taken from the store as they are: neither needs `this`.
    subscribe: store.subscribe,
    getSnapshot: store.get,
  };
}
