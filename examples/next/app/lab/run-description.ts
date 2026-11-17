// The sentence under the lab's summary that tells a run, built from the request log.
import { type LogRow, type Run, requestFailed, type Summary, seconds, summarize, throughputText } from "./run-report";

const REASONS: Record<string, string> = { "network error": "a network error", stalled: "a stall" };

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
        .map(({ status }) => REASONS[String(status)] ?? `HTTP ${status}`),
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
  // A job that ended before its first request, such as a resume refused for the file picked: its own words.
  const refusal = rows.length === 0 ? run.result?.error : null;
  if (refusal) return refusal.message;
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
