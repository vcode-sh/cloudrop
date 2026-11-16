// One file of a job after /upload, from its ticket to its outcome: passes that send its bytes and /complete
// (upload.ts), paused and resumed in between (spec §4.5), then an ending without success (a cancel or a failure). A
// cancel tells the server unless a /complete may have finished the file (decisions S14, S15, ruling S-18); a failure
// of start() keeps the ticket and the parts for retry() (spec §4.7), and one of upload() tells the server (M3-U29).

import type { CloudropError } from "../errors.ts";
import type { CompleteResponse } from "../protocol/types.ts";
import { aborted, withFile } from "./failures.ts";
import { letGo } from "./persist.ts";
import { createMeter, createProgress, type Meter, type Progress } from "./progress.ts";
import type { FileOutcome, FileStatus } from "./types.ts";
import { sendAndComplete, type Upload, type UploadContext } from "./upload.ts";

/** One file of a job and where it stands. */
export interface Entry {
  readonly id: string;
  readonly file: File;
  /** The file's place in the pool's queue (ruling M3-U9). */
  readonly rank: number;
  status: FileStatus;
  result: CompleteResponse<unknown> | null;
  error: CloudropError | null;
  /** The bytes sent so far; a new ticket starts a new count (ruling M3-U36). */
  progress: Progress;
  /** How fast they are sent. */
  readonly meter: Meter;
  /** Fires on abort() of the running file or the job, and when the job's signal fires. */
  readonly cancel: AbortController;
  /** The current sending pass: pause() aborts it, and so does a cancel. */
  pass: AbortController | null;
  /** Ends the wait of a paused file: resume() and a cancel call it. */
  wake: (() => void) | null;
  /**
   * Paused by the page going offline, so going online resumes it; the caller's pause() or resume() clears it
   * (M3-U28).
   */
  networkPaused: boolean;
  /** The part numbers the bucket stored (1 for a single PUT): a new pass sends only the others. */
  readonly landed: Set<number>;
  /** The current ticket's upload, which a retry with the same ticket continues; null without a ticket. */
  upload: Upload | null;
  /** How the file first settled, which `done` reports whatever a retry does later (M3-U35). */
  firstOutcome: FileOutcome<unknown> | null;
  /** The file's current run, from its /upload or retry until it settles. */
  run: Promise<void>;
  /** Tells the job something changed; `urgent` for a status change. */
  changed(urgent: boolean): void;
}

export function createEntry(file: File, rank: number, changed: (urgent: boolean) => void): Entry {
  const entry: Entry = {
    id: String(rank),
    file,
    rank,
    status: "queued",
    result: null,
    error: null,
    progress: createProgress(),
    meter: createMeter(Date.now()),
    cancel: new AbortController(),
    pass: null,
    wake: null,
    networkPaused: false,
    landed: new Set(),
    upload: null,
    firstOutcome: null,
    run: Promise.resolve(),
    changed,
  };
  // The pass's signal is the only one its requests hear (/complete excepted), so a cancel aborts the pass too, and wakes
  // a paused file to end it. One listener per file, whatever its runs, does what AbortSignal.any would, without raising
  // the browser floor to Safari 17.4.
  entry.cancel.signal.addEventListener("abort", () => {
    entry.pass?.abort();
    entry.wake?.();
  });
  return entry;
}

export function outcomeOf({ id, file, status, result, error }: Entry): FileOutcome<unknown> {
  const { name } = file;
  if (status === "done" && result) return { id, name, status, result };
  // Every settled entry without a result holds its error: settle() sets both.
  return { id, name, status: status === "aborted" ? "aborted" : "failed", error: error as CloudropError };
}

/** The file's status is final for now: the first time, its outcome is the one `done` reports. */
function settled(entry: Entry): void {
  entry.firstOutcome ??= outcomeOf(entry);
  entry.changed(true);
}

/** Ends `entry` without success. `error` is final: callers set `file` on it when it is the file's own. */
export function settle(entry: Entry, status: "failed" | "aborted", error: CloudropError): void {
  entry.error = error;
  entry.status = status;
  settled(entry);
}

/**
 * Stops a queued or uploading file's PUTs; a completing or settled file ignores it (ruling M3-U4). `byNetwork` marks a
 * pause by the page going offline; the caller's pause of a file already paused makes the pause the caller's (M3-U28).
 */
export function pauseFile(entry: Entry, byNetwork = false): void {
  if (entry.status === "paused" && !byNetwork) entry.networkPaused = false;
  if (entry.status !== "queued" && entry.status !== "uploading") return;
  entry.networkPaused = byNetwork;
  entry.status = "paused";
  entry.changed(true);
  entry.pass?.abort();
}

/** Queues a paused file's parts that have not landed again. */
export function resumeFile(entry: Entry): void {
  if (entry.status !== "paused") return;
  entry.networkPaused = false;
  entry.status = "queued";
  entry.changed(true);
  entry.wake?.();
}

/** Sends the /abort that frees `upload`'s parts and deletes its own object, once, and gives its ticket up. */
export function drop(context: UploadContext, upload: Upload): Promise<void> {
  upload.dropped = true;
  letGo(context, upload);
  return context.endpoints.abort(upload.ticket.token);
}

/**
 * Cancels a file (ruling M3-U38). A running one ends aborted through its run, which tells the server. A failed one
 * ends aborted at once and frees what it kept (M3-U32), unless a /complete may have finished it (keep-or-abort,
 * M3-S14, M3-H16).
 */
export function abortFile(context: UploadContext, entry: Entry): void {
  const { status, upload } = entry;
  if (status === "done" || status === "aborted") return;
  if (status !== "failed") {
    entry.cancel.abort();
    return;
  }
  context.leftovers.release(entry);
  settle(entry, "aborted", withFile(aborted(), entry));
  if (!upload || upload.dropped) return;
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
  if (mayBeComplete) {
    // A cancel ends the upload. A failure of upload() keeps the record for a resume, which only /complete can settle,
    // and lets the lock go: this page cannot send the file again (M3-U82).
    if (failed) upload.unlock();
    else letGo(context, upload);
    return;
  }
  const cleanup = drop(context, upload);
  // A failure's /abort finishes in the background: abort() never rejects, so nothing is left unhandled. A cancel waits
  // for it, and `done` with it, so the caller knows the server was told.
  if (!failed) await cleanup;
}

/**
 * Sends the file and completes it, one pass at a time: a pause ends the pass, a resume starts the next. `upload` is
 * kept across passes and same-ticket retries, so neither forgets a /complete that may have finished nor the parts that
 * landed. A file cancelled before this starts sends nothing but the /abort that tells the server.
 */
export async function runFile(context: UploadContext, upload: Upload): Promise<void> {
  const { entry } = upload;
  const { cancel } = entry;
  while (!cancel.signal.aborted) {
    if (entry.status === "paused") {
      // Resolved by resume() or a cancel; calling it again later does nothing.
      await new Promise<void>((resolve) => {
        entry.wake = resolve;
      });
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
      return settled(entry);
    }
    // Paused: the next pass starts after resume(). A failure that won the race with the pause ends the file.
    const paused = result.error.code === "ABORTED" && pass.signal.aborted && !cancel.signal.aborted;
    if (!paused) return end(context, upload, result.error);
  }
  return end(context, upload, aborted());
}
