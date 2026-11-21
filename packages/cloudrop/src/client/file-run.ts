// One file of a job after /upload, from its ticket to its outcome: passes that send its bytes and /complete
// (upload.ts), paused and resumed in between (entry.ts), then an ending without success (a cancel or a failure). A
// cancel tells the server unless a /complete may have finished the file (decisions S14, S15, ruling S-18); a failure
// of start() keeps the ticket and the parts for retry() (spec §4.7), and one of upload() gives the ticket up (M3-U29,
// M4-F1).

import type { CloudropError } from "../errors.ts";
import { counted, keptForResume } from "./close.ts";
import { type Entry, held, settle, settled } from "./entry.ts";
import { aborted, withFile } from "./failures.ts";
import { letGo } from "./persist.ts";
import { sendAndComplete, type Upload, type UploadContext } from "./upload.ts";

/**
 * Sends the /abort that frees `upload`'s parts and deletes its own object, once, and gives its ticket up. The record
 * goes at once; the lock only once the server has answered: another tab that took it sooner could complete the upload,
 * and this /abort, with a live token, would then delete the finished object (M3-U73). A ticket whose doubt the server
 * ended asks to keep an object that landed (`keepStored`, M11-R201).
 */
export function drop(context: UploadContext, upload: Upload): Promise<void> {
  upload.dropped = true;
  const answered = counted(
    context,
    context.endpoints.abort(upload.ticket.token, { keep: upload.keepStored }).then(() => undefined),
  );
  letGo(context, upload, answered);
  return answered;
}

/**
 * Gives a failed file's ticket up (M4-F1). A multipart ticket a reload can resume keeps its record and sends no
 * /abort, now or later: another tab may resume and complete the upload, and the bucket's lifecycle rule removes parts
 * never resumed. Any other ticket is dropped: a single PUT, one of a client that keeps no records, and one whose
 * failure the same ticket can never fix (a refusal, M3-U31), which a resume would only repeat.
 */
export function giveUp(context: UploadContext, upload: Upload): void {
  const { error } = upload.entry;
  // A retryable failure never ends its ticket (retryStep, M11-R80), so it is all a resume needs.
  const resumable = upload.ticket.kind === "multipart" && context.records.enabled && error?.retryable;
  if (!resumable) return void drop(context, upload);
  upload.dropped = true;
  upload.unlock();
}

/**
 * Cancels a file (ruling M3-U38). A running one ends aborted through its run, which tells the server. One still
 * waiting for its ticket has nothing to tell the server and ends aborted at once (M3-U11, M4-F2). A failed one ends
 * aborted at once and frees what it kept (M3-U32), unless a /complete may have finished it (keep-or-abort, M3-S14,
 * M3-H16).
 */
export function abortFile(context: UploadContext, entry: Entry): void {
  const { status, upload } = entry;
  if (status === "done" || status === "aborted") return;
  if (status !== "failed") {
    entry.cancel.abort();
    if (!upload) settle(entry, "aborted", withFile(aborted(), entry));
    return;
  }
  context.leftovers.release(entry);
  settle(entry, "aborted", withFile(aborted(), entry));
  if (!upload || upload.dropped || keptForResume(context, upload)) return;
  if (upload.mayBeComplete) letGo(context, upload);
  else void drop(context, upload);
}

/** Ends the file after `error`. A cancel is reported as one, whatever ended the pass. */
async function end(context: UploadContext, upload: Upload, error: CloudropError) {
  const { entry, mayBeComplete } = upload;
  const failed = !entry.cancel.signal.aborted;
  if (failed && context.keepFailed) {
    // Held before the status settles: a listener may retry the file at once, which lets it go again. A /complete
    // that may have finished the file is never undone by pagehide (M3-U33).
    if (!mayBeComplete) context.leftovers.hold(entry);
    return settle(entry, "failed", withFile(error, entry));
  }
  // The status settles first, so a page shows a cancel at once rather than when the server answers (ruling M3-U11).
  settle(entry, failed ? "failed" : "aborted", withFile(failed ? error : aborted(), entry));
  // A /complete that may have succeeded keeps the file rather than delete a recorded one (M3-H15, M3-H16). Otherwise
  // /abort frees the parts and deletes this upload's own object, which no lifecycle rule removes (S-18).
  if (failed) {
    // A failure of upload() keeps the record of a /complete in doubt for a resume, which only /complete can settle, and
    // lets the lock go: this page cannot send the file again (M3-U82). Any other is given up (M4-F1); an /abort that
    // sends finishes in the background: abort() never rejects, so nothing is left unhandled.
    if (mayBeComplete) upload.unlock();
    else giveUp(context, upload);
    return;
  }
  // A cancel ends the upload, unless close() keeps it for a resume. Its /abort is waited for, and `done` with it, so the
  // caller knows the server was told.
  if (keptForResume(context, upload)) return;
  if (mayBeComplete) letGo(context, upload);
  else await drop(context, upload);
}

/** What a resumed upload's probe answers when the upload is gone and was not completed (M3-U74). */
const GONE = new Set(["UPLOAD_EXPIRED", "INVALID_TOKEN", "NO_SUCH_UPLOAD"]);

/**
 * Sends the file and completes it, one pass at a time: a pause ends the pass, a resume starts the next. `upload` is
 * kept across passes and same-ticket retries, so neither forgets a /complete that may have finished nor the parts that
 * landed. A file cancelled before this starts sends nothing but the /abort that tells the server. Resolves with the
 * probe's error, the file not settled, when a resumed upload turns out gone: the caller starts it over (M3-U74).
 */
export async function runFile(context: UploadContext, upload: Upload): Promise<CloudropError | undefined> {
  const { entry } = upload;
  const { cancel } = entry;
  while (!cancel.signal.aborted) {
    if (entry.status === "paused") {
      await held(entry);
      continue;
    }
    const pass = new AbortController();
    entry.pass = pass;
    const result = await sendAndComplete(context, upload, pass.signal);
    // A completed upload stays completed: /abort with a live token would delete it (ruling M2-X1).
    if (!result.error) {
      letGo(context, upload);
      entry.result = result.data;
      entry.status = "done";
      settled(entry);
      return;
    }
    const { code } = result.error;
    if (upload.probe && GONE.has(code) && !cancel.signal.aborted) return result.error;
    // Paused: the next pass starts after resume(). A failure that won the race with the pause ends the file.
    const paused = code === "ABORTED" && pass.signal.aborted && !cancel.signal.aborted;
    if (!paused) {
      await end(context, upload, result.error);
      return;
    }
  }
  await end(context, upload, aborted());
}
