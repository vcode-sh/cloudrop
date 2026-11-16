# M3 uploader decisions

Decisions of the M3 progress and scheduler work (2026-11-16): bytes while they are sent, several files per call, one
connection pool per client, and pause, resume and cancel per file or per job, in `cloudrop/client`. Design:
`docs/superpowers/specs/2026-11-16-progress-scheduler-design.md`. Plan A:
`docs/superpowers/plans/2026-11-16-m3-progress-plan-a.md`, section "Rulings fixed by this plan"; its audit:
`docs/superpowers/plans/2026-11-16-m3-progress-plan-a.audit.md`. Plan B (automatic concurrency, smallest-first, stalls,
offline, `retry()`, part size): `docs/superpowers/plans/2026-11-16-m3-progress-plan-b.md`, same section; its audit:
`docs/superpowers/plans/2026-11-16-m3-progress-plan-b.audit.md`.

Numbering:

- `M3-U1` to `M3-U9` are plan A's rulings P1 to P9, with the same number.
- `M3-U10` to `M3-U13` are the design's decisions that spec §7 asks to record: the job's result, the snapshot, the pool
  and the budget. Fetch versus XHR is `M3-U6`, which records P6 together with spec §4.1.
- `M3-U14` to `M3-U22` are rulings taken while executing plan A that change behaviour or a public contract. Each names
  its source: an execution ledger ruling ("ledger"), a task report's ruling (`task 3 R1`, `R5-1`, `R6-1`) or a plan
  audit finding (`audit M12`). Task reports are kept with the plan's execution notes, not in the repository; each entry
  says what the ruling was.
- `M3-U23` to `M3-U39` are plan B's rulings Q1 to Q17, in order: `Q<n>` is `M3-U<n + 22>`.
- `M3-U40` upward are plan B's measured outcomes, owner decisions and execution rulings that change behaviour or a
  public contract, each naming its source as above (`task 2 R1`, `task 4 ruling 1`, `audit M4`).

The part-size outcome spec §7 asks for is `M3-U40`. The failed-file rule that amends `M3-S15` (spec §4.7: a failed file
of a `start()` job keeps its parts for `retry()` instead of the background `/abort`) is ruled in `M3-U29` to `M3-U38`
and carried out by plan B's task 5; its entry as built comes with that task, and until then `M3-S15` holds unchanged.

Rulings without an entry here, because an earlier entry holds them or they change neither behaviour nor a public
contract:

- Task 1 rulings 1 to 6 and task 2's `S-1`, `S-2`: test rows and the fake XHR's shape, and the XHR error handlers as
  three assignments to one function.
- Task 3 R3 (`senderFor` and `sendAndComplete` take one `Upload` object) and R4 (the pool rows live in
  `upload.test.ts`): internal shape and test layout. Task 3 R2 (when a file takes its rank) was replaced in task 4 by
  the file id (`M3-U2`, `M3-U9`).
- Task 4 rulings 1, 4, 5, 7, 8 and 9: test layout, internal types and how the rows prove what they prove. Ruling 3
  (`readTickets` refuses an answer with more tickets than files) is `M3-S16`. Ruling 2 (a file cancelled before its
  run starts goes through the normal ending, so it sends the `/abort` for its ticket and ends aborted) is `M3-S14`
  applied per file. Ruling 10 (the job keeps its own listener on its internal signal; the one on the caller's signal is
  removed when `done` settles) changes nothing a caller sees; plan B's `M3-U38` decides when that listener goes instead.
- `R5-4` to `R5-7`: the rows of the snapshot tests and where they live.
- `R6-3` (a round sends the file's parts that have not landed, so a `PARTS_MISSING` list naming a part outside
  `1..partCount` sends nothing): the answer checks of `M3-S16` already refuse such a list.
- `R7-1` to `R7-7`: the example's `/lab` page (which requests its wrappers record, notes per file, the "resumed" note,
  an extra browser row, the background `/abort` after a run, the status words, the ending sentence). The example is
  not a library contract; `examples/next/README.md` describes the lab.
