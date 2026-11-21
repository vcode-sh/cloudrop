// After a reload (resume spec §2, §3.3–§3.7): the unfinished multipart uploads this browser keeps, resuming one with
// the file the user picked again, and forgetting them at sign-out. A resumed file asks /complete first which parts the
// bucket lacks, so it sends only those, or nothing when the upload already finished.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import { readArguments } from "./arguments.ts";
import type { Ticket } from "./endpoints.ts";
import { type Entry, settle } from "./entry.ts";
import { notResumable, notSameFile, uploadInUse } from "./failures.ts";
import { isSameFile } from "./fingerprint.ts";
import { createUploadJob } from "./job.ts";
import { allSettled, type Job, resultOf } from "./job-run.ts";
import { lockUpload } from "./locks.ts";
import type { UploadRecord } from "./records.ts";
import { type Retried, retryFiles } from "./retry-file.ts";
import type { FileOutcome, ResumableUpload, UploadJob } from "./types.ts";
import { claim, newUpload, type UploadContext } from "./upload.ts";

/** The namespace's unfinished uploads, newest first, for `route` or every route, without a token, key or metadata. */
export async function resumable(context: UploadContext, route?: string): Promise<Result<ResumableUpload[]>> {
  const listed = await context.records.list(context.namespace);
  if (listed.error) return listed;
  // An upload this client holds is continued through its own job, and resume() would refuse it (M4-F22).
  const claimed = new Set(Array.from(context.claims, ({ id }) => id));
  return ok(
    listed.data
      .filter((record) => (route === undefined || record.route === route) && !claimed.has(record.id))
      // Exactly these fields (M3-U77).
      .map(({ id, route, name, size, type, lastModified, expiresAt }) => ({
        id,
        route,
        name,
        size,
        type,
        lastModified,
        expiresAt,
      })),
  );
}

/** forget() deletes the client's namespace, forget({ all: true }) every record of this browser (M3-U78). */
export async function forget(context: UploadContext, options: unknown): Promise<Result<{ forgotten: number }>> {
  const all = options !== undefined;
  // Exactly { all: true }: forget(userId) would otherwise look as if it forgot that user.
  if (all && !(isPlainObject(options) && options.all === true && Object.keys(options).length === 1)) {
    return fail(
      invalidInput(
        "Call forget() for this client's unfinished uploads, or forget({ all: true }) for every one in this browser.",
      ),
    );
  }
  const cleared = await context.records.clear(all ? null : context.namespace);
  return cleared.error ? cleared : ok({ forgotten: cleared.data });
}

const turns = new WeakMap<UploadContext, Map<string, Promise<void>>>();

/**
 * One check at a time per upload in a page: a resume() waits for the checks of an earlier resume() of the same upload.
 * The first call then always decides: once it holds the lock a later one is UPLOAD_IN_USE, and once it is refused or
 * cancelled a later one runs. Otherwise the call whose file check ended first took the lock (M9-H7).
 */
function takeTurn(context: UploadContext, id: string): { ready: Promise<void>; end: () => void } {
  const waiting = turns.get(context) ?? new Map<string, Promise<void>>();
  turns.set(context, waiting);
  const ready = waiting.get(id) ?? Promise.resolve();
  // Not Promise.withResolvers, which would raise the browser floor to Safari 17.4 (M8-Q8).
  let resolve = () => {};
  const mine = new Promise<void>((done) => {
    resolve = done;
  });
  waiting.set(id, mine);
  return {
    ready,
    end: () => {
      resolve();
      if (waiting.get(id) === mine) waiting.delete(id);
    },
  };
}

/** The record of upload `id` with its lock taken, or why it cannot be resumed, checked in M3-U76's order. */
async function check(
  context: UploadContext,
  id: string,
  file: File,
): Promise<CloudropError | { record: UploadRecord; unlock: () => void }> {
  // Claimed from the call, before the first await, so resumable() no longer lists it. A refusal releases this claim
  // only, as the upload's unlock does; another holder's claim, such as a running file's, stays (M4-F22).
  const release = claim(context, id);
  const refuse = (refusal: CloudropError) => {
    release();
    return refusal;
  };
  const turn = takeTurn(context, id);
  try {
    await turn.ready;
    return await checkInTurn(context, id, file, release, refuse);
  } finally {
    turn.end();
  }
}

