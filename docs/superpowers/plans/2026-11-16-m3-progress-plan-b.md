# M3 progress and pool, plan B: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cloudrop/client` sizes its connection pool by itself, can send small files first, recovers from stalled
requests and lost connectivity without the caller's help, and can retry a failed file in the same page without
re-sending what already landed; the part size is measured on live R2 and changed only if larger parts clearly win.

**Architecture:** Plan A's modules stay. `pool.ts` gains an automatic size (hill climbing on bytes per 2 s window) and
the per-request reporting it reads; `transport.ts` gains a stall watchdog; a new `lifecycle.ts` listens to
`offline`/`online` and `pagehide`; `file-run.ts` and `job.ts` gain `retry()` and keep a failed file's ticket and parts.
`parts.ts`, the retry budget and the failure classifier do not change.

**Tech Stack:** TypeScript 7, web-platform APIs only, Vitest 5 with fake timers, the fake R2 and the fake XHR
(`src/testing/fake-xhr.ts`), Playwright, Next.js, live R2 for the measurement.

**Spec:** [`docs/superpowers/specs/2026-11-16-progress-scheduler-design.md`](../specs/2026-11-16-progress-scheduler-design.md)
§4.4 (auto, smallest-first), §4.6 (stalls, offline), §4.7 (retry and the failed-file rule), §5 (part size), §6, §7.
Plan A is done (`a5de46a..a003cdb`); its decisions are `M3-U1` to `M3-U22` in `docs/decisions/m3-uploader.md`.

## Global Constraints

- Everything in English. Zero runtime dependencies; web-platform APIs only in `packages/cloudrop/src`; the client
  imports only `errors.ts`, `input.ts`, `plan.ts` and `protocol/types.ts` from outside `client/`.
- Source files aim at 200 to 220 lines; `bun run check` fails a source file over 250 lines, a test file over 400, a
  function over cognitive complexity 15. Split by responsibility when a file would pass 220.
- Tests next to the source; load `testing-patterns` before tests and `code-quality` before committing. Independent
  literal oracles; doubles only for network, clock, randomness; no `vi.mock` of our modules; fake timers restored.
- `isolatedDeclarations: true`: exported functions and constants carry explicit types.
- Public calls return `{ data, error }`; `UploadResult` as in spec §2.2; `done` and every new promise never reject.
  Messages say what happened and what to do next, never a URL, token or storage answer.
- No `AbortSignal.any` (`M3-U19`): combine signals with listeners.
- **Bundle:** `cloudrop/client` is 6.74 kB gzip. Owner decision 2026-11-16: raise the ceiling with headroom for the
  rest of M3 instead of raising it step by step; the plan commit sets the `cloudrop/client` limit to 9.0 kB. Tasks
  never edit `scripts/size-limit.config.ts` (Task 8 sets the final number) and every task reports its measured size.
  Allowance for plan B as a whole: about 1.2 kB.
- **Ports during parallel waves:** only the task that the wave names may use port 5173 (`test:browser`, the lab);
  others run unit gates only. RustFS lanes take their own `CLOUDROP_RUSTFS_PORT`.
- Live R2: `CLOUDROP_R2_ENV_FILE=~/.config/cloudrop/live-r2.env`; never read or print it; write only under
  `live-test/cloudrop-<random>/` and delete it; never change bucket settings or CORS.
- Git: stage exact paths, conventional commits, never push; never `git stash`, `reset`, `clean`, `checkout --`. Never
  write outside the worktree you were given (no `/tmp` scratch; measurement scratch goes to
  `~/projects/.worktrees/cloudrop/scratch/`).
- Gates on Node 24: `PATH=~/.nvm/versions/node/v24.22.2/bin:$PATH`. `bun run verify` for every task.

## Rulings fixed by this plan (Task 8 records each as an `M3-U` entry)

- **Q1. Auto sizing is lazy:** the pool evaluates a window when it is used (`acquire`, a release, `sent`), never on a
  timer, so an idle client holds no timer. A window is at least 2000 ms; it compares bytes per millisecond with the
  previous window, so windows of different lengths compare fairly.
