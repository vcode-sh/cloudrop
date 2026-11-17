"use client";

import {
  type CloudropClient,
  createCloudropClient,
  type ResumableUpload,
  type RouteResult,
  type UploadJob,
} from "cloudrop/client";
import { useRef, useState } from "react";
// A type import: the server module, and the secret it reads, stay out of the browser bundle.
import type { cloudrop } from "../../lib/cloudrop";
import { FaultPanel, type Faults, NO_FAULTS } from "./fault-panel";
import { FileRows, type Retry } from "./file-rows";
import { FileSource } from "./file-source";
import { createJournal, type Journal, type RequestRecord } from "./journal";
import styles from "./lab.module.css";
import { createLabFetch, type FaultSwitch, installLabFetch } from "./lab-fetch";
import { installLabXhr } from "./lab-xhr";
import { RequestTable } from "./request-table";
import { annotate, type JobResult, type Run, withOutcome } from "./run-report";
import { DEFAULT_SETTINGS, RunSettings, type Settings } from "./run-settings";
import { RunSummary } from "./run-summary";
import { SetupStrip } from "./setup-strip";
import { UnfinishedUploads, useUnfinished } from "./unfinished-uploads";

type FileResult = RouteResult<typeof cloudrop, "files">;
type LabClient = CloudropClient<typeof cloudrop>;

export default function LabPage() {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [records, setRecords] = useState<readonly RequestRecord[]>([]);
  const [job, setJob] = useState<UploadJob<FileResult> | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [faults, setFaults] = useState<Faults>(NO_FAULTS);
  const { unfinished, refresh: refreshUnfinished, forget } = useUnfinished();
  // The wrappers read the faults while an upload runs, between renders: the ref always holds the latest.
  const faultsNow = useRef<Faults>(NO_FAULTS);
  const cancel = useRef<AbortController | null>(null);
  // The job's log and client, kept for its retries; `wrap` is false when the client sends through the lab's fetch
  // option.
  const recorder = useRef<{ journal: Journal; wrap: boolean; client: LabClient } | null>(null);
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
    const { journal, wrap, client } = recorder.current;
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
      // A run saves a record when a multipart file gets its ticket and deletes it when the file ends.
      await refreshUnfinished(client);
    }
  }

  /** Starts the job `begin` makes with a client of this run's settings, as a run of `files` of `size` bytes. */
  function startRun(
    files: number,
    size: number,
    begin: (client: LabClient, signal: AbortSignal) => UploadJob<FileResult>,
  ) {
    const log: RequestRecord[] = [];
    const journal = createJournal(log, () => setRecords([...log]));
    const { putsWithFetch, concurrency, order } = settings;
    const fetch = putsWithFetch ? createLabFetch(journal, faultSwitch, window.fetch.bind(window)) : undefined;
    // A client per run, so each run's file ids and log start afresh; creating one costs nothing.
    const client = createCloudropClient<typeof cloudrop>({ concurrency, order, fetch });
    recorder.current = { journal, wrap: !putsWithFetch, client };
    const controller = new AbortController();
    cancel.current = controller;
    setRecords([]);
    const run = { files, size, startMs: performance.now(), endMs: null, result: null, retried: false };
    return record(run, () => {
      const started = begin(client, controller.signal);
      setJob(started);
      return started.done;
    });
  }

  function upload(chosen: readonly File[]) {
    const size = chosen.reduce((sum, file) => sum + file.size, 0);
    return startRun(chosen.length, size, (client, signal) => client.start("files", chosen, { signal }));
  }

  const resume = (upload: ResumableUpload<"files">, file: File) =>
    startRun(1, file.size, (client, signal) => client.resume(upload, file, { signal }));

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
      <UnfinishedUploads unfinished={unfinished} disabled={running} onResume={resume} onForget={forget} />
      <FaultPanel faults={faults} onChange={updateFaults} />
      <section className={styles.section}>
        <h2>Run</h2>
        <RunSettings settings={settings} disabled={running} onChange={setSettings} />
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
