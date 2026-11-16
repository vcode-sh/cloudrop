# Progress and scheduler: design

Status: approved in conversation 2026-11-16, awaiting the owner's review of this text. Parent spec:
[`2026-11-15-cloudrop-design.md`](2026-11-15-cloudrop-design.md) §6.1, §6.2 and §6.4 (§6.3, resume after reload, is
out of scope). Builds on `cloudrop/client` as merged at `d3f36a7` (`packages/cloudrop/src/client/`). Decisions taken
while executing this design go to a new series `M3-U` in `docs/decisions/`.

## 1. Goal

A browser user sees each file's progress, speed and time left, can pause, resume, cancel and retry, and many files
share the connections well. Concretely:

- bytes reported while they are sent (XHR `upload.onprogress`), never moving backwards;
- several files per call, with a result per file;
- one connection pool per client, sized automatically, small files first if asked;
- stalled requests and lost connectivity handled without the caller's help;
- a failed file can be retried in the same page without re-sending what already landed.

Two implementation plans execute it, one after the other: **plan A** (transport, progress, store, pool, several files,
pause/resume/abort) and **plan B** (auto concurrency, smallest-first, stalls, offline, `retry()`, part size). After plan
A a progress bar works end to end.

Out of scope: persistence and resume after a reload (§6.3, the resume plan), the chaos proxy (§11.3), React bindings
(M4), `warnOnUnload` (M4, where the UI lives).

## 2. Public API

Everything below is exported from `cloudrop/client`. Existing calls keep working.

```ts
const client = createCloudropClient<typeof cloudrop>({
  basePath: "/api/cloudrop",       // as today
  fetch,                           // as today; see §4.1 for what it changes
  concurrency: "auto",             // number 1..16, or "auto" (default "auto" after plan B; 4 in plan A)
  order: "added",                  // or "smallest-first" (plan B)
});

const job = client.start("files", files, { metadata, signal }); // File | File[]; one /upload for all of them
const unsubscribe = job.subscribe(() => render(job.getSnapshot()));
job.pause(); job.resume(); job.abort(); job.retry();            // every file of the job
job.files[0].pause(); job.files[0].resume(); job.files[0].abort(); job.files[0].retry();
const { data, error } = await job.done;

await client.upload("files", file);   // unchanged: start(...).done reduced to one file's Result
await client.upload("files", files);  // several files: the job's UploadResult
```

### 2.1 Snapshot

`getSnapshot()` returns the same object until something changes, then a new immutable one (what
`useSyncExternalStore` needs). Listeners are called at most every 100 ms while bytes flow, and at once on every status
change.

```ts
type FileStatus = "queued" | "uploading" | "paused" | "completing" | "done" | "failed" | "aborted";

interface FileSnapshot<R> {
  id: string;            // client-local, stable for the job's life
  name: string; size: number; type: string;
  status: FileStatus;
  bytes: number;         // confirmed bytes, never decreasing (§4.2)
  progress: number;      // bytes / size; 1 when done
  speed: number;         // bytes per second, EWMA (§4.3); 0 when not sending
  eta: number | null;    // seconds; null when speed is 0 or the file is settled
  error: CloudropError | null;
  result: CompleteResponse<R> | null;
}

interface JobSnapshot<R> {
  files: readonly FileSnapshot<R>[];
  totals: { bytes: number; size: number; progress: number; speed: number; eta: number | null;
            done: number; failed: number; aborted: number; count: number };
}
```

### 2.2 Results

Owner decision 2026-11-16: a per-file list, and the first error.

```ts
type FileOutcome<R> =
  | { id: string; name: string; status: "done"; result: CompleteResponse<R> }
  | { id: string; name: string; status: "failed" | "aborted"; error: CloudropError };

type UploadResult<R> =
  | { data: { files: FileOutcome<R>[] }; error: null }                 // every file done
  | { data: { files: FileOutcome<R>[] }; error: CloudropError }        // some failed: the first, with error.file
  | { data: null; error: CloudropError };                              // nothing started (/upload refused the job)
```

`UploadResult` departs from `Result<T>` (where `data` is null whenever `error` is set) on purpose: a partial failure
must not hide the files that succeeded. It still has the `{ data, error }` shape, so `if (error)` works. This needs a
decision entry and a line in spec §1.

`CloudropError` gains an optional `file?: { id: string; name: string }`, set on errors that belong to one file.

`job.done` settles once, when every file of the first run has settled. `job.retry()` and `file.retry()` return a new
promise for the next settlement (the job's `UploadResult`, or the file's `FileOutcome`).

## 3. Architecture

Approach chosen: keep the proven per-file logic and add a shared pool around it. `client/upload.ts` and
`client/parts.ts` keep renewal, `PARTS_MISSING` repair, the retry budget and keep-or-abort (`M3-S9` to `M3-S15`,
`M3-S28` to `M3-S34`); they change only where they acquire a connection and report bytes.