- Audit C1 (the provisional 7.5 kB budget during plan A, so every task's `verify` could pass): `M3-U13` records the
  budget it led to.

Plan B rulings without an entry, for the same reasons:

- Task 2 R2 (no rate to compare is `lastRate = 0`, not null) is part of `M3-U44`. R3 (the idle row uses a 1500 ms gap,
  so it catches the idle rule alone) and R5 (a fixed pool still adds `sent`'s bytes to a window it never weighs): a
  test row and internal state.
- Task 3 R1 (the XHR watchdog is armed just before `send`, inside the `try`, so a `send` that throws leaves no timer):
  nothing a caller sees. R2 (a fetch PUT whose signal already fired sends nothing) is in `M3-U27`.
- Task 4 ruling 2 (offline pauses every file that can pause, not only running ones) is `M3-U39`. Ruling 4 (`resumeFile`
  clears the network mark, which no row can observe because every pause sets it afresh) and ruling 5 (`job.pause()`
  loops instead of `forEach`, which would pass the index as `byNetwork`): nothing a caller sees.
- Task 1 and task 6 ruled nothing beyond the recommendation that `M3-U40` records; task 6 replaced the planner rows
  that pinned 8 MiB parts for files now at 16 MiB.
- Audit I1, I3, I4, I8, M5, M9 to M11, M13 and M14: plan text, test rows, renamed rows and doc comments. I1 and I3 (the
  order of weighing a window and granting slots) are in `M3-U23`.
- The ledger's split of tasks 7 and 8 into halves that run beside task 5: how the plan was executed, not what it does.

Commit ids below are on the branch `feat/m3-progress-a` up to `M3-U22` and on `feat/m3-progress-b` from `M3-U23`.
Paths are under `packages/cloudrop/src/` unless they say otherwise.

## Plan rulings

### M3-U1: no `job.file(id)`

- **Decision:** a job's files are reached by position: `job.files[i]` and `getSnapshot().files[i]` are both in the
  order the files were passed. There is no lookup by id.
- **Why:** spec §9 left it to what the example needs, and the lab needs nothing else.
- **If wrong:** adding `file(id)` later is a non-breaking addition.
- **Status:** in force (`21c96cf`, `07f235b`).
- **Visible in:** `client/types.ts` (`UploadJob`), `examples/next/app/lab/file-rows.tsx`.

### M3-U2: file ids are the client's sequence number as text

- **Decision:** a file's `id` is `"1"`, `"2"`, … counted across every job of one client: unique per client and stable
  for the job's life. A job refused for its arguments takes no id.
- **Why:** readable in tests and logs, and independent of `crypto.randomUUID()`, which a page served over plain HTTP on
  a LAN address does not have.
- **If wrong:** ids collide across two clients on one page, or across page loads. A caller that needs global
  uniqueness keys on something else; the resume plan, which persists files, may need its own key.
- **Status:** in force (`21c96cf`).
- **Visible in:** `client/job.ts` (`startJob`), `client/types.ts` (`FileHandle.id`), `client/job.test.ts`.

### M3-U3: the job's error is the first file that did not end done

- **Decision:** `UploadResult.error` is the error of the first file, in the order passed, that did not end done.
- **Why:** deterministic, unlike "the first to fail in time", and it matches the order of `data.files`.
- **If wrong:** a caller that wants every error reads `data.files`, which is always there after `/upload` succeeded.
- **Status:** in force (`21c96cf`).
- **Visible in:** `client/job.ts` (`run`), `client/types.ts` (`UploadResult`).

### M3-U4: a completing file ignores `pause()`

- **Decision:** `pause()` applies to a queued or uploading file only. A file that is completing, whose bytes are all
  sent and whose `/complete` runs without the pass's signal (`M3-S14`), ignores it, as a settled file does. A
  `PARTS_MISSING` repair turns the file back to uploading, where pause applies again (`M3-U19`).
- **Why:** interrupting `/complete` is not possible without losing the keep-or-abort guarantee: the server may finish
  it anyway.
- **If wrong:** a user who pauses during a slow `/complete` sees the file end done instead of paused.
- **Status:** in force (`2f6dce9`).
- **Visible in:** `client/file-run.ts` (`pauseFile`), `client/pause.test.ts`.

### M3-U5: `upload()` with one `File` keeps its `Result`

- **Decision:** `upload(route, file)` with one `File` still returns that file's `Result<CompleteResponse<…>>`; its
  error now carries `error.file` like every per-file error. `upload(route, files)` with a list (an array or any
  `ArrayLike<File>`, such as `input.files`) returns the job's `UploadResult` (`M3-U10`). The list overload is declared
  first, so `ReturnType` and `Parameters` still read the single-file shape. Anything that is not a list takes the
  one-file path, so a wrong argument keeps the message it had (task 4 ruling 6).
- **Why:** existing callers keep working, and a list is the only case that needs a result per file.
- **If wrong:** a caller passing a one-element array gets an `UploadResult`, not a `Result`; the types say so.
- **Status:** in force (`21c96cf`). Supersedes `M3-S1` (one file per call).
- **Visible in:** `client.ts` (`CloudropClient.upload`, `oneFile`), `client/arguments.ts` (`isList`),
  `client/types.test.ts`.

### M3-U6: bucket PUTs go through XHR in a browser, unless a `fetch` option is passed

- **Decision:** the transport is chosen once, when the client is created: `XMLHttpRequest` when
  `globalThis.XMLHttpRequest` is a function and no `fetch` option was passed; otherwise `fetch` (the option, or the
  global one). XHR reports `upload.onprogress` as bytes are sent; `fetch` reports a part's bytes once, when it is
  stored. Calls to the upload server always use `fetch`. The XHR constructor is read from `globalThis` on every PUT, so
  a page that wraps it later (the lab) is seen. XHR sends exactly the signed headers, no cookies (`withCredentials`
  stays unset), and its answers go through the same classifier as `fetch` (`M3-S10`): status 0, `error`, `timeout` and
  `abort` are the opaque outcome a `fetch` `TypeError` is. There is no public transport option.
- **Why:** XHR is the one web API that reports upload progress (spec §4.1). Passing `fetch` means "send everything
  through mine", which is what tests and non-browser runtimes need.
- **If wrong:** a page that passes `fetch` for another reason (logging, a proxy) loses byte-level progress: its bar
  moves a part at a time. The lab's checkbox and browser row show that difference.
- **Status:** in force (`a5de46a`). Amends `M3-S8` (`fetch` everywhere).
- **Visible in:** `client/transport.ts`, `client.ts` (`createPut`), `src/testing/fake-xhr.ts`,
  `examples/next/app/lab.browser.test.ts`.

### M3-U7: the snapshot refreshes once a second while a file uploads

- **Decision:** while any file is uploading, the store publishes a new snapshot at least once a second, even without new
  bytes; once no file is uploading it schedules nothing.
- **Why:** a stalled transfer must show its speed decaying (spec §4.3); without a refresh the last speed would stay on
  screen.
- **If wrong:** one timer and one snapshot per second per uploading job.
- **Status:** in force (`d75c21a`, `07f235b`).
- **Visible in:** `client/store.ts` (`REFRESH_MS`), `client/types.ts` (`UploadJob.subscribe`).

### M3-U8: a listener that throws stops nothing

- **Decision:** a snapshot listener that throws does not stop the upload or the other listeners; its error is thrown
  again from a `setTimeout`, so the page still sees it as an uncaught error.
- **Why:** a rendering bug must not cancel uploads, and swallowing it would hide the bug.
- **If wrong:** a test runner on real timers reports the re-thrown error as unhandled; the tests run that row on fake
  timers (audit M8).
- **Status:** in force (`d75c21a`).
- **Visible in:** `client/store.ts` (`publish`).

### M3-U9: pool order is the file's rank, then the part number

- **Decision:** a waiting PUT is granted a slot by its file's rank, then its part number; equal ranks keep arrival
  order. The rank is the file id as a number (`M3-U2`), so files added earlier send first, across the jobs of one
  client. A released slot passes straight to the first waiter.
- **Why:** spec §4.4's "the order files were added, then part number"; handing the slot over directly means a new
  request cannot overtake the queue.
- **If wrong:** a small file added after a large one waits for the large file's parts; plan B's `smallest-first` order
  is the answer.
- **Status:** amended by `M3-U42`: with `order: "smallest-first"` the file's size comes before its rank (`c7f43d0`,
  `21c96cf`, `ea771fc`). The hand-over now grants waiters while slots are free (`M3-U23`).
- **Visible in:** `client/pool.ts`, `client/upload.ts` (`senderFor`), `client/pool.test.ts`.

## Design decisions

### M3-U10: a job, `UploadResult` and `error.file`

- **Decision:** `client.start(route, files, options?)` takes a `File` or a list, sends every file through one `/upload`,
  then runs each file on its own: one file failing or being cancelled never stops another. It returns an `UploadJob`
  at once (`files`, `done`, `abort`, `pause`, `resume`, `subscribe`, `getSnapshot`). `job.done` settles once, when every
  file has settled, and never rejects; it resolves to an `UploadResult`:
  `{ data: { files }, error: null }` when every file is done, `{ data: { files }, error }` when some did not
  (`M3-U3`), and `{ data: null, error }` when nothing started: the arguments were wrong, or `/upload` refused the
  whole job (`TOO_MANY_FILES` among others). `data.files` holds a `FileOutcome` per file: `done` with its `result`, or
  `failed`/`aborted` with its `error`. `CloudropError` gains an optional `file: { id, name }`, set on every error that
  belongs to one file. A job refused for its arguments has the same handles over no files: the calls do nothing and
  its snapshot is empty (`R5-3`). When `/upload` fails, a file cancelled on its own meanwhile ends `aborted` with its
  own `ABORTED` error and `error.file`; the others end `failed` with the job's error, which stays the result's.
- **Why:** owner decision 2026-11-16 (spec §2.2). `UploadResult` departs from `Result<T>`, where `data` is null
  whenever `error` is set, on purpose: a partial failure must not hide the files that succeeded. It keeps the
  `{ data, error }` shape, so `if (error)` still works.
- **If wrong:** a caller that treats every `error` as "nothing happened" misses the files that succeeded; the type's
  doc comment and the README say so. `error.file` is a new public field (a minor semver change).
- **Status:** in force (`21c96cf`, `07f235b`, `1850ba1`, `5cc63e5`). Supersedes `M3-S1`; spec §1 says so.
- **Visible in:** `client/job.ts`, `client/types.ts`, `errors.ts` (`CloudropError.file`), `client/failures.ts`
  (`withFile`), `client/job.test.ts`.

### M3-U11: the snapshot

- **Decision:** `getSnapshot()` returns the same object until something changes, then a new one, as
  `useSyncExternalStore` needs. Listeners are called at once on every status change and at most every 100 ms while
  bytes flow, plus the refresh of `M3-U7`. Per file: `status`, `bytes`, `size`, `progress`, `speed`, `eta`, `error`,
  `result`. `bytes` never decreases: a re-sent part, or a single PUT sent again after a pause, adds nothing until it
  passes the most an earlier attempt reached, and a stored part counts its whole size, so a done file has
  `bytes = size` (`R5-2`). `progress` is `bytes / size`; an empty file's is 0 before done and 1 once done. `speed` is
  an exponentially weighted average with a 3 s time constant, restarted when a file starts or resumes sending, and 0
  unless the file is uploading. `eta` is the bytes left over the speed, null while the speed is 0. Totals: see
  `M3-U17`. A cancelled file shows `aborted` at once; its `/abort` is sent after that, and `done` still waits for the
  server's answer.
- **Why:** spec §2.1, §4.2 and §4.3. The throttle keeps a page from rendering on every progress event; an immediate
  status change keeps buttons and labels correct.
- **If wrong:** a page that renders on every listener call still renders up to ten times a second per job.
- **Known cost:** job-level `pause()`, `resume()` and a refused `/upload` publish once per file, each publish building
  a snapshot of every file (a 500-file job: 500 publishes of 500 file snapshots, synchronously). Unmeasured; plan B
  measures it and coalesces urgent publishes if it shows.
- **Status:** in force (`d75c21a`, `07f235b`, `5cc63e5`). Plan B decided one exception (`M3-U36`): a retry under a new
  ticket starts the file's bytes again from 0.
- **Visible in:** `client/store.ts`, `client/progress.ts`, `client/job.ts` (`fileSnapshot`, `snapshotOf`),
  `client/types.ts` (`FileSnapshot`, `JobSnapshot`), `client/job-snapshot.test.ts`.

### M3-U12: one pool per client, 4 slots by default

- **Decision:** each client has one pool of connection slots, shared by every job and every `upload()` call of that
  client. A slot is held by one bucket PUT, single or part, and is free again before a retry's wait; calls to the
  upload server take none. `concurrency` is a whole number from 1 to 16, default 4; anything else throws
  `INVALID_CONFIG` ("concurrency must be a whole number from 1 to 16."). A file still has at most 4 PUTs in flight
  (`PARTS_IN_FLIGHT`, `M3-S12`). One job is one `/upload`; the route's `maxFiles` is policy, so a job with more files
  fails whole with `TOO_MANY_FILES`, never split. There is no `"auto"` and no `order` option yet (plan B).
- **Why:** spec §4.4. Measured on R2 on 2026-11-16: 4 connections reached 60 MiB/s and 16 reached 71 MiB/s, so 4 is
  most of the link without crowding the page's other requests.
- **If wrong:** a fast link with many small files is under-used until plan B's automatic sizing; a caller can raise
  `concurrency` meanwhile.
- **Status:** amended by `M3-U41`: the default is `"auto"`, which starts at 4, and the message names it (`c7f43d0`,
  `21c96cf`, `ea771fc`).
- **Visible in:** `client/pool.ts`, `client.ts` (`ClientOptions.concurrency`), `client/upload.ts` (`senderFor`),
  `client/upload.test.ts`.

### M3-U13: `cloudrop/client`'s budget is 7.4 kB gzip

- **Decision:** the bundled `cloudrop/client` budget is 7.4 kB gzip: the 6712 B measured at the end of plan A plus about
  10 %, as every budget here is set. The owner's ceiling for the client, set 2026-11-16 (spec §7), is 7.5 kB, and spec
  §1's "client plus React" target moves from about 8 kB to about 10 kB. Plan A's 6.5 kB stop line was a planning
  guard, not the owner's limit (ledger ruling after task 5); a size pass at the end of plan A cut 34 B (`1850ba1`) and
  found nothing else to remove without golf.
- **Why:** progress, the pool, several files and pause added about 2.4 kB to the 4.31 kB slice. The messages stay full
  sentences (`M3-S32`).
- **If wrong:** plan B has about 0.8 kB left under the ceiling (0.7 kB under this budget) for automatic concurrency,
  smallest-first, stalls, offline and `retry()`. If that is not enough, plan B trims or asks the owner; M4's React
  bindings then have about 2.5 kB of the 10 kB.
- **Status:** amended by `M3-U43`: the ceiling is 9.0 kB for the rest of M3 and the "client plus React" target about
  11 kB. Supersedes `M3-S32` (4.7 kB); the provisional 7.5 kB during plan A came from audit C1.
- **Visible in:** `scripts/size-limit.config.ts`.

## Execution rulings

### M3-U14: a part waiting for a slot never starts after its file failed or was cancelled

- **Decision:** task 3 R1. `PartSender.put` takes a third argument, `stop`, the run's signal that fires on a cancel or
  once one part has failed the file. The pool wrapper waits for a slot on `stop` and checks it again after the grant;
  the PUT itself keeps the pass's signal, so a PUT already sent still finishes.
- **Why:** before the pool, `sendPart` checked for a failure right before each PUT. With the pool in between, a part
  past that check but queued for a slot still sent its PUT when granted: measured with `concurrency: 1`, a 4-part file
  whose part 1 is refused sent parts 2, 3 and 4 before the result came back. That broke spec §6.2's "the first part
  that fails for good stops new parts".
- **If wrong:** `parts.ts` changed, against plan A's "parts.ts does not change"; the change is one argument.
- **Status:** in force (`c7f43d0`).
- **Visible in:** `client/parts.ts` (`PartSender.put`), `client/upload.ts` (`senderFor`), `client/upload.test.ts`.

### M3-U15: at most one PUT can still start after a part fails its file

- **Decision:** task 3 C1, accepted as it is. The failing part's slot is released in the wrapper's `finally`, which
  hands it to the next waiter before `parts.ts` reads the answer and fires `stop`; that waiter's continuation runs
  first and sends its PUT. Every later waiter sees `stop` and drops. A cancel has no such window.
- **Why:** closing it means moving slot handling into `sendPart`, which the plan's architecture keeps out of
  `parts.ts`; the one extra PUT is bounded.
- **If wrong:** one extra PUT per failing file, whose part the background `/abort` (`M3-S15`) cleans up. The unit row
  pins it as `["PUT part 1", "PUT part 2"]`.
- **Status:** in force (`c7f43d0`).
- **Visible in:** `client/upload.ts` (`senderFor`), `client/upload.test.ts`.

### M3-U16: `ArrayLike<File>` instead of `FileList`, and no `AbortSignal.any`

- **Decision:** audit M12, ledger, and `R6-1`. `start()` and `upload()` accept `File | ArrayLike<File>`, which covers an
  array and `input.files` without naming `FileList` in the `.d.ts`. Signals are combined by hand: each file adds one
  listener on its cancel signal that aborts the current pass and wakes a paused file, so a pass's own signal is the
  only one its PUTs and `/sign` calls hear (`/complete` keeps the cancel signal, `M3-S14`).
- **Why:** `FileList` needs the DOM lib in a consumer that checks lib types; `AbortSignal.any` would raise the browser
  floor to Safari 17.4, Firefox 124 and Chrome 116. One listener per file replaced a helper and a listener per pass.
- **If wrong:** an object with a numeric `length` that is not a list of files is refused at run time
  (`INVALID_INPUT`), not at compile time. Raising the floor later would save about five lines.
- **Status:** in force (`21c96cf`, `2f6dce9`).
- **Visible in:** `client.ts` (`CloudropClient`), `client/arguments.ts`, `client/file-run.ts` (`runFile`).

### M3-U17: totals count only the files that can still deliver

- **Decision:** audit M3 and `R5-1`. `totals.bytes`, `size`, `progress`, `speed` and `eta` count only the files that did
  not fail or abort; `done`, `failed` and `aborted` count files, and `count` is every file of the job. When the
  counted size is 0, `progress` is 1 once at least one counted file exists and every counted file is done, else 0: a
  job with nothing left to count (every file failed or aborted, or no files) shows 0, not a finished 1.
- **Why:** a failed file sends no more, so counting it would hold the job below 1 for good and put bytes that will
  never be sent into the ETA; a job of empty files must not divide by zero.
- **If wrong:** a page that wants "of all bytes" computes it from `files`. After a failure the bar can jump forward
  as the failed file's size leaves the total.
- **Status:** in force (`07f235b`).
- **Visible in:** `client/job.ts` (`snapshotOf`), `client/types.ts` (`JobSnapshot`), `client/job-snapshot.test.ts`.

### M3-U18: a failing part stops new requests; requests already sent finish

- **Decision:** audit M14. When one part fails its file, no new part and no new attempt starts (`M3-U14`, `M3-U15`),
  but PUTs already in flight finish. Spec §4.6 says the file's "other PUTs stop at once (as since commit `7bf1d89`)";
  that commit's message and the code have always let sent requests finish, and the code is kept.
- **Why:** aborting a PUT in flight saves nothing the background `/abort` does not clean up, and the behaviour has been
  tested since the slice (spec §6.2).
- **If wrong:** a failing file's last PUTs use the connection a little longer.
- **Status:** in force (`7bf1d89`, kept through plan A). Spec §4.6's wording is the outlier.
- **Visible in:** `client/parts.ts` (`sendParts`).

### M3-U19: a repair is uploading at once, and its count survives a pause

- **Decision:** audit M2 and `R6-2`. When `/complete` answers `PARTS_MISSING`, the file turns `uploading` at once
  (restarting its speed), before its repair PUTs get a slot, so a pause applies to the repair (`M3-U4`). The count of
  repair rounds lives on the file's upload, not on one pass, so pausing and resuming does not reset `M3-S13`'s limit
  of two.
- **Why:** otherwise a pause after a `PARTS_MISSING` answer was ignored until a slot came, and every pause granted two
  more repair rounds.
- **If wrong:** none known.
- **Status:** in force (`2f6dce9`).
- **Visible in:** `client/upload.ts` (`sendAndComplete`, `Upload.repairs`), `client/pause.test.ts`.

### M3-U20: a paused or cancelled pass ends before `/complete`

- **Decision:** `R6-4` and task 6. A pass whose signal fired after the last part landed returns `ABORTED` before
  `/complete`: a paused file stays paused and sends nothing until resumed, then completes without sending a PUT
  again; a cancelled file goes straight to `aborted` without showing `completing`. Each pass starts from the ticket's
  first URLs.
- **Why:** `/complete` runs without the pass's signal (`M3-S14`), so starting it after a pause would ignore the pause.
- **If wrong:** URLs renewed in an earlier pass are forgotten, so a long pause may cost one extra `/sign` (the
  `expiresSoon` check and the opaque-failure renewal of `M3-S11` do it). During a cancel that meets a `PARTS_MISSING`
  answer, the file may show `uploading` for a moment before `aborted`.
- **Status:** in force (`2f6dce9`).
- **Visible in:** `client/upload.ts` (`sendAndComplete`), `client/file-run.ts` (`runFile`), `client/pause.test.ts`.

### M3-U21: status moves, and a pause is never lost to a slot grant

- **Decision:** audit I1 and `R6-5`. A file starts `queued`; it turns `uploading` when one of its PUTs gets a slot, and
  only from `queued`; `completing` before each `/complete`; then `done`, `failed` or `aborted`. `pause()` moves a
  queued or uploading file to `paused`; `resume()` moves it back to `queued`, and to `uploading` again on its first
  granted PUT (or to `completing` when nothing is left to send). After a slot is granted, the wrapper checks the stop
  signal before it changes the status or sends; a grant that arrives after a pause gives the slot back unused.
- **Why:** the grant resolves one microtask before the wrapper runs, and a pause in that gap would otherwise be
  overwritten by `uploading`, so the file kept sending after the user pressed Pause.
- **If wrong:** none known; the same-microtask case is guarded but has no row of its own.
- **Status:** in force (`21c96cf`, `2f6dce9`).
- **Visible in:** `client/upload.ts` (`senderFor`, `moveTo`), `client/file-run.ts` (`pauseFile`, `resumeFile`),
  `client/pause.test.ts`.

### M3-U22: a failure that wins the race with a pause ends the file

- **Decision:** audit M1. A pass that ends while paused is taken as a pause only when its error is `ABORTED`, its own
  signal fired and the file was not cancelled. A real failure that arrived first (an `UPLOAD_REJECTED` part while the
  user pauses) ends the file failed.
- **Why:** treating every error after a pause as the pause would send the file again after resume, to fail again.
- **If wrong:** none known; the race has no unit row.
- **Status:** in force (`2f6dce9`).
- **Visible in:** `client/file-run.ts` (`runFile`).

## Plan B rulings

`M3-U23` to `M3-U28` and `M3-U39` are in force. `M3-U29` to `M3-U38` rule `retry()` and the failed-file rule, which
plan B's task 5 carries out: they are decided, and their files are the ones that task changes.

### M3-U23: automatic sizing weighs a window only when the pool is used

- **Decision:** plan B Q1, with audit I1 and I3. An automatic pool (`concurrency: "auto"`, the default since `M3-U41`)
  starts with 4 slots and weighs the bytes the bucket accepted per millisecond over windows of at least 2000 ms. A
  window is weighed only when the pool is used (an `acquire`, a release, `sent`), never on a timer. When a due window's
  rate is at least 1.1 times the previous window's, work is waiting and the pool has fewer than 8 slots, it adds one.
  Every `acquire`, release and `sent` first closes a window that is due, then grants waiters in rank order while slots
  are free; an `acquire` never overtakes a waiter. The bytes of the `sent` call that closes a window count in the new
  one, which starts at that moment.
- **Why:** an idle client holds no timer. Since a window closes only when the pool is next used, windows differ in
  length, and bytes per millisecond compares them fairly where totals would not.
- **If wrong:** a window can run past 2 s until the next call; a busy pool is called many times a second, and a window
  over 4 s is not compared at all (`M3-U44`). Growth stops at 8 even where more would help; a caller sets a number.
- **Status:** in force (`ea771fc`).
- **Visible in:** `client/pool.ts` (`createPool`, `update`), `client/pool.test.ts`.

### M3-U24: one halving per window

- **Decision:** plan B Q2. `slowDown()` halves an automatic pool (rounded down, at least 1), starts a new window and
  holds: another `slowDown()` before that window closes does nothing, and the window's close only clears the hold, so
  it cannot grow. The window after can. A fixed pool ignores `slowDown()` and never weighs `sent`.
- **Why:** one cause, such as a dropped link, fails every PUT in flight at once; halving per failure would take the pool
  to 1 for a single event.
- **If wrong:** a link that keeps failing loses at most half its slots per window, and regaining each slot takes at
  least one window of rising throughput.
- **Status:** in force (`ea771fc`).
- **Visible in:** `client/pool.ts` (`slowDown`), `client/pool.test.ts`.

### M3-U25: what slows the pool down

- **Decision:** plan B Q3. A PUT whose outcome is opaque (a network error, a refusal CORS hides, a stall: `M3-U27`) or
  a `RATE_LIMITED` answer (429 or 503 from the bucket) calls `slowDown()`. A `STORAGE_ERROR` (500), a refusal such as
  `UPLOAD_REJECTED` and a cancel do not.
- **Why:** spec §4.4 names 429 or `SlowDown`, stalls and network errors: signs of too many connections or a congested
  link. A 500 is the bucket's own fault, and fewer connections do not cure it.
- **If wrong:** a bucket that answers 500 under load is not relieved. A page whose CORS rule is wrong sees its pool
  shrink to 1 before every PUT fails, which it does either way.
- **Status:** in force (`ea771fc`).
- **Visible in:** `client/upload.ts` (`senderFor`), `client/bucket.ts` (the classifier), `client/upload.test.ts` (the
  429 row).

### M3-U26: no public pool size

- **Decision:** plan B Q4. Neither the client nor the snapshot exposes how many slots the pool has. The example's lab
  shows the PUTs in flight from its own `XMLHttpRequest` wrapper.
- **Why:** the size changes every few seconds and is an implementation detail; exposing it would make it a contract and
  cost bundle bytes for something only a demo shows.
- **If wrong:** a read-only size can be added later without breaking anyone.
- **Status:** in force (`ea771fc`: the pool is not exported). The lab's counter comes with plan B's task 7.
- **Visible in:** `client.ts`, `examples/next/app/lab/`.

### M3-U27: a stall is the network-error outcome

- **Decision:** plan B Q5, with task 3 R2 and audit M3. An XHR PUT that goes 30 s without a progress event, or a fetch
  PUT still running 30 s plus its size at 100 KiB/s after it started (a 1 MiB body: 40 240 ms), is aborted and reported
  as the opaque outcome: `NETWORK_ERROR` with the existing message and no wait before the next attempt. Like any opaque
  outcome it costs one attempt of the budget (`M3-S9`), renews the URL once (`M3-S11`) and slows an automatic pool
  (`M3-U25`). The fetch PUT runs on its own controller, which the timer or the caller's signal aborts (a listener, no
  `AbortSignal.any`: `M3-U16`); when the caller's signal has already fired, the controller is aborted at once and no
  request is sent. Only an abort the caller caused is reported as `ABORTED`.
