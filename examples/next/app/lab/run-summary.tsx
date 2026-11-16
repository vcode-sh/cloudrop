import styles from "./lab.module.css";
import { describeRun, type LogRow, type Run, resultJson, seconds, summarize, throughput } from "./run-report";

const MIB = 1024 * 1024;

const readableSize = (bytes: number): string =>
  bytes >= MIB ? `${(bytes / MIB).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;

/** The numbers of a finished run, the sentence that tells it, and upload()'s result. */
export function RunSummary({ rows, run }: { rows: readonly LogRow[]; run: Run }) {
  const { endMs, result } = run;
  if (endMs === null || result === null) return <p role="status">Uploading…</p>;
  const finished = { ...run, endMs };
  const summary = summarize(rows, finished);
  const bucketHost = rows.find((row) => row.record.isBucketPut)?.record.host;
  const entries: [string, string][] = [
    ["Total time", seconds(summary.totalMs)],
    ["Bytes", `${summary.bytes} (${readableSize(summary.bytes)})`],
    [
      "Throughput",
      summary.megabytesPerSecond === null ? "none: not completed" : throughput(summary.megabytesPerSecond),
    ],
    ["Parts sent", String(summary.parts)],
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
