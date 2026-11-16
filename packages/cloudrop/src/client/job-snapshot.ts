// The snapshot a page renders of a job (spec §2.1, §4.2, §4.3): each file's bytes, progress, speed and time left, and
// totals over the files that did not fail or abort.

import type { Entry } from "./file-run.ts";
import type { FileSnapshot, FileStatus, JobSnapshot } from "./types.ts";

/** `part` of `whole`; when the whole is 0 bytes, 1 once `finished` and 0 before. */
const fraction = (part: number, whole: number, finished: boolean) => (whole > 0 ? part / whole : finished ? 1 : 0);
/** Seconds to send `left` bytes at `speed`; unknown while nothing is sent. */
const etaOf = (left: number, speed: number) => (speed > 0 ? left / speed : null);

function fileSnapshot(entry: Entry, now: number): FileSnapshot<unknown> {
  const { id, file, status, result, error } = entry;
  const { name, size, type } = file;
  // A file is done only once every part was stored, and a stored part counts its whole size: done means bytes = size.
  const bytes = entry.progress.bytes;
  const speed = status === "uploading" ? entry.meter.speed(now) : 0;
  const progress = fraction(bytes, size, status === "done");
  return { id, name, size, type, status, bytes, progress, speed, eta: etaOf(size - bytes, speed), error, result };
}

const sum = (files: readonly FileSnapshot<unknown>[], key: "bytes" | "size" | "speed") =>
  files.reduce((total, file) => total + file[key], 0);

export function snapshotOf(entries: readonly Entry[]): JobSnapshot<unknown> {
  const now = Date.now();
  const files = entries.map((entry) => fileSnapshot(entry, now));
  const counting = (status: FileStatus) => files.filter((file) => file.status === status).length;
  // A failed or aborted file sends no more: counting it would hold the job below 1 and its bytes in the ETA.
  const counted = files.filter((file) => file.status !== "failed" && file.status !== "aborted");
  const bytes = sum(counted, "bytes");
  const size = sum(counted, "size");
  const speed = sum(counted, "speed");
  const done = counting("done");
  return {
    files,
    totals: {
      bytes,
      size,
      // A job with nothing left to count has delivered nothing: 0, not a finished 1.
      progress: fraction(bytes, size, done > 0 && done === counted.length),
      speed,
      eta: etaOf(size - bytes, speed),
      done,
      failed: counting("failed"),
      aborted: counting("aborted"),
      count: files.length,
    },
  };
}
