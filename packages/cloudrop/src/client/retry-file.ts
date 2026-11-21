// retry() of a failed file (spec §4.7, rulings M3-U30, M3-U34, M3-U36, M3-U37, M11-R80): the same ticket when a new
// attempt with it can succeed, so the parts that landed are not sent again; otherwise a new ticket from /upload, shared
// by every file of one job.retry() that needs one, after the tickets it replaces were given up (M11-R89).

import type { CloudropError } from "../errors.ts";
import type { Entry } from "./entry.ts";
import { drop } from "./file-run.ts";
import { allSettled, forgetTicket, type Job } from "./job-run.ts";
import { launch } from "./launch.ts";
import { retryStep } from "./retry-step.ts";
import type { FileOutcome } from "./types.ts";
import { canSign } from "./upload.ts";

/**
 * Whether a retry of the failed `entry` asks /upload for a new ticket, decided when it is called (M3-U30): always
 * without a ticket, with one whose /abort was sent, or after a failure that ended it (retryStep, M11-R80). Otherwise
 * never while a /complete may have finished the file, which only /complete with its ticket can tell; and always with
 * a ticket that expired, or can no longer sign what is still to send (M9-H3).
 */
function needsTicket({ upload, error, landed }: Entry): boolean {
  if (!upload || upload.dropped) return true;
  const step = error ? retryStep(error) : "same";
  if (step === "new") return true;
  if (upload.mayBeComplete) return false;
  const { ticket } = upload;
  const expired = Date.parse(ticket.expiresAt) <= Date.now();
  // Past its signing time a ticket still completes, so it is kept while only /complete is left. What a "resend" sends
  // again is still counted as landed until the retry queues it.
  const partCount = ticket.kind === "single" ? 1 : ticket.partCount;
  const unsent = step === "resend" || landed.size < partCount;
  return expired || (unsent && !canSign(ticket));
}

/**
 * Counts as not landed what the failure of `entry`, a "resend", asks to send again: the parts /complete named, or every
 * part when it named none (NOT_UPLOADED, or a PARTS_MISSING whose list a proxy dropped), since /complete alone would
 * get the same answer for ever.
 */
function unland({ error, landed }: Entry): void {
  if (error?.parts?.length) for (const part of error.parts) landed.delete(part);
  else landed.clear();
}

/**
 * Queues a failed file again without telling the page. A new ticket starts from no parts and no bytes (M3-U36); the
 * speed starts from 0 when the file sends again, as on every start. The ticket it replaces is given up as abort() of
 * the failed file would give it up (M11-R89): its /abort, which the new /upload waits for, is added to `given`. One a
 * /complete may have finished is left alone, as abort() leaves it.
 */
function requeue(job: Job, entry: Entry, fresh: boolean, given: Promise<void>[]): void {
  const { upload, error } = entry;
  job.context.leftovers.release(entry);
  if (fresh) {
    if (upload && !upload.dropped && !upload.mayBeComplete) given.push(drop(job.context, upload));
    forgetTicket(job.context, entry);
  } else if (upload) {
    // The same ticket repairs from round 0 again (M3-U50).
    upload.repairs = 0;
    if (error && retryStep(error) === "resend") unland(entry);
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
  const given: Promise<void>[] = [];
  for (const entry of failed) requeue(job, entry, fresh.includes(entry), given);
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
  const after = given.length > 0 ? Promise.all(given) : undefined;
  const refused = fresh.length > 0 ? launch(job, fresh, { first: fresh.length === 1 ? 1 : undefined, after }) : null;
  const outcomes = await allSettled(entries);
  return { outcomes, refused: await refused };
}
