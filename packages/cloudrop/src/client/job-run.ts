// A job's runs after start(): one /upload for every file (launch.ts), each file then run on its own through the
// client's pool, and one result with an outcome per file (spec §2.2, §4.4, §4.6). Files are independent: one failing
// never stops another. A retry (retry-file.ts) runs files again through the same job.

import { fail } from "../errors.ts";
import type { Arguments } from "./arguments.ts";
import { type Entry, outcomeOf, pauseFile, resumeFile } from "./entry.ts";
import { abortFile, drop, runFile } from "./file-run.ts";
import { launch } from "./launch.ts";
import { watchConnectivity } from "./lifecycle.ts";
import { letGo } from "./persist.ts";
import { createProgress } from "./progress.ts";
import type { FileOutcome, UploadResult } from "./types.ts";
import type { Upload, UploadContext } from "./upload.ts";

/** What a job's runs and retries share. */
export interface Job {
  readonly context: UploadContext;
  readonly args: Arguments;
  readonly entries: readonly Entry[];
  /** Fires on abort() of the job and when the caller's signal fires: it stops an /upload in flight. */
  readonly signal: AbortSignal;
  /** Ends every file (ruling M3-U38). */
  abort(): void;
  /**
   * Runs `upload` until its file settles, with the page's connectivity watched meanwhile. A resumed upload that turns
   * out gone starts over within the run (M3-U74).
   */
  runUpload(upload: Upload): Promise<void>;
  /** Runs `run` with the page's connectivity watched meanwhile (M3-U49). */
  watch<T>(run: () => Promise<T>): Promise<T>;
  /** Hears the caller's signal from now on (a run starts), or stops once no file runs or holds its ticket (M3-U38). */
  listen(): void;
  idle(): void;
}

const settledStatus = ({ status }: Entry) => status === "done" || status === "failed" || status === "aborted";

/** No file can send again: each ended done or aborted, or failed where no retry() can send it again (M3-U29). */
const ended = (entries: readonly Entry[], keepFailed: boolean) =>
  entries.every(({ status }) => status === "done" || status === "aborted" || (status === "failed" && !keepFailed));

/** Still sending, or failed and holding a ticket whose /abort the caller's signal would send. */
const busy = (entry: Entry) =>
  !settledStatus(entry) ||
  (entry.status === "failed" && !!entry.upload && !entry.upload.dropped && !entry.upload.mayBeComplete);

export function createJob(context: UploadContext, args: Arguments, entries: readonly Entry[]): Job {
  const controller = new AbortController();
  const { signal } = controller;
  const abort = () => controller.abort();
  // The caller's signal may outlive the job: the listener that holds it goes once nothing is left to cancel. A signal
  // adds the same listener once however often listen() runs, and removing one it does not hold does nothing.
  const idle = () => {
    if (!entries.some(busy)) args.signal.removeEventListener("abort", abort);
    // close() stops the jobs in this set (M8-L2).
    if (ended(entries, context.keepFailed)) context.lifetime.jobs.delete(job);
  };
  signal.addEventListener("abort", () => {
    for (const entry of entries) abortFile(context, entry);
    idle();
  });
  // The page's connectivity is watched from the first run's start to the last one's end. Offline pauses every file
  // that can pause; online resumes only those it paused (rulings M3-U28, M3-U39).
  let running = 0;
  let unwatch = () => {};
  const offline = () => {
    for (const entry of entries) pauseFile(entry, true);
  };
  const online = () => {
    for (const entry of entries) if (entry.networkPaused) resumeFile(entry);
  };
  const job: Job = {
    context,
    args,
    entries,
    signal,
    abort,
    runUpload: (upload) =>
      job.watch(() => runFile(context, upload).then((gone) => gone && startOver(job, upload.entry))),
    watch(run) {
      running += 1;
      if (running === 1) unwatch = watchConnectivity(offline, online);
      return run().finally(() => {
        running -= 1;
        if (running === 0) unwatch();
      });
    },
    listen() {
      args.signal.addEventListener("abort", abort);
      if (args.signal.aborted) abort();
    },
    idle,
  };
  context.lifetime.jobs.add(job);
  return job;
}

/**
 * `entry` forgets its ticket, without the /abort that file-run.ts's drop sends, and waits for a new one, which starts
 * from no parts and no bytes (M3-U36).
 */
export function forgetTicket(context: UploadContext, entry: Entry): void {
  // The new ticket's record replaces this one's, under the new id (resume spec §3.2). A ticket already given up let
  // go then: a record giveUp kept may be another tab's now (M4-F1).
  if (entry.upload && !entry.upload.dropped) letGo(context, entry.upload);
  entry.upload = null;
  entry.landed.clear();
  entry.progress = createProgress();
}

/**
 * A resumed upload whose probe found it gone asks /upload for a new ticket with the record's route and metadata, on the
 * file's own signals as any one-file /upload (M3-U92), and sends the whole file, without settling in between (M3-U74).
 * Resolves once the file has settled.
 */
async function startOver(job: Job, entry: Entry): Promise<void> {
  const { upload } = entry;
  // The old ticket is given up first, as a retry gives up the one it replaces (M11-R89, M11-R90): with a store its row
  // may still be pending, as when the ticket only stopped signing or expired, and holds the owner's quota against the
  // new /upload, which waits for the /abort's answer. Never while a /complete may have finished the file: the probe's
  // UPLOAD_EXPIRED or INVALID_TOKEN ended that doubt (upload.ts, M11-R201).
  const given = upload && !upload.mayBeComplete ? drop(job.context, upload) : undefined;
  forgetTicket(job.context, entry);
  entry.status = "queued";
  entry.changed(true);
  await launch(job, [entry], { first: 1, after: given });
  await entry.run;
}

/**
 * Resolves with the outcomes of `entries` once every file has settled, also those a retry restarted meanwhile. They are
 * read in the step that sees every file settled: another retry may start a file again before the caller resumes.
 */
export async function allSettled(entries: readonly Entry[]): Promise<FileOutcome<unknown>[]> {
  while (!entries.every(settledStatus)) await Promise.all(entries.map((entry) => entry.run));
  return entries.map(outcomeOf);
}

/** The job's result over `files`: the first file, in the order passed, that did not end done (ruling M3-U3). */
export function resultOf(files: FileOutcome<unknown>[]): UploadResult<unknown> {
  return { data: { files }, error: files.find((outcome) => outcome.status !== "done")?.error ?? null };
}

/** The first run: `done` settles once every file first settled, with those outcomes, whatever a retry did (M3-U35). */
export function firstRun(job: Job): Promise<UploadResult<unknown>> {
  const { entries } = job;
  job.listen();
  const refused = launch(job, entries);
  const runs = entries.map((entry) => entry.run);
  return Promise.all([refused, ...runs]).then(([error]) =>
    // Every file has settled once its first run ended, which recorded its outcome.
    error ? fail(error) : resultOf(entries.map((entry) => entry.firstOutcome as FileOutcome<unknown>)),
  );
}
