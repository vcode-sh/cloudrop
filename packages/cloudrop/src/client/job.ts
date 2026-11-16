// start(): several files through one /upload, each file run on its own through the client's pool (job-run.ts), retried
// on request (retry-file.ts), and the snapshot a page renders meanwhile (job-snapshot.ts). The handles pause, resume,
// cancel and retry one file or all of them.

import { fail } from "../errors.ts";
import { readArguments } from "./arguments.ts";
import { abortFile, createEntry, type Entry, outcomeOf, pauseFile, resumeFile } from "./file-run.ts";
import { createJob, firstRun, type Job, resultOf } from "./job-run.ts";
import { snapshotOf } from "./job-snapshot.ts";
import { retryFiles } from "./retry-file.ts";
import { createStore } from "./store.ts";
import type { FileHandle, UploadJob, UploadResult } from "./types.ts";
import type { UploadContext } from "./upload.ts";

function handleOf(job: Job, entry: Entry): FileHandle {
  return {
    id: entry.id,
    name: entry.file.name,
    pause: () => pauseFile(entry),
    resume: () => resumeFile(entry),
    abort: () => {
      abortFile(job.context, entry);
      job.idle();
    },
    retry: async () => {
      await retryFiles(job, [entry]);
      return outcomeOf(entry);
    },
  };
}

/** Retries every failed file of the job and resolves with every file's current outcome once all have settled. */
async function retryJob(job: Job): Promise<UploadResult<unknown>> {
  const refused = await retryFiles(job, job.entries);
  return refused ? fail(refused) : resultOf(job.entries.map(outcomeOf));
}

export function startJob(context: UploadContext, route: unknown, files: unknown, options: unknown): UploadJob<unknown> {
  const args = readArguments(route, files, options);
  // A job refused for its arguments has no files, and a snapshot that says so. `changed` is only called once the job
  // runs, after the store below exists.
  const entries = (args.error ? [] : args.data.files).map((file) =>
    createEntry(file, context.nextRank(), (urgent) => store.changed(urgent)),
  );
  const store = createStore(
    () => snapshotOf(entries),
    () => entries.some((entry) => entry.status === "uploading"),
  );
  const job = args.error ? null : createJob(context, args.data, entries);
  const done = args.error ? Promise.resolve(args) : firstRun(job as Job);
  return {
    files: job ? entries.map((entry) => handleOf(job, entry)) : [],
    done,
    abort: () => job?.abort(),
    pause: () => {
      for (const entry of entries) pauseFile(entry);
    },
    resume: () => entries.forEach(resumeFile),
    // A job refused for its arguments answers a retry as it answered `done` (Q15).
    retry: () => (job ? retryJob(job) : done),
    // Taken from the store as they are: neither needs `this`.
    subscribe: store.subscribe,
    getSnapshot: store.get,
  };
}