- **Why:** spec §4.6. A stall is handled exactly as a dropped connection, so a new code would add a message, a
  classifier row and docs for nothing a caller can do differently. A listener added to a signal that already fired
  never runs, so without the check the PUT would go out and only the timer would stop it.
- **If wrong:** a caller cannot tell a stall from a network error. Slow answers count too (`M3-U47`).
- **Status:** in force (`a3172d5`).
- **Visible in:** `client/transport.ts` (`STALL_MS`, `SLOWEST_BYTES_PER_MS`), `client/transport.test.ts`.

### M3-U28: a file paused by the network is `paused`

- **Decision:** plan B Q6. `offline` pauses files as `pause()` does and marks them paused by the network; the snapshot
  shows `paused`, with no status of its own. `online` resumes only marked files. The caller's `pause()` on a marked
  file, or `resume()` of it, clears the mark: from then on the file is the caller's.
- **Why:** a new status is a public type every page must render, for a state in which the caller can do nothing else.
  Clearing the mark keeps `online` from undoing the user's Pause.
- **If wrong:** a page cannot say "waiting for the network" from the snapshot alone; it can read `navigator.onLine`.
- **Status:** in force (`58d24f7`).
- **Visible in:** `client/file-run.ts` (`Entry.networkPaused`, `pauseFile`, `resumeFile`), `client/job-run.ts`
  (`watchedRuns`), `client/lifecycle.test.ts`.

