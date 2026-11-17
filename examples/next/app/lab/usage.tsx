import { useEffect, useState } from "react";
import type { UsageInfo } from "../api/usage/route";
import styles from "./lab.module.css";

const MIB = 1024 * 1024;

const mib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

/** What the section shows: the route's answer, or what went wrong reading it. */
type Shown = UsageInfo | { error: string };

/**
 * The signed-in user's storage from /api/usage, read when the page loads and whenever `version` changes (the page
 * passes the end of each run). Without a database store the example keeps no rows, so there is nothing to count.
 */
export function Usage({ version }: { version: number | null }) {
  const [shown, setShown] = useState<Shown | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the signal to read again, not an input.
  useEffect(() => {
    fetch("/api/usage")
      .then(async (response) => {
        const body = await response.json();
        return response.ok ? (body as UsageInfo) : { error: String(body.error) };
      })
      .then(setShown, () => setShown({ error: "/api/usage did not answer." }));
  }, [version]);

  if (shown === null) return null;
  if ("error" in shown) return <p className={styles.muted}>Usage: {shown.error}</p>;
  if (!shown.store) {
    return (
      <p className={styles.muted}>
        No database store: set CLOUDROP_EXAMPLE_STORE=sqlite to keep a row per upload, count each user's storage against
        a quota and run onComplete once per file (README.md).
      </p>
    );
  }
  return (
    <section className={styles.section}>
      <h2>Your storage</h2>
      <dl className={styles.summary}>
        <dt>Used</dt>
        <dd>
          {mib(shown.activeBytes)} of {mib(shown.quotaBytes)} in {shown.files} {shown.files === 1 ? "file" : "files"}
        </dd>
        <dt>Reserved</dt>
        <dd>{mib(shown.reservedBytes)}</dd>
      </dl>
      <table className={styles.table}>
        <caption>Finished uploads</caption>
        <thead>
          <tr>
            <th>Key</th>
            <th>Bytes</th>
            <th>onComplete runs</th>
          </tr>
        </thead>
        <tbody>
          {shown.uploads.map((upload) => (
            <tr key={upload.key}>
              <td>{upload.key}</td>
              <td>{upload.size}</td>
              <td>{upload.completions}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.muted}>
        Reserved bytes belong to uploads not finished yet; they move to used when an upload completes, and are released
        when it is cancelled or expires.
      </p>
    </section>
  );
}
