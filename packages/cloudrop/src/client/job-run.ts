// A job's runs after start(): one /upload for every file, each file then run on its own through the client's pool, and
// one result with an outcome per file (spec §2.2, §4.4, §4.6). Files are independent: one failing never stops another.
// A retry (retry-file.ts) runs files again through the same job.

import { CloudropError, fail, type Result } from "../errors.ts";
import type { Arguments } from "./arguments.ts";
import type { Ticket } from "./endpoints.ts";
import { aborted, withFile } from "./failures.ts";
import { abortFile, type Entry, pauseFile, resumeFile, runFile, settle } from "./file-run.ts";
import { watchConnectivity } from "./lifecycle.ts";
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
  /** Ends every file (Q16). */
  abort(): void;
  /** Brackets each run of a file: `begin` when it starts, `finish` when it ends. */
  begin(): void;
  finish(): void;
  /** Hears the caller's signal from now on (a run starts), or stops once no file runs or holds its ticket (Q16). */
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
  // The caller's signal may outlive the job: the listener that holds it goes once nothing is left to cancel.
  let heard = false;
  const idle = () => {
    if (!heard || entries.some(busy)) return;
    heard = false;
    args.signal.removeEventListener("abort", abort);
  };
  signal.addEventListener("abort", () => {
    for (const entry of entries) abortFile(context, entry);
    idle();
  });
  // The page's connectivity is watched from the first run's start to the last one's end. Offline pauses every file
  // that can pause; online resumes only those it paused (Q6, Q17).
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
    begin() {
      running += 1;
      if (running === 1) unwatch = watchConnectivity(offline, online);
    },
    finish() {
      running -= 1;
      if (running === 0) unwatch();
    },
    listen() {
      if (heard) return;
      heard = true;
      args.signal.addEventListener("abort", abort);
      if (args.signal.aborted) abort();
    },
    idle,
  };
}

/** Runs `upload` until its file settles, with the job's connectivity watched meanwhile. */
export function runUpload(job: Job, upload: Upload): Promise<void> {
  job.begin();
  return runFile(job.context, upload).finally(job.finish);
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
  const ticket = answer.data[index];
  if (ticket instanceof CloudropError) return settle(entry, "failed", withFile(ticket, entry));
  // readTickets answered one ticket per file, so `ticket` is never undefined here.
  if (!ticket) return;
  entry.upload = { ticket, entry, mayBeComplete: false, repairs: 0, dropped: false };
  await runUpload(job, entry.upload);
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

/** Resolves once every file of `entries` has settled, also those a retry restarted meanwhile. */
export async function allSettled(entries: readonly Entry[]): Promise<void> {
  while (!entries.every(settledStatus)) await Promise.all(entries.map((entry) => entry.run));
}

/** The job's result over `files`: the first file, in the order passed, that did not end done (ruling M3-U3). */
export function resultOf(files: FileOutcome<unknown>[]): UploadResult<unknown> {
  const error = files.find((outcome) => outcome.status !== "done")?.error ?? null;
  return error ? { data: { files }, error } : { data: { files }, error: null };
}

/** The first run: `done` settles once every file first settled, with those outcomes, whatever a retry did (Q13). */
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
