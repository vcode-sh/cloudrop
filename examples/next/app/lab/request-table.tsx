import styles from "./lab.module.css";
import type { RequestRecord } from "./lab-fetch";
import { type LogRow, requestFailed } from "./run-report";

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

const statusText = (status: RequestRecord["status"]): string => (status === null ? "…" : String(status));

/** One row per request in the order they started, with a bar on a timeline all rows share. */
export function RequestTable({ rows }: { rows: readonly LogRow[] }) {
  if (rows.length === 0) return <p className={styles.muted}>No requests yet.</p>;
  const records = rows.map((row) => row.record);
  const origin = Math.min(...records.map((record) => record.startMs));
  // A request still in flight reaches the latest moment the log knows of.
  const latest = Math.max(...records.map((record) => record.endMs ?? record.startMs));
  const span = Math.max(latest - origin, 1);

  return (
    <table className={styles.table}>
      <caption>Requests</caption>
      <thead>
        <tr>
          <th>Request</th>
          <th>Status</th>
          <th>Note</th>
          <th>ms</th>
          <th>Bytes</th>
          <th className={styles.timeline}>Timeline</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ record, note }) => {
          const end = record.endMs ?? latest;
          return (
            <tr key={`${record.kind} ${record.startMs}`} className={requestFailed(record) ? styles.failed : undefined}>
              <td>{record.kind}</td>
              <td>{statusText(record.status)}</td>
              <td>{note}</td>
              <td>{record.endMs === null ? "…" : Math.round(record.endMs - record.startMs)}</td>
              <td>{record.bytes}</td>
              <td>
                <div className={styles.track}>
                  <div
                    className={styles.bar}
                    style={{
                      left: percent((record.startMs - origin) / span),
                      width: percent((end - record.startMs) / span),
                    }}
                  />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
