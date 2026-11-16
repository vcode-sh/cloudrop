# Plan audit: M3 progress plan A

Plan: `docs/superpowers/plans/2026-11-16-m3-progress-plan-a.md` (commit `99014a3`). Spec:
`docs/superpowers/specs/2026-11-16-progress-scheduler-design.md`. This is a read-only audit: no source or plan file was
changed. Line numbers refer to the plan unless a file is named.

Counts: **1 Critical, 5 Important, 14 Minor.**

---

## Critical

### C1. `bun run verify` fails from Task 3 or Task 4 on, because the client budget is raised only in Task 8

- **Where:** every task's gate, "`bun run verify` → PASS" (plan lines 234, 509, 640, 703, 760). The budget is raised in
  Task 8 Step 1 (lines 820-822).
- **Evidence:** `package.json:22` `verify` ends with `bun run package:check`. `scripts/check-package.sh:22` runs
  size-limit. `scripts/size-limit.config.ts` sets `cloudrop/client` to `limit: "4.7 kB"`. The client measures 4.31 kB
  today, so there are about 0.39 kB of headroom.
- **What goes wrong:** Task 1 adds `putWithXhr` and `createPut` to the bundle, roughly 0.2-0.3 kB gzip. Task 3 adds the
  pool and its wrapper. Task 4 adds `job.ts`, list arguments and `readTickets`, which is well over 0.4 kB. Task 2's
  modules are tree-shaken until Task 5 imports them. So `verify` goes red at Task 3, or at Task 4 at the latest. An
  executor then either stops or raises the budget ad hoc in a task commit, which the size-limit header forbids ("raise
  one only on purpose, and say why in the commit").
- **Fix:** add a step to Task 1, or to the first task that crosses 4.7 kB, that sets the `cloudrop/client` limit to the
  owner's ceiling of 7.5 kB. Its comment should say "provisional during plan A, tightened in Task 8". Task 8 keeps its
  "measured + 10 %" step. Also have each task report the measured size, so the 6.5 kB STOP in Task 8 is seen early
  (see M14).

---

## Important

### I1. A pause that lands between a slot grant and the wrapper's continuation is lost, and a new pass starts

- **Where:** Task 4 Step 4 (lines 593-595): "`queued` → `uploading` when a PUT of the file gets a pool slot (in the
  `put` wrapper, only if not yet `uploading`)". Task 6 loop (lines 740-751). The pool grants slots (lines 463-465,
  483-485).
- **Evidence:** `release()` resolves the waiter's promise synchronously. The wrapper's code after `await acquire()`
  runs one microtask later. A `pause()` in that gap sets `status = "paused"` and aborts the pass. The wrapper then sees
  "not yet uploading" and sets `uploading`, calls `put` with an aborted signal (which returns aborted), and the pass
  ends. In `runFile`, `pass.signal.aborted && !cancel` leads to `continue`. At the top of the loop
  `entry.status === "paused"` is now false (it is `"uploading"`), so a new pass starts at once. The user pressed Pause
  and the file keeps uploading. The same overwrite can happen after `resume()` → `queued` for an old pass's late grant.
- **Fix:** in the wrapper, after `acquire` resolves, check the PUT's signal first. If it has fired, release the slot
  and return `{ kind: "aborted", error: aborted() }`. Change status only from `queued` or `completing` (the repair
  case) to `uploading`, never from `paused` or a settled state. Add a unit row: a size-1 pool held by another file,
  `pause()` and the release in the same tick, and the file stays `paused` with no PUT sent.

### I2. Under fake timers, `vi.waitFor` moves the clock, so Task 5's time-exact oracles cannot be produced

- **Where:** Task 5 Step 4 (lines 686-697): row 4 (speed ≈ 486.58, ETA ≈ 16.44 with "restart at the slot (t = 0)")
  and row 3 (ten events within 50 ms → one call after 100 ms). The fake XHR's interface (lines 122-136) offers no way
  to wait for a request to open.
