# M3 uploader decisions

Decisions of the M3 progress and scheduler work (2026-11-16): bytes while they are sent, several files per call, one
connection pool per client, and pause, resume and cancel per file or per job, in `cloudrop/client`. Design:
`docs/superpowers/specs/2026-11-16-progress-scheduler-design.md`. Plan A:
`docs/superpowers/plans/2026-11-16-m3-progress-plan-a.md`, section "Rulings fixed by this plan"; its audit:
`docs/superpowers/plans/2026-11-16-m3-progress-plan-a.audit.md`. Plan B (automatic concurrency, smallest-first, stalls,
offline, `retry()`, part size): `docs/superpowers/plans/2026-11-16-m3-progress-plan-b.md`, same section; its audit:
`docs/superpowers/plans/2026-11-16-m3-progress-plan-b.audit.md`. Resume after a reload (records in IndexedDB,
`resumable()`, `resume()`, `forget()`): design `docs/superpowers/specs/2026-11-16-resume-design.md`, plan
`docs/superpowers/plans/2026-11-16-m3-resume.md`, same section.

Numbering:

- `M3-U1` to `M3-U9` are plan A's rulings P1 to P9, with the same number.
- `M3-U10` to `M3-U13` are the design's decisions that spec §7 asks to record: the job's result, the snapshot, the pool
  and the budget. Fetch versus XHR is `M3-U6`, which records P6 together with spec §4.1.
- `M3-U14` to `M3-U22` are rulings taken while executing plan A that change behaviour or a public contract. Each names
  its source: an execution ledger ruling ("ledger"), a task report's ruling (`task 3 R1`, `R5-1`, `R6-1`) or a plan
  audit finding (`audit M12`). Task reports are kept with the plan's execution notes, not in the repository; each entry
  says what the ruling was.
- `M3-U23` to `M3-U39` are plan B's rulings Q1 to Q17, in order: `Q<n>` is `M3-U<n + 22>`.
- `M3-U40` to `M3-U59` are plan B's measured outcomes, owner decisions and execution rulings that change behaviour or
  a public contract, each naming its source as above (`task 2 R1`, `task 4 ruling 1`, `audit M4`).
- `M3-U60` to `M3-U69` are the resume design's decisions: the owner's of 2026-11-16 (`M3-U60` to `M3-U63`), then the
  research's defaults the design adopted (`M3-U64` to `M3-U69`). `M3-U70` to `M3-U79` are the resume plan's rulings
  R1 to R10: `R<n>` is `M3-U<n + 69>`. The resume plan's execution rulings follow from `M3-U80`.

The part-size outcome spec §7 asks for is `M3-U40`. The failed-file rule that amends `M3-S15` (spec §4.7: a failed file
of a `start()` job keeps its parts for `retry()` instead of the background `/abort`) is ruled in `M3-U29` to `M3-U38`;
its entry as built is `M3-U50`, and `upload()` keeps `M3-S15` (`M3-U29`).

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
- **Status:** in force (`21c96cf`). The resume plan keys its records by the ticket's `id` instead (`M3-U70`).
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
  own `ABORTED` error and `error.file`; the others end `failed` with the job's error, which stays the result's. A file
  cancelled while `/upload` was on its way that `/upload` then refuses on its own ends `aborted` the same way.
- **Why:** owner decision 2026-11-16 (spec §2.2). `UploadResult` departs from `Result<T>`, where `data` is null
  whenever `error` is set, on purpose: a partial failure must not hide the files that succeeded. It keeps the
  `{ data, error }` shape, so `if (error)` still works.
- **If wrong:** a caller that treats every `error` as "nothing happened" misses the files that succeeded; the type's
  doc comment and the README say so. `error.file` is a new public field (a minor semver change).
- **Status:** in force (`21c96cf`, `07f235b`, `1850ba1`, `5cc63e5`). Supersedes `M3-S1`; spec §1 says so. A cancelled
  file that `/upload` refused ends `aborted` since `d399b90` (plan B early review M3): before, it ended `failed`, and
  its `retry()` asked for a ticket only to `/abort` it at once.
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
- **Status:** in force (`d75c21a`, `07f235b`, `5cc63e5`). Plan B made one exception (`M3-U36`, `4f1887a`): a retry under
  a new ticket starts the file's bytes again from 0.
- **Visible in:** `client/store.ts`, `client/progress.ts`, `client/job-snapshot.ts` (`fileSnapshot`, `snapshotOf`),
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

All are in force. `M3-U29` to `M3-U38` rule `retry()` and the failed-file rule, which plan B's task 5 built
(`613bbcf` split `job.ts`, `4f1887a` added `retry()`); `M3-U50` to `M3-U57` record how.

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
  holds: another `slowDown()` before a window closes does nothing, and that close only clears the hold, so it cannot
  grow. The window after can. Restarting the window when the pool is used again after idleness (`M3-U44`) keeps the
  hold. A fixed pool ignores `slowDown()` and never weighs `sent`.
- **Why:** one cause, such as a dropped link, fails every PUT in flight at once; halving per failure would take the pool
  to 1 for a single event.
- **If wrong:** a link that keeps failing loses at most half its slots per window, and regaining each slot takes at
  least one window of rising throughput. The PUTs of one outage usually all give their slots back before their retries
  ask again, so the hold then lasts until 2 s after the pool is used again.
- **Status:** in force (`ea771fc`). Since `d399b90` (plan B early review M1) the idle restart keeps the hold; before,
  it cleared it, and one outage could take the pool from 4 to 1 within a second.
