// start(): several files through one /upload, each file run on its own through the client's pool, one result with an
// outcome per file, and the snapshot a page renders meanwhile (spec §2, §2.1, §2.2, §4.4, §4.6). Files are
// independent: one failing never stops another.

import { CloudropError, fail } from "../errors.ts";
import { type Arguments, readArguments } from "./arguments.ts";
import { aborted, withFile } from "./failures.ts";
import { type Entry, runFile, settle } from "./file-run.ts";
import { createMeter, createProgress } from "./progress.ts";
import { withRetry } from "./retry.ts";
import { createStore } from "./store.ts";
import type { FileOutcome, FileSnapshot, FileStatus, JobSnapshot, UploadJob, UploadResult } from "./types.ts";
import type { UploadContext } from "./upload.ts";

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

function snapshotOf(entries: readonly Entry[]): JobSnapshot<unknown> {
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

function outcomeOf({ id, file, status, result, error }: Entry): FileOutcome<unknown> {
  const { name } = file;
  if (result) return { id, name, status: "done", result };
  // Every settled entry without a result holds its error: settle() sets both.
  return { id, name, status: status === "aborted" ? "aborted" : "failed", error: error as CloudropError };
}

async function run(
  context: UploadContext,
  { route, files, metadata }: Arguments,
  entries: readonly Entry[],
  signal: AbortSignal,
): Promise<UploadResult<unknown>> {
  const started = await withRetry(() => context.endpoints.start(route, files, metadata, signal), signal);
  if (started.error) {
    // The whole job's error, so no file of its own.
    const error = signal.aborted ? aborted() : started.error;
    for (const entry of entries) settle(entry, signal.aborted ? "aborted" : "failed", error);
    return fail(error);
  }
  // Every file at once: the pool decides who sends.
  await Promise.all(
    entries.map(async (entry, index) => {
      const ticket = started.data[index];
      if (ticket instanceof CloudropError) settle(entry, "failed", withFile(ticket, entry));
      // readTickets answered one ticket per file, so `ticket` is never undefined here.
      else if (ticket) await runFile(context, entry, ticket);
    }),
  );
  const outcomes = entries.map(outcomeOf);
  // The first file, in the order passed, that did not end done (ruling P3).
  const error = outcomes.find((outcome) => outcome.status !== "done")?.error ?? null;
  return error ? { data: { files: outcomes }, error } : { data: { files: outcomes }, error: null };
}

export function startJob(context: UploadContext, route: unknown, files: unknown, options: unknown): UploadJob<unknown> {
  const args = readArguments(route, files, options);
  // A job refused for its arguments has no files, and a snapshot that says so.
  const entries = (args.error ? [] : args.data.files).map((file): Entry => {
    const rank = context.nextRank();
    return {
      id: String(rank),
      file,
      rank,
      status: "queued",
      result: null,
      error: null,
      progress: createProgress(),
      meter: createMeter(Date.now()),
      cancel: new AbortController(),
      // Only called once the job runs, after the store below exists.
      changed: (urgent) => store.changed(urgent),
    };
  });
  const store = createStore(
    () => snapshotOf(entries),
    () => entries.some((entry) => entry.status === "uploading"),
  );
  // Taken from the store as they are: neither needs `this`.
  const snapshot = { subscribe: store.subscribe, getSnapshot: store.get };
  if (args.error) return { files: [], done: Promise.resolve(args), abort: () => {}, ...snapshot };
  // The caller's signal and job.abort() both cancel every file.
  const job = new AbortController();
  job.signal.addEventListener("abort", () => {
    for (const entry of entries) entry.cancel.abort();
  });
  const { signal } = args.data;
  const abort = () => job.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // The caller's signal may outlive the job: drop the listener that holds it.
  const done = run(context, args.data, entries, job.signal).finally(() => signal.removeEventListener("abort", abort));
  return {
    files: entries.map(({ id, file, cancel }) => ({ id, name: file.name, abort: () => cancel.abort() })),
    done,
    abort,
    ...snapshot,
  };
}