- **Evidence:** `packages/cloudrop/node_modules/vitest` 5.1.0 `waitFor`:
  `const checkCallback = () => { if (vi.isFakeTimers()) vi.advanceTimersByTime(interval); …`. Each check, the first
  one included, moves the fake clock forward 50 ms before it runs the callback. `/upload` goes through the real handler
  (WebCrypto), so the XHR does not open within one microtask chain. The only way the plan leaves to wait for it is
  `vi.waitFor`.
- **What goes wrong:** `meter.restart(Date.now())` runs when the slot is granted. That happens before the `waitFor`
  check that sees the open call, so the test's "t = 1000" is at least 1050 ms after the restart. The speed becomes
  1 − e^(−1.05/3)… ≈ 475, not 486.58, and `toBeCloseTo(…, 1)` fails. Row 3's throttle window shifts the same way: the
  first `changed(false)` may schedule a 0 ms timer, so two calls happen instead of one.
- **Fix:** add `next(): Promise<XhrCall>` to `FakeXhr`, or an `opened` promise per call, resolved in `send`. Tests
  await it with no timer movement. State in Task 5 that `vi.waitFor` must not be used between the slot grant and a
  timed assertion. A simpler alternative is a test-only clock: pass `now` into the meter through the entry. The fake
  hook is the smaller change.

### I3. The plan's overload order breaks `upload.test.ts`'s typecheck ("must pass unchanged")

- **Where:** Task 4 Interfaces (lines 569-570): overload 1 takes `File` and overload 2 takes a list. Task 4 Step 7
  says the existing `upload.test.ts` "must pass unchanged" (line 638).
- **Evidence:** `src/client/upload.test.ts:143`
  `const upload = client.upload as (...args: unknown[]) => ReturnType<typeof client.upload>;` and then
  `errorOf(result)`, where `errorOf` takes `Result<unknown>`. `ReturnType` of an overloaded function uses the last
  overload. That gives `Promise<UploadResult<…>>`, and its `{ data: { files }, error: CloudropError }` member is not
  assignable to `Result<unknown>`. `typecheck` runs `tsconfig.test.json` (`packages/cloudrop/package.json:34`), so
  `verify` fails. A related problem: the arrow that implements `upload` in the object literal in `client.ts` gets no
  contextual parameter types from an overloaded member, so its parameters are implicitly `any` under `strict`.
- **Fix:** declare the list overload first and the `File` overload last, so `ReturnType` and `Parameters` still see
  the single-file shape (`types.test.ts:58` uses `Parameters<typeof client.upload>[0]`, which is the same either way).
  Type the implementation explicitly, for example
  `const upload = ((route: string, files: unknown, ...rest: unknown[]) => …) as CloudropClient<TCloudrop>["upload"]`.

### I4. The lab's `window.fetch` wrapper calls itself without end

- **Where:** Task 7 Step 1 (lines 779-783): "`window.fetch` (the endpoints; the existing `createLabFetch` logic …)".
- **Evidence:** `examples/next/app/lab/lab-fetch.ts:173` `const response = await fetch(url, init);` resolves the global
  `fetch` at call time. Once `window.fetch` is the wrapper, this line calls the wrapper again, so the recursion never
  ends.
- **Fix:** take the original before installing (`const realFetch = window.fetch.bind(window)`), pass it into
  `createLabFetch` and use it in `sendWithFaults`. Record only requests under the app's `/api/cloudrop/` and pass every
  other request through unrecorded. Otherwise `/api/lab-info` or any Next request during a run shows up in the table
  and breaks the existing row equality in `lab.browser.test.ts`. In "Send PUTs with fetch" mode, pass the lab fetch as
  the client option and install no global wrapper, or every endpoint call is recorded twice.

### I5. Per-file Cancel and Pause buttons break the existing lab test's button locator

- **Where:** Task 7 Step 3 (lines 788-792): per-file "Pause, Resume and Cancel buttons" plus job-level ones. It also
  says "the three existing tests must still pass" (line 793).
- **Evidence:** `examples/next/app/lab.browser.test.ts:97`
  `page.getByRole("button", { name: "Cancel", exact: true }).click()`. Playwright's strict mode throws when a locator
  matches more than one element.
- **Fix:** keep the job-level buttons named exactly "Pause", "Resume" and "Cancel". Give per-file buttons accessible
  names that include the file, such as `aria-label="Cancel random-20-MiB.bin"`. State this in Step 3, and have the new
  browser rows use those names.

