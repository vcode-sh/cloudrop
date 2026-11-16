"use client";

import { createCloudropClient } from "cloudrop/client";
import { useRef, useState } from "react";
// A type import: the server module, and the secret it reads, stay out of the browser bundle.
import type { cloudrop } from "../../lib/cloudrop";
import { FaultPanel, type Faults, NO_FAULTS } from "./fault-panel";
import { FileSource } from "./file-source";
import styles from "./lab.module.css";
import { createLabFetch, type FaultSwitch, type RequestRecord } from "./lab-fetch";
import { RequestTable } from "./request-table";
import { annotate, type Run } from "./run-report";
import { RunSummary } from "./run-summary";
import { SetupStrip } from "./setup-strip";

export default function LabPage() {
  const [file, setFile] = useState<File | null>(null);
  const [records, setRecords] = useState<readonly RequestRecord[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [faults, setFaults] = useState<Faults>(NO_FAULTS);
  // The fetch reads the faults while an upload runs, between renders: the ref always holds the latest.
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

  async function upload(chosen: File) {
    const log: RequestRecord[] = [];
    // A client per run, so each run's log starts empty; creating one costs nothing.
    const client = createCloudropClient<typeof cloudrop>({
      fetch: createLabFetch(log, faultSwitch, () => setRecords([...log])),
    });
    const controller = new AbortController();
    cancel.current = controller;
    const startMs = performance.now();
    setRecords([]);
    setRun({ fileSize: chosen.size, startMs, endMs: null, result: null });
    const result = await client.upload("files", chosen, { signal: controller.signal });
    setRun({ fileSize: chosen.size, startMs, endMs: performance.now(), result });
  }

  return (
    <main className={styles.lab}>
      <h1>cloudrop lab</h1>
      <p>
        Every request the client sends for one upload, timed in this browser, with faults you can inject. The numbers
        come from one browser on one network: they are not a benchmark. <a href="/">Back to the quickstart page</a>.
      </p>
      <SetupStrip />
      <FileSource file={file} disabled={running} onChoose={setFile} />
      <FaultPanel faults={faults} onChange={updateFaults} />
      <section className={styles.section}>
        <h2>Run</h2>
        <div className={styles.row}>
          <button type="button" disabled={!file || running} onClick={() => file && upload(file)}>
            Upload
          </button>
          <button type="button" disabled={!running} onClick={() => cancel.current?.abort()}>
            Cancel
          </button>
        </div>
        <RequestTable rows={rows} />
      </section>
      {run && <RunSummary rows={rows} run={run} />}
    </main>
  );
}