- **Q2. One halving per window:** several failures in the same burst halve once; the next window cannot grow.
- **Q3. What slows the pool:** an outcome `opaque` (network error, CORS-hidden refusal, stall) or a `RATE_LIMITED`
  answer (429 or 503 from the bucket). A `STORAGE_ERROR` (500) does not.
- **Q4. No public pool size.** The lab shows the PUTs in flight from its own XHR wrapper.
- **Q5. A stall is the network-error outcome** (`opaque`, `NETWORK_ERROR`, the existing message): it costs one attempt
  of the budget and renews the URL once, as any opaque outcome does.
- **Q6. Paused by the network** is not a separate status: `paused` in the snapshot. `online` resumes only files that
  `offline` paused; a caller's `pause()` on such a file makes it the caller's.
- **Q7. `upload()` keeps `M3-S15`** (owner-confirmed 2026-11-16; Task 8 amends spec §4.7): it returns no handle, so nobody can retry its failed file; its failure still sends
  the background `/abort`. Only `start()` jobs keep a failed file's ticket and parts (spec §4.7).
- **Q8. `retry()` chooses at the time it is called:** same ticket when the file has one that is not expired, was not
  aborted, and the error is not one a new attempt with that ticket cannot fix; otherwise a new `/upload`. It does not
  fall back from one branch to the other within one call. Exception first (audit I6): when a `/complete` may have
  succeeded, `retry()` always sends `/complete` with the kept ticket, whatever the clock says or `dropped`; success ends
  the file done, any other answer ends it failed with that answer.
- **Q9. Codes that need a new ticket:** `UPLOAD_EXPIRED`, `INVALID_TOKEN`, `UPLOAD_REJECTED`, `VERIFICATION_FAILED`,
  and any failure of a file that never had a ticket (rejected at `/upload`, or a job-level error).
- **Q10. `abort()` on a failed file** sends its `/abort` (keep-or-abort: not when a `/complete` may have succeeded) and
  turns it `aborted`. `done` is already settled; only the snapshot and later `retry()` see it.
- **Q11. `pagehide`** sends a keepalive `/abort` for every failed file that holds a ticket and no `/complete` that may
  have succeeded, and marks that ticket aborted, so a later `retry()` (after a back-forward cache restore) asks for a
  new one. Files still uploading or paused are left to the bucket's lifecycle rule, as today.
- **Q12. `job.retry()` asks for new tickets in one `/upload`** for all its files that need one, so a job refused with
  `TOO_MANY_FILES` is never split silently; `file.retry()` asks for its file alone.

- **Q13. `done` reports each file's first outcome** (audit C1): a file's outcome is recorded when it first settles
  (`entry.firstOutcome`) and a later `retry()` never changes it; `done` is built from those. `job.retry()` resolves
  only when every file of the job has settled (it waits for files still running), with the current outcomes.
- **Q14. A new ticket starts new byte accounting** (audit I10): a retry that asks `/upload` for a new ticket gives the
  file a fresh `Progress` and `Meter`, so its bytes drop to 0: an explicit exception to spec §4.2, because the new
  upload has stored nothing. A same-ticket retry keeps the bytes.
- **Q15. `retry()` on a file that has not settled** sends nothing and resolves with its outcome when it next settles; on
  a done or aborted file, at once with that outcome. `job.retry()` on a job refused for its arguments resolves with the
  same `{ data: null, error }` as `done` (audit I11).
- **Q16. One `abortFile(entry)`** serves the file handle, `job.abort()` and the caller's signal: a running file is
  cancelled as today; a failed file holding a ticket follows Q10 (it turns `aborted`; its `/abort` is skipped only when
  a `/complete` may have succeeded). The caller's signal stays attached while any file of the job runs or is held,
  and is removed when none is (audit I9, M8).
- **Q17. Offline pauses queued and uploading files** (spec §4.6 says uploading; queued files would start and fail
  too). A job that starts while `navigator.onLine === false` pauses its files at once (audit M1, M2).

## File map

