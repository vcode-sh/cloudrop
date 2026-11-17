// Everything the lab says about a run, read from the request log: the notes per row, the summary and the sentence
// under it.
import type { CloudropError, FileHandle, FileOutcome, RouteResult, UploadResult } from "cloudrop/client";
import type { cloudrop } from "../../lib/cloudrop";
import type { RequestRecord } from "./journal";

type FileResult = RouteResult<typeof cloudrop, "files">;
export type JobResult = UploadResult<FileResult>;

export interface Run {
  /** How many files the job sends, and their bytes together. */
  files: number;
  size: number;
  startMs: number;
  /** When the job's `done`, or the latest Retry, settled; null while it runs. */
  endMs: number | null;
  /** The job's latest outcomes: after a Retry, the files' current ones. */
  result: JobResult | null;
  /** True once Retry was pressed: the time then includes the wait before it. */
  retried: boolean;
}

export interface LogRow {
  record: RequestRecord;
  /** "retry", "renewal", "resumed", "new ticket", "already stored" and the injected faults, joined. */
  note: string;
}

const MIB = 1024 * 1024;

/** A PUT answered 412 repeats a create-only PUT whose first attempt stored the object: the client counts it as stored (M3-S10). */
const alreadyStored = (record: RequestRecord): boolean => record.isBucketPut && record.status === 412;

/** A request that ended without a 2xx answer (or a PUT's 412); one in flight has not failed yet. */
export const requestFailed = (record: RequestRecord): boolean =>
  typeof record.status === "number" ? record.status >= 300 && !alreadyStored(record) : record.status !== null;

/** What `record` is beside its file's earlier attempt at it, `before`. */
function repeatLabel(record: RequestRecord, before: RequestRecord | undefined): string | null {
  const target = record.signedFor;
  if (target !== null) {
    const of = target === "the PUT" ? "" : ` of ${target}`;
    return `${before && requestFailed(before) ? "retry" : "renewal"}${of}`;
  }
  if (before === undefined) return null;
  if (before.status === "cancelled") return "resumed";
  // An /upload after one that was answered asks for a new ticket for a retried file.
  return record.kind === "/upload" && !requestFailed(before) ? "new ticket" : "retry";
}

/** Only a resumed upload starts with /complete: it asks the server which parts the bucket already has. */
const isResume = (records: readonly RequestRecord[]): boolean => records[0]?.kind === "/complete";

/**
 * A request its file already sent is a retry (after a stall too), or, when the earlier one was cancelled by a pause,
 * resumed. A /sign renews a URL, unless the file's last /sign for the same URL failed: then it is that renewal's
 * retry. This example's /upload ticket signs every part (the route's 100 MB limit, binary as in cloudrop, is 13
 * parts of 8 MiB; a ticket signs up to 20), so the client asks /sign only to replace a URL, or, in a resumed upload,
 * which has no URL, for the parts its first /complete named missing. That /complete is a question, not an attempt the next one retries.
 */
export function annotate(records: readonly RequestRecord[]): LogRow[] {
  const probe = isResume(records) ? records[0] : undefined;
  // True until a resumed upload's first /sign, which asks for the missing parts' URLs.
  let missing = probe !== undefined;
  const last = new Map<string, RequestRecord>();
  return records.map((record) => {
    const request = `${record.kind} ${record.signedFor} ${record.subject}`;
    const before = last.get(request);
    last.set(request, record);
    let label: string | null;
    if (record === probe) label = "resume: asks which parts are stored";
    else if (missing && record.kind === "/sign") {
      missing = false;
      label = `URLs for the missing ${record.signedFor}`;
    } else label = probe !== undefined && before === probe ? null : repeatLabel(record, before);
    const notes = [label, alreadyStored(record) ? "already stored" : null, ...record.injected];
    return { record, note: notes.filter((note) => note !== null).join("; ") };
  });
}