| Module (new unless noted) | One purpose |
|---|---|
| `client/transport.ts` | Sends one presigned PUT: XHR with progress events, or `fetch` with one at the end (§4.1) |
| `client/progress.ts` | Per-file byte accounting that never goes backwards, and the EWMA speed and ETA |
| `client/store.ts` | Holds the snapshot, applies changes, notifies listeners with the 100 ms throttle |
| `client/pool.ts` | Connection slots shared by the client: queue order, per-file cap, the size (fixed or auto) |
| `client/job.ts` | `start()`: one `/upload` for the job, runs each file, collects outcomes, pause/resume/abort/retry |
| `client/lifecycle.ts` | `offline`/`online` and `pagehide` listeners, registered while a job runs (plan B) |
| `upload.ts`, `parts.ts`, `bucket.ts` (changed) | Take a pool slot per PUT; report bytes to `progress.ts`; stop on pause |

Each stays near 200 lines (cap 250). The client still imports only `errors.ts`, `input.ts`, `plan.ts` and
`protocol/types.ts` from outside `client/` (Biome rule unchanged).

Data flow: `start()` → one `/upload` (all files, shared metadata) → per file: queue its PUTs in the pool → each PUT
runs through `transport.ts` → progress events go to `progress.ts` → `store.ts` publishes → on the last part, `/complete`
(no slot) → the file's outcome → when all settle, `done` resolves.

## 4. Behaviour

### 4.1 Transport

- In a browser (`globalThis.XMLHttpRequest` exists) and with no `fetch` option, bucket PUTs use XHR and report
  `upload.onprogress`. Calls to the upload server keep using `fetch`.
- With a `fetch` option, or without XHR (Node, Bun, Deno, Workers), bucket PUTs use that `fetch` and report a part's
  bytes when its answer arrives. Passing `fetch` means "send everything through mine".
- The answer is classified exactly as today (`classifyAnswer`, `M3-S10`): an XHR network error or a CORS-blocked answer
  is the same opaque outcome a `fetch` `TypeError` is.
- Tests replace `globalThis.XMLHttpRequest` with a fake that sends to the fake R2 and fires progress events on demand
  (in `src/testing/`, never shipped). No public transport option.

### 4.2 Bytes that never go backwards

Each part (or the single PUT) has a `sent` count from its current attempt and a `best` count, the most it ever
reached. A file's `bytes` is the sum of `best` over its parts, capped at the part's size; a part that lands counts its
full size. A re-sent part therefore adds nothing until it passes its earlier best. A single PUT restarted after a pause
holds its earlier `best` the same way. `bytes` is never above `size`, and is `size` once the file is done.

### 4.3 Speed and ETA

Speed is an exponentially weighted moving average of bytes per second with a time constant of 3 s, updated on each
progress event (`α = 1 − e^(−Δt/3 s)`), decaying towards 0 when no bytes arrive. ETA = (size − bytes) / speed, `null`
when speed is 0. Totals use the sum of the files' speeds. A paused or settled file reports speed 0.

### 4.4 Pool

- One pool per client, shared by every job. A slot is held by one bucket PUT (single or part); calls to the upload
  server take no slot.
- A file has at most 4 PUTs in flight (`PARTS_IN_FLIGHT`, unchanged), so a small file never waits behind a large one.
- Queue order: the order files were added, then part number. `order: "smallest-first"` (plan B) orders by file size,
  then part number.
- `concurrency` is a fixed number (1 to 16) or `"auto"` (plan B): start at 4; every 2 s compare the bytes sent in the
  window with the previous window; when it rose by at least 10 % and work is waiting, add one slot, up to 8; on a
  `429`/`SlowDown`, a stall or a network error, halve (at least 1) and hold for one window. Measured on R2 on
  2026-11-16: 4 connections 60 MiB/s, 16 connections 71 MiB/s.
- One `/upload` per job. The route's `maxFiles` is policy: a job with more files gets `TOO_MANY_FILES` for the whole
  job (`data: null`), never a silent split.

### 4.5 Pause, resume, abort

- `pause()` aborts the file's PUTs in flight and keeps its token and the parts that landed. Bytes stay as counted.
  A `/complete` in flight is not interrupted (it runs without a signal, `M3-S14`); if it succeeds the file is done.
- `resume()` re-queues the parts that have not landed; a single PUT starts again. The token lives 24 hours; a file
  resumed after that fails with `UPLOAD_EXPIRED`.
- `abort()` is today's cancel: the file ends `aborted`, and `/abort` is sent unless a `/complete` may have succeeded
  (keep-or-abort, `M3-S14`, `M3-H16`). The job's `signal` aborts every file.
- Job-level calls apply to every file that can take them; a settled file ignores pause and resume.

### 4.6 Failures, stalls, offline (plan B for stalls and offline)

- The failure classifier and the retry budget do not change (`M3-S9` to `M3-S11`). A file fails when one of its parts
  exhausts its attempts; its other PUTs stop at once (as since commit `7bf1d89`). Other files of the job are not
  affected.
