// Everything the lab says about a run, read from the request log: the notes per row, the summary and the sentence
// under it.
import type { CompleteResponse, Result, RouteResult } from "cloudrop/client";
import type { cloudrop } from "../../lib/cloudrop";
import type { RequestRecord } from "./lab-fetch";

export type UploadResult = Result<CompleteResponse<RouteResult<typeof cloudrop, "files">>>;

export interface Run {
  fileSize: number;
  startMs: number;
  /** When upload() returned; null while it runs. */
  endMs: number | null;
  result: UploadResult | null;
}

export interface LogRow {
  record: RequestRecord;
  /** "retry", "renewal" and the injected faults, joined. */
  note: string;
}

/** A request that ended without a 2xx answer; one in flight has not failed yet. */
export const requestFailed = ({ status }: RequestRecord): boolean =>
  typeof status === "number" ? status >= 300 : status !== null;

/**
 * A request of a kind already sent is a retry. Every /sign renews a URL: this example's /upload ticket signs every part
 * (the route's 100 MB limit, binary as in cloudrop, is 13 parts of 8 MiB; a ticket signs up to 20), so the client asks
 * /sign only to replace one.
 */
export function annotate(records: readonly RequestRecord[]): LogRow[] {
  const seen = new Set<string>();
  let lastSignFailed = false;
  return records.map((record) => {
    const notes = [...record.injected];
    if (record.kind === "/sign") {
      notes.unshift(lastSignFailed ? "retry" : "renewal");
      lastSignFailed = requestFailed(record);
    } else if (seen.has(record.kind)) notes.unshift("retry");
    seen.add(record.kind);
    return { record, note: notes.join("; ") };
  });
}

/** The most bucket PUTs that were in flight at the same moment. */
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
  bytes: number;
  /** Only for a completed upload. */
  megabytesPerSecond: number | null;
  parts: number;
  retries: number;
  renewals: number;
  peakInFlight: number;
}

export function summarize(rows: readonly LogRow[], run: Run & { endMs: number }): Summary {
  const records = rows.map((row) => row.record);
  const totalMs = run.endMs - run.startMs;
  const completed = run.result !== null && run.result.error === null;
  return {
    totalMs,
    bytes: run.fileSize,
    megabytesPerSecond: completed && totalMs > 0 ? run.fileSize / 1e6 / (totalMs / 1000) : null,
    parts: new Set(records.filter((record) => record.isBucketPut).map((record) => record.kind)).size,
    retries: rows.filter((row) => row.note.startsWith("retry")).length,
    renewals: rows.filter((row) => row.note.startsWith("renewal")).length,
    peakInFlight: peakInFlight(records),
  };
}

export const seconds = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Two significant digits for a small file's rate, which would otherwise read 0.0 MB/s. */
export const throughput = (megabytesPerSecond: number): string =>
  `${megabytesPerSecond >= 10 ? megabytesPerSecond.toFixed(1) : megabytesPerSecond.toPrecision(2)} MB/s`;

const times = (count: number): string => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

function sendingClause(summary: Summary): string {
  if (summary.parts === 0) return "Sent no bytes to the bucket";
  if (summary.parts === 1 && summary.peakInFlight <= 1) return "Sent the file in one PUT";
  return `Sent ${summary.parts} parts, at most ${summary.peakInFlight} at a time`;
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
        .map(({ record }) => record.status)
        .filter((status) => status === "network error" || (typeof status === "number" && status >= 300))
        .map((status) => (status === "network error" ? "a network error" : `HTTP ${status}`)),
    );
    const subject = kind === "PUT single" ? "the PUT" : kind.replace("PUT ", "");
    const after = reasons.size > 0 ? ` after ${[...reasons].join(" and ")}` : "";
    return [`${subject} was retried ${times(attempts.length - 1)}${after}`];
  });
}

function endingClause(rows: readonly LogRow[], run: Run & { endMs: number }, summary: Summary): string {
  const took = seconds(summary.totalMs);
  const error = run.result?.error;
  if (!error) {
    const rate = summary.megabytesPerSecond === null ? "" : ` at ${throughput(summary.megabytesPerSecond)}`;
    return `completed in ${took}${rate}`;
  }
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
