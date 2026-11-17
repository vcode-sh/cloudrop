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

/** What Retry does for the job and for one file; null while a run or a retry is going, which Retry waits for. */
export interface Retry<R> {
  job(): void;
  file(handle: FileHandle<R>): void;
}

/** Wraps a button's action with what it asks the client: to stop (true) or to go on (false). */
export type Asked = (stop: boolean, act: () => void) => () => void;

interface RowProps<R> {
  file: FileSnapshot<R>;
  handle: FileHandle<R>;
  retry: Retry<R> | null;
  asked: Asked;
}

function FileRow<R>({ file, handle, retry, asked }: RowProps<R>) {
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
          onClick={asked(true, handle.pause)}
        >
          Pause
        </button>
        <button
          type="button"
          aria-label={`Resume ${name}`}
          disabled={status !== "paused"}
          onClick={asked(false, handle.resume)}
        >
          Resume
        </button>
        <button type="button" aria-label={`Cancel ${name}`} disabled={settled} onClick={asked(true, handle.abort)}>
          Cancel
        </button>
        <button
          type="button"
          aria-label={`Retry ${name}`}
          disabled={retry === null || status !== "failed"}
          onClick={() => retry?.file(handle)}
        >
          Retry
        </button>
      </td>
    </tr>
  );
}

/** The job's snapshot: a row per file in the order they were passed, and the totals with the job's Retry. */
export function FileRows<R>({ job, retry, asked }: { job: UploadJob<R>; retry: Retry<R> | null; asked: Asked }) {
  const { files, totals } = useSyncExternalStore(job.subscribe, job.getSnapshot);
  return (
    <>
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
            <FileRow key={file.id} file={file} handle={job.files[index] as FileHandle<R>} retry={retry} asked={asked} />
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
            <td>
              <button type="button" disabled={retry === null || totals.failed === 0} onClick={() => retry?.job()}>
                Retry
              </button>
            </td>
          </tr>
        </tfoot>
      </table>
      <p className={styles.muted}>
        The totals leave out failed and aborted files, so one of them never holds the bar below full.
      </p>
    </>
  );
}