- Stall: an XHR with no progress event for 30 s is aborted and counted as one attempt with the network-error outcome.
  Without XHR there are no progress events, so a PUT gets a timeout of 30 s plus its size at 100 KiB/s instead.
- `offline` pauses every file that is uploading and marks it paused by the network; `online` resumes only those.
  A file the caller paused stays paused.

### 4.7 retry() and what happens to a failed file (amends `M3-S15`)

Owner decision 2026-11-16: a failed file keeps what it sent so `retry()` can reuse it.

- A file that fails no longer sends `/abort` at once (the background `/abort` of `M3-S15`). Its parts and token are
  kept until the first of: `abort()` on the file or job (then keep-or-abort applies), `pagehide` (`/abort` with
  `keepalive`, only when no `/complete` may have succeeded), or the token's expiry, after which the bucket's lifecycle
  rule removes unfinished multipart uploads. A single-PUT object left by a failed file whose page closed without
  `pagehide` firing stays in the bucket; the decision entry states that cost.
- `retry()` on a failed file:
  1. if a `/complete` may have succeeded, it calls `/complete` again first (idempotent); a success ends the file done;
  2. else, with a valid token, it re-sends the parts that have not landed and completes (`PARTS_MISSING` repair covers
     the rest); a single PUT is sent again;
  3. else (token expired, `UPLOAD_REJECTED`, or a refusal that a new attempt cannot fix with the same token), it asks
     `/upload` for a new ticket (new key) and starts over.
- `retry()` on a done or aborted file does nothing; on a queued, uploading or paused file it does nothing.

## 5. Part size (plan B, task 1, a measurement before any change)

Measured 2026-11-16: one 8 MiB PUT reaches about 17 MiB/s, one 64 MiB PUT about 37 MiB/s (TCP ramp-up over a ~130 ms
round trip). Plan B measures on live R2, from Node and from a browser through `/lab`: part sizes 8, 16 and 32 MiB ×
concurrency 4, 6 and 8, on 256 MiB files, three runs each. Only if larger parts win clearly does the server's planner
(`src/plan.ts`) change, for example a larger first part size for large files, with a decision entry and the storage
lanes (`test:rustfs`, `test:wrangler`, `test:live`). The multipart threshold stays 64 MiB. Otherwise the measurement is
recorded and nothing changes.

## 6. Testing

- Unit lane: the fake XHR over the fake R2 with fake timers. Rows prove: bytes never decrease across a re-sent part
  and a restarted single PUT; EWMA and ETA against hand-worked numbers; the 100 ms throttle and immediate status
  notifications; the per-file cap and the pool limit under several files; queue order; pause keeps landed parts and
  resume sends only the rest; abort's keep-or-abort; one failing file leaves the others done; `UploadResult` for all
  done, some failed and `/upload` refused; auto concurrency's add, halve and hold (plan B); stall abort and the fetch
  timeout (plan B); offline and online (plan B); each `retry()` branch (plan B).
- Browser lane (RustFS, and R2 through `test:browser:live`): progress events from real XHR rise and end at the file
  size; pause and resume of a multipart file; three files in one job; a failed file retried (plan B).
- `/lab` shows the snapshot: a progress bar per file, speed, ETA, the pool size, pause, resume and retry buttons. It
  instruments XHR by wrapping `window.XMLHttpRequest` in the demo page (no library option), and keeps its fetch wrapper
  for the upload-server calls.

## 7. Size, decisions, docs

- Bundle: the `cloudrop/client` budget is set from the measured size after plan A and again after plan B, at most
  about 7.5 kB gzip (owner decision 2026-11-16); spec §1's "client plus React under about 8 kB" becomes about 10 kB.
- Decision entries in `docs/decisions/m3-uploader.md`, series `M3-U` (registered in the README and in `AGENTS.md`):
  `UploadResult` and `error.file`; the snapshot contract; fetch versus XHR; the pool and its defaults; the failed-file
  rule amending `M3-S15`; the budget; the part-size outcome.
- README: the job API, the snapshot, pause/resume/retry, and what changes when `fetch` is passed.

## 8. Plans

Plan A (about 7 tasks): transport and the fake XHR; progress accounting, EWMA and the store; the pool with a fixed
size; `start()` with several files, `UploadResult` and the `upload()` overloads; pause, resume and abort per file and
job; `/lab`, example and browser rows; budget, docs and decisions.

Plan B (about 7 tasks): the part-size measurement and its decision; auto concurrency; smallest-first; stall detection
and the fetch timeout; offline and online; `retry()` with the failed-file rule; the planner change if the measurement
called for it, then docs.

## 9. Not settled here

- Whether `job.files[i]` handles are also available by id (`job.file(id)`); decided in plan A by what the example
  needs.
- The exact pool numbers (2 s window, 10 % rise, cap 8) are starting points; plan B may tune them on the R2
  measurement, with a decision entry.
