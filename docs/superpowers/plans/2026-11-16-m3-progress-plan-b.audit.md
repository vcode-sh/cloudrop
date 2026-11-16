# Plan B audit (pre-execution)

Plan: `docs/superpowers/plans/2026-11-16-m3-progress-plan-b.md` at `994e29a`. Code read as of that commit. Paths below
are relative to `packages/cloudrop/src/` unless they start with `docs/`, `examples/` or `scripts/`.

## Critical

### C1. A file retried before the first run settles corrupts `done` (and `job.retry()`'s result)

- **Plan:** Task 5 Step 2 (`retryFile`: "status `queued`, error cleared"), row 6 ("`done` of the first run is
  unchanged"); spec §2.2 ("`job.done` settles once, when every file of the first run has settled").
- **Evidence:** `client/job.ts:85-96` awaits `Promise.all` of each entry's `runFile`, then builds
  `entries.map(outcomeOf)`. `outcomeOf` (`client/job.ts:60-65`) returns `{ status: "failed", error: error as
  CloudropError }` for any entry without a result.
- **What goes wrong:** file A fails while file B still uploads; the page calls `files[0].retry()`. A's `runFile` already
  returned, so `Promise.all` no longer waits for it. When B finishes, A is `queued`/`uploading` with `error: null`, so
  `done` resolves with `{ status: "failed", error: null }` for A, and `data.files.find(...)?.error ?? null` is null:
  `{ data, error: null }` with a failed file. `UploadResult`'s contract (every non-done outcome has an error, `error`
  null only when all are done) breaks. The same happens to `job.retry()`'s result for files still running ("once the
  retried ones settle").
- **Fix:** record each file's outcome when it first settles (e.g. `entry.outcome` set in `settle()` and on done, never
  cleared by a retry) and build the first run's `done` from those; or make `done` wait for a retry that started before
  it settled. Pick one, add a row ("retry during the first run: `done` reports the first outcome / waits"), and record
  it as an `M3-U` ruling. `job.retry()` must resolve only once every file is settled, not only the retried ones.

## Important

### I1. Pool Step 2 reads as "grant waiters only when a window closes"

