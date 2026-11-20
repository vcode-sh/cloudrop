// start(): several files through one /upload, each file run on its own through the client's pool (job-run.ts), retried
// on request (retry-file.ts), and the snapshot a page renders meanwhile (job-snapshot.ts). The handles pause, resume,
// cancel and retry one file or all of them.

import { fail, type Result } from "../errors.ts";
import { type Arguments, readArguments } from "./arguments.ts";
import { createEntry, type Entry, pauseFile, resumeFile } from "./entry.ts";
import { clientClosed } from "./failures.ts";
import { abortFile } from "./file-run.ts";
import { createJob, firstRun, type Job, resultOf } from "./job-run.ts";
import { snapshotOf } from "./job-snapshot.ts";
import { type Retried, retryFiles } from "./retry-file.ts";
import { createStore } from "./store.ts";
import type { FileHandle, FileOutcome, UploadJob, UploadResult } from "./types.ts";
import type { UploadContext } from "./upload.ts";

/** Retries the failed files among `entries` (retryFiles, unless the job retries its own way). */
type Retry = (job: Job, entries: readonly Entry[]) => Promise<Retried>;

function handleOf(job: Job, entry: Entry, retry: Retry): FileHandle {
  return {
    id: entry.id,
    name: entry.file.name,
    pause: () => pauseFile(entry),
    resume: () => resumeFile(entry),
    abort: () => {
      abortFile(job.context, entry);
      job.idle();
    },
    retry: async () => (await retry(job, [entry])).outcomes[0] as FileOutcome<unknown>,
  };
}

export function startJob(context: UploadContext, route: unknown, files: unknown, options: unknown): UploadJob<unknown> {
  return createUploadJob(context, readArguments(route, files, options), firstRun);
}

/**
 * A job over the files of `args` that `run` starts and `retry` retries, as start() and resume() return it. A job
 * refused for its arguments, or by a closed client (M8-L1), has no files, and a snapshot that says so; its `done` and
 * `retry()` answer with the refusal (ruling M3-U37).
 */
export function createUploadJob(
  context: UploadContext,
  given: Result<Arguments>,
  run: (job: Job) => Promise<UploadResult<unknown>>,
  retry: Retry = retryFiles,
): UploadJob<unknown> {
  const args = context.lifetime.closed ? fail(clientClosed()) : given;
  // `changed` is only called once the job runs, after the store below exists.
  const entries = (args.error ? [] : args.data.files).map((file) =>
    createEntry(file, context.nextRank(), (urgent) => store.changed(urgent)),
  );
  const store = createStore(
    () => snapshotOf(entries),
    () => entries.some((entry) => entry.status === "uploading"),
  );
  const job = args.error ? null : createJob(context, args.data, entries);
  const done = args.error ? Promise.resolve(args) : run(job as Job);
  return {
    files: job ? entries.map((entry) => handleOf(job, entry, retry)) : [],
    done,
    abort: () => job?.abort(),
    pause: () => {
      for (const entry of entries) pauseFile(entry);
    },
    resume: () => entries.forEach(resumeFile),
    // Every failed file, resolving with every file's current outcome once all have settled.
    retry: async () => {
      if (!job) return done;
      const { outcomes, refused } = await retry(job, job.entries);
      return refused ? fail(refused) : resultOf(outcomes);
    },
    // Taken from the store as they are: neither needs `this`.
    subscribe: store.subscribe,
    getSnapshot: store.get,
  };
}
