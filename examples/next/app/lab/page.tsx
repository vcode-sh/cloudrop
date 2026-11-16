"use client";

import { type ClientOptions, createCloudropClient, type RouteResult, type UploadJob } from "cloudrop/client";
import { useRef, useState } from "react";
// A type import: the server module, and the secret it reads, stay out of the browser bundle.
import type { cloudrop } from "../../lib/cloudrop";
import { FaultPanel, type Faults, NO_FAULTS } from "./fault-panel";
import { FileRows, type Retry } from "./file-rows";
import { FileSource } from "./file-source";
import styles from "./lab.module.css";
import {
  createJournal,
  createLabFetch,
  type FaultSwitch,
  installLabFetch,
  type Journal,
  type RequestRecord,
} from "./lab-fetch";
import { installLabXhr } from "./lab-xhr";
import { RequestTable } from "./request-table";
import { annotate, type JobResult, type Run, withOutcome } from "./run-report";
import { RunSummary } from "./run-summary";
import { SetupStrip } from "./setup-strip";

type FileResult = RouteResult<typeof cloudrop, "files">;
type Concurrency = NonNullable<ClientOptions["concurrency"]>;
type Order = NonNullable<ClientOptions["order"]>;

/** The choices for the client's concurrency: how many bucket PUTs it sends at once, across all its files. */
const CONCURRENCY_CHOICES: readonly Concurrency[] = ["auto", 1, 2, 4, 8, 16];
const ORDER_CHOICES: readonly Order[] = ["added", "smallest-first"];