---

## Minor

### M1. Pause can swallow a part's final failure

- **Where:** Task 6 loop, line 749.
- **What goes wrong:** `if (pass.signal.aborted && !cancel) continue;` also catches a real failure that won the race,
  for example `UPLOAD_REJECTED` from one part while the user pauses. After resume, the file sends again and fails
  again.
- **Fix:** continue only when `sent.result.error.code === "ABORTED"`. Otherwise end with the failure.

### M2. Repair rounds restart with each pass, and pause is ignored after a `PARTS_MISSING` answer

- **Where:** Task 6 lines 753-757; P4 (lines 60-61).
- **What goes wrong:** `round` is local to `sendAndComplete`, so every pause and resume resets `REPAIR_ROUNDS`. After a
  `PARTS_MISSING` answer the status stays `completing` until a repair PUT gets a slot, and `pause()` is ignored in that
  window.
- **Fix:** keep the round count on the run, like `mayBeComplete`. Set `uploading` as soon as `PARTS_MISSING` arrives.

### M3. Totals mislead when a file has failed, and divide by zero when every file is empty

- **Where:** Task 5 Step 2 (lines 681-682).
- **What goes wrong:** Totals include the sizes of failed and aborted files. `totals.eta` then counts bytes that will
  never be sent, and `totals.progress` never reaches 1. A job of zero-byte files gives `0/0 = NaN`.
- **Fix:** compute the remaining bytes for the ETA from files that are not settled. Apply the zero-size rule to the
  totals. Record the choice in `M3-U`.

### M4. `isolatedDeclarations` needs explicit types on two new exports

- **Where:** Task 1 Step 3, the new exports in `bucket.ts`.
- **Evidence:** `tsconfig.json` sets `isolatedDeclarations: true`, and existing constants are annotated, for example
  `parts.ts` `export const PARTS_IN_FLIGHT: number = 4`.
- **Fix:** write `export const STORAGE_CODE: RegExp = …` and `export function unreachable(signal: AbortSignal):
  BucketOutcome`.

### M5. The file lists do not match the steps

- **Where:** Task 3 Files (line 417) does not list `src/client.test.ts`, although Step 4 extends its refusal table.
  Task 1 Step 6 says "stage the five files", but the task touches six files.
- **Fix:** correct both lists.

### M6. Task 4 row 3 chooses the failing file by arrival order and does not wait for the background `/abort`

- **Where:** Task 4 row 3 (lines 625-626).
- **What goes wrong:** "fault on `PUT object` nth 2" depends on microtask order across three files. The background
  `/abort` is not awaited, so asserting on it races the test.
- **Fix:** select the file by body size (`(call.init.body as Blob).size`). Keep the `/abort` promise as
  `upload-abort.test.ts:28-33` does (`seen.aborted`).

### M7. Store rows 2 and 4 need stated preconditions

- **Where:** Task 2, store rows 2 and 4 (lines 290-294).
- **What goes wrong:** `lastMs` starts at −∞, so a first `changed(false)` publishes after 0 ms, not 100 ms (row 2
  needs an earlier publish). In row 4, a refresh already scheduled fires once more after `active()` turns false, so
  `getTimerCount()` is 0 only after that.
- **Fix:** write both preconditions into the rows. In the job they hold anyway, because the switch out of
  `uploading` is an urgent publish that clears the timer.

### M8. P8's re-thrown listener error fails the run under real timers

- **Where:** P8 (lines 69-70); Task 5 row 7 (line 701).
- **What goes wrong:** If a row lets the `setTimeout(() => { throw error })` run on real timers, Vitest reports an
  unhandled error and the run fails.
- **Fix:** run row 7 under fake timers and assert the throw (`expect(() => vi.runOnlyPendingTimers()).toThrow(…)`), or
  drop the pending timer in that row.

### M9. The fake XHR keeps no history of requests sent

- **Where:** Task 1 Interfaces (lines 129-134); Task 6 row 1 (lines 728-730).
- **What goes wrong:** A held call that is aborted never reaches `fixture.requests`. So "`fixture.requests` shows no
  second `PUT part 1`" holds even if part 1 were sent again and aborted. `open` shows only the calls still open.
