import styles from "./lab.module.css";
import type { HeldFault, OneShotFault } from "./lab-fetch";

export type Faults = Record<OneShotFault | HeldFault, boolean> & { delayMs: number };

export const NO_FAULTS: Faults = {
  bucketNetworkError: false,
  endpoint503: false,
  dropComplete: false,
  part2NetworkError: false,
  bucket400: false,
  delayMs: 0,
};

const FAULT_BOXES: { fault: OneShotFault | HeldFault; label: string; effect: string }[] = [
  {
    fault: "bucketNetworkError",
    label: "Fail the next bucket PUT with a network error",
    effect:
      "What a browser shows for an answer it may not read, such as an expired R2 URL. The client waits a random time of up to 0.5 s after a first attempt, renews that URL once through /sign and sends it again (decisions M3-S10, M3-S11).",
  },
  {
    fault: "endpoint503",
    label: "Answer the next /upload or /sign with 503",
    effect:
      "A proxy's error page instead of the server. For /upload the client waits a random time of up to 0.5 s, then up to 1, 2, 4 and 8 s, at most 6 attempts. A /sign shares its part's 6 attempts and comes at the part's second attempt or later, so its first wait is up to 1 s or more and fewer attempts are left (M3-S9, M3-S16).",
  },
  {
    fault: "dropComplete",
    label: "Drop the answer of the next /complete",
    effect:
      "The server finishes the request; the page gets a network error. The client sends /complete again, and from then on a cancel or a failure keeps the file and sends no /abort: the dropped one may have completed it (M3-S14, M3-H16).",
  },
  {
    fault: "part2NetworkError",
    label: "Fail every PUT of part 2 with a network error while ticked",
    effect:
      "A part that never gets through: the client renews its URL once and makes 6 attempts with random waits of up to 0.5, 1, 2, 4 and 8 s between them, then the file fails with NETWORK_ERROR and keeps its ticket and the parts that landed, so Retry, once this is unticked, sends part 2 and /complete only (M3-U30, M3-U31).",
  },
  {
    fault: "bucket400",
    label: "Refuse every bucket PUT with 400 while ticked",
    effect:
      "The lab answers in the bucket's place, sending nothing, as a bucket answers a request it will never accept: the file fails at once with UPLOAD_REJECTED, and Retry asks /upload for a new ticket and a new key, so the file starts again from 0 bytes (M3-U31, M3-U36).",
  },
];

interface Props {
  faults: Faults;
  onChange(faults: Faults): void;
}

export function FaultPanel({ faults, onChange }: Props) {
  return (
    <section className={styles.section}>
      <h2>Faults</h2>
      <p className={styles.muted}>
        The first three boxes hit the next matching request once, then untick themselves; the next two hit every
        matching request until you untick them. Faults can change while an upload runs.
      </p>
      {FAULT_BOXES.map(({ fault, label, effect }) => (
        <div key={fault} className={styles.fault}>
          <label>
            <input
              type="checkbox"
              checked={faults[fault]}
              onChange={(event) => onChange({ ...faults, [fault]: event.target.checked })}
            />{" "}
            {label}
          </label>
          <p className={styles.muted}>{effect}</p>
        </div>
      ))}
      <div className={styles.fault}>
        <label>
          Delay every bucket PUT by{" "}
          <input
            type="number"
            min={0}
            step={100}
            value={faults.delayMs}
            onChange={(event) => onChange({ ...faults, delayMs: Math.max(0, event.target.valueAsNumber || 0) })}
          />{" "}
          ms
        </label>
        <p className={styles.muted}>
          Stays on until set to 0. The client keeps at most 4 parts of a file in flight (M3-S12): with a delay of a
          second or more, a 100 MiB file shows four bars side by side.
        </p>
      </div>
    </section>
  );
}
