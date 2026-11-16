// A job's run after start(): one /upload for every file, each file then run on its own through the client's pool, and
// one result with an outcome per file (spec §2.2, §4.4, §4.6). Files are independent: one failing never stops another.

import { CloudropError, fail } from "../errors.ts";
import type { Arguments } from "./arguments.ts";
import { aborted, withFile } from "./failures.ts";
import { type Entry, pauseFile, resumeFile, runFile, settle } from "./file-run.ts";
import { watchConnectivity } from "./lifecycle.ts";
import { withRetry } from "./retry.ts";
import type { FileOutcome, UploadResult } from "./types.ts";
import type { UploadContext } from "./upload.ts";

function outcomeOf({ id, file, status, result, error }: Entry): FileOutcome<unknown> {
  const { name } = file;
  if (result) return { id, name, status: "done", result };
  // Every settled entry without a result holds its error: settle() sets both.
  return { id, name, status: status === "aborted" ? "aborted" : "failed", error: error as CloudropError };
}

/** Brackets each run of a file: `begin` when it starts, `finish` when it ends. */
export interface Runs {
  begin(): void;
  finish(): void;
}

/**
 * Counts the files of the job that run: the page's connectivity is watched from the first run's start to the last
 * one's end. Offline pauses every file that can pause; online resumes only those it paused (Q6, Q17).
 */
export function watchedRuns(entries: readonly Entry[]): Runs {
  let running = 0;
  let unwatch = () => {};
  const offline = () => {
    for (const entry of entries) pauseFile(entry, true);
  };
  const online = () => {
    for (const entry of entries) if (entry.networkPaused) resumeFile(entry);
  };
  return {
    begin: () => {
      running += 1;
      if (running === 1) unwatch = watchConnectivity(offline, online);
    },
    finish: () => {
      running -= 1;
      if (running === 0) unwatch();
    },
  };
}

export async function run(
  context: UploadContext,
  { route, files, metadata }: Arguments,
  entries: readonly Entry[],
  signal: AbortSignal,
  runs: Runs,
): Promise<UploadResult<unknown>> {
  const started = await withRetry(() => context.endpoints.start(route, files, metadata, signal), signal);
  if (started.error) {
    // The whole job's error, so no file of its own.
    const error = signal.aborted ? aborted() : started.error;
    for (const entry of entries) {
      // A file cancelled on its own meanwhile ends as cancelled, with its own error (ruling M3-U10).
      const own = entry.cancel.signal.aborted && !signal.aborted;
      settle(entry, entry.cancel.signal.aborted ? "aborted" : "failed", own ? withFile(aborted(), entry) : error);
    }
    return fail(error);
  }
  // Every file at once: the pool decides who sends.
  await Promise.all(
    entries.map(async (entry, index) => {
      const ticket = started.data[index];
      if (ticket instanceof CloudropError) settle(entry, "failed", withFile(ticket, entry));
      // readTickets answered one ticket per file, so `ticket` is never undefined here.
      else if (ticket) {
        runs.begin();
        await runFile(context, entry, ticket).finally(runs.finish);
      }
    }),
  );
  const data = { files: entries.map(outcomeOf) };
  // The first file, in the order passed, that did not end done (ruling M3-U3).
  const error = data.files.find((outcome) => outcome.status !== "done")?.error ?? null;
  return error ? { data, error } : { data, error: null };
}
