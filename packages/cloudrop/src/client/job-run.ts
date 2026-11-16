// A job's runs after start(): one /upload for every file, each file then run on its own through the client's pool, and
// one result with an outcome per file (spec §2.2, §4.4, §4.6). Files are independent: one failing never stops another.
// A retry (retry-file.ts) runs files again through the same job.

import { CloudropError, fail, type Result } from "../errors.ts";
import type { Arguments } from "./arguments.ts";
import type { Ticket } from "./endpoints.ts";
import { aborted, unreadableAnswer, withFile } from "./failures.ts";
import { abortFile, type Entry, outcomeOf, pauseFile, resumeFile, runFile, settle } from "./file-run.ts";
import { watchConnectivity } from "./lifecycle.ts";
import { uploadOf } from "./persist.ts";
import { withRetry } from "./retry.ts";
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
  /** Runs `upload` until its file settles, with the page's connectivity watched meanwhile. */
  runUpload(upload: Upload): Promise<void>;
  /** Hears the caller's signal from now on (a run starts), or stops once no file runs or holds its ticket (M3-U38). */
  listen(): void;
  idle(): void;
}

const settledStatus = ({ status }: Entry) => status === "done" || status === "failed" || status === "aborted";

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
  return {
    context,
    args,
    entries,
    signal,
    abort,
    runUpload(upload) {
      running += 1;
      if (running === 1) unwatch = watchConnectivity(offline, online);
      return runFile(context, upload).finally(() => {
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
}

/** One file's share of an /upload answer. `whole`: the /upload asked for every file of the job. */
async function runEntry(
  job: Job,
  entry: Entry,
  answer: Result<(Ticket | CloudropError)[]>,
  index: number,
  whole: boolean,
): Promise<void> {
  const cancelled = entry.cancel.signal.aborted;
  if (answer.error) {
    // A file cancelled on its own meanwhile ends as cancelled, with its own error (ruling M3-U10). Otherwise the error
    // is the job's when /upload asked for every file, and the file's own when a retry asked for some (ruling M3-U3).
    const own = cancelled && !job.signal.aborted;
    const error = own ? aborted() : answer.error;
    return settle(entry, cancelled ? "aborted" : "failed", own || !whole ? withFile(error, entry) : error);
  }
  // readTickets answers one ticket per file; a missing one would otherwise leave the file queued for good.
  const ticket = answer.data[index] ?? unreadableAnswer(200);
  if (ticket instanceof CloudropError) {
    // A file cancelled meanwhile ends as cancelled: it holds no ticket the server must be told about.
    return settle(entry, cancelled ? "aborted" : "failed", withFile(cancelled ? aborted() : ticket, entry));
  }
  entry.upload = uploadOf(job.context, job.args, entry, ticket);
  await job.runUpload(entry.upload);
}

/**
 * Asks one /upload for tickets for `entries`, then runs every file at once (the pool decides who sends); each
 * `entry.run` settles with its file. Resolves with the /upload's refusal when it asked for every file of the job.
 */
export async function launch(job: Job, entries: readonly Entry[]): Promise<CloudropError | null> {
  const { context, args, signal } = job;
  const files = entries.map((entry) => entry.file);
  const started = withRetry(() => context.endpoints.start(args.route, files, args.metadata, signal), signal).then(
    (answer) => (answer.error && signal.aborted ? fail(aborted()) : answer),
  );
  const whole = entries.length === job.entries.length;
  entries.forEach((entry, index) => {
    entry.run = started.then((answer) => runEntry(job, entry, answer, index, whole)).finally(job.idle);
  });
  const { error } = await started;
  return whole ? error : null;
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
  const error = files.find((outcome) => outcome.status !== "done")?.error ?? null;
  return error ? { data: { files }, error } : { data: { files }, error: null };
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
