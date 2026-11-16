// Everything the lab says about a run, read from the request log: the notes per row, the summary and the sentence
// under it.
import type { CloudropError, FileHandle, FileOutcome, RouteResult, UploadResult } from "cloudrop/client";
import type { cloudrop } from "../../lib/cloudrop";
import type { RequestRecord } from "./lab-fetch";

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

/**
 * A request its file already sent is a retry, or, when the earlier one was cancelled by a pause, resumed. A /sign
 * renews a URL, unless the file's last /sign for the same URL failed: then it is that renewal's retry. This example's
 * /upload ticket signs every part (the route's 100 MB limit, binary as in cloudrop, is 13 parts of 8 MiB; a ticket
 * signs up to 20), so the client asks /sign only to replace a URL.
 */
export function annotate(records: readonly RequestRecord[]): LogRow[] {
  const last = new Map<string, RequestRecord>();
  return records.map((record) => {
    const request = `${record.kind} ${record.signedFor} ${record.subject}`;
    const label = repeatLabel(record, last.get(request));
    last.set(request, record);
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

interface Summary {
  totalMs: number;
  completed: boolean;
  retried: boolean;
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
  // Under 1 MiB the time is mostly round trips to the server and the bucket, not bytes moving.
  const measurable = completed && !run.retried && run.size >= MIB && totalMs > 0;
  const noted = (label: string) => rows.filter((row) => row.note.startsWith(label)).length;
  return {
    totalMs,
    completed,
    retried: run.retried,
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
export function throughputText({ completed, retried, mibPerSecond }: Summary): string {
  if (!completed) return "none: not completed";
  if (retried) return "not shown: the time includes the wait before Retry";
  if (mibPerSecond === null) return "not shown: under 1 MiB the time is mostly round trips";
  return `${mibPerSecond.toFixed(1)} MiB/s`;
}

const times = (count: number): string => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

function answeredText(started: number, answered: number): string {
  if (answered === 0) return started === 1 ? "it got no answer" : "none got an answer";
  if (answered === started) return started === 1 ? "it got an answer" : "all got an answer";
  return `${answered} got an answer`;
}

/** Counts requests, never parts "sent": a PUT cancelled before an answer may not have sent a byte. */
function sendingClause({ putsStarted, putsAnswered, peakInFlight }: Summary): string {
  if (putsStarted === 0) return "Started no PUT";
  const atOnce = peakInFlight > 1 ? ` (at most ${peakInFlight} at a time)` : "";
  const started = putsStarted === 1 ? "Started 1 PUT" : `Started ${putsStarted} PUTs`;
  return `${started}${atOnce}, ${answeredText(putsStarted, putsAnswered)}`;
}

/** "part 2 was retried once after a network error", one clause per request of a file that was retried. */
function retryClauses(rows: readonly LogRow[]): string[] {
  const byRequest = Map.groupBy(
    rows.filter((row) => row.record.kind !== "/sign"),
    ({ record }) => `${record.kind} ${record.subject}`,
  );
  return [...byRequest.values()].flatMap((attempts) => {
    const retries = attempts.filter((row) => row.note.startsWith("retry"));
    const [first] = retries;
    if (!first) return [];
    const reasons = new Set(
      attempts
        .map(({ record }) => record)
        .filter((record) => requestFailed(record) && record.status !== "cancelled")
        .map(({ status }) => (status === "network error" ? "a network error" : `HTTP ${status}`)),
    );
    const { kind } = first.record;
    const subject = kind === "PUT single" ? "the PUT" : kind.replace("PUT ", "");
    const after = reasons.size > 0 ? ` after ${[...reasons].join(" and ")}` : "";
    return [`${subject} was retried ${times(retries.length)}${after}`];
  });
}

function endingClause(rows: readonly LogRow[], run: Run & { endMs: number }, summary: Summary): string {
  const took = seconds(summary.totalMs);
  // After a Retry the time counts from Upload, the wait before Retry included.
  const after = run.retried ? `after Retry, ${took} after Upload` : `after ${took}`;
  const error = run.result?.error;
  if (!error && run.retried) return `completed ${after}`;
  if (!error) return `completed in ${took}${summary.mibPerSecond === null ? "" : ` at ${throughputText(summary)}`}`;
  const files = run.result?.data?.files ?? [];
  const done = files.filter((file) => file.status === "done").length;
  // The job's error is its first file that did not end done; with several files, say how many did.
  const some = files.length > 1 ? `${done} of ${files.length} files done, then ` : "";
  const ended = `${some}${error.code === "ABORTED" ? "cancelled" : `failed with ${error.code}`} ${after}`;
  if (rows.some((row) => row.record.kind === "/abort")) return `${ended}; the client told the server with /abort`;
  const completeUnanswered = rows.some(
    ({ record }) => record.kind === "/complete" && (record.status === "network error" || Number(record.status) >= 500),
  );
  return completeUnanswered ? `${ended}; a /complete may have finished the file, so the client kept it` : ended;
}

/** The run in one plain sentence, built from the log. */
export function describeRun(rows: readonly LogRow[], run: Run & { endMs: number }): string {
  const summary = summarize(rows, run);
  const { renewals: count, resumed } = summary;
  const renewals = count > 0 ? [`renewed ${count === 1 ? "one URL" : `${count} URLs`} through /sign`] : [];
  const resumes = resumed > 0 ? [`sent ${resumed === 1 ? "one PUT" : `${resumed} PUTs`} again after a pause`] : [];
  const clauses = [
    sendingClause(summary),
    ...retryClauses(rows),
    ...renewals,
    ...resumes,
    endingClause(rows, run, summary),
  ];
  return `${clauses.join("; ")}.`;
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