### M3-U29: `upload()` keeps `M3-S15`

- **Decision:** plan B Q7, confirmed by the owner on 2026-11-16 (audit I12). Only files of `start()` jobs keep a
  failed file's ticket and parts for `retry()` (spec §4.7). `upload()` returns no handle, so nothing could retry its
  failed file: its failure still sends `M3-S15`'s background `/abort`.
- **Why:** parts nobody can retry would wait for the lifecycle rule, and a single-PUT object would stay in the bucket
  for good: the cost `M3-S15` was made to remove.
- **If wrong:** a page that wants to retry a failure of `upload()` calls `start()` instead.
- **Status:** decided; plan B's task 5 carries it out (`upload()` passes `keepFailed: false`). Spec §4.7's first
  bullet says so since this entry.
- **Visible in:** `client.ts` (`upload`), `client/upload-abort.test.ts`.

### M3-U30: `retry()` chooses its branch when it is called

- **Decision:** plan B Q8, with audit I6. When a `/complete` of the file may have succeeded, `retry()` sends
  `/complete` with the kept ticket, whatever the clock says: success ends the file done, any other answer ends it
  failed with that answer. Otherwise it keeps the ticket when the file has one that has not expired, was not aborted,
  and failed with an error that ticket can still fix (`M3-U31`); else it asks `/upload` for a new one. One call never
  falls back from one branch to another.
