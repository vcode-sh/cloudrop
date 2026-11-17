// retry() of a failed file (spec §4.7, rulings M3-U30, M3-U31, M3-U34, M3-U36, M3-U37): the same ticket when a new
// attempt with it can succeed, so the parts that landed are not sent again; otherwise a new ticket from /upload, shared
// by every file of one job.retry() that needs one.

import type { CloudropError } from "../errors.ts";
import { NEEDS_NEW_TICKET } from "./failures.ts";
import type { Entry } from "./file-run.ts";
import { allSettled, forgetTicket, type Job } from "./job-run.ts";
import { launch } from "./launch.ts";
import type { FileOutcome } from "./types.ts";

/**
 * Whether a retry of the failed `entry` asks /upload for a new ticket, decided when it is called (M3-U30): never when
 * a /complete may have finished the file, which only /complete with its ticket can tell; always without a ticket,
 * with one that expired or whose /abort was sent, or after a failure in M3-U31.
 */
function needsTicket({ upload, error }: Entry): boolean {
  if (!upload) return true;
  if (upload.mayBeComplete) return false;
  return upload.dropped || Date.parse(upload.ticket.expiresAt) <= Date.now() || NEEDS_NEW_TICKET.has(error?.code);
}

/** Queues a failed file again without telling the page. A new ticket starts from no parts and no bytes (M3-U36); the
 * speed starts from 0 when the file sends again, as on every start. */
function requeue(job: Job, entry: Entry, fresh: boolean): void {
  job.context.leftovers.release(entry);
  if (fresh) forgetTicket(job.context, entry);
  else if (entry.upload) {
    // The same ticket repairs from round 0 again (M3-U50), and sends again the parts its last /complete found missing.
    entry.upload.repairs = 0;
    if (entry.error?.code === "PARTS_MISSING") for (const part of entry.error.parts ?? []) entry.landed.delete(part);
  }
  entry.error = null;
  entry.status = "queued";
}

/** What a retry ended with: the outcome of every file it was given, and the refusal of an /upload for the whole job. */
export interface Retried {
  outcomes: FileOutcome<unknown>[];
  refused: CloudropError | null;
}

/**
 * Retries the failed files among `entries`: those that need a ticket share one /upload (M3-U34). Files that have not
 * settled are waited for, done and aborted ones left as they are (M3-U37). Resolves once every file of `entries` has
 * settled, with their outcomes and the /upload's refusal when it asked for every file of the job.
 */
export async function retryFiles(job: Job, entries: readonly Entry[]): Promise<Retried> {
  const failed = entries.filter((entry) => entry.status === "failed");
  const fresh = failed.filter(needsTicket);
  for (const entry of failed) requeue(job, entry, fresh.includes(entry));
  // One publish once every file is queued (M3-U59): a listener that retries then finds none failed and only waits. One
  // that pauses or cancels a file leaves it to its run below, which ends a cancelled one as job.abort() would.
  failed[0]?.changed(true);
  // After the requeue: a signal that fired meanwhile cancels the files as queued ones, which tells the server.
  if (failed.length > 0) job.listen();
  for (const entry of failed) {
    const { upload } = entry;
    if (upload) entry.run = job.runUpload(upload).finally(job.idle);
  }
  // One file's new ticket stops on that file's cancel and pause, as its re-asks do (M3-U92).
  const refused = fresh.length > 0 ? launch(job, fresh, fresh.length === 1 ? 1 : undefined) : null;
  const outcomes = await allSettled(entries);
  return { outcomes, refused: await refused };
}
