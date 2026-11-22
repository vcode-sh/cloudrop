// Asking /upload for tickets, then running each file on its share of the answer (spec §4.4). The job's own /upload and
// a retry's of several files run on the job's signal; a one-file /upload (a re-ask after a refusal, a one-file
// retry()'s new ticket, a resumed file's start over) runs on that file's own signals (M3-U92). A cancel ends the files
// at once and leaves an /upload in flight to answer, so the tickets it brings can be aborted (M11-R261).

import { CloudropError, fail, type Result } from "../errors.ts";
import { retryAfterOf } from "../retry-after.ts";
import { counted } from "./close.ts";
import type { Ticket } from "./endpoints.ts";
import { type Entry, held, settle } from "./entry.ts";
import { aborted, unreadableAnswer, withFile } from "./failures.ts";
import type { Job } from "./job-run.ts";
import { uploadOf } from "./persist.ts";
import { MAX_ATTEMPTS, pause, retryDelay, waitsTooLong, withRetry } from "./retry.ts";
import type { UploadContext } from "./upload.ts";

type Answer = Result<(Ticket | CloudropError)[]>;

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
 * the wait of any request's retry (M3-U92); the file stays queued meanwhile. One that asks to wait longer than the
 * backoff's cap fails the file, retryable, for the app's retry() (M12-E4). A file cancelled meanwhile ends aborted
 * and sends nothing: it holds no ticket the server must be told about (M3-U51). Resolves once the file has settled.
 */
async function refused(job: Job, entry: Entry, refusal: CloudropError, attempt: number): Promise<void> {
  if (!refusal.retryable || attempt === MAX_ATTEMPTS || waitsTooLong(refusal)) {
    return settle(entry, "failed", withFile(refusal, entry));
  }
  await launch(job, [entry], { first: attempt + 1, waitMs: retryDelay(attempt, retryAfterOf(refusal)) });
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
  // Cancelled meanwhile, it ended then (M4-F2): a ticket it was given gets its /abort and nothing else, and the run
  // ends once that was answered, which close() waits for. After a cancel of the whole ask the answer here is ABORTED,
  // and unlessCancelled aborts the tickets (M11-R261).
  if (entry.status === "aborted") {
    const late = answer.error ? undefined : answer.data[index];
    if (late && !(late instanceof CloudropError)) await job.context.endpoints.abort(late.token);
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
 * `answered`, an /upload's answer, or ABORTED as soon as `signal` fires. The request is not cut then (endpoints.ts):
 * the server may already have reserved for its files, which only the tickets it answers can free. So the answer is
 * waited for behind the cancelled files, at most the request's 30 seconds and with no further attempt, and each ticket
 * it brings gets its /abort. close() waits for all of it, as for any /abort a cancel sent (M11-R261).
 */
function unlessCancelled(context: UploadContext, signal: AbortSignal, answered: Promise<Answer>): Promise<Answer> {
  return new Promise((resolve) => {
    const cancel = () => {
      resolve(fail(aborted()));
      const told = answered.then(({ data }) =>
        Promise.all(
          (data ?? []).map((given) => (given instanceof CloudropError ? null : context.endpoints.abort(given.token))),
        ),
      );
      void counted(context, told);
    };
    signal.addEventListener("abort", cancel, { once: true });
    void answered.then((answer) => {
      signal.removeEventListener("abort", cancel);
      resolve(answer);
    });
  });
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
 * (M3-U92), after `waitMs`: a cancel ends the waits and the file, a pause ends a wait and holds the file, and
 * resume() asks at once with the attempt count kept. `first` above 1 is a re-ask after a refusal, so never the whole
 * job, whose /upload has answered. `after`: what the first ask waits for, a retry's /abort of the tickets it replaces.
 */
export async function launch(
  job: Job,
  entries: readonly Entry[],
  { first, waitMs = 0, after }: { first?: number; waitMs?: number; after?: Promise<unknown> } = {},
): Promise<CloudropError | null> {
  const { context, args } = job;
  const files = entries.map((entry) => entry.file);
  const own = first === undefined ? undefined : entries[0];
  // job.abort() and the caller's signal cancel every file, so a file's own signal hears them too.
  const signal = own ? own.cancel.signal : job.signal;
  let attempt = (first ?? 1) - 1;
  // One key per ask, shared by its retries: with a store, a retry after a lost answer supersedes what that answer held.
  // An ask that ended without a ticket leaves its key to the next ask of one of its files, whose /upload so frees what
  // the lost answers reserved. That ask takes the key: a second one sending it would end the first one's live rows
  // (M5-T101, M11-R92).
  const lost = entries.find((entry) => entry.lostAsk?.key)?.lostAsk;
  const key = lost?.key ?? newRequestKey();
  if (lost) lost.key = null;
  const ask = (at: number) => {
    attempt = at;
    const start = () =>
      unlessCancelled(context, signal, context.endpoints.start(args.route, files, args.metadata, key, signal));
    // Without `after` the request leaves in this step, as before.
    return after ? after.then(start) : start();
  };
  const started = (own ? askAlone(job, own, ask, () => attempt + 1, waitMs) : withRetry(ask, signal)).then((answer) => {
    // Before any file settles: a listener that retries at once already finds the key.
    const lostAsk = answer.error ? { key } : null;
    for (const entry of entries) entry.lostAsk = lostAsk;
    return answer.error && signal.aborted ? fail(aborted()) : answer;
  });
  const whole = (first ?? 1) === 1 && entries.length === job.entries.length;
  entries.forEach((entry, index) => {
    entry.run = started.then((answer) => runEntry(job, entry, answer, index, whole, attempt)).finally(job.idle);
  });
  // Counted with the /aborts: a job whose files were all cancelled one by one leaves the client's jobs while this ask
  // is still to answer, and close() waits for the tickets it brings to be aborted (M11-R264).
  void counted(context, Promise.allSettled(entries.map((entry) => entry.run)));
  const { error } = await started;
  return whole ? error : null;
}
