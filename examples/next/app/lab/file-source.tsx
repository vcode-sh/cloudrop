import type { ChangeEvent } from "react";
import styles from "./lab.module.css";
import { randomFile, TEST_FILE_SIZES } from "./test-file";

interface Props {
  file: File | null;
  disabled: boolean;
  onChoose(file: File): void;
}

export function FileSource({ file, disabled, onChoose }: Props) {
  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    // Cleared so that choosing the same file again counts: Chromium fires `cancel`, not `change`, for an unchanged
    // selection.
    event.target.value = "";
    if (chosen) onChoose(chosen);
  }

  return (
    <section className={styles.section}>
      <h2>File</h2>
      <p>
        <label>
          File to upload <input type="file" onChange={onChange} disabled={disabled} />
        </label>
      </p>
      <div className={styles.row}>
        Or random bytes made in this browser:
        {TEST_FILE_SIZES.map(({ label, bytes }) => (
          <button key={label} type="button" disabled={disabled} onClick={() => onChoose(randomFile(label, bytes))}>
            {label}
          </button>
        ))}
      </div>
      <p>{file ? `Chosen: ${file.name}, ${file.size} bytes.` : "No file chosen yet."}</p>
    </section>
  );
}
