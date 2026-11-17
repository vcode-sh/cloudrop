// After a reload (resume spec §2, §3.3–§3.7): the unfinished multipart uploads this browser keeps, resuming one with
// the file the user picked again, and forgetting them at sign-out. A resumed file asks /complete first which parts the
// bucket lacks, so it sends only those, or nothing when the upload already finished.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import { readArguments } from "./arguments.ts";
import type { Ticket } from "./endpoints.ts";
import { aborted, notResumable, notSameFile, uploadInUse } from "./failures.ts";
import { type Entry, settle } from "./file-run.ts";
import { isSameFile } from "./fingerprint.ts";
import { createUploadJob } from "./job.ts";
import type { Job } from "./job-run.ts";
import { resultOf } from "./job-run.ts";
import { lockUpload } from "./locks.ts";
import type { UploadRecord } from "./records.ts";
import type { FileOutcome, ResumableUpload, UploadJob, UploadResult } from "./types.ts";
import type { UploadContext } from "./upload.ts";

/** The namespace's unfinished uploads, newest first, for `route` or every route, without a token, key or metadata. */
export async function resumable(context: UploadContext, route?: string): Promise<Result<ResumableUpload[]>> {
  const listed = await context.records.list(context.namespace);
  if (listed.error) return listed;
  return ok(
    listed.data
      .filter((record) => route === undefined || record.route === route)
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

/** The record of upload `id` with its lock taken, or why it cannot be resumed, checked in M3-U76's order. */
async function check(
  context: UploadContext,
  id: string,
  file: File,
): Promise<CloudropError | { record: UploadRecord; unlock: () => void }> {
  const { data, error } = await context.records.list(context.namespace);
  // A store that cannot be read says so; a record that is gone, expired or another namespace's cannot be resumed.
  const record = data?.find((saved) => saved.id === id);
  if (!record) return error ?? notResumable();
  if (!(await isSameFile(record, file))) return notSameFile();
  const lock = lockUpload(id);
  const taken = await lock.taken;
  if (taken) return { record, unlock: lock.release };
  // Where the browser refuses Web Locks, nothing can be resumed (M3-U88).
  return taken === false ? uploadInUse() : notResumable();
}

/**
 * Checks the record, the file and the lock, then runs the upload rebuilt from the record, which starts at /complete
 * with every part counted as landed (resume spec §3.4). A failed check, or a cancel meanwhile, ends the file before
 * any request, with `{ data: null, error }` (audit I7).
 */
async function resumeRun(job: Job, id: string): Promise<UploadResult<unknown>> {
  const { context, args } = job;
  const [entry] = job.entries as [Entry];
  job.listen();
  const checked = await check(context, id, entry.file);
  const refuse = (status: "failed" | "aborted", error: CloudropError) => {
    settle(entry, status, error);
    job.idle();
    return fail(error);
  };
  // Cancelled while checking: nothing was sent, and the record stays for a later resume.
  if (entry.cancel.signal.aborted) {
    if (!(checked instanceof CloudropError)) checked.unlock();
    return refuse("aborted", aborted());
  }
  if (checked instanceof CloudropError) return refuse("failed", checked);
  const { record, unlock } = checked;
  // From the record: a start over asks /upload with the route and metadata the upload began with (M3-U74).
  args.route = record.route;
  args.metadata = record.metadata;
  // The record holds every field of the ticket but its URLs: every part is signed through /sign when needed. Its
  // expiry is the record's, verbatim, which a retry reads (audit M14).
  const ticket: Ticket = { ...record, kind: "multipart", parts: [] };
  for (let part = 1; part <= record.partCount; part++) entry.landed.add(part);
  const upload = { ticket, entry, mayBeComplete: false, repairs: 0, dropped: false, unlock, probe: true };
  entry.upload = upload;
  const run = job.runUpload(upload).finally(job.idle);
  entry.run = run;
  // Settled once this run ends, a start over included: its outcome is the first (M3-U35).
  await run;
  return resultOf([entry.firstOutcome as FileOutcome<unknown>]);
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
  // The run starts only when the arguments passed, the id included.
  return createUploadJob(context, args, (job) => resumeRun(job, id as string));
}
