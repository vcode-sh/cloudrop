// Asking /upload for tickets, then running each file on its share of the answer (spec §4.4). The job's own /upload and
// a retry's of several files run on the job's signal; a one-file /upload (a re-ask after a refusal, a one-file
// retry()'s new ticket, a resumed file's start over) runs on that file's own signals (M3-U92).

import { CloudropError, fail, type Result } from "../errors.ts";
import type { Ticket } from "./endpoints.ts";
import { aborted, unreadableAnswer, withFile } from "./failures.ts";
import { type Entry, held, settle } from "./file-run.ts";
import type { Job } from "./job-run.ts";
import { uploadOf } from "./persist.ts";
import { MAX_ATTEMPTS, pause, retryAfterOf, retryDelay, withRetry } from "./retry.ts";

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
