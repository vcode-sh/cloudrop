// One file of a job and where it stands (spec §2.1): its status, bytes and speed, how it settles, and its pause and
// resume (spec §4.5). file-run.ts runs it from its ticket to its outcome.

import type { CloudropError } from "../errors.ts";
import type { CompleteResponse } from "../protocol/types.ts";
import { createMeter, createProgress, type Meter, type Progress } from "./progress.ts";
import type { FileOutcome, FileStatus } from "./types.ts";
import type { Upload } from "./upload.ts";

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
  /**
   * The /upload ask that ended without a ticket for this file, shared by that ask's files: its key, until the next ask
   * of one of them takes it (launch.ts, M11-R92). Null once an ask answered the file.
   */
  lostAsk: { key: string | null } | null;
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
    meter: createMeter(),
    cancel: new AbortController(),
    pass: null,
    wake: null,
    networkPaused: false,
    landed: new Set(),
    upload: null,
    lostAsk: null,
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
export function settled(entry: Entry): void {
  entry.firstOutcome ??= outcomeOf(entry);
  entry.changed(true);
}

/** Ends `entry` without success. `error` is final: callers set `file` on it when it is the file's own. */
export function settle(entry: Entry, status: "failed" | "aborted", error: CloudropError): void {
  entry.error = error;
  entry.status = status;
  settled(entry);
}

/** Holds a paused `entry` until resume() or a cancel wakes it; a file that is not paused goes on at once. */
export async function held(entry: Entry): Promise<void> {
  while (entry.status === "paused" && !entry.cancel.signal.aborted) {
    // Waking it again later does nothing.
    await new Promise<void>((resolve) => {
      entry.wake = resolve;
    });
  }
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