| File | Task | Change |
|---|---|---|
| `scripts/` none; scratch in `~/projects/.worktrees/cloudrop/scratch/`; `docs/research/r2-spike-findings.md` | 1 | Part-size measurement and its section |
| `packages/cloudrop/src/client/pool.ts`, `pool.test.ts`, `client.ts`, `client.test.ts`, `upload.ts` | 2 | Auto size, `sent`, `slowDown`; `concurrency: "auto"`, `order` |
| `packages/cloudrop/src/client/transport.ts`, `transport.test.ts` | 3 | Stall watchdog (XHR) and timeout (fetch) |
| `packages/cloudrop/src/client/lifecycle.ts` (new), `file-run.ts`, `job.ts`, `lifecycle.test.ts` | 4 | `offline`/`online` |
| `file-run.ts`, `job.ts`, `types.ts`, `lifecycle.ts`, `upload.ts`, `client.ts`, `job.test.ts`, `retry-file.test.ts` (new) | 5 | `retry()`, the failed-file rule, `pagehide` |
| `packages/cloudrop/src/plan.ts` and its tests | 6 | Only if Task 1 says so |
| `examples/next/app/lab/*`, `examples/next/app/lab.browser.test.ts`, `examples/next/README.md` | 7 | Lab controls and browser rows |
| `scripts/size-limit.config.ts`, `docs/decisions/m3-uploader.md`, `README.md`, specs, plans README | 8 | Size pass, budget, decisions, docs |

## Waves

- **Wave 1, in parallel** (separate worktrees from the plan commit): Task 1 (owns port 5173 and live R2), Task 2,
  Task 3, Task 4. They touch disjoint files except `client.ts` (Task 2 only) and `job.ts`/`file-run.ts` (Task 4 only).
- **Wave 2, in parallel:** Task 5 (on Wave 1 merged) and Task 6 (only if Task 1 recommends a change; server code).
- **Wave 3:** Task 7, then Task 8.

---

### Task 1: Measure the part size on live R2

**Files:** scratch scripts in `~/projects/.worktrees/cloudrop/scratch/` (never committed); modify
`docs/research/r2-spike-findings.md` (a new section "Part size, 2026-11-16").