- **Why:** spec §4.7's order. `/complete` comes first because a second upload under a new key would leave two objects
  and run `onComplete` twice when the first did finish. One branch per call keeps the requests of a retry predictable.
- **If wrong:** a same-ticket retry that fails with an error from `M3-U31`'s list takes a second `retry()` to get a
  new ticket.
- **Status:** decided (plan B task 5).
- **Visible in:** `client/file-run.ts`, `client/job.ts`.

### M3-U31: the errors that need a new ticket

- **Decision:** plan B Q9. `UPLOAD_EXPIRED`, `INVALID_TOKEN`, `UPLOAD_REJECTED`, `VERIFICATION_FAILED`, and any failure
  of a file that never had a ticket (refused at `/upload`, or the job's own error), make `retry()` ask `/upload` for a
  new ticket. Every other error is retried with the same ticket.
- **Why:** each of these says the ticket, its URLs or what was stored cannot finish this upload: a part the bucket
  refused (400, a signature mismatch) would be refused again under the same ticket.
- **If wrong:** an error missing from the list spends one `retry()` on the old ticket; one wrongly on it re-sends a file
  that could have finished.
- **Status:** decided (plan B task 5).
- **Visible in:** `client/file-run.ts`.

### M3-U32: `abort()` on a failed file

- **Decision:** plan B Q10. Aborting a failed file that holds a ticket sends its `/abort`, except when a `/complete`
  may have succeeded (keep-or-abort, `M3-S14`), and turns the file `aborted` in both cases. `done` has already settled;
  only the snapshot and a later `retry()` see the change.
- **Why:** spec §4.7 holds a failed file's parts until `abort()`, `pagehide` or the token's expiry; `abort()` is how a
  page lets them go.
- **If wrong:** after such an abort the snapshot says `aborted` while `done` said `failed` (`M3-U35`).
- **Status:** decided (plan B task 5).
- **Visible in:** `client/file-run.ts`, `client/job.ts`.

### M3-U33: `pagehide` gives up failed files' tickets

- **Decision:** plan B Q11. On `pagehide` the client sends a `keepalive` `/abort` for every failed file that holds a
  ticket and no `/complete` that may have succeeded, and marks that ticket aborted, so a `retry()` after a back-forward
  cache restore asks for a new one. Files still uploading or paused are left to the bucket's lifecycle rule, as before.
- **Why:** spec §4.7. A closed tab must not leave a failed single-PUT object in the bucket for good, and a restored page
  must not retry with a ticket whose upload `/abort` removed. `pagehide`, unlike `unload`, does not block the
  back-forward cache.
- **If wrong:** a page that closes without `pagehide` firing (a crash) leaves a failed single-PUT object in the bucket;
  a restored page re-sends the whole file under a new key.
- **Status:** decided (plan B task 5).
- **Visible in:** `client/lifecycle.ts`.

### M3-U34: `job.retry()` asks for new tickets in one `/upload`

- **Decision:** plan B Q12. `job.retry()` retries every failed file of the job; those that need a new ticket share one
  `/upload`, so the route's `maxFiles` and `authorize` apply to them as one job and `TOO_MANY_FILES` fails them
  together, never split silently. `file.retry()` asks for its own file alone.
- **Why:** one job is one `/upload` (`M3-U12`).
- **If wrong:** one refusal of that `/upload` fails every file that needed a ticket; `file.retry()` retries one at a
  time.
- **Status:** decided (plan B task 5).
- **Visible in:** `client/job.ts`.

### M3-U35: `done` reports each file's first outcome

- **Decision:** plan B Q13, from audit C1. A file's outcome is recorded when it first settles, and a later `retry()`
  never changes it; `job.done` is built from those. `job.retry()` resolves only when every file of the job has settled
  (it waits for files still running), with their current outcomes.
- **Why:** a file retried while another still ran would have reached `done` as failed without an error, and `error`
  null beside a failed file breaks `UploadResult` (`M3-U10`).
- **If wrong:** after a retry `done` and the snapshot disagree; a page that wants the latest outcome reads
  `job.retry()`'s result or the snapshot.
- **Status:** decided (plan B task 5).
- **Visible in:** `client/job.ts`, `client/job-run.ts`.

### M3-U36: a new ticket starts the bytes again

- **Decision:** plan B Q14, from audit I10. A retry that gets a new ticket gives the file a fresh byte count and speed
  meter, so its `bytes` drop to 0. A same-ticket retry keeps them. This is an explicit exception to spec §4.2 and to
  `M3-U11`'s "bytes never decreases".
- **Why:** the new upload has stored nothing; keeping the old count would show 90 % or 100 % of a file of which nothing
  has landed.
- **If wrong:** a bar jumps back to 0 on such a retry, which is what happened to the upload.
- **Status:** decided (plan B task 5).
- **Visible in:** `client/file-run.ts`, `client/progress.ts`.

### M3-U37: `retry()` on a file that has not failed

- **Decision:** plan B Q15, from audit I11. On a queued, uploading, paused or completing file `retry()` sends nothing
  and resolves with the file's outcome when it next settles; on a done or aborted file, at once with that outcome.
  `job.retry()` on a job refused for its arguments resolves with the same `{ data: null, error }` as `done`.
- **Why:** an outcome is always a settled state, so the promise waits for one; a Retry button pressed twice must not
  start a second run.
- **If wrong:** a page awaiting `retry()` of a paused file waits until the user resumes it.
- **Status:** decided (plan B task 5).
- **Visible in:** `client/file-run.ts`, `client/job.ts`.

### M3-U38: one `abortFile` for every cancel

- **Decision:** plan B Q16, from audit I9 and M8. The file's `abort()`, `job.abort()` and the caller's signal all go
  through one routine: a running file is cancelled as before; a failed file holding a ticket follows `M3-U32`. The
  listener on the caller's signal stays while any file of the job runs or is held, and is removed when none is.
- **Why:** before, `job.abort()` and the signal reached only running files: a failed file kept its ticket after the job
  was aborted, and a signal fired after `done` stopped neither held files nor a running retry.
- **If wrong:** a long-lived signal keeps the job reachable while a failed file is held, until its expiry or
  `pagehide`. Changes plan A's task 4 ruling 10 (the listener went when `done` settled).
- **Status:** decided (plan B task 5).
- **Visible in:** `client/file-run.ts`, `client/job.ts`.

### M3-U39: offline pauses queued and uploading files, also at the start

- **Decision:** plan B Q17, from audit M1 and M2, with task 4 ruling 2. `offline` pauses every file of the job that
  can pause, queued as well as uploading (spec §4.6 says uploading). Where the page is already offline
  (`navigator.onLine === false`) when the job's files start, they pause at once, before any PUT, and `online` resumes
  them.
- **Why:** a queued file would start right after and spend its attempts against no network, and a page that is already
  offline fires no `offline` event.
- **If wrong:** a `navigator.onLine` that reads false while the bucket is reachable holds the files until an `online`
  event; browsers report false only when no network interface is up.
- **Status:** in force (`58d24f7`).
- **Visible in:** `client/lifecycle.ts` (`watchConnectivity`), `client/job-run.ts` (`watchedRuns`),
  `client/lifecycle.test.ts`.

## Plan B outcomes and execution rulings

### M3-U40: files of 256 MiB or more start at 16 MiB parts

- **Decision:** plan B task 1's recommendation, applied by task 6. `planParts` starts files of 256 MiB or more at
  16 MiB parts and keeps 8 MiB below. The doubling that keeps a file within 10,000 parts, the 64 MiB multipart
  threshold and equal parts are unchanged; on R2 the doubling now begins above 156.25 GiB instead of 78.1 GiB.
- **Why:** measured on live R2 on 2026-11-16 (`docs/research/r2-spike-findings.md`, "Part size, 2026-11-16"): 256 MiB
  files, part sizes 8, 16 and 32 MiB × 4, 6 and 8 PUTs at a time, n = 6 per cell, from Node and from headless
  Chromium. Medians, 8 → 16 MiB: Node 60.5 → 76.3 MiB/s at 4 (+26 %) and 108.0 → 122.7 at 8 (+14 %); browser 44.5 →
  69.5 at 4 (+56 %) and 73.8 → 89.3 at 8 (+21 %). The plan's rule (at least 15 % faster at 4 and not slower at 8, in
  both runtimes) held in each of the two matrices and in both together. 32 MiB was not chosen: level with 16 MiB in
  Node at 4 and slower at 8, it failed the rule in the first matrix (Node +8 % at 4), and it halves the parallelism a
  file can use and doubles what a retried part re-sends.
