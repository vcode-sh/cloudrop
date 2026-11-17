import { type CloudropClient, createCloudropClient, type ResumableUpload } from "cloudrop/client";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import type { cloudrop } from "../../lib/cloudrop";
import styles from "./lab.module.css";

/** What the section shows: the uploads `client.resumable("files")` listed, or what went wrong reading them. */
type Unfinished = { uploads: readonly ResumableUpload<"files">[]; error: null } | { uploads: null; error: string };

/** The unfinished uploads, read when the page loads and again on `refresh()`; `forget()` is the sign-out call. */
export function useUnfinished() {
  const [unfinished, setUnfinished] = useState<Unfinished | null>(null);
  // Any client of this page reads the same browser storage: this one only lists and forgets, each run has its own.
  // Created on first use, in the browser: the server renders this page too.
  const client = useRef<CloudropClient<typeof cloudrop> | null>(null);
  const lister = () => {
    client.current ??= createCloudropClient<typeof cloudrop>();
    return client.current;
  };

  /**
   * Reads the list through `client`: after a run, the run's own client, whose store applies its operations in order, so
   * the read comes after the run's last save or delete. Another client's read could come before them.
   */
  async function refresh(client = lister()) {
    const { data, error } = await client.resumable("files");
    setUnfinished(error ? { uploads: null, error: error.message } : { uploads: data, error: null });
  }

  async function forget() {
    const { error } = await lister().forget();
    if (error) setUnfinished({ uploads: null, error: error.message });
    else await refresh();
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once when the page loads; refresh() reads it again.
  useEffect(() => {
    void refresh();
  }, []);

  return { unfinished, refresh, forget };
}

interface Props {
  /** Null until the first read of the browser's storage ends. */
  unfinished: Unfinished | null;
  disabled: boolean;
  onResume(upload: ResumableUpload<"files">, file: File): void;
  onForget(): void;
}

function ResumeInput({
  upload,
  disabled,
  onResume,
}: { upload: ResumableUpload<"files"> } & Pick<Props, "disabled" | "onResume">) {
  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const [file] = event.target.files ?? [];
    // Cleared so that picking the same file again counts, as in the Files section.
    event.target.value = "";
    if (file) onResume(upload, file);
  }
  return <input type="file" aria-label={`Resume ${upload.name}`} disabled={disabled} onChange={onChange} />;
}

/**
 * The multipart uploads this browser saved and has not finished, read again when the page loads and after each run.
 * Only the record's public fields reach the page: never its token, key or metadata.
 */
export function UnfinishedUploads({ unfinished, disabled, onResume, onForget }: Props) {
  const uploads = unfinished?.uploads ?? [];
  return (
    <section className={styles.section}>
      <h2>Unfinished uploads</h2>
      <p className={styles.muted}>
        A multipart upload stopped by a reload or a closed tab, from client.resumable(&quot;files&quot;). Pick the same
        file to resume it: client.resume(upload, file) asks /complete which parts the bucket already has, then sends
        only the missing ones. Forget is client.forget(), the call an app makes at sign-out.
      </p>
      {unfinished === null && <p className={styles.muted}>Reading this browser&apos;s storage…</p>}
      {unfinished?.error && <p>{unfinished.error}</p>}
      {unfinished?.uploads?.length === 0 && <p>No unfinished uploads.</p>}
      {uploads.length > 0 && (
        <table className={styles.table}>
          <caption>Unfinished uploads</caption>
          <thead>
            <tr>
              <th>File</th>
              <th>Bytes</th>
              <th>Expires</th>
              <th>Pick the same file to resume</th>
            </tr>
          </thead>
          <tbody>
            {uploads.map((upload) => (
              <tr key={upload.id}>
                <td>{upload.name}</td>
                <td>{upload.size}</td>
                <td>{new Date(upload.expiresAt).toLocaleString()}</td>
                <td>
                  <ResumeInput upload={upload} disabled={disabled} onResume={onResume} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <button type="button" disabled={disabled || uploads.length === 0} onClick={onForget}>
          Forget unfinished uploads
        </button>
      </p>
    </section>
  );
}