- [ ] **Step 1: Node.** A script like `scratch/r2-speed.ts` (read it: it loads settings through
  `scripts/live-r2-settings.ts`'s `loadSettings` and uses the `r2` driver): for part sizes 8, 16 and 32 MiB ×
  concurrency 4, 6 and 8, upload a 256 MiB random file as a real multipart upload through the driver
  (`createMultipart`, `presignPart` per part, PUT with `fetch`, `completeMultipart`; read the driver's exported API in
  `packages/cloudrop/src/storage/` for the exact names), three runs each, in an order that interleaves combinations.
  Record wall time and MiB/s per run; delete every object and abort every unfinished upload under its
  `live-test/cloudrop-<random>/` prefix, also on failure (register the cleanup first).
- [ ] **Step 2: Browser.** The same matrix from headless Chromium (Playwright, `examples/next` has it installed): serve
  a blank page on `http://localhost:5173` (the bucket's CORS rule allows that origin; nothing else may listen there),
  have Node presign the parts and the page PUT them with `fetch` at the given concurrency, timing in the page. Never
  print or log a URL. One run per combination is enough if three take over 15 minutes; say so.
- [ ] **Step 3: Write the section:** method, a table (part size × concurrency → median MiB/s, min–max), the round
  trip measured the same day, and a recommendation: change the planner only if a larger first part is at least 15 %
  faster at the default concurrency 4 *and* not slower at 8, in both Node and the browser. State the exact change
  (for example "first part 16 MiB for files over 256 MiB") or "no change". Prove the cleanup (a listing of the prefix
  is empty).
- [ ] **Step 4: Commit** `docs(research): measure part size and parallelism on R2` (the findings file only).

### Task 2: Auto concurrency and smallest-first

**Files:** modify `packages/cloudrop/src/client/pool.ts`, `pool.test.ts`, `packages/cloudrop/src/client.ts`,
`packages/cloudrop/src/client.test.ts`, `packages/cloudrop/src/client/upload.ts`; a client-level row file
`client/pool-auto.test.ts` if `upload.test.ts` would pass 400 lines.

**Interfaces:**
```ts
// client/pool.ts
export interface Pool {
  acquire(rank: readonly number[], signal: AbortSignal): Promise<Release | null>;   // unchanged
  /** Bytes the bucket accepted; auto sizing reads them. */
  sent(bytes: number): void;
  /** A network error, a stall or a 429/503: an auto pool halves (at least 1) and does not grow next window (Q2, Q3). */
  slowDown(): void;
}
export function createPool(size: number | "auto", now?: () => number): Pool;   // now defaults to Date.now
// client.ts
export interface ClientOptions { basePath?; fetch?; concurrency?: number | "auto"; order?: "added" | "smallest-first" }
// client/upload.ts: UploadContext gains `order: "added" | "smallest-first"`
```

- [ ] **Step 1: Failing tests** (`pool.test.ts`, an injected `now`, no timers). Constants: start 4, window 2000 ms,
  rise factor 1.1, auto maximum 8. Rows:
  1. Auto starts with 4 slots: five acquires → four granted.
  2. Growth: with work waiting, window 1 (t 0–2000) `sent(1000)`, window 2 (t 2000–4000) `sent(1100)`, then an
     `acquire` at t = 4000 → the size is 5 (the waiting acquire is granted). `sent(1099)` instead → still 4.
  3. Windows of different lengths compare per millisecond: window 1 is 2000 ms with 1000 bytes; window 2 is 4000 ms
     with 2100 bytes (1.05×) → no growth.
  4. No growth without waiting work, and never above 8.
  5. `slowDown()` at size 8 → 4; a second `slowDown()` in the same window → still 4 (Q2); the next window cannot grow
     even with a 50 % rise; the one after can.
  6. Size 1 halves to 1.
  7. A fixed size ignores `sent` and `slowDown`.
  8. Shrinking below the slots in use grants nothing until enough are released.
- [ ] **Step 2: Implement** (lazy windows, Q1): state `size`, `inUse`, `windowStart`, `windowBytes`, `lastRate` (null
  before the first full window), `hold`. On `acquire`, a release and `sent`, if `now() - windowStart >= 2000`:
  `rate = windowBytes / elapsed`; if auto and not `hold` and waiters exist and `lastRate !== null` and
  `rate >= lastRate * 1.1` and `size < 8`, then `size++`; then `lastRate = rate`, reset the window, `hold = false`,
  and grant waiters while `inUse < size`. `slowDown`: if auto and not `hold`, `size = max(1, floor(size / 2))`,
  `hold = true`, reset the window.
- [ ] **Step 3: Wire.** `client.ts`: `concurrency` default `"auto"`, refused unless `"auto"` or a whole number 1–16
  (`concurrency must be "auto" or a whole number from 1 to 16.`); `order` default `"added"`, refused otherwise
  (`order must be "added" or "smallest-first".`). `upload.ts` put wrapper: rank `[entry.rank, partNumber]` for
  `"added"`, `[entry.file.size, entry.rank, partNumber]` for `"smallest-first"`; after `progress.sent` adds bytes,
  `context.pool.sent(added)`; after the outcome, `context.pool.slowDown()` when it is `opaque` or its error code is
  `RATE_LIMITED` (Q3).
- [ ] **Step 4: Client rows:** smallest-first with `concurrency: 1`: a 3-part file started first, then a 1000-byte
  file → the small file's `PUT object` is sent right after the large file's first part (the fake XHR `sent` list or
  `fixture.requests`); `"added"` sends it after all three parts. A 429 answer to a PUT on an auto client → that file
  still completes and the PUTs in flight never exceed 2 afterwards within the window (count with a holding fault).
  Refusal rows for the two options.
- [ ] **Step 5:** `bun run verify`; report the size. **Commit** `feat(client): size the pool by itself and send small
  files first`.

**Audit amendments (binding; they override the steps above where they differ):**
- Invariant (I1): every `acquire`, release and `sent` first evaluates the window if it is due, then grants waiters in
  rank order while `inUse < size`. An `acquire` waits whenever waiters exist or `inUse >= size` (no overtaking). A
  release decrements `inUse` (the double-call guard stays). `now` defaults to `() => Date.now()`, read per call (M11).
- Evaluation (I3): evaluate before counting the call's bytes; the new window starts at `now()`; compare as
  `rate >= lastRate * 1.1`. Row 2 with times: `sent(1000)` at t = 0, `sent(1101)` at t = 2000 (this call closes window
  1 before counting), `acquire` at t = 4000 → size 5; with `sent(1099)` → 4.
- Idle (I2): grow only when `lastRate > 0` and `rate > 0`. A window that began while the pool was idle (`inUse === 0`
  and no waiters) or that lasted over 4000 ms is discarded (`lastRate = null`, new window). Rows: first use after an
  idle minute does not grow; 0 → 0 does not grow.
- The 429 row (I4): two 3-part files in one job (6 wanted, 4 granted), `Math.random` at 0, fake `Date` frozen; answer
  one PUT with 429 and hold the others; assert no new PUT starts until fewer than 2 are in flight (release the held ones
  one by one), and both files end done.
- Smallest-first row (M10): both files in one `start()` (the large one first), `concurrency: 1`.
- Existing tests (I8): update `client.test.ts`'s `concurrency` refusal row to the new message; rename
  `upload.test.ts`'s "the default of 4" row (the default is `"auto"`, which starts at 4).
- `sent` counts only bytes above a part's earlier best (`progress.sent`), so re-sent bytes are not throughput (M12):
  say so in a comment.
- Report the measured gzip size; do not edit `scripts/size-limit.config.ts`.
### Task 3: Stalls

**Files:** modify `packages/cloudrop/src/client/transport.ts`, `transport.test.ts`.

- [ ] **Step 1: Failing tests** (fake timers with `toFake: ["setTimeout", "clearTimeout", "Date"]`, fake XHR held):
  1. An XHR with no progress for 30 000 ms is aborted and resolves `{ kind: "opaque", error: NETWORK_ERROR,
     retryAfterMs: 0 }`; at 29 999 ms it is still open.
  2. A progress event at 20 000 ms re-arms: still open at 49 999, opaque at 50 000.
  3. The caller's signal still yields `aborted`, and a settled request leaves no timer (`vi.getTimerCount()` 0).
  4. The fetch path: a fault that answers only when its signal fires; a 1 MiB body times out at 30 000 + 10 240 =
     40 240 ms (100 KiB/s = 102.4 bytes per ms) → `opaque`; at 40 239 it is pending. The caller's own abort still
     yields `aborted`.
- [ ] **Step 2: Implement** in `transport.ts`: `STALL_MS = 30_000`, `SLOWEST_BYTES_PER_MS = 102.4`. XHR: arm a timer at
  `send` and on every progress event; on firing, `xhr.abort()` (the `onabort` handler already resolves
  `unreachable(signal)`, which is `opaque` while the caller's signal has not fired); clear it in `settle`. Fetch: a
  controller aborted by a timer of `STALL_MS + body.size / SLOWEST_BYTES_PER_MS` and by the caller's signal (a
  listener, removed after); `putObject` gets the controller's signal; an `aborted` outcome while the caller's signal
  has not fired becomes `unreachable` of the caller's signal (opaque). Comment: Q5 and spec §4.6.
- [ ] **Step 3:** `bun run verify`; report the size. **Commit** `feat(client): give up on a stalled PUT and try again`.

**Audit amendments (binding):**
- Fetch path (M3): if the caller's signal has already fired, abort the controller at once; clear the timer and remove
  the listener in `finally`.
- Comment (M4): an answer slower than 30 s after the body is sent, or an XHR the browser queues behind its per-host
  connection limit, also counts as a stall: spec-conformant; one line in the code comment.
- Report the measured gzip size; do not edit `scripts/size-limit.config.ts`.
### Task 4: Offline and online

**Files:** create `packages/cloudrop/src/client/lifecycle.ts`, `lifecycle.test.ts`; modify `file-run.ts` (`Entry`
gains `networkPaused: boolean`; `pauseFile(entry, byNetwork = false)`), `job.ts`.

**Interfaces:**
```ts
// client/lifecycle.ts
/** Calls `offline` and `online` on the page's connectivity events until the returned function runs. No-op without
 * a global addEventListener (Node, Workers). */
export function watchConnectivity(offline: () => void, online: () => void): () => void;
```

- [ ] **Step 1: Failing tests** (`lifecycle.test.ts`; stub `addEventListener`/`removeEventListener` with an
  `EventTarget`; fake XHR held): `offline` pauses a queued and an uploading file and aborts the PUTs in flight; `online`
  resumes both and the job ends done; a file the caller paused before `offline` stays paused after `online`; a
  network-paused file the caller then pauses stays paused after `online` (Q6); after `done` both listeners are removed;
  without a global `addEventListener` nothing throws.
- [ ] **Step 2: Implement.** `startJob` registers `watchConnectivity` when it starts running and removes it when
  `done` settles (`finally`, beside the caller-signal listener). `offline` → `pauseFile(entry, true)` for each entry;
  `online` → `resumeFile` for entries with `networkPaused`. `pauseFile` sets `networkPaused = byNetwork` when it pauses,
  and a caller `pause()` on a paused file clears it. Keep `pauseFile`'s ruling `M3-U4`.
- [ ] **Step 3:** `bun run verify`; report the size. **Commit** `feat(client): pause on offline and resume on online`.

**Audit amendments (binding):**
- Lifetime (I14): do not tie the listeners to `done`. The job keeps a count of files that are running (from the start
  of a file's run to its end); `watchConnectivity` is registered when the count goes from 0 to 1 and removed when it
  returns to 0. Expose this as two small functions in `job.ts` (for example `begin()`/`finish()` around `runFile`), so
  Task 5's retries reuse them unchanged.
- `resumeFile` (a caller's `resume()` while offline) clears `networkPaused` (M1). At registration, when
  `navigator.onLine === false` (where `navigator` exists), pause the running files at once (Q17).
- Doc comment (M5): "no-op where the global has no addEventListener"; Deno and Workers have one, which is harmless.
- Report the measured gzip size; do not edit `scripts/size-limit.config.ts`.
### Task 5: `retry()` and the failed-file rule

**Files:** modify `packages/cloudrop/src/client/file-run.ts`, `job.ts`, `types.ts`, `lifecycle.ts`, `upload.ts` (the
`Upload` state gains `dropped`), `packages/cloudrop/src/client.ts` (`upload()` passes `keepFailed: false`); create
`client/retry-file.test.ts` (split further if over 400 lines). Split `job.ts` if it would pass 220 lines (for example
`job-run.ts` for `/upload` and outcomes).

**Interfaces:**
```ts
// types.ts
interface FileHandle { …; retry(): Promise<FileOutcome<R>> }        // FileHandle becomes FileHandle<R>
interface UploadJob<R> { …; retry(): Promise<UploadResult<R>>; readonly files: readonly FileHandle<R>[] }
// file-run.ts: Entry gains `upload: Upload | null` (the state a retry reuses)
// upload.ts: Upload gains `dropped: boolean` (its /abort was sent: pagehide or abort())
// lifecycle.ts
/** Keeps a keepalive /abort ready for failed files' tickets: one pagehide listener while any is held (Q11). */
export interface Leftovers { hold(entry: Entry): void; release(entry: Entry): void }
export function createLeftovers(abort: (token: string) => Promise<void>): Leftovers;
```

- [ ] **Step 1: Failing tests.** Rows (fake XHR or fixture faults; `Math.random` mocked to 0):
  1. A `start()` file failing at a PUT (`400`): no `POST /abort` is sent; the snapshot says `failed`.
  2. `file.retry()` with a valid ticket re-sends only the parts that had not landed and completes with the **same**
     key; no new `POST /upload` (a 3-part file whose part 3 failed: the retry sends `PUT part 3`, `POST /complete`).
  3. `mayBeComplete` (a `/complete` answer dropped, then budget exhausted): `retry()` sends `POST /complete` first, no
     PUT, and ends done.
  4. A failure with `UPLOAD_REJECTED` (403 `SignatureDoesNotMatch`), and one whose ticket has expired (fake clock past
     `expiresAt`): `retry()` sends a new `POST /upload` for that file and ends done with a **new** key (Q8, Q9).
  5. `job.retry()` with two files refused by `/upload` (`UNAUTHORIZED`, then signed in): one `POST /upload` for both
     (Q12); resolves `UploadResult` with both done.
  6. `retry()` on a done, aborted, queued, uploading or paused file resolves at once with its current outcome or
     nothing changes, and sends nothing; `done` of the first run is unchanged.
  7. `abort()` on a failed file sends `POST /abort` and turns it `aborted` (Q10); not when `mayBeComplete`.
  8. `pagehide` (dispatched on the stubbed global target) sends `POST /abort` with `keepalive` for each held failed
     file and none for a done or uploading file; a later `retry()` of that file asks for a new ticket (Q11).
  9. `upload()` (one file, no handle) still sends the background `/abort` after a failure (Q7):
     `upload-abort.test.ts` passes unchanged.
- [ ] **Step 2: Implement.**
  - `runFile(context, entry, upload)` takes the `Upload` state, so a retry continues it; `entry.upload` holds it.
  - `end()` on a failure: with `keepFailed` (jobs from `start()`) keeps `entry.upload`, sends no `/abort`, and
    `leftovers.hold(entry)` unless `mayBeComplete`; without it (from `upload()`), today's background `/abort`.
  - `retryFile(entry)`: only from `failed`; status `queued`, error cleared, `changed(true)`; same ticket when
    `entry.upload` exists, `!dropped`, the ticket's `expiresAt` is in the future, and the error's code is not in Q9's
    list; then `runFile` (landed parts are skipped, so a file whose parts all landed goes straight to `/complete`).
    Otherwise a new ticket through the job's `/upload` (with the job's route, metadata and signal), `entry.landed`
    cleared, a fresh `Upload`. Release it from `leftovers` before sending. Resolves the file's `FileOutcome`.
  - `job.retry()`: retries every failed file; those needing a ticket share one `/upload` (Q12); resolves the job's
    `UploadResult` over all files once the retried ones settle. Connectivity listeners (Task 4) are active while any
    run or retry runs.
  - `abort()` per Q10; `leftovers` registers one `pagehide` listener per client (in `UploadContext`) while it holds any
    entry, and removes it when empty.
- [ ] **Step 3:** `bun run verify`, `bun run test:browser` (port 5173 is free in wave 2); report the size. **Commit**
  `feat(client): retry a failed file and keep what it sent`.

**Audit amendments (binding):**
- Q13 to Q16 above are part of this task: `entry.firstOutcome` and `done` built from it, with a row "a file retried
  while another still runs: `done` reports the first outcome and an error"; `job.retry()` waits for every file; Q14
  fresh `Progress`/`Meter` on a new ticket, with a row; Q15 rows; Q16 `abortFile` with rows for `job.abort()` on a
  failed file and the caller's signal firing during a retry.
- Same-ticket retry (I5): reset `upload.repairs = 0`; when the error is `PARTS_MISSING`, delete its parts (read from the
  error's `cause`, which `withFile` keeps) from `entry.landed`. Row: a file that failed with `PARTS_MISSING` after two
  repairs completes on retry.
- `mayBeComplete` first (I6, Q8): row with the fake clock past `expiresAt`: `retry()` sends `POST /complete` with the
  kept ticket and no `/upload`.
- Row 2 (I7): part 3 fails with six `500` answers (`STORAGE_ERROR`, retryable, budget exhausted, `Math.random` at 0),
  never a `400`, which Q9 sends to a new ticket.
- Existing tests (I8): `job.test.ts`'s row "fails only the file whose PUT the bucket refused, and aborts only that one"
  becomes `aborts: 0` (a `start()` failure keeps its ticket); `FileHandle` becomes `FileHandle<R = unknown>` so
  `examples/next/app/lab/file-rows.tsx` still compiles.
- `runFile` registers its cancel listener once per entry, not once per call (M6).
- Leftovers (M7): skip and release entries whose ticket's `expiresAt` has passed, when `pagehide` fires and when an
  entry is held.
- Report the measured gzip size; do not edit `scripts/size-limit.config.ts`.
### Task 6: The planner change (only if Task 1 recommends one)

**Files:** modify `packages/cloudrop/src/plan.ts` and its tests; whatever server tests pin the first part size.

- [ ] Apply exactly Task 1's recommended change, with property and hand-worked rows in the planner's tests (oracle:
  the measured table and R2's part rules). Run `bun run verify`, `bun run test:rustfs` (own port),
  `bun run test:wrangler`, `bun run test:live`. **Commit** `feat(plan): <the change>` with the measured reason.
  If Task 1 recommends no change, this task does not run; Task 8 records the decision.

### Task 7: The lab and browser rows

**Files:** modify `examples/next/app/lab/*`, `examples/next/app/lab.browser.test.ts`, `examples/next/README.md`.

- [ ] **Controls:** concurrency (`auto`, 1, 2, 4, 8, 16) and order (added, smallest-first) selects; "PUTs in flight"
  from the lab's XHR wrapper (Q4); Retry for the job (exact name "Retry") and per file (`aria-label="Retry <name>"`);
  a fault that makes the bucket refuse the next PUTs (so a file fails at once), and Offline/Online through the page's
  own controls if CDP emulation is not used.
- [ ] **Browser rows** (existing rows must pass): a failed file retried completes, and the table shows whether it reused
  its ticket (no new `/upload`) or asked for a new one, per Q8; going offline (CDP `Network.emulateNetworkConditions`
  `offline: true`, after `Network.enable`) pauses a throttled upload and going online resumes it to completion;
  smallest-first with concurrency 1: a small file chosen after a large one completes first.
- [ ] Gates: `bun run verify`, `bun run test:browser`, `bun run test:browser:live`. **Commit** `feat(examples): show
  auto connections, smallest-first and retry in the lab`.

**Audit amendments (binding):**
- The "reused its ticket" row needs a fault that fails a file with a retryable outcome until the budget runs out (for
  example the bucket answering `500`, or network errors, on every PUT while ticked); a `400` always takes the
  new-ticket branch (M14). Show both: one row per branch.
### Task 8: Size pass, budget, decisions, docs

- [ ] Size pass over `client/` (simplify rule, no behaviour change, own `refactor(client)` commit, browser lane green);
  set the budget to the measured size + about 5 %, never above 7.5 kB; if the measured size is above 7.5 kB, STOP and
  report the numbers and the heaviest parts.
- [ ] `docs/decisions/m3-uploader.md`: Q1–Q12 as `M3-U23`… in order, then the failed-file rule amending `M3-S15`
  (cross-reference it in `m3-slice.md`), the part-size outcome (Task 1, and Task 6 if it ran), and every execution
  ruling from the ledger and task reports that changes behaviour or a public contract.
- [ ] `README.md`: `concurrency: "auto"`, `order`, stalls, offline, `retry()` and what a failed file keeps; remove the
  "No stall detection yet" limitation. Spec status line: plan B executed. Plans README: plan B done, next the resume
  plan. Replace "ruling Q<n>" citations in code with `M3-U` ids.
- [ ] `bun run verify`. **Commit** `docs: record plan B's decisions, the client budget and the uploader guide`.

**Audit amendments (binding):**
- Amend spec §4.7's first bullet: the rule applies to files of `start()` jobs; `upload()` keeps `M3-S15`'s background
  `/abort` (Q7, owner-confirmed). Spec §7: the client ceiling is 9.0 kB for the rest of M3 (owner decision
  2026-11-16); spec §1's "client plus React" target becomes about 11 kB.
- The budget: the measured size + about 10 %, rounded up to 0.1 kB, and never above 9.0 kB; the comment states the
  room left for the resume plan.
- Decision entries also for Q13–Q17, M4 (slow answers count as stalls) and M12 (what `sent` measures).
## Self-review

- Spec coverage: §4.4 auto and smallest-first → Task 2; §4.6 stalls → Task 3, offline → Task 4; §4.7 → Task 5; §5 →
  Tasks 1, 6; §6 unit rows → Tasks 2–5, browser and lab → Task 7; §7 budget, decisions, README → Task 8; §9 pool
  numbers → Task 2 constants, tunable by Task 1's data (recorded in Task 8).
- Interfaces: `Pool.sent`/`slowDown` (Task 2) are called only from `upload.ts` (Task 2); stalls (Task 3) reach the pool
  as `opaque`; `pauseFile(entry, byNetwork)` (Task 4) is used by Task 5 unchanged; `Entry.upload` and
  `Upload.dropped` are Task 5's.