- **Plan:** Task 2 Step 2 — "if `now() - windowStart >= 2000`: … then `lastRate = rate`, reset the window, `hold =
  false`, and grant waiters while `inUse < size`."
- **Evidence:** today a release hands its slot straight to the first waiter (`client/pool.ts:27-37`); with a size that
  can shrink, that hand-off must become `inUse--` then "grant while `inUse < size`".
- **What goes wrong:** read literally, a release between window boundaries grants nobody: throughput collapses for up to
  2 s per slot, and under fake `Date` (pause/job-snapshot tests pass `concurrency` but Task 4/5 rows may not) a test
  that never advances time hangs. The existing row `client/pool.test.ts:24` would catch it, but only after the executor
  writes the wrong thing.
- **Fix:** state the invariant: every `acquire`, release and `sent` first evaluates the window (if due), then grants
  waiters in rank order while `inUse < size`; an `acquire` waits whenever waiters exist or `inUse >= size` (no
  overtaking); a release decrements `inUse` (the double-call guard stays). Row 8 then follows.

### I2. Zero and idle windows make the auto pool grow without any throughput gain

- **Plan:** Task 2 Step 2 (`lastRate` null only before the first full window; `rate >= lastRate * 1.1`), Q1.
- **What goes wrong:**
  - `windowStart` starts at `createPool` time. A client created at page load and first used minutes later evaluates a
    window of minutes with 0 bytes: `lastRate = 0`. The next window with any bytes (or 0 bytes: `0 >= 0 * 1.1`) grows.
    The same happens after every idle gap between jobs, and during a stall (no `sent`, evaluations triggered by retry
    acquires with 0 bytes). The pool thus climbs to 8 one step per window regardless of throughput.
  - With the fetch transport bytes arrive only when a part is stored, so 0-byte windows are common.
- **Fix:** grow only when `lastRate > 0` and `rate > 0`; discard (set `lastRate = null`, restart the window) a window
  that began while the pool was idle (`inUse === 0` and no waiters), or one longer than, say, 2 × 2000 ms. Add rows:
  "first use after idle does not grow", "0 → 0 does not grow".

### I3. Pool row 2 leaves the evaluation order and window reset open

- **Plan:** Task 2 Step 1 row 2 ("window 1 (t 0–2000) `sent(1000)`, window 2 (t 2000–4000) `sent(1100)`, then an
  `acquire` at t = 4000").
- **What goes wrong:** window 1 only closes when some call arrives at t ≥ 2000. If `sent(1100)` at t = 2000 adds its
  bytes before evaluating, window 1 holds 2100 bytes and the row fails; if the reset sets `windowStart = windowStart +
  2000` rather than `now()`, later rows shift. The growth test also sits exactly on the boundary: `1100/2000` and
  `0.5 * 1.1` are the same double (0.55000000000000004…), so `>=` passes but any refactor to `rate / lastRate >= 1.1`
  (1.1 vs 1.1000000000000000888…) flips it.
- **Fix:** write it in the step: "evaluate before counting the call's bytes; the new window starts at `now()`". Put
  the calls' times in the row (`sent(1000)` at 0, `sent(1100)` at 2000, acquire at 4000) and keep the comparison as
  `rate >= lastRate * 1.1`, or move the row off the boundary (1101 grows, 1099 does not).

### I4. The client-level 429 row cannot be met as written

- **Plan:** Task 2 Step 4 — "A 429 answer to a PUT on an auto client → that file still completes and the PUTs in flight
  never exceed 2 afterwards within the window (count with a holding fault)."
- **What goes wrong:** one file has at most 4 PUTs in flight (`PARTS_IN_FLIGHT`, `client/parts.ts:12`), and a 3-part
  file at most 3, so the auto pool of 4 never has waiters; and the PUTs already in flight when the 429 arrives (up to 3)
  stay in flight after the halving, so "never exceed 2 afterwards" is false by construction.
- **Fix:** two 3-part files in one job (6 wanted, 4 granted), `Math.random` mocked to 0; answer one PUT with 429, hold
  the others; assert no new PUT starts until fewer than 2 are in flight (count PUT starts while the held ones are
  released one by one), and that both files end done. Fake `Date` so the window cannot elapse mid-row.

### I5. A same-ticket retry of a `PARTS_MISSING` failure can never succeed

- **Plan:** Task 5 Step 2 (`retryFile` → same ticket → `runFile`), Q9 (PARTS_MISSING is not in the new-ticket list).
- **Evidence:** `client/upload.ts:121-124` returns at `upload.repairs === REPAIR_ROUNDS` without removing the missing
  parts from `entry.landed`; `upload.repairs` lives on the kept `Upload`.
- **What goes wrong:** the retry finds no unsent parts, calls `/complete`, gets `PARTS_MISSING` again, and since
  `repairs` is already 2 fails at once. Every retry repeats it.
- **Fix:** on a same-ticket retry reset `upload.repairs = 0` and, when the error is `PARTS_MISSING`, delete
  `error.parts` (on the `cause`, as `withFile` wraps it) from `entry.landed`. Add a row.

### I6. A file whose `/complete` may have succeeded can be uploaded a second time

- **Plan:** Q8 and Task 5 Step 2 check the ticket's expiry before anything else; spec §4.7 step 1 says "if a
  `/complete` may have succeeded, it calls `/complete` again first".
- **What goes wrong:** `mayBeComplete` plus an expired ticket (or `dropped`) takes the new-ticket branch: a second
  object under a new key and a second `onComplete`, while the first may exist. Q11 rightly skips `mayBeComplete` files at
  pagehide, but expiry is not covered.
- **Fix:** when `mayBeComplete`, always send `/complete` with the kept ticket first (whatever the clock says); on
  success the file is done, on any other answer it ends failed with that answer (no fallback, which keeps Q8's
  "one branch per call"). Say so in Q8 and add a row with the fake clock past `expiresAt`.

### I7. Task 5 row 2 does not say how part 3 fails; a 400 sends it down the wrong branch

- **Plan:** Task 5 row 2 ("a 3-part file whose part 3 failed: the retry sends `PUT part 3`, `POST /complete`"), row 1
  (400 PUT), Q9.
- **Evidence:** `client/bucket.ts:40-42`: 400 → `uploadRejected` → `UPLOAD_REJECTED`, which Q9 sends to a new `/upload`.
- **Fix:** row 2's part 3 must fail with a retryable outcome that exhausts the budget (six 500s → `STORAGE_ERROR`, or
  six network errors → `NETWORK_ERROR`), `Math.random` at 0. State it.

### I8. Existing tests and the example that Task 2 and Task 5 break are not named

- `client/job.test.ts:139-166` ("fails only the file whose PUT the bucket refused, and aborts only that one") asserts
  `aborts: 1` through `start()`; after Task 5 a `start()` failure sends no `/abort`, so it must become `aborts: 0` (or
  move to `upload()`). Task 5's file list omits `job.test.ts`.
- `client.test.ts:46-57` asserts the old message `concurrency must be a whole number from 1 to 16.`; Task 2 changes it.
  (`client.test.ts` is in Task 2's list, but the step only says "refusal rows", not "update the existing row".)
- `client/upload.test.ts:199-200` names a row "the default of 4"; the default becomes `"auto"` (it still starts at 4, so
  it passes, but the name and comment then lie). Rename it.
- `FileHandle` becomes `FileHandle<R>` (Task 5 interfaces). `examples/next/app/lab/file-rows.tsx:1,23,84` uses bare
  `FileHandle`, and `bun run verify` typechecks the example (`package.json:22`), so Task 5's gate fails, and a public
  type stops compiling for callers. **Fix:** `FileHandle<R = unknown>`.

### I9. `abort()` of the job, the caller's signal, and retries are not wired to failed files

- **Plan:** Q10, Task 5 Step 2 ("`abort()` per Q10"); spec §4.5 ("the job's `signal` aborts every file"), §4.7 ("until
  the first of: `abort()` on the file or job").
- **Evidence:** `job.abort()` only fires `entry.cancel` (`client/job.ts:126-130`); the only reaction to it is the
  listener `runFile` registered (`client/file-run.ts:86-93`), which does nothing once `runFile` returned. The caller's
  signal listener is removed when `done` settles (`client/job.ts:138`).
- **What goes wrong:** `job.abort()` after a failure leaves failed files held (no `/abort`, status `failed`); a caller's
  signal fired after `done` neither aborts held files nor a running retry.
- **Fix:** one `abortFile(entry)` used by the handle, by the job's abort listener and by the caller's signal: running →
  today's cancel; failed and holding a ticket → Q10. Decide whether the caller's signal stays attached while files are
  held or retried (recommended: yes, removed when nothing is held or running), and add rows for `job.abort()` on a
  failed file and the signal firing during a retry.

### I10. A new-ticket retry keeps the old upload's bytes

- **Plan:** Task 5 Step 2 ("`entry.landed` cleared, a fresh `Upload`"); spec §4.2 (bytes never decrease).
- **Evidence:** `client/progress.ts:15-31`: `best` per part number survives; nothing resets it.
- **What goes wrong:** a file that failed at 90 % and restarts under a new key shows 90 % (or 100 % if every part had
  landed before a `VERIFICATION_FAILED`) while nothing of the new upload has landed; `done`'s "bytes = size" reasoning
  in `client/job.ts:23` no longer guarantees anything.
- **Fix:** decide and record it: a new ticket starts a new `Progress` and `Meter` (bytes drop to 0, an explicit
  exception to §4.2 for a new upload), or keep it and say why. Add a row either way.

### I11. `retry()` on a file that has not settled has no defined result

- **Plan:** row 6 ("resolves at once with its current outcome or nothing changes"); `FileOutcome` has only
  `done | failed | aborted` (`client/types.ts:51-53`).
- **Fix:** specify: on a queued, uploading, paused or completing file `retry()` sends nothing and resolves with the
  file's outcome when it next settles; on done/aborted, at once with that outcome. For `job.retry()` on a job refused
  for its arguments (no entries), resolve with the same `{ data: null, error }` as `done`.

### I12. Q7 departs from the binding spec without an amendment step

- **Plan:** Q7 ("`upload()` keeps `M3-S15`"); spec §4.7 first bullet ("A file that fails no longer sends `/abort` at
  once") has no `start()`-only restriction.
- **What goes wrong:** the ruling is sensible (no handle, so nothing can retry), but the spec says otherwise and Task 8
  only records a decision entry.
- **Fix:** have the controller confirm Q7 with the owner before Task 5, and have Task 8 amend spec §4.7 ("from
  `start()`; `upload()` keeps `M3-S15`'s background `/abort`").

### I13. 7.5 kB is unlikely, and the parallel wave hides the combined size

- **Plan:** Global constraints "Bundle"; Waves 1 (Tasks 2–4 measured separately against the same base).
- **Estimate:** the shipped client is about 1 120 non-comment source lines for 6.74 kB gzip (about 5–6 bytes per line).
  Added lines and gzip: Task 2 ~45 lines (auto pool, two option checks and messages, rank and pool calls) ≈ +0.20–0.25
  kB; Task 3 ~20 lines ≈ +0.10 kB; Task 4 ~25 lines ≈ +0.10–0.15 kB; Task 5 ~110–140 lines (retry, shared `/upload`,
  Q10, leftovers, keepFailed, I1–I11 fixes) ≈ +0.45–0.65 kB. Total ≈ +0.85–1.15 kB → **≈ 7.6–7.9 kB**. Each wave-1 task
  alone stays under 7.4 kB, so nobody stops until Task 5, and Task 8's size pass comes after Tasks 5–7.
- **Fix:** measure once after Wave 1 is merged, before Task 5; give each task a gzip allowance (for example T2 0.20,
  T3 0.10, T4 0.12, T5 0.35) and ask the owner now whether to raise the ceiling or cut scope (e.g. drop `order`, or
  keep Q12 out), rather than at a forced STOP. Raising the limit to 7.5 kB in two parallel tasks also edits the same
  line of `scripts/size-limit.config.ts` (an identical change, but it should be the controller's, not a task's).

### I14. Task 5's connectivity lifetime and leftovers need the shape fixed before Task 4 is written

- **Plan:** Task 4 Step 2 (register on start, remove when `done` settles); Task 5 ("active while any run or retry
  runs").
- **What goes wrong:** Task 4 ties the listener to `done`; Task 5 must rework it into a count of running files, and a
  retry after `done` otherwise runs with no offline handling. Wave-1 Task 4 does not know this.
- **Fix:** tell Task 4 to expose start/stop around each file's run (a counter in the job: listen while > 0), so Task 5
  reuses it unchanged.

## Minor

- **M1. `networkPaused` on resume.** Task 4: `resumeFile` (caller's `resume()` while offline) should clear
  `networkPaused`; say so. Also `navigator.onLine === false` when a job starts fires no `offline` event, so the files
  burn their attempts; either check it at registration or note it in the decision.
- **M2. Offline pauses queued files too.** Spec §4.6 says "every file that is uploading"; the plan pauses queued and
  uploading (`pauseFile`). Better behaviour, but record it as a ruling.
- **M3. Fetch timeout details.** Task 3: if the caller's signal has already fired, abort the controller at once (a
  listener added later never fires); clear the timer and remove the listener in `finally`.
- **M4. XHR stall after the body is sent.** Upload progress stops once the body is out; an answer that takes over 30 s
  (or an XHR queued by the browser behind its per-host connection limit on HTTP/1.1 with `concurrency` up to 16) counts
  as a stall and costs an attempt. Spec-conformant; worth one line in the decision entry and a check of R2's protocol
  (HTTP/2 would remove the queueing case).
- **M5. Global `addEventListener` exists in Deno and Workers.** "No-op without a global addEventListener" registers
  harmless listeners there; fine, but the doc comment should say "where the global has one".
- **M6. Listener accumulation.** `runFile` adds a `cancel` listener on every call (`client/file-run.ts:86-93`); a retried
  file adds one per retry. Register it once per entry (in `startJob`) when Task 5 reworks `runFile`.
- **M7. Leftovers never expire.** Spec §4.7 releases a held ticket at its expiry; `createLeftovers` has no expiry, so
  the pagehide listener and the job's entries stay for the page's life and pagehide sends `/abort` with dead tokens.
  Skip (and release) entries past `expiresAt` when pagehide fires or when another entry is held.
- **M8. Q10 with `mayBeComplete`.** Row 7 says "not when `mayBeComplete`": state that the file still turns `aborted`
  (as today's cancel does) and only the `/abort` is skipped. Also: an `abort()` on a failed file before `done` settles
  turns its first-run outcome into `aborted`; C1's fix decides which one `done` reports.
- **M9. File map vs Task 5.** The file map row for Task 5 omits `upload.ts`; Task 5's Files line includes it.
- **M10. Smallest-first client row.** Put both files in one `start()` (or hold the large file's PUTs): with two jobs the
  small file's `/upload` may answer after part 1 already finished, and the order becomes timing-dependent.
- **M11. Pool clock.** Default `now` should be `() => Date.now()`, not `Date.now` captured at `createPool` time, so a
  fake `Date` installed after a client exists is still read (store and meter call `Date.now()` per use).
- **M12. What `sent` measures.** `progress.sent` returns only bytes above a part's earlier best (`client/progress.ts`),
  so re-sent bytes after a stall or pause do not count as throughput. Acceptable; say so in the Q1 entry.
- **M13. Task 1.** `completeMultipart` needs each part's ETag (`storage/driver.ts:49-52, 99-104`): the browser half must
  read `ETag` (the CORS rule exposes it) or Node must call `listParts`. A listing of the prefix proves objects are
  gone, not unfinished multipart uploads: record every `uploadId` and `abortMultipart` each. Never forward page console
  messages (Chromium's CORS and network errors quote the request URL); if anything is forwarded, pass it through
  `createRedactor` from `scripts/live-r2-settings.ts`. Note: `~/projects/.worktrees/cloudrop/scratch/` already holds
  `part-size-node.ts`, `part-size-browser.ts`, `part-size-lib.ts` and their logs from 21:31–21:35 today (the logs hold
  no `X-Amz` strings), and `r2-speed.ts` imports from `~/projects/cloudrop`, not from a worktree: the Task 1
  executor should import from its own worktree and not overwrite another run's files.
- **M14. Task 7 fault.** A 400 refusal always takes Q9's new-ticket branch; to show "reused its ticket" the lab needs a
  fault that fails a file with a retryable outcome (six 500s or network errors).

## Checks that passed

- Fetch timeout: 1 MiB / 102.4 bytes per ms = 10 240 ms; 30 000 + 10 240 = 40 240 ms (row 4 and 40 239 pending).
- XHR stall path: `xhr.abort()` → `onabort` → `lost` → `unreachable(signal)` (`client/transport.ts:40-43`,
  `client/bucket.ts:46-50`) is `opaque`/`NETWORK_ERROR`/`retryAfterMs: 0` while the caller's signal has not fired and
  `aborted` when it has; `settle` (`client/transport.ts:24-27`) is the one place to clear the timer, also on the
  `send` throw path. The fake XHR's `abort()` during `hold` fires `onabort` once (`testing/fake-xhr.ts:125-127`) and
  `progress()` re-fires `upload.onprogress` while open, so rows 1–3 are producible.
- Existing fake-timer tests advance at most 5 s with an XHR open (`client/job-snapshot.test.ts:157`), so a 30 s stall
  timer does not change them.
- Pool rows 2, 3 and 5 recomputed: 1000/2000 = 0.5, 1100/2000 = 0.55 = 0.5 × 1.1 in doubles (grows), 1099 → 0.5495
  (no); 2100/4000 = 0.525 = 1.05× (no); after `slowDown` the next evaluation (≥ 2000 ms later) sees `hold` and only
  clears it, the one after can grow. Halving 8 → 4, 1 → 1. With grants on every release (I1), no deadlock: waiters
  exist only while `inUse >= size >= 1`, so a release always comes; a size increase due while waiters exist is applied
  at the next release or `sent` of an in-flight PUT.
- Smallest-first ranks `[size, rank, part]` vs `[rank, part]` work with the existing element-wise `before`
  (`client/pool.ts:19-22`); concurrency 1 gives the small file the slot after part 1 when both are in one job.
- Wave 1 files are disjoint (T2: pool, client, upload; T3: transport; T4: lifecycle, file-run, job); Task 5's
  `upload.ts` hunk (`Upload`, lines 36-43) does not touch Task 2's (`senderFor`, lines 53-76). No textual conflicts on
  cherry-pick.
- `endpoints.abort` already sends `keepalive: true` with a 10 s timeout (`client/endpoints.ts:108-117`), so Q11 needs
  no endpoint change. Tickets carry `expiresAt` (`protocol/types.ts:50`).
- `client/upload-abort.test.ts` uses only `client.upload`, so with `keepFailed: false` it passes unchanged (row 9).
- Task 1: the driver has `createMultipart`, `presignPart(key, uploadId, partNumber, { size, expiresIn })`,
  `completeMultipart(key, uploadId, parts)`, `abortMultipart`, `listParts` (`storage/driver.ts:84-107`); a part PUT's
  signed size is derived by the browser from the body, so a page on `http://localhost:5173` can PUT the parts under the
  CORS rule in `AGENTS.md`. Runtime: 9 combinations × 3 runs × 256 MiB at 60–70 MiB/s ≈ 27 × 4–8 s ≈ 2–4 min per
  environment plus setup, well under 15 min.
- Q3 matches the classifier: 429 and 503 → `RATE_LIMITED` (`client/bucket.ts:39`), 500 → `STORAGE_ERROR`.
- Q11 matches spec §4.7 (pagehide `/abort` only without a possible `/complete`); pagehide does not block bfcache.
