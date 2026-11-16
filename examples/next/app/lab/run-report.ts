// Everything the lab says about a run, read from the request log: the notes per row, the summary and the sentence
// under it.
import type { CompleteResponse, Result, RouteResult } from "cloudrop/client";
import type { cloudrop } from "../../lib/cloudrop";
import type { RequestRecord } from "./lab-fetch";

type UploadResult = Result<CompleteResponse<RouteResult<typeof cloudrop, "files">>>;

export interface Run {
  fileSize: number;
  startMs: number;
  /** When upload() returned; null while it runs. */
  endMs: number | null;
  result: UploadResult | null;
}

export interface LogRow {
  record: RequestRecord;
  /** "retry", "renewal", "already stored" and the injected faults, joined. */
  note: string;
}

const MIB = 1024 * 1024;

/** A PUT answered 412 repeats a create-only PUT whose first attempt stored the object: the client counts it as stored (M3-S10). */
const alreadyStored = (record: RequestRecord): boolean => record.isBucketPut && record.status === 412;

/** A request that ended without a 2xx answer (or a PUT's 412); one in flight has not failed yet. */
export const requestFailed = (record: RequestRecord): boolean =>
  typeof record.status === "number" ? record.status >= 300 && !alreadyStored(record) : record.status !== null;

/**
 * A request of a kind already sent is a retry. A /sign renews a URL, unless the last /sign for the same URL failed: then
 * it is that renewal's retry. This example's /upload ticket signs every part (the route's 100 MB limit, binary as in
 * cloudrop, is 13 parts of 8 MiB; a ticket signs up to 20), so the client asks /sign only to replace a URL.
 */
export function annotate(records: readonly RequestRecord[]): LogRow[] {
  const seen = new Set<string>();
  const signFailed = new Map<string, boolean>();
  return records.map((record) => {
    let label: string | null = seen.has(record.kind) ? "retry" : null;
    const target = record.signedFor;
    if (target !== null) {
      const of = target === "the PUT" ? "" : ` of ${target}`;
      label = `${signFailed.get(target) ? "retry" : "renewal"}${of}`;
      signFailed.set(target, requestFailed(record));
    }
    seen.add(record.kind);
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
  fileSize: number;
  /** Body bytes of the PUTs the bucket answered. A PUT cancelled or failed before an answer may have sent nothing. */
  sentBytes: number;
  /** File size over the whole upload() call; null when not completed or under 1 MiB. */
  mibPerSecond: number | null;
  putsStarted: number;
  putsAnswered: number;
  retries: number;
  renewals: number;
  peakInFlight: number;
}

export function summarize(rows: readonly LogRow[], run: Run & { endMs: number }): Summary {
  const records = rows.map((row) => row.record);
  const puts = records.filter((record) => record.isBucketPut);
  const answered = puts.filter((record) => typeof record.status === "number");
  const totalMs = run.endMs - run.startMs;
  const completed = run.result !== null && run.result.error === null;
  // Under 1 MiB the time is mostly round trips to the server and the bucket, not bytes moving.
  const measurable = completed && run.fileSize >= MIB && totalMs > 0;
  return {
    totalMs,
    completed,
    fileSize: run.fileSize,
    sentBytes: answered.reduce((sum, record) => sum + record.bytes, 0),
    mibPerSecond: measurable ? run.fileSize / MIB / (totalMs / 1000) : null,
    putsStarted: puts.length,
    putsAnswered: answered.length,
    retries: rows.filter((row) => row.note.startsWith("retry")).length,
    renewals: rows.filter((row) => row.note.startsWith("renewal")).length,
    peakInFlight: peakInFlight(records),
  };
}

export const seconds = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** End to end, binary as cloudrop's sizes are: the file size over the time from /upload to /complete's answer. */
export function throughputText({ completed, mibPerSecond }: Summary): string {
  if (!completed) return "none: not completed";
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

/** "part 2 was retried once after a network error", one clause per request kind that was sent again. */
function retryClauses(rows: readonly LogRow[]): string[] {
  const byKind = Map.groupBy(
    rows.filter((row) => row.record.kind !== "/sign"),
    (row) => row.record.kind,
  );
  return [...byKind].flatMap(([kind, attempts]) => {
    if (attempts.length < 2) return [];
    const reasons = new Set(
      attempts
        .map(({ record }) => record)
        .filter((record) => requestFailed(record) && record.status !== "cancelled")
        .map(({ status }) => (status === "network error" ? "a network error" : `HTTP ${status}`)),
    );
    const subject = kind === "PUT single" ? "the PUT" : kind.replace("PUT ", "");
    const after = reasons.size > 0 ? ` after ${[...reasons].join(" and ")}` : "";
    return [`${subject} was retried ${times(attempts.length - 1)}${after}`];
  });
}

function endingClause(rows: readonly LogRow[], run: Run & { endMs: number }, summary: Summary): string {
  const took = seconds(summary.totalMs);
  const error = run.result?.error;
  if (!error) return `completed in ${took}${summary.mibPerSecond === null ? "" : ` at ${throughputText(summary)}`}`;
  const ended = error.code === "ABORTED" ? `cancelled after ${took}` : `failed with ${error.code} after ${took}`;
  if (rows.some((row) => row.record.kind === "/abort")) return `${ended}; the client told the server with /abort`;
  const completeUnanswered = rows.some(
    ({ record }) => record.kind === "/complete" && (record.status === "network error" || Number(record.status) >= 500),
  );
  return completeUnanswered ? `${ended}; a /complete may have finished the file, so the client kept it` : ended;
}

/** The run in one plain sentence, built from the log. */
export function describeRun(rows: readonly LogRow[], run: Run & { endMs: number }): string {
  const summary = summarize(rows, run);
  const { renewals: count } = summary;
  const renewals = count > 0 ? [`renewed ${count === 1 ? "one URL" : `${count} URLs`} through /sign`] : [];
  const clauses = [sendingClause(summary), ...retryClauses(rows), ...renewals, endingClause(rows, run, summary)];
  return `${clauses.join("; ")}.`;
}

/** The `{ data, error }` result as the page shows it: the key and the route's result, or the error's public fields. */
export function resultJson(result: UploadResult): string {
  const shown = result.error
    ? {
        data: null,
        error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable },
      }
    : { data: { key: result.data.file.key, result: result.data.data }, error: null };
  return JSON.stringify(shown, null, 2);
}