- **Fix:** add `sent: readonly string[]` (the label of every `send`) to `FakeXhr`, and assert on it.

### M10. Task 6 row 1 needs `concurrency: 2`

- **Where:** Task 6 row 1 (line 728).
- **What goes wrong:** With the default concurrency of 4, a 3-part file opens all three parts at once, not "parts 1
  and 2".
- **Fix:** add `concurrency: 2` to the row's setup. Note that part 3 opens once part 1 is finished, before the pause.

### M11. `upload.ts` will crowd the line cap

- **Where:** Tasks 4 to 6.
- **What goes wrong:** `upload.ts` has 146 lines. Moving `readArguments` out removes about 40. Adding `Entry`, the pass
  loop, `end`, `withFile`, `resumed`, `landed` and the wrapper with pool, status and progress adds about 120. That
  ends near the 250-line fail line, and `runFile` nears complexity 15.
- **Fix:** plan the split now, for example `client/file-run.ts` (the loop, pause and resume) beside `upload.ts`
  (sender, `sendAndComplete`). Say where `withFile` lives, since both `job.ts` and `upload.ts` use it.

### M12. The public API reaches beyond the spec's types and the existing browser support

- **Where:** Task 4 (`FileList`, line 567); Task 6 (`AbortSignal.any`, line 746).
- **What goes wrong:** `FileList` in `cloudrop/client`'s `.d.ts` needs the DOM lib in consumers that do not skip lib
  checks. The spec's API names only `File | File[]`. `AbortSignal.any` sets the floor at Safari 17.4, Firefox 124 and
  Chrome 116.
- **Fix:** record both in `M3-U`. As an alternative, accept `ArrayLike<File>` and combine the two signals by hand
  (about 5 lines).

### M13. Task 7 row 1 may get fewer than three samples

- **Where:** Task 7 row 1 (lines 794-799).
- **Evidence:** at 8 MiB/s, 20 MiB takes about 2.5 s. `expect.poll`'s default intervals (100, 250, 500, then 1000 ms)
  give about three or four samples inside that window, which is borderline for "at least three strictly between".
- **Fix:** pass `intervals: [100]`, or throttle to 4 MiB/s. Send `Network.enable` before
  `Network.emulateNetworkConditions`. Feasibility otherwise looks fine: Chromium's network service throttles request
  bodies (its throttling upload data stream), so XHR upload progress should rise gradually. The plan's STOP guard
  stays the right fallback.

### M14. Other small points

- **The bundle estimate is close to the STOP line.** The new code is about 470 lines of TypeScript with few message
  strings, which suggests roughly +1.4 to 2.0 kB gzip, or about 5.7 to 6.3 kB. That is plausible under 6.5 kB but with
  a thin margin. Measure and report after each task (see C1) rather than first in Task 8.
- **The lab's XHR wrapper:**
  - It must observe its own requests through `addEventListener`. The transport sets `onload`, `onerror` and `onabort`
    after construction and would overwrite handler properties set in the wrapper's constructor.
  - It should dispatch the injected `error` event asynchronously, as a browser does.
  - A failed file's background `/abort` that settles after the run ends is no longer recorded once the wrappers are
    removed. Say so in the lab text, or remove the wrappers only after background work has settled.
- **Task 1 Step 5's wording contradicts itself** ("the quickstart and the lab now send PUTs through real XHR (the lab
  still passes its own fetch …)"). Only the quickstart moves to XHR in Task 1.
- **Spec §4.6 versus the code.** The spec says a failing file's "other PUTs stop at once (as since commit `7bf1d89`)".
  That commit's message and `parts.ts:354` say requests already sent still finish, and the plan keeps that behaviour.
  Note the difference in `M3-U` rather than change the code.

---

## Checks that passed (no finding)

