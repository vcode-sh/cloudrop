// retry() of a failed file (spec §4.7, plan B rulings Q8, Q9, Q12, Q14, Q15): the same ticket when a new attempt with it
// can succeed, so the parts that landed are not sent again; otherwise a new ticket from /upload, shared by every file
// of one job.retry() that needs one.

import type { CloudropError } from "../errors.ts";
import type { Entry } from "./file-run.ts";
import { allSettled, type Job, launch } from "./job-run.ts";
import { createProgress } from "./progress.ts";

/** Failures that a new attempt with the same ticket cannot fix (Q9). */
const NEEDS_NEW_TICKET = new Set<string | undefined>([
  "UPLOAD_EXPIRED",
  "INVALID_TOKEN",
  "UPLOAD_REJECTED",
  "VERIFICATION_FAILED",
]);

/**
 * Whether a retry of the failed `entry` asks /upload for a new ticket, decided when it is called (Q8): never when a
 * /complete may have finished the file, which only /complete with its ticket can tell (I6); always without a ticket,
 * with one that expired or whose /abort was sent, or after a failure in Q9.
 */
function needsTicket({ upload, error }: Entry): boolean {
  if (!upload) return true;
  if (upload.mayBeComplete) return false;
  return upload.dropped || Date.parse(upload.ticket.expiresAt) <= Date.now() || NEEDS_NEW_TICKET.has(error?.code);
}

/** Queues a failed file again. A new ticket starts from no parts and no bytes (M3-U36); the speed starts from 0 when
 * the file sends again, as on every start. */
function requeue(job: Job, entry: Entry, fresh: boolean): void {
  job.context.leftovers.release(entry);
  if (fresh) {
    entry.upload = null;
    entry.landed.clear();
    entry.progress = createProgress();
  } else if (entry.upload) {
    // The same ticket repairs from round 0 again (I5), and sends again the parts its last /complete found missing.
    entry.upload.repairs = 0;
    if (entry.error?.code === "PARTS_MISSING") for (const part of entry.error.parts ?? []) entry.landed.delete(part);
  }
  entry.error = null;
  entry.status = "queued";
  entry.changed(true);
}

/**
 * Retries the failed files among `entries`: those that need a ticket share one /upload (Q12). Files that have not
 * settled are waited for, done and aborted ones left as they are (Q15). Resolves once every file of `entries` has
 * settled, with the /upload's refusal when it asked for every file of the job.
 */
export async function retryFiles(job: Job, entries: readonly Entry[]): Promise<CloudropError | null> {
  const failed = entries.filter((entry) => entry.status === "failed");
  const fresh = failed.filter(needsTicket);
  for (const entry of failed) requeue(job, entry, fresh.includes(entry));
  // After the requeue: a signal that fired meanwhile cancels the files as queued ones, which tells the server.
  if (failed.length > 0) job.listen();
  for (const entry of failed) {
    const { upload } = entry;
    if (upload) entry.run = job.runUpload(upload).finally(job.idle);
  }
  const refused = fresh.length > 0 ? launch(job, fresh) : null;
  await allSettled(entries);
  return refused;
}
