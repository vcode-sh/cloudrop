// One file of a job after /upload, from its ticket to its outcome: its bytes and /complete (upload.ts), then an ending
// without success (a cancel or a failure) that tells the server unless a /complete may have finished the file
// (decisions S14, S15, ruling S-18).

import type { CloudropError } from "../errors.ts";
import type { CompleteResponse } from "../protocol/types.ts";
import type { Ticket } from "./endpoints.ts";
import { aborted, withFile } from "./failures.ts";
import type { FileStatus } from "./types.ts";
import { sendAndComplete, type UploadContext } from "./upload.ts";

/** One file of a job and where it stands. */
export interface Entry {
  readonly id: string;
  readonly file: File;
  /** The file's place in the pool's queue (ruling P9). */
  readonly rank: number;
  status: FileStatus;
  result: CompleteResponse<unknown> | null;
  error: CloudropError | null;
  /** Fires on abort() of the file or the job, and when the job's signal fires. */
  readonly cancel: AbortController;
  /** Tells the job something changed; `urgent` for a status change. */
  changed(urgent: boolean): void;
}

/** Ends `entry` without success. `error` is final: callers set `file` on it when it is the file's own. */
export function settle(entry: Entry, status: "failed" | "aborted", error: CloudropError): void {
  entry.error = error;
  entry.status = status;
  entry.changed(true);
}

/**
 * Sends the file and completes it. A file cancelled before this starts sends nothing: sendParts stops at once, and the
 * /abort below tells the server.
 */
export async function runFile(context: UploadContext, entry: Entry, ticket: Ticket): Promise<void> {
  const { signal } = entry.cancel;
  const { result, mayBeComplete } = await sendAndComplete(context, { ticket, entry });
  // A completed upload stays completed: /abort with a live token would delete it (ruling M2-X1).
  if (!result.error) {
    entry.result = result.data;
    entry.status = "done";
    entry.changed(true);
    return;
  }
  const cancelled = signal.aborted;
  // A /complete that may have succeeded keeps the file rather than delete a recorded one (M3-H15, M3-H16). Otherwise
  // /abort frees the parts and deletes this upload's own object, which no lifecycle rule removes (S-18).
  if (!mayBeComplete) {
    const cleanup = context.endpoints.abort(ticket.token);
    // A failure settles at once and its /abort finishes in the background: abort() never rejects, so nothing is left
    // unhandled. A cancel waits for it, so the caller knows the server was told.
    if (cancelled) await cleanup;
  }
  settle(entry, cancelled ? "aborted" : "failed", withFile(cancelled ? aborted() : result.error, entry));
}
