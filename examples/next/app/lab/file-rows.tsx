import type { FileHandle, FileSnapshot, UploadJob } from "cloudrop/client";
import { useSyncExternalStore } from "react";
import styles from "./lab.module.css";

const MIB = 1024 * 1024;

const speedText = (bytesPerSecond: number): string => `${(bytesPerSecond / MIB).toFixed(1)} MiB/s`;

const etaText = (eta: number | null): string => (eta === null ? "–" : `${Math.ceil(eta)} s`);

/** A bar in bytes; an empty file has none to count, so its bar shows the snapshot's progress, 0 or 1. */
function Bar({ label, bytes, size, progress }: { label: string; bytes: number; size: number; progress: number }) {
  return (
    <progress
      className={styles.progress}
      aria-label={label}
      value={size > 0 ? bytes : progress}
      max={size > 0 ? size : 1}
    />
  );
}

function FileRow({ file, handle }: { file: FileSnapshot<unknown>; handle: FileHandle }) {
  const { name, status } = file;
  const settled = status === "done" || status === "failed" || status === "aborted";
  return (
    <tr>
      <td>{name}</td>
      <td>
        <Bar label={`Progress of ${name}`} {...file} />
      </td>
      <td>
        {file.bytes} of {file.size}
      </td>
      <td>{speedText(file.speed)}</td>
      <td>{etaText(file.eta)}</td>
      <td>{file.error ? `${status}: ${file.error.code}` : status}</td>
      <td className={styles.row}>
        {/* Named with the file: the job's own buttons are "Pause", "Resume" and "Cancel". */}
        <button
          type="button"
          aria-label={`Pause ${name}`}
          disabled={status !== "queued" && status !== "uploading"}
          onClick={handle.pause}
        >
          Pause
        </button>
        <button type="button" aria-label={`Resume ${name}`} disabled={status !== "paused"} onClick={handle.resume}>
          Resume
        </button>
        <button type="button" aria-label={`Cancel ${name}`} disabled={settled} onClick={handle.abort}>
          Cancel
        </button>
      </td>
    </tr>
  );
}

/** The job's snapshot: a row per file in the order they were passed, and the totals. */
export function FileRows<R>({ job, connections }: { job: UploadJob<R>; connections: number }) {
  const { files, totals } = useSyncExternalStore(job.subscribe, job.getSnapshot);
  return (
    <>
      <p>
        Connections: {connections}. The client sends at most this many bucket PUTs at once across its files, and at most
        4 parts of one file.
      </p>
      <table className={styles.table}>
        <caption>Files</caption>
        <thead>
          <tr>
            <th>File</th>
            <th>Progress</th>
            <th>Bytes sent</th>
            <th>Speed</th>
            <th>Time left</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file, index) => (
            // job.files and snapshot.files are both in the order the files were passed (ruling M3-U1).
            <FileRow key={file.id} file={file} handle={job.files[index] as FileHandle} />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">All files</th>
            <td>
              <Bar label="Progress of all files" {...totals} />
            </td>
            <td>
              {totals.bytes} of {totals.size}
            </td>
            <td>{speedText(totals.speed)}</td>
            <td>{etaText(totals.eta)}</td>
            <td>
              {totals.done} of {totals.count} done, {totals.failed} failed, {totals.aborted} aborted
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
      <p className={styles.muted}>
        The totals leave out failed and aborted files, so one of them never holds the bar below full.
      </p>
    </>
  );
}