async function checkInTurn(
  context: UploadContext,
  id: string,
  file: File,
  release: () => void,
  refuse: (refusal: CloudropError) => CloudropError,
): Promise<CloudropError | { record: UploadRecord; unlock: () => void }> {
  const { data, error } = await context.records.list(context.namespace);
  // A store that cannot be read says so; a record that is gone, expired or another namespace's cannot be resumed.
  const record = data?.find((saved) => saved.id === id);
  if (!record) return refuse(error ?? notResumable());
  if (!(await isSameFile(record, file))) return refuse(notSameFile());
  const lock = lockUpload(id);
  const taken = await lock.taken;
  if (taken) {
    const unlock = () => {
      release();
      lock.release();
    };
    return { record, unlock };
  }
  // Where the browser refuses Web Locks, nothing can be resumed (M3-U88).
  return refuse(taken === false ? uploadInUse() : notResumable());
}

/**
 * Checks the record, the file and the lock, then runs the upload rebuilt from the record, which starts at /complete
 * with every part counted as landed (resume spec §3.4); `passed` hears that the checks passed. A failed check, or a
 * cancel meanwhile, ends the file before any request (audit I7). Resolves once the file has settled, with that
 * refusal, or null once the upload ran.
 */
async function resumeRun(job: Job, id: string, passed: () => void): Promise<CloudropError | null> {
  const { context, args } = job;
  const [entry] = job.entries as [Entry];
  job.listen();
  const checked = await check(context, id, entry.file);
  // Cancelled while checking, it ended then (M4-F2): nothing was sent, and the record stays for a later resume.
  if (entry.cancel.signal.aborted) {
    if (!(checked instanceof CloudropError)) checked.unlock();
    job.idle();
    return entry.error;
  }
  if (checked instanceof CloudropError) {
    settle(entry, "failed", checked);
    job.idle();
    return checked;
  }
  const { record, unlock } = checked;
  passed();
  // From the record: a start over asks /upload with the route and metadata the upload began with (M3-U74).
  args.route = record.route;
  args.metadata = record.metadata;
  // The record holds every field of the ticket but its URLs: every part is signed through /sign when needed. Its
  // expiry is the record's, verbatim, which a retry reads (audit M14).
  const ticket: Ticket = { ...record, kind: "multipart", parts: [] };
  for (let part = 1; part <= record.partCount; part++) entry.landed.add(part);
  const upload = newUpload(ticket, entry, unlock, true);
  entry.upload = upload;
  // Settled once this run ends, a start over included.
  await job.runUpload(upload).finally(job.idle);
  return null;
}

/** retry() of a file whose checks refused: queued again, it is checked again, then runs when they pass (M3-U90). */
async function checkAgain(job: Job, run: (job: Job) => Promise<CloudropError | null>): Promise<Retried> {
  const [entry] = job.entries as [Entry];
  entry.error = null;
  entry.status = "queued";
  // The checks are the file's run before the page hears of it: a listener that retries waits for them.
  const refused = run(job);
  entry.changed(true);
  return { refused: await refused, outcomes: await allSettled(job.entries) };
}

/** resume(upload, file, options?): a job of one file, its route and metadata from the record (M3-U76). */
export function resumeJob(
  context: UploadContext,
  upload: unknown,
  file: unknown,
  options: unknown,
): UploadJob<unknown> {
  const id = (upload as { id?: unknown } | null | undefined)?.id;
  // The options as start() reads them. The route and the metadata come from the record once it is read.
  const args =
    typeof id === "string" && file instanceof File
      ? readArguments("resume", file, options)
      : fail(invalidInput("Pass resume() an upload from resumable() and the File the user picked again."));
  // Until a check passes the job has no route or metadata to ask /upload with, so a retry of the refused file checks
  // again; once one passed, a retry is any job's (M3-U90).
  let checksPassed = false;
  const run = (job: Job) => {
    const resumed = resumeRun(job, id as string, () => {
      checksPassed = true;
    });
    // The file's run is the whole of it, checks to settling: a retry() meanwhile waits for all of it (M3-U90, M4-F5).
    // A start over hands it to its /upload's run, which this one awaits.
    (job.entries[0] as Entry).run = resumed.then(() => {});
    return resumed;
  };
  // The run starts only when the arguments passed, the id included.
  return createUploadJob(
    context,
    args,
    async (job) => {
      const refused = await run(job);
      // Its first outcome, whatever a retry did since (M3-U35).
      return refused ? fail(refused) : resultOf([(job.entries[0] as Entry).firstOutcome as FileOutcome<unknown>]);
    },
    (job, entries) =>
      checksPassed || job.entries[0]?.status !== "failed" ? retryFiles(job, entries) : checkAgain(job, run),
  );
}
