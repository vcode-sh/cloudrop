import type { ClientOptions } from "cloudrop/client";
import styles from "./lab.module.css";

type Concurrency = NonNullable<ClientOptions["concurrency"]>;
type Order = NonNullable<ClientOptions["order"]>;

/** How each run sends: through the lab's fetch or XMLHttpRequest, and the client's concurrency and order. */
export interface Settings {
  putsWithFetch: boolean;
  concurrency: Concurrency;
  order: Order;
}

export const DEFAULT_SETTINGS: Settings = { putsWithFetch: false, concurrency: "auto", order: "added" };

/** The choices for the client's concurrency: how many bucket PUTs it sends at once, across all its files. */
const CONCURRENCY_CHOICES: readonly Concurrency[] = ["auto", 1, 2, 4, 8, 16];
const ORDER_CHOICES: readonly Order[] = ["added", "smallest-first"];

interface Props {
  settings: Settings;
  disabled: boolean;
  onChange(settings: Settings): void;
}

export function RunSettings({ settings, disabled, onChange }: Props) {
  return (
    <>
      <p>
        <label>
          <input
            type="checkbox"
            checked={settings.putsWithFetch}
            disabled={disabled}
            onChange={(event) => onChange({ ...settings, putsWithFetch: event.target.checked })}
          />{" "}
          Send PUTs with fetch (no progress while sending)
        </label>
      </p>
      <p className={styles.muted}>
        Off, the client sends bucket PUTs with XMLHttpRequest, whose upload events move the bars while bytes leave. On,
        the lab passes its fetch to createCloudropClient, the client sends everything through it, and a PUT&apos;s bytes
        count only once the bucket answers, so a bar moves a part at a time.
      </p>
      <div className={styles.row}>
        <label htmlFor="connections">Connections</label>
        <select
          id="connections"
          value={settings.concurrency}
          disabled={disabled}
          onChange={(event) => {
            const { value } = event.target;
            onChange({ ...settings, concurrency: value === "auto" ? "auto" : Number(value) });
          }}
        >
          {CONCURRENCY_CHOICES.map((choice) => (
            <option key={choice}>{choice}</option>
          ))}
        </select>
        <label htmlFor="order">Order</label>
        <select
          id="order"
          value={settings.order}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...settings, order: event.target.value === "added" ? "added" : "smallest-first" })
          }
        >
          {ORDER_CHOICES.map((choice) => (
            <option key={choice}>{choice}</option>
          ))}
        </select>
      </div>
      <p className={styles.muted}>
        Connections is the most bucket PUTs the client sends at once across its files, never more than 4 parts of one
        file. Auto, the default, starts at 4, adds one every 2 s while the bytes sent per second rise by 10 % or more
        and PUTs wait, up to 8, and halves after a network error, a stalled PUT or a busy bucket. Order chooses which
        waiting PUT goes next: the files in the order they were added, or the smallest file first.
      </p>
    </>
  );
}
