// Asking /upload for tickets, then running each file on its share of the answer (spec §4.4). The job's own /upload and
// a retry's of several files run on the job's signal; a one-file /upload (a re-ask after a refusal, a one-file
// retry()'s new ticket, a resumed file's start over) runs on that file's own signals (M3-U92).

import { CloudropError, fail, type Result } from "../errors.ts";
import { counted } from "./close.ts";
import type { Ticket } from "./endpoints.ts";
import { type Entry, held, settle } from "./entry.ts";
import { aborted, unreadableAnswer, withFile } from "./failures.ts";
import type { Job } from "./job-run.ts";
import { uploadOf } from "./persist.ts";
import { MAX_ATTEMPTS, pause, retryAfterOf, retryDelay, withRetry } from "./retry.ts";

/**
 * A new `/upload` idempotency key: 128 random bits as 32 hex digits. Not `crypto.randomUUID()`, which a page outside a
 * secure context (plain http on a LAN address) does not have, while uploads work there. Where there is no
 * `crypto.getRandomValues` either (React Native's Hermes without a polyfill), the bits come from `Math.random`: the key
 * is no secret. It only has to differ from the same owner's other asks of the last day, since a store supersedes
 * nothing but that owner's own rows by it (M5-T105, M11-R83).
 */
function newRequestKey(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.random() * 256;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A file /upload refused at `attempt`. A retryable refusal asks again for this file alone, within the budget and after
 * the wait of any request's retry (M3-U92); the file stays queued meanwhile. A file cancelled meanwhile ends aborted
 * and sends nothing: it holds no ticket the server must be told about (M3-U51). Resolves once the file has settled.
 */
async function refused(job: Job, entry: Entry, refusal: CloudropError, attempt: number): Promise<void> {
  if (!refusal.retryable || attempt === MAX_ATTEMPTS) return settle(entry, "failed", withFile(refusal, entry));
  await launch(job, [entry], attempt + 1, retryDelay(attempt, retryAfterOf(refusal)));
  return entry.run;
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
  // Cancelled meanwhile, it ended then (M4-F2): a ticket it was given gets its /abort and nothing else.
  if (entry.status === "aborted") {
    const late = answer.error ? undefined : answer.data[index];
    if (late && !(late instanceof CloudropError)) void counted(job.context, job.context.endpoints.abort(late.token));
    return;
  }
  // The error is the job's when /upload asked for every file, and the file's own when a retry asked for some (M3-U3).
  if (answer.error) return settle(entry, "failed", whole ? answer.error : withFile(answer.error, entry));
  // readTickets answers one ticket per file; a missing one would otherwise leave the file queued for good.
  const ticket = answer.data[index] ?? unreadableAnswer(200);
  if (ticket instanceof CloudropError) return refused(job, entry, ticket, attempt);
  entry.upload = uploadOf(job, entry, ticket);
  await job.runUpload(entry.upload);
}

/**
 * Calls `ask` through the retry budget, from attempt `next()`, after waiting `waitMs` (a refusal's backoff), with
 * `entry`'s pause and cancel ending the wait and the backoff. A pause, offline included, holds the file, then asks at
 * once with the count kept (M3-U92). A cancel's ABORTED is returned as it is. The whole ask is watched in one bracket:
 * watching again would call online(), which resumes a file offline paused (M3-U48).
 */
function askAlone<T>(
  job: Job,
  entry: Entry,
  ask: (attempt: number) => Promise<Result<T>>,
  next: () => number,
  waitMs: number,
): Promise<Result<T>> {
  const { signal } = entry.cancel;
  return job.watch(async () => {
    for (let wait = waitMs; ; wait = 0) {
      if (entry.status === "paused") wait = 0;
      await held(entry);
      if (signal.aborted) return fail(aborted());
      // pauseFile and a cancel abort the pass, which here is the wait and the backoff.
      const pass = new AbortController();
      entry.pass = pass;
      if (wait > 0) await pause(wait, pass.signal);
      const answer = await withRetry(ask, pass.signal, next());
      // A pause ended the wait only when this pass fired, as in runFile: an answer may carry ABORTED itself.
      if (answer.error?.code !== "ABORTED" || !pass.signal.aborted || signal.aborted) return answer;
    }
  });
}

/**
 * Asks one /upload for tickets for `entries`, then runs every file at once (the pool decides who sends); each
 * `entry.run` settles with its file. Resolves with the /upload's refusal when it asked for every file of the job.
 * With `first`, the attempt of the budget it starts at, it asks for its one file alone, on that file's own signals
 * (M3-U92), after `waitMs`: a cancel stops the request and the waits, a pause ends a wait and holds the file, and
 * resume() asks at once with the attempt count kept. `first` above 1 is a re-ask after a refusal, so never the whole
 * job, whose /upload has answered.
 */
export async function launch(
  job: Job,
  entries: readonly Entry[],
  first?: number,
  waitMs = 0,
): Promise<CloudropError | null> {
  const { context, args } = job;
  const files = entries.map((entry) => entry.file);
  const own = first === undefined ? undefined : entries[0];
  // job.abort() and the caller's signal cancel every file, so a file's own signal hears them too.
  const signal = own ? own.cancel.signal : job.signal;
  let attempt = (first ?? 1) - 1;
  // One key per ask, shared by its retries: with a store, a retry after a lost answer supersedes what that answer held.
  const key = newRequestKey();
  const ask = (at: number) => {
    attempt = at;
    return context.endpoints.start(args.route, files, args.metadata, key, signal);
  };
  const started = (own ? askAlone(job, own, ask, () => attempt + 1, waitMs) : withRetry(ask, signal)).then((answer) =>
    answer.error && signal.aborted ? fail(aborted()) : answer,
  );
  const whole = (first ?? 1) === 1 && entries.length === job.entries.length;
  entries.forEach((entry, index) => {
    entry.run = started.then((answer) => runEntry(job, entry, answer, index, whole, attempt)).finally(job.idle);
  });
  const { error } = await started;
  return whole ? error : null;
}