export default function LabPage() {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [putsWithFetch, setPutsWithFetch] = useState(false);
  const [concurrency, setConcurrency] = useState<Concurrency>("auto");
  const [order, setOrder] = useState<Order>("added");
  const [records, setRecords] = useState<readonly RequestRecord[]>([]);
  const [job, setJob] = useState<UploadJob<FileResult> | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [faults, setFaults] = useState<Faults>(NO_FAULTS);
  // The wrappers read the faults while an upload runs, between renders: the ref always holds the latest.
  const faultsNow = useRef<Faults>(NO_FAULTS);
  const cancel = useRef<AbortController | null>(null);
  // The job's log, kept for its retries; `wrap` is false when the client sends through the lab's fetch option.
  const recorder = useRef<{ journal: Journal; wrap: boolean } | null>(null);
  const running = run !== null && run.endMs === null;
  const rows = annotate(records);
  // Started by the lab's XMLHttpRequest or fetch and not ended yet, the lab's injected delay included.
  const putsInFlight = records.filter((record) => record.isBucketPut && record.status === null).length;

  function updateFaults(next: Faults) {
    faultsNow.current = next;
    setFaults(next);
  }

  const faultSwitch: FaultSwitch = {
    delayMs: () => faultsNow.current.delayMs,
    take(fault) {
      if (!faultsNow.current[fault]) return false;
      updateFaults({ ...faultsNow.current, [fault]: false });
      return true;
    },
    on: (fault) => faultsNow.current[fault],
  };

  /** Shows `run` as going, records the requests of `work` in the job's log, then shows the result it settles with. */
  async function record(run: Run, work: () => Promise<JobResult>) {
    if (!recorder.current) return;
    const { journal, wrap } = recorder.current;
    // By default the lab wraps the browser's fetch and XMLHttpRequest while the job runs, and the client sends bucket
    // PUTs through XMLHttpRequest, which reports bytes as they leave. With a fetch option the client sends everything
    // through it, and a PUT's bytes count only once the bucket answers (spec §4.1).
    const uninstall = wrap ? [installLabFetch(journal, faultSwitch), installLabXhr(journal, faultSwitch)] : [];
    setRun(run);
    try {
      const result = await work();
      setRun({ ...run, endMs: performance.now(), result });
    } finally {
      for (const remove of uninstall) remove();
    }
  }

  function upload(chosen: readonly File[]) {
    const log: RequestRecord[] = [];
    const journal = createJournal(log, () => setRecords([...log]));
    recorder.current = { journal, wrap: !putsWithFetch };
    const fetch = putsWithFetch ? createLabFetch(journal, faultSwitch, window.fetch.bind(window)) : undefined;
    // A client per run, so each run's file ids and log start afresh; creating one costs nothing.
    const client = createCloudropClient<typeof cloudrop>({ concurrency, order, fetch });
    const controller = new AbortController();
    cancel.current = controller;
    const size = chosen.reduce((sum, file) => sum + file.size, 0);
    setRecords([]);
    const run = { files: chosen.length, size, startMs: performance.now(), endMs: null, result: null, retried: false };
    return record(run, () => {
      const started = client.start("files", chosen, { signal: controller.signal });
      setJob(started);
      return started.done;
    });
  }

  // Retry adds its requests to the job's log and its outcome to the run; it waits for a run or retry to end.
  const last = running ? null : run;
  const result = last?.result;
  const retry: Retry<FileResult> | null =
    job && last && result
      ? {
          job: () => record({ ...last, endMs: null, retried: true }, () => job.retry()),
          file: (handle) =>
            record({ ...last, endMs: null, retried: true }, async () =>
              withOutcome(result, await handle.retry(), job.files),
            ),
        }
      : null;

  return (
    <main className={styles.lab}>
      <h1>cloudrop lab</h1>
      <p>
        Every request the client sends for one job, timed in this browser, with faults you can inject. The numbers come
        from one browser on one network: they are not a benchmark. <a href="/">Back to the quickstart page</a>.
      </p>
      <SetupStrip />
      <FileSource
        files={files}
        disabled={running}
        onAdd={(added) => setFiles([...files, ...added])}
        onClear={() => setFiles([])}
      />
      <FaultPanel faults={faults} onChange={updateFaults} />
      <section className={styles.section}>
        <h2>Run</h2>
        <p>
          <label>
            <input
              type="checkbox"
              checked={putsWithFetch}
              disabled={running}
              onChange={(event) => setPutsWithFetch(event.target.checked)}
            />{" "}
            Send PUTs with fetch (no progress while sending)
          </label>
        </p>
        <p className={styles.muted}>
          Off, the client sends bucket PUTs with XMLHttpRequest, whose upload events move the bars while bytes leave.
          On, the lab passes its fetch to createCloudropClient, the client sends everything through it, and a PUT&apos;s
          bytes count only once the bucket answers, so a bar moves a part at a time.
        </p>
        <div className={styles.row}>
          <label htmlFor="connections">Connections</label>
          <select
            id="connections"
            value={concurrency}
            disabled={running}
            onChange={(event) => setConcurrency(event.target.value === "auto" ? "auto" : Number(event.target.value))}
          >
            {CONCURRENCY_CHOICES.map((choice) => (
              <option key={choice}>{choice}</option>
            ))}
          </select>
          <label htmlFor="order">Order</label>
          <select
            id="order"
            value={order}
            disabled={running}
            onChange={(event) => setOrder(event.target.value === "added" ? "added" : "smallest-first")}
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
        <div className={styles.row}>
          <button type="button" disabled={files.length === 0 || running} onClick={() => upload(files)}>
            Upload
          </button>
          <button type="button" disabled={!running} onClick={() => job?.pause()}>
            Pause
          </button>
          <button type="button" disabled={!running} onClick={() => job?.resume()}>
            Resume
          </button>
          <button type="button" disabled={!running} onClick={() => cancel.current?.abort()}>
            Cancel
          </button>
        </div>
        {job && (
          <>
            <dl className={styles.summary}>
              <dt>PUTs in flight</dt>
              <dd>{putsInFlight}</dd>
            </dl>
            <FileRows job={job} retry={retry} />
          </>
        )}
        <RequestTable rows={rows} />
        <p className={styles.muted}>
          The lab records requests only while a run or a retry is going: a request the client sends after that, such as
          an /abort it has to send again, is not in the table.
        </p>
      </section>
      {run && <RunSummary rows={rows} run={run} />}
    </main>
  );
}