- **Visible in:** `client/pool.ts` (`slowDown`, `update`), `client/pool.test.ts`.

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
- **Status:** in force (`ea771fc`: the pool is not exported; the lab's "PUTs in flight" counter: `f84a845`).
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
  (`createJob`: `offline`, `online`), `client/lifecycle.test.ts`.

### M3-U29: `upload()` keeps `M3-S15`

- **Decision:** plan B Q7, confirmed by the owner on 2026-11-16 (audit I12). Only files of `start()` jobs keep a
  failed file's ticket and parts for `retry()` (spec §4.7). `upload()` returns no handle, so nothing could retry its
  failed file: its failure still sends `M3-S15`'s background `/abort`.
- **Why:** parts nobody can retry would wait for the lifecycle rule, and a single-PUT object would stay in the bucket
  for good: the cost `M3-S15` was made to remove.
- **If wrong:** a page that wants to retry a failure of `upload()` calls `start()` instead.
- **Status:** in force (`4f1887a`: `upload()` passes `keepFailed: false`). Spec §4.7's first bullet says so.
- **Visible in:** `client.ts` (`upload`), `client/file-run.ts` (`end`), `client/upload-abort.test.ts`.

### M3-U30: `retry()` chooses its branch when it is called

- **Decision:** plan B Q8, with audit I6. When a `/complete` of the file may have succeeded, `retry()` sends
  `/complete` with the kept ticket, whatever the clock says: success ends the file done, any other answer ends it
  failed with that answer. Otherwise it keeps the ticket when the file has one that has not expired, was not aborted,
  and failed with an error that ticket can still fix (`M3-U31`); else it asks `/upload` for a new one. One call never
  falls back from one branch to another.
- **Why:** spec §4.7's order. `/complete` comes first because a second upload under a new key would leave two objects
  and run `onComplete` twice when the first did finish. One branch per call keeps the requests of a retry predictable.
- **If wrong:** a same-ticket retry that fails with an error from `M3-U31`'s list takes a second `retry()` to get a
  new ticket. A file whose `/complete` may have succeeded and whose ticket has expired can never be confirmed done by
  `retry()`: `/complete` answers `UPLOAD_EXPIRED`, the file ends failed with it, and no new ticket follows, since the
  file may be stored (task 5 concern, audit I6). The app's own `onComplete` record is then the only answer.
- **Status:** in force (`4f1887a`).
- **Visible in:** `client/retry-file.ts` (`needsTicket`, `retryFiles`), `client/retry-file.test.ts` (the two
  `/complete`-first rows).

### M3-U31: the errors that need a new ticket

- **Decision:** plan B Q9. `UPLOAD_EXPIRED`, `INVALID_TOKEN`, `UPLOAD_REJECTED`, `VERIFICATION_FAILED`, and any failure
  of a file that never had a ticket (refused at `/upload`, or the job's own error), make `retry()` ask `/upload` for a
  new ticket. Every other error is retried with the same ticket.
- **Why:** each of these says the ticket, its URLs or what was stored cannot finish this upload: a part the bucket
  refused (400, a signature mismatch) would be refused again under the same ticket.
- **If wrong:** an error missing from the list spends one `retry()` on the old ticket; one wrongly on it re-sends a file
  that could have finished.
- **Status:** in force (`4f1887a`). Amended by `M3-U74` (decided): `NO_SUCH_UPLOAD` joins the list.
- **Visible in:** `client/retry-file.ts` (`NEEDS_NEW_TICKET`, `needsTicket`), `client/retry-file.test.ts`.

### M3-U32: `abort()` on a failed file

- **Decision:** plan B Q10. Aborting a failed file that holds a ticket sends its `/abort`, except when a `/complete`
  may have succeeded (keep-or-abort, `M3-S14`), and turns the file `aborted` in both cases. `done` has already settled;
  only the snapshot and a later `retry()` see the change.
- **Why:** spec §4.7 holds a failed file's parts until `abort()`, `pagehide` or the token's expiry; `abort()` is how a
  page lets them go.
- **If wrong:** after such an abort the snapshot says `aborted` while `done` said `failed` (`M3-U35`). A failed file
  without a ticket turns `aborted` too, sending nothing (`M3-U51`).
- **Status:** in force (`4f1887a`).
- **Visible in:** `client/file-run.ts` (`abortFile`), `client/job.ts` (`handleOf`), `client/retry-abort.test.ts`.

### M3-U33: `pagehide` gives up failed files' tickets

- **Decision:** plan B Q11. On `pagehide` the client sends a `keepalive` `/abort` for every failed file that holds a
  ticket and no `/complete` that may have succeeded, and marks that ticket aborted, so a `retry()` after a back-forward
  cache restore asks for a new one. Files still uploading or paused are left to the bucket's lifecycle rule, as before.
- **Why:** spec §4.7. A closed tab must not leave a failed single-PUT object in the bucket for good, and a restored page
  must not retry with a ticket whose upload `/abort` removed. `pagehide`, unlike `unload`, does not block the
  back-forward cache.
- **If wrong:** a page that closes without `pagehide` firing (a crash) leaves a failed single-PUT object in the bucket;
  a restored page re-sends the whole file under a new key.
- **Status:** in force (`4f1887a`). An expired ticket is let go without an `/abort` (audit M7), and the failed file is
  held before its status changes (`M3-U53`).
- **Visible in:** `client/lifecycle.ts` (`createLeftovers`), `client/file-run.ts` (`end`), `client.ts` (`leftovers`),
  `client/retry-abort.test.ts` (the `pagehide` rows).

### M3-U34: `job.retry()` asks for new tickets in one `/upload`

- **Decision:** plan B Q12. `job.retry()` retries every failed file of the job; those that need a new ticket share one
  `/upload`, so the route's `maxFiles` and `authorize` apply to them as one job and `TOO_MANY_FILES` fails them
  together, never split silently. `file.retry()` asks for its own file alone.
- **Why:** one job is one `/upload` (`M3-U12`).
- **If wrong:** one refusal of that `/upload` fails every file that needed a ticket; `file.retry()` retries one at a
  time.
- **Status:** in force (`4f1887a`). What a refused `/upload` answers each file: `M3-U52`.
- **Visible in:** `client/retry-file.ts` (`retryFiles`), `client/job-run.ts` (`launch`), `client/job.ts` (`retryJob`),
  `client/retry-file.test.ts`.

### M3-U35: `done` reports each file's first outcome

- **Decision:** plan B Q13, from audit C1. A file's outcome is recorded when it first settles, and a later `retry()`
  never changes it; `job.done` is built from those. `job.retry()` resolves only when every file of the job has settled
  (it waits for files still running), with their current outcomes.
- **Why:** a file retried while another still ran would have reached `done` as failed without an error, and `error`
  null beside a failed file breaks `UploadResult` (`M3-U10`).
- **If wrong:** after a retry `done` and the snapshot disagree; a page that wants the latest outcome reads
  `job.retry()`'s result or the snapshot.
- **Status:** in force (`4f1887a`).
- **Visible in:** `client/file-run.ts` (`Entry.firstOutcome`, `settled`), `client/job-run.ts` (`firstRun`),
  `client/job.ts` (`retryJob`), `client/retry-file.test.ts`.

### M3-U36: a new ticket starts the bytes again

- **Decision:** plan B Q14, from audit I10. A retry that gets a new ticket gives the file a fresh byte count, so its
  `bytes` drop to 0; its speed starts from 0 when it sends again, as on every start. A same-ticket retry keeps them.
  This is an explicit exception to spec §4.2 and to `M3-U11`'s "bytes never decreases".
- **Why:** the new upload has stored nothing; keeping the old count would show 90 % or 100 % of a file of which nothing
  has landed.
- **If wrong:** a bar jumps back to 0 on such a retry, which is what happened to the upload.
- **Status:** in force (`4f1887a`; the speed meter is kept and restarted since `b368bc4`, with the same snapshot).
- **Visible in:** `client/retry-file.ts` (`requeue`), `client/file-run.ts` (`Entry.progress`),
  `client/retry-file.test.ts`.

### M3-U37: `retry()` on a file that has not failed

- **Decision:** plan B Q15, from audit I11. On a queued, uploading, paused or completing file `retry()` sends nothing
  and resolves with the file's outcome when it next settles; on a done or aborted file, at once with that outcome.
  `job.retry()` on a job refused for its arguments resolves with the same `{ data: null, error }` as `done`.
- **Why:** an outcome is always a settled state, so the promise waits for one; a Retry button pressed twice must not
  start a second run.
- **If wrong:** a page awaiting `retry()` of a paused file waits until the user resumes it.
- **Status:** in force (`4f1887a`). When the promise resolves: `M3-U56`.
- **Visible in:** `client/retry-file.ts` (`retryFiles`), `client/job-run.ts` (`allSettled`), `client/job.ts`
  (`startJob`'s `retry`), `client/retry-file.test.ts`.

### M3-U38: one `abortFile` for every cancel

- **Decision:** plan B Q16, from audit I9 and M8. The file's `abort()`, `job.abort()` and the caller's signal all go
  through one routine: a running file is cancelled as before; a failed file holding a ticket follows `M3-U32`. The
  listener on the caller's signal stays while any file of the job runs or is held, and is removed when none is.
- **Why:** before, `job.abort()` and the signal reached only running files: a failed file kept its ticket after the job
  was aborted, and a signal fired after `done` stopped neither held files nor a running retry.
- **If wrong:** a long-lived signal keeps the job reachable while a failed file is held, and after its expiry or
  `pagehide` until the next run ends or an `abort()` (`M3-U54`). Changes plan A's task 4 ruling 10 (the listener went
  when `done` settled).
- **Status:** in force (`4f1887a`; the listener's flag gave way to the signal's own deduplication in `b368bc4`).
- **Visible in:** `client/file-run.ts` (`abortFile`), `client/job-run.ts` (`createJob`: `busy`, `listen`, `idle`),
  `client/job.ts`, `client/retry-abort.test.ts`.

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
- **Visible in:** `client/lifecycle.ts` (`watchConnectivity`), `client/job-run.ts` (`Job.runUpload`),
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
- **Status:** in force (`fbc5c15`); the budget after plan B is `M3-U58`. Amends `M3-U13`. Amended by `M3-U60`
  (decided 2026-11-16): the ceiling is 10 kB and the "client plus React" target about 12 kB.
- **Visible in:** `scripts/size-limit.config.ts`.

### M3-U44: a window weighs only time the pool was busy

- **Decision:** task 2 R1 and R2, from audit I2. An `acquire` on a pool with no slot in use starts a fresh window with
  no rate to compare, and a window longer than 4000 ms is not compared either: both leave the rate at 0, which means
  "nothing to compare". The pool grows only when the previous and the current rate are both above 0. That restart
  keeps a `slowDown()`'s hold (`M3-U24`).
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
  only where the global has `addEventListener`: false calls `offline`, anything else `online`, which resumes only files
  `offline` paused. A runtime whose `navigator.onLine` is false but that has no `addEventListener` uploads as if
  online.
- **Why:** a file paused there could never resume, since no `online` event would arrive. Checking at registration also
  means every start of watching checks it, including a retry's. Calling `online` catches up an `online` event that
  came while nothing listened (`M3-U49`): a retry's file paused by `offline` while its `/upload` was on its way, after
  the job's last counted run ended, would otherwise wait for good.
- **If wrong:** none known; no such runtime is known (Node's `navigator` has no `onLine`).
- **Status:** in force (`58d24f7`). `online` at the start since `d399b90` (plan B early review I1).
- **Visible in:** `client/lifecycle.ts` (`watchConnectivity`), `client/lifecycle.test.ts`, `client/retry-abort.test.ts`
  (the connectivity row).

### M3-U49: connectivity is watched only while files run

- **Decision:** task 4 ruling 3, from audit I14. The job counts its files that run, from the start of a file's run to
  its end; the `offline` and `online` listeners are added when the count goes from 0 to 1 and removed when it returns
  to 0. Nothing is watched while `/upload` is on its way: an `/upload` sent offline goes through the retry budget as
  before, and a job whose tickets arrive while offline pauses its files when they start (`M3-U39`).
- **Why:** tying the listeners to `done` would leave a later `retry()` without offline handling; the count lets plan
  B's task 5 bracket a retry's run with the same calls.
- **If wrong:** an `/upload` sent offline spends its attempts and fails the job with `NETWORK_ERROR` instead of
  waiting for `online`. An `online` that comes while nothing is watched is caught up when the next run starts
  (`M3-U48`).
- **Status:** in force (`58d24f7`, moved to `client/job-run.ts` by `613bbcf`; one `Job.runUpload` brackets each run
  since `b368bc4`).
- **Visible in:** `client/job-run.ts` (`Job.runUpload`), `client/lifecycle.test.ts`.

## Plan B's failed-file rule as built, task 5's rulings and the budget

### M3-U50: a failed file of a `start()` job keeps its ticket and parts

- **Decision:** spec §4.7 as plan B's task 5 built it, ruled by `M3-U29` to `M3-U38`. When a file of a `start()` job
  fails after `/upload` gave it a ticket, the client sends no `/abort`: the file keeps its ticket, the parts that landed
  and its byte count, and `retry()` continues from them. They are held until `abort()` of the file or the job or the
  caller's signal (`M3-U32`, `M3-U38`), `pagehide` (`M3-U33`), or the ticket's expiry, after which the bucket's
  lifecycle rule removes unfinished parts. A same-ticket retry starts its repair rounds from 0 again and re-sends the
  parts its last `/complete` found missing (audit I5). `upload()` keeps `M3-S15`'s background `/abort` (`M3-U29`); a
  cancel sends `/abort` as before.
- **Why:** a retry in the same page should not re-send what already landed (spec §4.7), and a retry gets the same
  repair rounds as the first run.
- **If wrong:** a failed single-PUT object of a `start()` job stays in the bucket for good when its page neither
  aborts it nor fires `pagehide` before the ticket expires (a crash, a tab left open past the expiry): the case
  `M3-S15` removed for every failure. A page that never retries can release its failed files with `job.abort()` after
  `done`.
- **Status:** in force (`4f1887a`). Amends `M3-S15` for `start()` jobs; its status line and spec §4.7's first bullet
  say so.
- **Visible in:** `client/file-run.ts` (`end`), `client/retry-file.ts` (`requeue`), `client.ts` (`keepFailed`),
  `client/job.test.ts` (the PUT 400 row), `client/retry-file.test.ts`.

### M3-U51: aborting a failed file that never had a ticket sends nothing

- **Decision:** task 5 ruling 1. `abort()` on a failed file without a ticket (refused at `/upload`, or failed with the
  job's error) turns it `aborted` and sends nothing.
- **Why:** spec §4.5: `abort()` ends a file aborted, and only a done file ignores it. There is nothing to free.
- **If wrong:** the snapshot says `aborted` where `done` said `failed`, as for every aborted failed file (`M3-U35`).
- **Status:** in force (`4f1887a`).
- **Visible in:** `client/file-run.ts` (`abortFile`).

### M3-U52: the errors of a retry's refused `/upload`

- **Decision:** task 5 ruling 2. When a retry's `/upload` asked for every file of the job and is refused, each file
  gets the job's error as it is, and `job.retry()` answers `{ data: null, error }` as `done` does. When it asked for
  some files only (`file.retry()` in a job of several files, or a `job.retry()` where other files are done or keep
  their ticket), each file's error carries `error.file`.
- **Why:** `UploadResult`'s contract (`M3-U3`, `M3-U10`): a file's error names its file unless the whole job failed.
- **If wrong:** the same refusal reads with or without `error.file` depending on how many files the retry asked for.
- **Status:** in force (`4f1887a`).
- **Visible in:** `client/job-run.ts` (`launch`, `runEntry`), `client/retry-file.test.ts`.

### M3-U53: a failed file is held for `pagehide` before its status turns `failed`

- **Decision:** task 5 ruling 3. A failed file of a `start()` job joins the tickets `pagehide` frees first, and only
  then turns `failed`.
- **Why:** a `subscribe` listener may call `retry()` inside the status change. Holding afterwards would hold a file
  already running again, and `pagehide` would `/abort` a live upload.
- **If wrong:** none known.
- **Status:** in force (`4f1887a`). A retry queues all its files before the page hears of any: `M3-U59`.
- **Visible in:** `client/file-run.ts` (`end`).

### M3-U54: how long the caller's signal is heard

- **Decision:** task 5 ruling 4, refining `M3-U38`. The job listens to the caller's signal while any file is queued,
  uploading, paused or completing, or failed with a ticket that is neither dropped nor possibly complete. It checks
  when a file's run ends, after a file's `abort()` and after `job.abort()`. A retry listens again, and a signal that
  fired while nobody listened cancels that retry at once.
- **Why:** a held ticket is still something the signal can release (`M3-U32`); checking at those moments needs no
  timer.
- **If wrong (known cost):** a ticket released by `pagehide` or by its expiry does not start the check, so the listener
  stays on a long-lived signal, and the job stays reachable through it, until the next run ends or an `abort()`. If
  the signal fires meanwhile, those files turn `aborted`; an expired ticket's `/abort` changes nothing on the server.
- **Status:** in force (`4f1887a`, `b368bc4`). Plan B's early review (M2) proposed checking after `pagehide` and
  treating an expired ticket as idle; it stays a known cost: the only harm is the job's memory while a long-lived
  signal lives, and the fix would spend client bytes (`M3-U58`) on it. A row since `d399b90` proves the listener is
  held while a ticket is and goes after the file's or the job's `abort()`.
- **Visible in:** `client/job-run.ts` (`busy`, `listen`, `idle`), `client/retry-file.ts` (`retryFiles`),
  `client/retry-abort.test.ts`.

### M3-U55: no `/abort` for the old ticket on a new-ticket retry

- **Decision:** task 5 ruling 5. A retry that asks `/upload` for a new ticket sends no `/abort` for the old one.
- **Why:** spec §4.7 ends a kept ticket only by `abort()`, `pagehide` and expiry, and the cases that need a new ticket
  leave little to free: a dropped ticket was aborted already, the server ignores an expired one, and after
  `INVALID_TOKEN`, `UPLOAD_REJECTED` or `VERIFICATION_FAILED` nothing under the old ticket can be reused.
- **If wrong:** parts landed under an old multipart ticket wait for the bucket's lifecycle rule.
- **Status:** in force (`4f1887a`).
- **Visible in:** `client/retry-file.ts` (`requeue`).

### M3-U56: `retry()` resolves once every file it waits for has settled

- **Decision:** task 5 ruling 6. `file.retry()` and `job.retry()` resolve when every file they retried or waited for
  has settled, and wait again when a listener restarted one meanwhile. The outcomes are read in the step that sees
  every file settled, so another retry that starts a file again before the promise resolves cannot change them.
- **Why:** an outcome is a settled state (`M3-U37`); a running file has none to report. Read later, a file started
  again reads as `failed` with a null `error`, which breaks `UploadResult` (`M3-U10`, `M3-U35`).
- **If wrong:** a listener that retries a file on every failure keeps the promise pending until it stops.
- **Status:** in force (`4f1887a`). Outcomes read when every file settled since `d399b90` (plan B early review I2).
- **Visible in:** `client/job-run.ts` (`allSettled`), `client/retry-file.ts` (`retryFiles`), `client/job.ts`
  (`handleOf`, `retryJob`), `client/retry-file.test.ts` (the "a retry's result" rows).

### M3-U57: `upload()` marks the ticket it aborted

- **Decision:** task 5 ruling 7. When a failed file of `upload()` sends `M3-S15`'s background `/abort`, its ticket is
  marked dropped, so the caller's signal on an `upload()` of several files never sends a second `/abort` for it.
- **Why:** one `/abort` per ticket (`M3-U38` routes the signal through `abortFile`, which would otherwise send it
  again).
- **If wrong:** none known.
- **Status:** in force (`4f1887a`).
- **Visible in:** `client/file-run.ts` (`drop`, `end`, `abortFile`), `client/upload.ts` (`Upload.dropped`).

### M3-U58: the client's budget after plan B is the 9 kB ceiling

- **Decision:** plan B task 8. `cloudrop/client` measures 8.32 kB gzip after plan B, against 6.74 kB after plan A:
  1.58 kB for plan B against its allowance of about 1.2 kB. The rule of `M3-U43` (the measured size plus about 10 %,
  rounded up to 0.1 kB, never above 9.0 kB) gives 9.2 kB, so the budget is the ceiling, 9 kB, and about 0.68 kB is
  left for the resume plan.
- **Why:** where plan B's bytes went: tasks 2, 3, 4 and 6 +0.64 kB, task 5's `retry()` +0.98 kB; task 8's size pass
  took 0.04 kB (the job's connectivity count in one method, two "already listening" flags, a replaced speed meter).
  Most of the rest is property names that do not minify and the messages, which stay as worded.
- **If wrong:** the resume plan must fit in about 0.68 kB, find bytes elsewhere, or ask the owner to raise the ceiling.
- **Status:** in force (`ab5f0b0`; the size pass `b368bc4`). The early review's fixes (`d399b90`) cost 0.02 kB:
  8.34 kB, 0.66 kB left. The final review's fix (`M3-U59`) costs 0.01 kB: 8.35 kB, 0.65 kB left.
- **Visible in:** `scripts/size-limit.config.ts`.

### M3-U59: a retry queues every file it retries before it tells the page

- **Decision:** plan B final review I1. `retryFiles` queues every failed file it was given without publishing, then
  publishes once, then starts their runs. A `subscribe` listener that calls `retry()` inside that publish finds no
  failed file among them and only waits for them (`M3-U56`). One that pauses or cancels one of them leaves it to the
  run this retry starts: a paused file waits for `resume()`, and a cancelled one ends `aborted` without a `PUT`, with
  the `/abort` its ticket needs, as `job.abort()` ends a queued file (`M3-U38`).
- **Why:** each file used to publish as it was queued, so a listener saw the next file still `failed` and retried it
  itself; the outer loop then queued and ran it again. Two runs sent one file's `PUT` and `/complete` twice on the same
  ticket, or asked two tickets and stored it twice under two keys, with `onComplete` run twice. A file the listener
  cancelled was queued again and uploaded.
- **If wrong:** none known. A re-check of each file's status before its run would guard nothing: after the one publish
  a listener can only leave a file `queued` or `paused`, cancelled or not, and its run handles each.
- **Status:** in force (plan B final review I1).
- **Visible in:** `client/retry-file.ts` (`requeue`, `retryFiles`), `client/retry-file.test.ts` (the "subscriber that
  retries" rows).

## Resume after reload: the design's decisions

`M3-U60` to `M3-U63` are the owner's decisions of 2026-11-16, `M3-U64` to `M3-U69` the research's defaults the design
adopted. The research is `.superpowers/research/research-resume.md` (git-ignored; the resume design restates what it
decides); "research decision `<n>`" is its section 5, question `<n>`. Its measurements were made on this machine
(Ryzen 9 9950X3D, Node 26.13.0, Bun 1.4.4).

### M3-U60: resume after a reload is on by default, and the client's ceiling is 10 kB

- **Decision:** owner decision 2026-11-16 (resume design §1, §7; research decision 1, option (a)). The record store,
  the fingerprint and the three calls (`M3-U63`) ship in `cloudrop/client` itself, and persistence is on unless the
  client is created with `persist: false` (`M3-U79`). The ceiling for the bundled `cloudrop/client` rises from 9 kB to
  10 kB gzip, and spec §1's "client plus React" target from about 11 kB to about 12 kB. The resume plan's last task
  sets the budget by `M3-U43`'s rule against the new ceiling: the measured size plus about 10 %, rounded up to 0.1 kB,
  never above 10 kB.
- **Why:** spec §1: resume needs no configuration. The research recommended an opt-in entry
  (`cloudrop/client/resume`, about 0.15 to 0.3 kB in the core), which makes resume one import line every app has to
  know about. On by default is estimated at 0.8 to 1.1 kB on top of 8.35 kB (`M3-U58`), and 9 kB left about 0.65 kB:
  the research's prototypes measured 380 B for an IndexedDB store and 261 B for the fingerprint on their own, with 350
  to 600 B estimated for the integration.
- **If wrong:** every app ships the store, also one that never reloads during an upload or runs where there is no
  `indexedDB` (Node, Bun, Workers, where the store does nothing). M4's React bindings keep about 2 kB of the 12 kB. An
  app that wants no records on disk passes `persist: false`.
- **Status:** decided (resume plan, tasks 4, 5 and 7). The 10 kB limit is in `scripts/size-limit.config.ts` since
  `57144e0`. Amends `M3-U43` (9 kB and about 11 kB); `M3-U58`'s budget holds until the resume plan's last task
  replaces it.
- **Visible in:** spec §1, `scripts/size-limit.config.ts`, `client.ts` (`persist`).

### M3-U61: on resume, the server's part list decides

- **Decision:** owner decision 2026-11-16 (resume design §3.4, §8; research decision 2, option (b)). A record holds
  no part list, ETag or checksum. A resumed file's first request is `/complete` with the saved token, and its answer
  says what is left: done, `PARTS_MISSING` with exactly the parts to send (`M3-U75`), or an upload that is gone
  (`M3-U67`, `M3-U74`). It replaces spec §6.3's "the client trusts its own record and does not call `ListParts` on
  resume".
- **Why:** `/complete` already lists the parts (`ListParts`, paginated past 1,000) and answers `PARTS_MISSING` for
  every part that is absent or has the wrong size, and when the multipart upload is gone it finds a `/complete` that
  finished before the reload by the object's `cloudrop-id` and size (spec §5.4). A saved list would be written as parts
  land (up to `partCount` writes per file), miss the parts that landed after its last write, and still need
  `mayBeComplete` saved and a probe in that case. The client never sends an ETag (spec §7.6), so a saved one serves
  nothing. The record is written once (`M3-U62`), which also costs fewer bytes.
- **If wrong (known cost):** one `ListParts` more per resumed file: a Class A operation, $4.50 per million requests
  on R2 with 1 million Class A requests a month free ([R2 pricing](https://developers.cloudflare.com/r2/pricing/);
  `docs/research/r2-spike-findings.md` Q10). A resumed file spends one round trip before its first PUT.
- **Status:** decided (resume plan, task 5). Spec §6.3 says so.
- **Visible in:** spec §6.3, `client/resume.ts` (the probe start), `client/upload.ts`.

### M3-U62: the upload token is persisted, with limits

- **Decision:** owner decision 2026-11-16 (resume design §3.1, §3.2, §4; research decisions 3, option (b), and 8).
  A record keeps the upload token, the key, the plan (`partSize`, `partCount`), `expiresAt`, the route, the metadata
  sent to `/upload`, and the file's name, size, type, `lastModified` and fingerprint (`M3-U68`); never a presigned URL.
  The limits:
  - written once, when a multipart ticket arrives; deleted the moment its file ends done or aborted, when `pagehide`
    sends the `/abort` of a failed file's ticket (`M3-U33`), when a new ticket replaces it, and when it is found
    expired. A failed file keeps its record until one of these;
  - an expired record is never used (`M3-U72`);
  - a record carries the client's `namespace` (`M3-U79`), and a client never reads another namespace's records;
  - `forget()` deletes the namespace's records and is the call for sign-out (`M3-U78`); the README says to make it.

  Spec §7 gains a paragraph on the persisted token.
- **Why:** without the token a resume has to ask `/upload` again, which gives a new key and sends every byte: no
  resume (the research's option (c)). The token is a bearer credential for 24 hours that can sign PUTs for its key,
  complete the upload, and through `/abort` abort it or delete its finished object (spec §5.5); it is signed, not
  encrypted, so its `owner` and `metadata` (up to 2 KiB each) are readable, and the record repeats `metadata`.
  Persisting it adds exposure to other users of the same browser profile within 24 hours, to the time after sign-out,
  and to disk at rest; it adds nothing a script injected into the live page does not already have, except the tokens
  of earlier page loads. Deleting at done or aborted means a persisted token never outlives its use and cannot delete
  a finished object after a reload; deleting at `pagehide`'s `/abort` means a reload never resumes an aborted upload.
- **If wrong:** an app that never calls `forget()` leaves a signed-out user's unfinished uploads, with whatever
  `owner` and `metadata` hold, on the browser profile for up to 24 hours. `authorize` runs only in `/upload` (spec
  §5.2), so a resumed upload runs with its original owner: a second user signed in on the same profile and namespace
  could finish the first user's upload. It stays the first user's file, and an `onComplete` that must re-check the
  session reads the request there. A record whose delete fails (store errors never fail an upload, `M3-U71`) stays
  until it is found expired.
- **Status:** decided (resume plan, tasks 1, 4, 5 and 7). Spec §7 says so.
- **Visible in:** spec §7, `client/records.ts`, `client/job-run.ts` (the save), `client/file-run.ts`,
  `client/lifecycle.ts`.

### M3-U63: resume is explicit: `resumable()`, `resume(upload, file)` and `forget()`

- **Decision:** owner decision 2026-11-16 (resume design §2; research decision 6, option (a), with `forget`). The
  client gains three calls: `resumable(route?)` resolves the namespace's unfinished uploads, newest first (`M3-U77`);
  `resume(upload, file, { signal }?)` returns an `UploadJob` of one file that continues that upload (`M3-U76`);
  `forget()` deletes records (`M3-U78`). `start()` and `upload()` never match a picked file against a record. None of
  the three rejects: `resumable()` and `forget()` resolve `{ data, error }`, and `resume()`'s job resolves `done` as
  any job does. A new client error code, `UPLOAD_IN_USE`, comes with them (`M3-U69`).
- **Why:** the research recommended matching each file of `start()` silently, which keeps the five-line API; the
  owner chose explicit calls. A page then knows when it offers a resume and can say so; `start()` keeps one `/upload`
  for its files and hashes nothing; a picked file is compared with the one record the page named, not with every
  record of the route; and a refused match is an error the page sees, not a silent new upload.
- **If wrong:** a page that never calls `resume()` gets no resume, though records are kept until they expire. The
  same file picked into an ordinary `start()` is uploaded again under a new key, and the old upload's parts wait for
  the bucket's lifecycle rule.
- **Status:** decided (resume plan, tasks 2 and 5).
- **Visible in:** `client.ts`, `client/resume.ts`, `client/types.ts` (`ResumableUpload`), `errors.ts`.

### M3-U64: only multipart uploads are persisted

- **Decision:** research decision 7, option (a) (resume design §1, §3.1). A single-PUT ticket never gets a record:
  a reload during a single PUT loses it, and the page starts that file again.
- **Why:** spec §6.3 persists multipart uploads. A file under the 64 MiB multipart threshold (`M3-U40`) is one PUT,
  which a reload loses whole, so there is nothing to continue; a record would serve only cleanup.
- **If wrong (known cost):** a single PUT that landed before a reload and was never completed stays in the bucket for
  good: no lifecycle rule removes a stored object, and no record is left to complete or abort it.
- **Status:** decided (resume plan, task 4).
- **Visible in:** `client/job-run.ts` (the save), `client/persist.test.ts`.

### M3-U65: no copy into the origin-private file system yet

- **Decision:** research decision 4 (resume design §1, §8). Spec §6.3's `persist: "opfs"` is deferred: the client
  never copies a file, so a resume needs the user to pick it again. File System Access handles are not used either.
  `persist` is a boolean (`M3-U79`); a later `"opfs"` would add a value to it.
- **Why:** writing to OPFS from the main thread needs `FileSystemFileHandle.createWritable()`: Chrome 86, Firefox 111,
  Safari only from 26. Before that the only write path is a sync access handle inside a worker, which a library would
  ship as a `blob:` worker that a strict CSP `worker-src` blocks. A copy writes every file once more and needs free
  quota of its size: 4 GiB of extra disk writes for a 4 GiB video, most of which never reload. File System Access
  handles are Chromium only and come only from the app's own picker, never from `<input>`.
- **If wrong:** a reload during a large upload needs the user to pick the file again; `resumable()` gives the page the
  name and size to ask for.
- **Status:** decided (resume design; nothing to build). Spec §6.3 says so.
- **Visible in:** spec §6.3.

### M3-U66: the library never calls `navigator.storage.persist()`

- **Decision:** research decision 11 (resume design §3.7). Records live in the origin's best-effort storage. An app
  that wants persistent storage calls `navigator.storage.persist()` itself; the README says so.
- **Why:** Firefox shows the user a prompt for it, while Safari and Chromium decide without one (MDN, "Storage quotas
  and eviction criteria"): a library that asks raises a prompt the app did not ask for. Best-effort storage is enough
  for a record that lives 24 hours.
- **If wrong:** under storage pressure a browser may evict the origin's data, records included; those uploads can no
  longer be resumed, and their parts wait for the bucket's lifecycle rule.
- **Status:** decided (resume plan, tasks 1 and 7).
- **Visible in:** `client/records.ts` (no such call), `README.md`.

### M3-U67: an expired upload starts over with a new ticket

- **Decision:** research decision 10, option (a) (resume design §1, §3.4). A resumed upload that the server says is
  gone (`UPLOAD_EXPIRED`, `INVALID_TOKEN` or `NO_SUCH_UPLOAD` from the probe) asks `/upload` once for a new ticket with
  the record's route and metadata, as `retry()`'s new-ticket branch does (`M3-U30`, `M3-U31`), and sends the whole
  file (`M3-U74`). A record expired by the client's clock is not resumed at all (`NOT_FOUND`, `M3-U72`). Nothing
  re-issues a token for the same multipart upload.
- **Why:** the token lives 24 hours while R2's default lifecycle rule keeps incomplete parts for 7 days
  (`docs/research/r2-spike-findings.md`), so parts can outlive their token. Using them would need a server call that
  runs `authorize` again and signs a new token for an existing `uploadId`: a server and security design of its own,
  1.1 at the earliest. The new-ticket branch exists and is tested.
- **If wrong (known cost):** a resume between 24 hours and 7 days sends every byte again, and the old parts wait for
  the lifecycle rule (`M3-U55`).
- **Status:** decided (resume plan, task 5).
- **Visible in:** `client/resume.ts`, `client/retry-file.ts`.

### M3-U68: the fingerprint is an edge hash, with a fallback without `crypto.subtle`

- **Decision:** research decision 5 (resume design §3.3). `resume(upload, file)` accepts `file` only when its name,
  size, `lastModified`, type and fingerprint equal the record's. The fingerprint is the hex SHA-256, by
  `crypto.subtle`, of the file's first 64 KiB followed by its last 64 KiB, or of the whole file when it is at most
  128 KiB. Without `crypto.subtle` it is the empty string on both sides, and the match rests on the other four fields.
- **Why:** measured on a 256 MiB file read through `Blob.slice`: the edge hash takes 0.18 ms in Node 26.13.0 and
  0.11 ms in Bun 1.4.4, the whole file 315 ms and 178 ms; WebCrypto has no streaming digest, so a whole-file hash
  needs the whole file in memory, seconds and gigabytes on the multi-GiB files multipart exists for. The edges tell
  apart files with the same name, size and timestamp, a real case for exported or generated files, for about 150 to
  200 B. `crypto.subtle` exists only in secure contexts, and a page served over plain HTTP on a LAN address has none
  (the case `M3-U2` handles); there the four fields still refuse most wrong files.
- **If wrong (known cost):** a match is a heuristic. A file edited in the middle with the same edges and timestamp is
  accepted, and the object stored mixes parts of the two files, which the server's size checks accept; without
  `crypto.subtle` the edges are not compared either. `checksums()` (M5) closes it. Where the platform does not know a
  file's `lastModified`, the File API returns the current time, so no file matches and every resume is refused.
- **Status:** decided (resume plan, task 2).
- **Visible in:** `client/fingerprint.ts`.

### M3-U69: a Web Lock keeps two tabs from sending one upload

- **Decision:** research decision 9 (resume design §2, §3.5). Every run of a persisted upload, from `start()`,
  `resume()` or `retry()`, holds a Web Lock for its upload from its first request until it settles, where
  `navigator.locks` exists (`M3-U73`). `resume()` asks for it without waiting; when another tab holds it, the job ends
  with the new client error code `UPLOAD_IN_USE` and sends nothing. Like `ABORTED`, the server never sends it.
- **Why:** a lock is shared by every tab and worker of the origin (MDN, "Web Locks API"; Baseline since March 2022),
  for about 50 B. Two tabs resuming one record would send the same parts twice and race at `/complete`, where a part
  sent again during the call makes a listed ETag stale and answers a retryable `STORAGE_ERROR` (spec §5.4).
- **If wrong:** Web Locks exist only in secure contexts. Without them two tabs may send the same parts: harmless to
  the result, since the server verifies, but wasted bytes.
- **Status:** decided (resume plan, tasks 2, 4 and 5).
- **Visible in:** `client/locks.ts`, `errors.ts` (`ClientErrorCode`), `client/failures.ts` (`uploadInUse`).

## Resume plan rulings

`M3-U70` to `M3-U79` are the resume plan's rulings R1 to R10 (`docs/superpowers/plans/2026-11-16-m3-resume.md`,
"Rulings fixed by this plan"): `R<n>` is `M3-U<n + 69>`.

### M3-U70: one object store keyed by the upload id, without an index

- **Decision:** R1. Database `cloudrop`, version 1, object store `uploads` with `keyPath: "id"` and no index. The key
  is the ticket's `id`, the object's `cloudrop-id`, which survives the page, unlike the file id (`M3-U2`). A
  namespace's records are read with `getAll()` and filtered.
- **Why:** at most a few hundred records of a few KiB each (the token alone can reach about 12 KiB) make a full read
  cheap, and an index costs a schema and bytes. `localStorage` is synchronous, holds strings only and about 5 MiB per
  origin in practice (MDN, "Storage quotas and eviction criteria"), which a few hundred records could fill.
- **If wrong:** a profile holding thousands of records reads them all on every `resumable()`; an index needs a
  version 2 upgrade.
- **Status:** decided (resume plan, task 1).
- **Visible in:** `client/records.ts`.

### M3-U71: one ordered queue per client, and the store never holds up an upload

- **Decision:** R2 (resume design §3.2). Every store operation of one client is chained on one promise, so a delete
  issued after a save runs after it. The database is opened once, lazily, by the first operation; a failed open makes
  every later operation fail the same way. Uploads ignore store failures. `resumable()` and `forget()` resolve
  `{ data: null, error }` with code `STORAGE_ERROR` and a message that names the browser's storage, never its raw
  text.
- **Why:** a file that ends right after its ticket arrived issues a delete right after a save; out of order, the save
  could land last and leave a live token for a finished upload (`M3-U62`). A page that never uploads never opens the
  database. The records are a convenience: a quota error or a browser that refuses storage must not fail an upload the
  network can finish.
- **If wrong:** one failed open turns resume off for the client's life, also when a later open would have worked; the
  next page load tries again.
- **Status:** decided (resume plan, task 1).
- **Visible in:** `client/records.ts`, `client/failures.ts` (`storageUnavailable`).

### M3-U72: a record counts as expired 60 seconds early

- **Decision:** R3 (resume design §3.6). A record whose `expiresAt` is less than 60,000 ms ahead counts as expired:
  `resumable()` does not list it, `resume()` ends with `NOT_FOUND`, and whichever sees it deletes it.
- **Why:** a listed upload needs time to start: the page asks for the file, the client hashes it, and the probe
  reaches the server before the token expires. Without the margin an upload listed at the last moment would meet
  `UPLOAD_EXPIRED` and start over (`M3-U67`).
- **If wrong:** an upload with less than a minute left is not offered. A client clock more than 60 s behind the
  server's can still list a record the server finds expired; the resume then starts over.
- **Status:** decided (resume plan, task 1).
- **Visible in:** `client/records.ts`.

### M3-U73: the lock's name and how long it is held

- **Decision:** R4. The lock is `cloudrop:upload:<id>`, requested with `ifAvailable: true` and held until the file's
  run settles: done, failed or aborted. A retry of a failed file asks for it again. Without `navigator.locks` nothing
  is locked.
- **Why:** `ifAvailable` never queues behind another tab, which would leave a job waiting with no status to show. A
  failed file holds no lock, so a tab that gave up does not block a resume in another. The prefix keeps the name apart
  from an app's own locks.
- **If wrong:** between a file's failure and its retry another tab may resume the same upload; the retry's request
  for the lock is what finds it.
- **Status:** decided (resume plan, tasks 2 and 4).
- **Visible in:** `client/locks.ts`.

### M3-U74: a resumed upload that is gone starts over in the same run

- **Decision:** R5 (resume design §3.4). In a resumed file's first run, `UPLOAD_EXPIRED`, `INVALID_TOKEN` and
  `NO_SUCH_UPLOAD` from the probe mean "start over": the file does not settle, asks `/upload` for a new ticket, which
  replaces the record, and sends the whole file, its bytes from 0 (`M3-U36`). Its first outcome (`M3-U35`) is that
  run's. `retry()`'s new-ticket list (`M3-U31`) gains `NO_SUCH_UPLOAD`.
- **Why:** `/complete` answers `NO_SUCH_UPLOAD` only when the multipart upload is gone and no object of this upload's
  `cloudrop-id` and size is stored, so the old ticket can never finish; the user who picked the file wants it stored,
  and ending it failed would only make the page call `retry()`. A probe that `NETWORK_ERROR` or `SERVER_ERROR` answers
  sets `mayBeComplete` as any `/complete` does (`M3-S14`), so a file that may be stored never takes this branch.
- **If wrong:** the old upload's parts wait for the bucket's lifecycle rule (`M3-U55`). The page sees one outcome per
  run and no failure in between.
- **Status:** decided (resume plan, task 4 for the retry list, task 5 for the probe). Amends `M3-U31`.
- **Visible in:** `client/resume.ts`, `client/retry-file.ts` (`NEEDS_NEW_TICKET`).

### M3-U75: the probe's first `PARTS_MISSING` is free

- **Decision:** R6 (resume design §3.4). The probe's first `PARTS_MISSING` consumes none of the `PARTS_MISSING` repair
  rounds (`M3-S13`); a later one counts as usual. From that answer the snapshot's `bytes` are the sizes of the parts
  it did not name; before it they are 0.
- **Why:** that answer is the list of what is left, not a repair: counting it would leave a resumed file one repair
  round where every other file has two. Before the answer the client does not know what landed (`M3-U61`), so it
  counts nothing, and progress then only rises (spec §6.4).
- **If wrong:** progress jumps from 0 to the landed share when the probe answers. A resumed file can meet
  `PARTS_MISSING` three times before it fails.
- **Status:** decided (resume plan, task 5). Refines `M3-S13` for a resumed file.
- **Visible in:** `client/upload.ts`.

### M3-U76: `resume()` checks in a fixed order and sends nothing when a check fails

- **Decision:** R7 (resume design §2, §2.1). `resume(upload, file)` checks the arguments (`INVALID_INPUT`: `file` is
  a `File` and `upload` an object with a string `id`), then the record (`NOT_FOUND`: it exists in the client's
  namespace and has not expired), then the file (`INVALID_INPUT`, `M3-U68`), then the lock (`UPLOAD_IN_USE`,
  `M3-U73`). The first failure ends the job with `{ data: null, error }` before any request. The only option is
  `signal`; the route and metadata come from the record, and the file's id is the client's next sequence number
  (`M3-U2`).
- **Why:** the cheap checks first, the file is hashed only once a record exists, and the lock last, so a refused call
  never takes a lock it has to release.
- **If wrong:** a page sees one refusal at a time: a wrong file for an expired record reads as "can no longer be
  resumed", the more useful of the two.
- **Status:** decided (resume plan, task 5; the messages task 2).
- **Visible in:** `client/resume.ts`, `client/failures.ts` (`notResumable`, `notSameFile`, `uploadInUse`).

### M3-U77: what `resumable()` shows of a record

- **Decision:** R8 (resume design §2, §3.6). `ResumableUpload` is exactly
  `{ id, route, name, size, type, lastModified, expiresAt }`, a plain, JSON-safe object with `expiresAt` as an ISO
  string. `resumable(route?)` lists the namespace's unexpired records newest first, filtered by route when one is
  given, deletes the expired ones and calls no server. With persistence off or no `indexedDB` it resolves `ok([])`.
  The token, the key and the metadata never leave the store through the public API.
- **Why:** these fields are enough to show an upload and ask for its file again. The token is the credential, the key
  is the server's until the upload completes, and the metadata may hold what the app does not show (`M3-U62`).
- **If wrong:** an app that wants to show metadata keeps its own copy. Adding a field later is compatible; removing
  one is not.
- **Status:** decided (resume plan, task 5).
- **Visible in:** `client/types.ts` (`ResumableUpload`), `client/resume.ts`.

### M3-U78: `forget()` and its one option

- **Decision:** R9 (resume design §2). `forget()` deletes the records of the client's namespace and
  `forget({ all: true })` every record of the origin; any other argument is `INVALID_INPUT`. It resolves
  `ok({ forgotten: n })`, `ok({ forgotten: 0 })` with persistence off or no `indexedDB`, and `STORAGE_ERROR`
  (`M3-U71`) when the store fails. Uploads already running keep going; one saves a record again only when it gets a
  new ticket.
- **Why:** signing one user out must not erase another user's records on a shared profile, while `all` serves a
  "clear this browser" action and a namespace scheme the app changed. Refusing other arguments catches
  `forget(userId)`, which would otherwise look as if it forgot that user.
- **If wrong:** an upload running at sign-out finishes under the signed-out user and, with its record gone, cannot be
  resumed after a reload; an app that must stop it aborts the job.
- **Status:** decided (resume plan, task 5).
- **Visible in:** `client/resume.ts`, `client.ts`.

### M3-U79: the `persist` and `namespace` options

- **Decision:** R10. `persist` must be a boolean, default `true`; `namespace` a string of at most 256 characters,
  default `""`. Anything else throws `INVALID_CONFIG` (`configError`) with a message that names the option. A record
  carries its namespace, and `resumable()`, `resume()` and `forget()` see only the client's.
- **Why:** a wrong option throws where it is set, as `concurrency` and `order` do (`M3-U41`, `M3-U42`); the cap keeps
  a record and the filter's comparison small.
- **If wrong:** a longer user id must be shortened or hashed by the app. The namespace is fixed when the client is
  created, so a page that switches users creates a new client.
- **Status:** decided (resume plan, task 4).
- **Visible in:** `client.ts` (`ClientOptions`).
