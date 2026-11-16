// start(): several files through one /upload, each file run on its own through the client's pool, and one result
// with an outcome per file (spec §2, §2.2, §4.4, §4.6). Files are independent: one failing never stops another.

import { CloudropError, fail } from "../errors.ts";
import { type Arguments, readArguments } from "./arguments.ts";
import { aborted, withFile } from "./failures.ts";
import { type Entry, runFile, settle } from "./file-run.ts";
import { withRetry } from "./retry.ts";
import type { FileOutcome, UploadJob, UploadResult } from "./types.ts";
import type { UploadContext } from "./upload.ts";

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
  if (args.error) return { files: [], done: Promise.resolve(args), abort: () => {} };
  const entries = args.data.files.map((file): Entry => {
    const rank = context.nextRank();
    return {
      id: String(rank),
      file,
      rank,
      status: "queued",
      result: null,
      error: null,
      cancel: new AbortController(),
      changed: () => {},
    };
  });
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
  };
}