- **Snippets against the types:**
  - `putWithXhr` and `createPut` fit `SignedRequest`, `BucketOutcome`, `ClientFetch`, `classifyAnswer` and
    `parseRetryAfter`.
  - The status handling matches `putObject`: 2xx or 412 means `stored`; a network failure, CORS refusal or abort
    gives `unreachable(signal)`.
  - The `return resolve(…)` pattern already exists in `retry.ts:pause`.
  - Biome accepts the chained `onerror = ontimeout = onabort` assignment (checked with the repo's `biome.json`).
  - `PartSender` and `sendParts` need no change for the wrapper. `withRetry` on `/complete` with `entry.cancel.signal`
    is sound.
  - The fixture's `Fault` and `forward` support the counting and holding faults the rows describe.
- **`createPool`:**
  - `drop` can run only while the entry is still waiting, because `grant` removes the listener synchronously right
    after `shift`.
  - Releasing twice frees one slot.
  - Insertion keeps ties in arrival order.
  - Row 2's grant order `[1,2]`, `[1,3]`, `[2,1]`a, `[2,1]`b is correct.
- **`createStore`:** the `dueMs` logic is correct. A refresh at +1000 is pulled forward to +100 by a byte change. An
  urgent publish clears any pending timer. Several throttled changes fold into one timer.
- **`createMeter` and the hand-worked numbers:**
  - 283.4687 (α = 1 − e^(−1/3), rate 1000 B/s).
  - 486.5829.
  - 179.0038 (× e^(−1)).
  - 921.1097 (3000 B over 500 ms, α = 1 − e^(−1/6)).
  - Snapshot ETA (10 000 − 2000) / 486.58 = 16.44.
  - Progress sequence `[40, 0, 0, 20]` → 60; the cap at 100; 150 for two stored parts.
  - Re-sent part bytes 4, 4 and 5 MiB.
  - Totals 1400 / 2000 = 0.7.
- **Requests and sizes:**
  - `["POST /upload", "PUT object", "POST /complete"]` matches `labelOf` in `client-fixture.ts`.
  - With `multipartThreshold: "8MB"` (binary, `size.ts`), 8 MiB × 8 + 1 = 67 108 865 B → 9 parts; the ticket signs
    all 9 (`PARTS_PER_SIGN` 20), so exactly 4 are in flight.
  - 8 MiB × 2 + 1000 → 3 parts.
  - 20 MiB = 20 971 520 B, which the example splits into 3 parts (`examples/next/lib/cloudrop.ts`).
  - The default `maxFiles` is 10 (`route.ts`), and per-file `FILE_TOO_LARGE` comes back as a rejected ticket.
- **Retry waits:** with `Math.random` mocked to 0, `retryDelay` is 0. Under fake timers it is still a `setTimeout`
  that the test must advance, as the plan says.
- **Order between tasks:** `PutObject` (T1) → wrapper (T3); `UploadContext` gains `pool` and `nextRank` (T3) → `rank`
  and ids (T4); `Entry` gains fields in T4, T5 and T6; `UploadJob` grows in T4, T5 and T6; `FileHandle` gains methods
  in T4 and T6. Nothing is consumed before it is produced.
- **Pause, resume and abort design:**
  - `landed` and the `PARTS_MISSING` removal work.
  - `mayBeComplete` stays sticky across passes.
  - Keep-or-abort on cancel works, a paused file included.
  - A pause racing the last part returns before `/complete`; the next pass sends nothing and then completes.
  - A pause while `/upload` is in flight waits in `resumed`.
  - A resume before the old pass has unwound starts a new pass correctly.
  - Expired URLs after a long pause are renewed through `expiresSoon`; past 24 hours the result is `UPLOAD_EXPIRED`
    from `/sign` or `/complete`.
  - The exception is I1.
- **Spec coverage:** the parts of §2, §4.1-4.5, §6 and §7 assigned to plan A each map to a task. The plan adds no
  `retry`, no `"auto"`, no `order` and no `lifecycle.ts`. The P1 to P9 rulings do not conflict with the spec.
- **Task 7 feasibility:**
  - Subclassing `window.XMLHttpRequest` works, because the transport reads it on every PUT (P6).
  - A manual `abort` event is required, since `abort()` on an XHR that is opened but not yet sent fires nothing; the
    plan says so.
  - CDP upload throttling is plausible (see M13).
  - Apart from I4 and I5, the existing anchors (the "completed" status line, request rows, "Sent to the bucket") can
    be kept.