/** The most bucket PUTs that were in flight at the same moment, the lab's injected delay included. */
function peakInFlight(records: readonly RequestRecord[]): number {
  const edges = records
    .filter((record) => record.isBucketPut)
    .flatMap((record) => [
      { at: record.startMs, step: 1 },
      { at: record.endMs ?? Number.POSITIVE_INFINITY, step: -1 },
    ])
    // At the same instant an end comes before a start: back-to-back requests do not overlap.
    .sort((a, b) => a.at - b.at || a.step - b.step);
  let inFlight = 0;
  let peak = 0;
  for (const { step } of edges) {
    inFlight += step;
    peak = Math.max(peak, inFlight);
  }
  return peak;
}

export interface Summary {
  totalMs: number;
  completed: boolean;
  retried: boolean;
  /** True for a resumed upload, which sends only the parts the bucket lacks. */
  resumedUpload: boolean;
  files: number;
  size: number;
  /** Body bytes of the PUTs the bucket answered. A PUT cancelled or failed before an answer may have sent nothing. */
  sentBytes: number;
  /** The files' size over the whole job; null when not completed or under 1 MiB. */
  mibPerSecond: number | null;
  putsStarted: number;
  putsAnswered: number;
  retries: number;
  renewals: number;
  resumed: number;
  peakInFlight: number;
}

export function summarize(rows: readonly LogRow[], run: Run & { endMs: number }): Summary {
  const records = rows.map((row) => row.record);
  const puts = records.filter((record) => record.isBucketPut);
  const answered = puts.filter((record) => typeof record.status === "number");
  const totalMs = run.endMs - run.startMs;
  const completed = run.result !== null && run.result.error === null;
  const resumedUpload = isResume(records);
  // Under 1 MiB the time is mostly round trips to the server and the bucket, not bytes moving.
  const measurable = completed && !run.retried && !resumedUpload && run.size >= MIB && totalMs > 0;
  const noted = (label: string) => rows.filter((row) => row.note.startsWith(label)).length;
  return {
    totalMs,
    completed,
    retried: run.retried,
    resumedUpload,
    files: run.files,
    size: run.size,
    sentBytes: answered.reduce((sum, record) => sum + record.bytes, 0),
    mibPerSecond: measurable ? run.size / MIB / (totalMs / 1000) : null,
    putsStarted: puts.length,
    putsAnswered: answered.length,
    retries: noted("retry"),
    renewals: noted("renewal"),
    resumed: noted("resumed"),
    peakInFlight: peakInFlight(records),
  };
}

export const seconds = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** End to end, binary as cloudrop's sizes are: the files' size over the time from /upload to the last answer. */
export function throughputText({ completed, retried, resumedUpload, mibPerSecond }: Summary): string {
  if (!completed) return "none: not completed";
  if (retried) return "not shown: the time includes the wait before Retry";
  if (resumedUpload) return "not shown: a resumed upload sends only the parts the bucket lacks";
  if (mibPerSecond === null) return "not shown: under 1 MiB the time is mostly round trips";
  return `${mibPerSecond.toFixed(1)} MiB/s`;
}

const publicFields = ({ code, message, retryable }: CloudropError) => ({ code, message, retryable });

/** The job's `{ data, error }` as the page shows it: per file its key and result, or the error's public fields. */
export function resultJson({ data, error }: JobResult): string {
  const files = data?.files.map((file) =>
    file.status === "done"
      ? { id: file.id, name: file.name, status: file.status, key: file.result.file.key, result: file.result.data }
      : { id: file.id, name: file.name, status: file.status, error: publicFields(file.error) },
  );
  return JSON.stringify({ data: files ? { files } : null, error: error ? publicFields(error) : null }, null, 2);
}

/** The job's result once `outcome` replaced its file's earlier one: what job.retry() would resolve with now. */
export function withOutcome(
  result: JobResult,
  outcome: FileOutcome<FileResult>,
  handles: readonly FileHandle<FileResult>[],
): JobResult {
  // A job the server refused has no outcomes: each of its files failed with the job's error.
  const before = result.data
    ? result.data.files
    : handles.map(({ id, name }) => ({ id, name, status: "failed" as const, error: result.error }));
  const files = before.map((file) => (file.id === outcome.id ? outcome : file));
  const failed = files.find((file) => file.status !== "done");
  return failed ? { data: { files }, error: failed.error } : { data: { files }, error: null };
}
