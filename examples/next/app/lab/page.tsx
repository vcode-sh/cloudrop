"use client";

import { createCloudropClient, type RouteResult, type UploadJob } from "cloudrop/client";
import { useRef, useState } from "react";
// A type import: the server module, and the secret it reads, stay out of the browser bundle.
import type { cloudrop } from "../../lib/cloudrop";
import { FaultPanel, type Faults, NO_FAULTS } from "./fault-panel";
import { FileRows } from "./file-rows";
import { FileSource } from "./file-source";
import styles from "./lab.module.css";
import { createJournal, createLabFetch, type FaultSwitch, installLabFetch, type RequestRecord } from "./lab-fetch";
import { installLabXhr } from "./lab-xhr";
import { RequestTable } from "./request-table";
import { annotate, type Run } from "./run-report";
import { RunSummary } from "./run-summary";
import { SetupStrip } from "./setup-strip";

/** The client's concurrency: how many bucket PUTs it sends at once, across all its files. The default. */
const CONNECTIONS = 4;

export default function LabPage() {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [putsWithFetch, setPutsWithFetch] = useState(false);
  const [records, setRecords] = useState<readonly RequestRecord[]>([]);
  const [job, setJob] = useState<UploadJob<RouteResult<typeof cloudrop, "files">> | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [faults, setFaults] = useState<Faults>(NO_FAULTS);
  // The wrappers read the faults while an upload runs, between renders: the ref always holds the latest.
  const faultsNow = useRef<Faults>(NO_FAULTS);
  const cancel = useRef<AbortController | null>(null);
  const running = run !== null && run.endMs === null;
  const rows = annotate(records);

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
  };

  async function upload(chosen: readonly File[]) {
    const log: RequestRecord[] = [];
    const journal = createJournal(log, () => setRecords([...log]));
    // By default the lab wraps the browser's fetch and XMLHttpRequest for the length of the run, and the client sends
    // bucket PUTs through XMLHttpRequest, which reports bytes as they leave. With a fetch option the client sends
    // everything through it, and a PUT's bytes count only once the bucket answers (spec §4.1).
    const uninstall = putsWithFetch ? [] : [installLabFetch(journal, faultSwitch), installLabXhr(journal, faultSwitch)];
    const fetch = putsWithFetch ? createLabFetch(journal, faultSwitch, window.fetch.bind(window)) : undefined;
    // A client per run, so each run's file ids and log start afresh; creating one costs nothing.
    const client = createCloudropClient<typeof cloudrop>({ concurrency: CONNECTIONS, fetch });
    const controller = new AbortController();
    cancel.current = controller;
    const size = chosen.reduce((sum, file) => sum + file.size, 0);
    const startMs = performance.now();
    setRecords([]);
    setRun({ files: chosen.length, size, startMs, endMs: null, result: null });
    try {
      const started = client.start("files", chosen, { signal: controller.signal });
      setJob(started);
      const result = await started.done;
      setRun({ files: chosen.length, size, startMs, endMs: performance.now(), result });
    } finally {
      for (const remove of uninstall) remove();
    }
  }

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
        {job && <FileRows job={job} connections={CONNECTIONS} />}
        <RequestTable rows={rows} />
        <p className={styles.muted}>
          The lab records requests only while a run is going. A failed file tells the server with /abort in the
          background; if that request has to be sent again after the run ended, the retry is not in the table.
        </p>
      </section>
      {run && <RunSummary rows={rows} run={run} />}
    </main>
  );
}
