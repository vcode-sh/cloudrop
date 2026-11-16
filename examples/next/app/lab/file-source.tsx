import type { ChangeEvent } from "react";
import styles from "./lab.module.css";
import { randomFile, TEST_FILE_SIZES } from "./test-file";

interface Props {
  files: readonly File[];
  disabled: boolean;
  onAdd(files: File[]): void;
  onClear(): void;
}

/** The list Upload sends in one job: files chosen on disk and random ones made here, in the order they were added. */
export function FileSource({ files, disabled, onAdd, onClear }: Props) {
  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const chosen = [...(event.target.files ?? [])];
    // Cleared so that choosing the same file again counts: Chromium fires `cancel`, not `change`, for an unchanged
    // selection.
    event.target.value = "";
    if (chosen.length > 0) onAdd(chosen);
  }

  return (
    <section className={styles.section}>
      <h2>Files</h2>
      <p>
        <label>
          Files to upload <input type="file" multiple onChange={onChange} disabled={disabled} />
        </label>
      </p>
      <div className={styles.row}>
        Or add random bytes made in this browser:
        {TEST_FILE_SIZES.map(({ label, bytes }) => (
          <button key={label} type="button" disabled={disabled} onClick={() => onAdd([randomFile(label, bytes)])}>
            {label}
          </button>
        ))}
      </div>
      <div className={styles.row}>
        <p>
          {files.length === 0
            ? "No file chosen yet."
            : `Chosen: ${files.map((file) => `${file.name}, ${file.size} bytes`).join("; ")}.`}
        </p>
        <button type="button" disabled={disabled || files.length === 0} onClick={onClear}>
          Clear the list
        </button>
      </div>
    </section>
  );
}
