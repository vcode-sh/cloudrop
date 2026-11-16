// One file of a job after /upload, from its ticket to its outcome: passes that send its bytes and /complete
// (upload.ts), paused and resumed in between (spec §4.5), then an ending without success (a cancel or a failure) that
// tells the server unless a /complete may have finished the file (decisions S14, S15, ruling S-18).

import type { CloudropError } from "../errors.ts";
import type { CompleteResponse } from "../protocol/types.ts";
import type { Ticket } from "./endpoints.ts";
import { aborted, withFile } from "./failures.ts";
import type { Meter, Progress } from "./progress.ts";
import type { FileStatus } from "./types.ts";
import { sendAndComplete, type Upload, type UploadContext } from "./upload.ts";

/** One file of a job and where it stands. */
export interface Entry {
  readonly id: string;
  readonly file: File;
  /** The file's place in the pool's queue (ruling P9). */
  readonly rank: number;
  status: FileStatus;
  result: CompleteResponse<unknown> | null;
  error: CloudropError | null;
  /** The bytes sent so far. */
  readonly progress: Progress;
  /** How fast they are sent. */
  readonly meter: Meter;
  /** Fires on abort() of the file or the job, and when the job's signal fires. */
  readonly cancel: AbortController;
  /** The current sending pass: pause() aborts it, and so does a cancel. */
  pass: AbortController | null;
  /** Ends the wait of a paused file: resume() and a cancel call it. */
  wake: (() => void) | null;
  /** The part numbers the bucket stored (1 for a single PUT): a new pass sends only the others. */
  readonly landed: Set<number>;
  /** Tells the job something changed; `urgent` for a status change. */
  changed(urgent: boolean): void;
}

/** Ends `entry` without success. `error` is final: callers set `file` on it when it is the file's own. */
export function settle(entry: Entry, status: "failed" | "aborted", error: CloudropError): void {
  entry.error = error;
  entry.status = status;
  entry.changed(true);
}

/** Stops a queued or uploading file's PUTs; a completing or settled file ignores it (ruling P4). */
export function pauseFile(entry: Entry): void {
  if (entry.status !== "queued" && entry.status !== "uploading") return;
  entry.status = "paused";
  entry.changed(true);
  entry.pass?.abort();
}

/** Queues a paused file's parts that have not landed again. */
export function resumeFile(entry: Entry): void {
  if (entry.status !== "paused") return;
  entry.status = "queued";
  entry.changed(true);
  entry.wake?.();
}

/** Ends the file after `error`. A cancel is reported as one, whatever ended the pass. */
async function end(context: UploadContext, { ticket, entry, mayBeComplete }: Upload, error: CloudropError) {
  const cancelled = entry.cancel.signal.aborted;
  // A /complete that may have succeeded keeps the file rather than delete a recorded one (M3-H15, M3-H16). Otherwise
  // /abort frees the parts and deletes this upload's own object, which no lifecycle rule removes (S-18).
  if (!mayBeComplete) {
    const cleanup = context.endpoints.abort(ticket.token);
    // A failure settles at once and its /abort finishes in the background: abort() never rejects, so nothing is left
    // unhandled. A cancel waits for it, so the caller knows the server was told.
    if (cancelled) await cleanup;
  }
  settle(entry, cancelled ? "aborted" : "failed", withFile(cancelled ? aborted() : error, entry));
}

/**
 * Sends the file and completes it, one pass at a time: a pause ends the pass, a resume starts the next. A file
 * cancelled before this starts sends nothing but the /abort that tells the server.
 */
export async function runFile(context: UploadContext, entry: Entry, ticket: Ticket): Promise<void> {
  const { cancel } = entry;
  // Kept across passes: a pause neither forgets a /complete that may have finished nor resets the repairs.
  const upload: Upload = { ticket, entry, mayBeComplete: false, repairs: 0 };
  // The pass's signal is the only one its requests hear (/complete excepted), so a cancel aborts the pass too, and wakes
  // a paused file to end it. One listener per file does what AbortSignal.any would, without raising the browser floor
  // to Safari 17.4.
  cancel.signal.addEventListener(
    "abort",
    () => {
      entry.pass?.abort();
      entry.wake?.();
    },
    { once: true },
  );
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
      entry.result = result.data;
      entry.status = "done";
      entry.changed(true);
      return;
    }
    // Paused: the next pass starts after resume(). A failure that won the race with the pause ends the file.
    const paused = result.error.code === "ABORTED" && pass.signal.aborted && !cancel.signal.aborted;
    if (!paused) return end(context, upload, result.error);
  }
  return end(context, upload, aborted());
}