- **If wrong:** files from 64 to 256 MiB were not measured and keep 8 MiB. A part retried or re-sent after a pause
  costs up to 16 MiB instead of 8. A ticket issued before the change keeps its plan, which the token carries.
- **Status:** in force (`8f50795`; the measurement `2365ae6`). Design spec §5.1 and progress spec §5 say so.
- **Visible in:** `plan.ts` (`LARGE_FILE_SIZE`, `LARGE_FIRST_PART_SIZE`, `planParts`), `plan.test.ts`.

### M3-U41: `concurrency` defaults to `"auto"`, which still starts at 4

- **Decision:** plan B task 2, spec §4.4 and §9. `concurrency` defaults to `"auto"` (`M3-U23`); a whole number from 1
  to 16 fixes the pool's size; anything else throws `INVALID_CONFIG` with `concurrency must be "auto" or a whole number
  from 1 to 16.` The pool numbers stay as spec §4.4 set them: start at 4, windows of 2 s, a rise of 10 %, at most 8.
- **Measured:** in task 1's runs 6 connections beat 4 by 18 to 62 % at every part size in both runtimes (Node, 8 MiB
  parts: 60.5 → 71.5 MiB/s, 16 MiB: 76.3 → 102.4; browser, 8 MiB: 44.5 → 72.0, 16 MiB: 69.5 → 99.2).
- **Why 4 still:** the measurement is one machine on a 10 GbE LAN sending one 256 MiB file with nothing else on the
  page; the start applies to every page on every link. Where more connections raise throughput, the pool can reach 6
  after two windows of rising bytes (about 4 s); a slow or shared link never pays for connections it cannot use. A
  browser on HTTP/1.1 opens at most 6 connections per host and the page's own requests share them, and the HTTP
  version Chromium used against R2 was not measured.
- **If wrong:** a fast link sends the first seconds of each burst over 4 connections instead of 6; a caller who knows
  its link passes a number.
- **Status:** in force (`ea771fc`). Amends `M3-U12` (default 4).
- **Visible in:** `client.ts` (`ClientOptions.concurrency`), `client/pool.ts`, `client.test.ts`.

### M3-U42: `order: "smallest-first"`

- **Decision:** plan B task 2, spec §4.4. The client option `order` is `"added"` (the default, `M3-U9`) or
  `"smallest-first"`; anything else throws `INVALID_CONFIG` with `order must be "added" or "smallest-first".` With
  `"smallest-first"` a waiting PUT's rank is its file's size, then the file's rank, then the part number, across every
  job of the client: smaller files get slots first, equal sizes keep the order they were added.
- **Why:** with `"added"` a small file added after a large one waits for the large file's parts (`M3-U9`); a page that
  shows many thumbnails wants the small ones finished first.
- **If wrong:** a large file can wait as long as smaller files keep coming; there is no ageing.
- **Status:** in force (`ea771fc`). Amends `M3-U9`.
- **Visible in:** `client.ts` (`ClientOptions.order`), `client/upload.ts` (`senderFor`), `client/upload.test.ts`.

### M3-U43: the client's ceiling is 9 kB

- **Decision:** owner decision 2026-11-16 (plan B ledger, audit I13). The ceiling for the bundled `cloudrop/client` is
  9.0 kB gzip for the rest of M3, plan B and the resume plan, instead of raising it plan by plan; spec §1's "client
  plus React" target becomes about 11 kB. `scripts/size-limit.config.ts` reads 9 kB until plan B's last step sets the
  budget: the measured size plus about 10 %, rounded up to 0.1 kB, never above 9.0 kB.
- **Why:** the audit estimated 7.6 to 7.9 kB after plan B, above `M3-U13`'s 7.5 kB, and a forced stop at the last task
  would have cut scope late. Measured: 6.74 kB after plan A, 7.38 kB with tasks 2, 3, 4 and 6 merged.
- **If wrong:** M4's React bindings have about 2 kB of the 11 kB.
- **Status:** in force (`fbc5c15`); the budget comes with plan B's last step. Amends `M3-U13`.
- **Visible in:** `scripts/size-limit.config.ts`.

### M3-U44: a window weighs only time the pool was busy

- **Decision:** task 2 R1 and R2, from audit I2. An `acquire` on a pool with no slot in use starts a fresh window with
  no rate to compare, and a window longer than 4000 ms is not compared either: both leave the rate at 0, which means
  "nothing to compare". The pool grows only when the previous and the current rate are both above 0.
- **Why:** a client created at page load and first used minutes later would read a near-empty window, then any window
  as a rise, and climb to 8 one step per window whatever the throughput; so would every gap between jobs and every
  window during a stall. With fetch a part's bytes arrive only when it is stored, so empty windows are common. The
  audit's "a window that began while idle", read against the pool's creation, would also discard the first busy
  window; restarting at the first `acquire` after idleness discards exactly the idle time.
- **If wrong:** after each idle gap the pool needs two windows (4 s or more) before it can grow again, and a fetch
  transport with large parts may grow rarely.
- **Status:** in force (`ea771fc`).
- **Visible in:** `client/pool.ts` (`acquire`, `LONGEST_WINDOW_MS`), `client/pool.test.ts` (the idle rows).

### M3-U45: the slow-down comes before the slot's release

- **Decision:** task 2 R4. After an outcome that slows the pool (`M3-U25`), the PUT wrapper calls `slowDown()` before
  it releases its slot.
- **Why:** a release grants waiters up to the size it sees; releasing first would hand the slot to a waiter at the old
  size, the opposite of slowing down.
- **If wrong:** none known.
- **Status:** in force (`ea771fc`).
- **Visible in:** `client/upload.ts` (`senderFor`), `client/upload.test.ts` (the 429 row).

### M3-U46: the pool counts only bytes no attempt sent before

- **Decision:** audit M12. The pool's `sent` receives what `progress.sent` returns: only bytes above a part's earlier
  best (`M3-U11`). Bytes sent again after a stall, a pause or a failed attempt are not throughput.
- **Why:** the pool should grow on what the bucket newly accepts, the number the progress bar shows; counting re-sent
  bytes would let a pool that keeps losing parts read them as a rise.
- **If wrong:** a pool recovering from many retries reads a lower rate than the link carried and grows later.
- **Status:** in force (`ea771fc`).
- **Visible in:** `client/upload.ts` (`senderFor`), `client/progress.ts`.

### M3-U47: a slow answer counts as a stall

- **Decision:** audit M4. The XHR watchdog runs on upload progress events, which stop once the body is sent: an answer
  that comes more than 30 s after the last progress event, or an XHR the browser keeps queued behind its per-host
  connection limit for 30 s, is aborted as a stall (`M3-U27`) and costs an attempt.
- **Why:** it conforms to spec §4.6: from the page, such a request cannot be told from one that hangs. The limit sits
  well above what R2 showed: in task 1's runs 9 of 108 uploads took 11.1 to 12.8 s instead of 2 to 5 s, and in the
  four browser cases one part took 10.4 to 11.2 s and then succeeded. None comes near 30 s, so the watchdog would have
  cut none of them; one shorter than about 10 s would have.
- **If wrong:** a bucket that takes over 30 s to answer a PUT loses an attempt each time. With HTTP/1.1 and a fixed
  `concurrency` above 6 the browser queues PUTs to one host; HTTP/2 removes that case. Which one Chromium used against
  R2 is not known.
- **Status:** in force (`a3172d5`).
- **Visible in:** `client/transport.ts` (the comment over `STALL_MS`).

### M3-U48: the offline check lives with the listeners

- **Decision:** task 4 ruling 1. `watchConnectivity` reads `navigator.onLine` only after it added its listeners, and
  only where the global has `addEventListener`. A runtime whose `navigator.onLine` is false but that has no
  `addEventListener` uploads as if online.
- **Why:** a file paused there could never resume, since no `online` event would arrive. Checking at registration also
  means every start of watching checks it, including a retry's.
- **If wrong:** none known; no such runtime is known (Node's `navigator` has no `onLine`).
- **Status:** in force (`58d24f7`).
- **Visible in:** `client/lifecycle.ts` (`watchConnectivity`), `client/lifecycle.test.ts`.

### M3-U49: connectivity is watched only while files run

- **Decision:** task 4 ruling 3, from audit I14. The job counts its files that run, from the start of a file's run to
  its end; the `offline` and `online` listeners are added when the count goes from 0 to 1 and removed when it returns
  to 0. Nothing is watched while `/upload` is on its way: an `/upload` sent offline goes through the retry budget as
  before, and a job whose tickets arrive while offline pauses its files when they start (`M3-U39`).
- **Why:** tying the listeners to `done` would leave a later `retry()` without offline handling; the count lets plan
  B's task 5 bracket a retry's run with the same calls.
- **If wrong:** an `/upload` sent offline spends its attempts and fails the job with `NETWORK_ERROR` instead of
  waiting for `online`.
- **Status:** in force (`58d24f7`, moved to `client/job-run.ts` by `613bbcf`).
- **Visible in:** `client/job-run.ts` (`watchedRuns`), `client/lifecycle.test.ts`.

## Plan B task 5 (to come)

Task 5's own execution rulings, the entry for the failed-file rule as built (which amends `M3-S15`, with a
cross-reference in `m3-slice.md`) and the client budget get their entries with that task's docs, from `M3-U50`.
