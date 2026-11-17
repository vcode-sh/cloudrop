// A job's runs after start(): one /upload for every file, each file then run on its own through the client's pool, and
// one result with an outcome per file (spec §2.2, §4.4, §4.6). Files are independent: one failing never stops another.
// A retry (retry-file.ts) runs files again through the same job.

import { CloudropError, fail, type Result } from "../errors.ts";
import type { Arguments } from "./arguments.ts";
import type { Ticket } from "./endpoints.ts";
import { aborted, unreadableAnswer, withFile } from "./failures.ts";
import { abortFile, type Entry, held, outcomeOf, pauseFile, resumeFile, runFile, settle } from "./file-run.ts";
import { watchConnectivity } from "./lifecycle.ts";
import { letGo, uploadOf } from "./persist.ts";
import { createProgress } from "./progress.ts";
import { MAX_ATTEMPTS, pause, retryAfterOf, retryDelay, withRetry } from "./retry.ts";
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
  return job;
}

/**
 * `entry` forgets its ticket, without the /abort that file-run.ts's drop sends, and waits for a new one, which starts
 * from no parts and no bytes (M3-U36).
 */
export function forgetTicket(context: UploadContext, entry: Entry): void {
  // The new ticket's record replaces this one's, under the new id (resume spec §3.2).
  if (entry.upload) letGo(context, entry.upload);
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
  // No /abort for the old ticket, as for a retry's new ticket (M3-U55): the bucket's lifecycle rule frees its parts.
  forgetTicket(job.context, entry);
  entry.status = "queued";
  entry.changed(true);
  await launch(job, [entry], { reask: false, first: 1 });
  await entry.run;
}

/**
 * A file /upload refused at `attempt`. A retryable refusal asks again for this file alone, within the budget and after
 * the wait of any request's retry (M3-U92); the file stays queued meanwhile. A pause, offline included, ends the wait
 * and holds the file until resume() asks at once. A file cancelled before or meanwhile ends aborted and sends nothing:
 * it holds no ticket the server must be told about (M3-U51). Resolves once the file has settled.
 */
async function refused(job: Job, entry: Entry, refusal: CloudropError, attempt: number): Promise<void> {
  const { signal } = entry.cancel;
  if (refusal.retryable && attempt < MAX_ATTEMPTS && !signal.aborted) {
    // In one bracket: watching again would call online(), which resumes a file offline paused (M3-U48).
    await job.watch(async () => {
      // pauseFile and a cancel abort the pass, which here is the wait.
      const wait = new AbortController();
      entry.pass = wait;
      if (entry.status !== "paused") await pause(retryDelay(attempt, retryAfterOf(refusal)), wait.signal);
      await held(entry);
    });
    await launch(job, [entry], { reask: true, first: attempt + 1 });
    return entry.run;
  }
  settle(entry, signal.aborted ? "aborted" : "failed", withFile(signal.aborted ? aborted() : refusal, entry));
}

/** One file's share of an /upload answer, given at `attempt`. `whole`: the /upload asked for every file of the job. */
async function runEntry(
  job: Job,
  entry: Entry,
  answer: Result<(Ticket | CloudropError)[]>,
  index: number,
  whole: boolean,
  attempt: number,
): Promise<void> {
  if (answer.error) {
    const cancelled = entry.cancel.signal.aborted;
    // A file cancelled on its own meanwhile ends as cancelled, with its own error (ruling M3-U10). Otherwise the error
    // is the job's when /upload asked for every file, and the file's own when a retry asked for some (ruling M3-U3).
    const own = cancelled && !job.signal.aborted;
    const error = own ? aborted() : answer.error;
    return settle(entry, cancelled ? "aborted" : "failed", own || !whole ? withFile(error, entry) : error);
  }
  // readTickets answers one ticket per file; a missing one would otherwise leave the file queued for good.
  const ticket = answer.data[index] ?? unreadableAnswer(200);
  if (ticket instanceof CloudropError) return refused(job, entry, ticket, attempt);
  entry.upload = uploadOf(job, entry, ticket);
  await job.runUpload(entry.upload);
}

/**
 * Calls `ask` through the retry budget, from attempt `next()`, with `entry`'s pause and cancel ending the backoff. A
 * pause holds the file, then asks at once with the count kept (M3-U92). A cancel's ABORTED is returned as it is.
 */
async function askAlone<T>(
  job: Job,
  entry: Entry,
  ask: (attempt: number) => Promise<Result<T>>,
  next: () => number,
): Promise<Result<T>> {
  const { signal } = entry.cancel;
  for (;;) {
    if (entry.status === "paused") await job.watch(() => held(entry));
    if (signal.aborted) return fail(aborted());
    // pauseFile and a cancel abort the pass, which here is the backoff.
    const pass = new AbortController();
    entry.pass = pass;
    const answer = await withRetry(ask, pass.signal, next());
    // A pause ended the backoff only when this pass fired, as in runFile: an answer may carry ABORTED itself.
    if (answer.error?.code !== "ABORTED" || !pass.signal.aborted || signal.aborted) return answer;
  }
}

/**
 * An /upload for one file, which that file's cancel and pause stop rather than the job's signal (M3-U92). `reask`:
 * after a refusal, so never the whole job, whose /upload has answered; `first`: the attempt of the budget it starts at.
 */
export interface Alone {
  reask: boolean;
  first: number;
}

/**
 * Asks one /upload for tickets for `entries`, then runs every file at once (the pool decides who sends); each
 * `entry.run` settles with its file. Resolves with the /upload's refusal when it asked for every file of the job.
 * `alone` asks for its one file on that file's own signals: a cancel stops the request and its backoff, a pause ends
 * the backoff and holds the file, and resume() asks at once with the attempt count kept.
 */
export async function launch(job: Job, entries: readonly Entry[], alone?: Alone): Promise<CloudropError | null> {
  const { context, args } = job;
  const files = entries.map((entry) => entry.file);
  const own = alone && entries[0];
  // job.abort() and the caller's signal cancel every file, so a file's own signal hears them too.
  const signal = own ? own.cancel.signal : job.signal;
  let attempt = (alone?.first ?? 1) - 1;
  const ask = (at: number) => {
    attempt = at;
    return context.endpoints.start(args.route, files, args.metadata, signal);
  };
  const started = (own ? askAlone(job, own, ask, () => attempt + 1) : withRetry(ask, signal)).then((answer) =>
    answer.error && signal.aborted ? fail(aborted()) : answer,
  );
  const whole = !alone?.reask && entries.length === job.entries.length;
  entries.forEach((entry, index) => {
    entry.run = started.then((answer) => runEntry(job, entry, answer, index, whole, attempt)).finally(job.idle);
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
