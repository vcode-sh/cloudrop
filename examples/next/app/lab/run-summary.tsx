import styles from "./lab.module.css";
import { describeRun, type LogRow, type Run, resultJson, seconds, summarize, throughputText } from "./run-report";

const MIB = 1024 * 1024;

/** Exact bytes, with KiB or MiB beside them once there are at least 1024. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return bytes >= MIB ? `${bytes} (${(bytes / MIB).toFixed(1)} MiB)` : `${bytes} (${(bytes / 1024).toFixed(1)} KiB)`;
}

/** The numbers of a finished run, the sentence that tells it, and upload()'s result. */
export function RunSummary({ rows, run }: { rows: readonly LogRow[]; run: Run }) {
  const { endMs, result } = run;
  if (endMs === null || result === null) return <p role="status">Uploading…</p>;
  const finished = { ...run, endMs };
  const summary = summarize(rows, finished);
  const bucketHost = rows.find((row) => row.record.isBucketPut)?.record.host;
  const entries: [string, string][] = [
    ["Total time", seconds(summary.totalMs)],
    ["File size", sizeText(summary.fileSize)],
    ["Sent to the bucket", sizeText(summary.sentBytes)],
    ["Throughput (end to end, /upload to /complete)", throughputText(summary)],
    ["PUT requests started", String(summary.putsStarted)],
    ["PUT requests answered", String(summary.putsAnswered)],
    ["Retries", String(summary.retries)],
    ["Renewals", String(summary.renewals)],
    ["Peak parts in flight", String(summary.peakInFlight)],
    ["Bucket host", bucketHost ?? "none: no bucket request"],
  ];

  return (
    <section className={styles.section}>
      <h2>Summary</h2>
      <dl className={styles.summary}>
        {entries.map(([term, value]) => [<dt key={`${term} term`}>{term}</dt>, <dd key={`${term} value`}>{value}</dd>])}
      </dl>
      <p role="status">{describeRun(rows, finished)}</p>
      <figure className={styles.figure}>
        <figcaption>Result</figcaption>
        <pre className={styles.result}>{resultJson(result)}</pre>
      </figure>
    </section>
  );
}
