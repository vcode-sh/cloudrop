# M3 uploader decisions

Decisions of the M3 progress and scheduler work (2026-11-16): bytes while they are sent, several files per call, one
connection pool per client, and pause, resume and cancel per file or per job, in `cloudrop/client`. Design:
`docs/superpowers/specs/2026-11-16-progress-scheduler-design.md`. Plan A:
`docs/superpowers/plans/2026-11-16-m3-progress-plan-a.md`, section "Rulings fixed by this plan"; its audit:
`docs/superpowers/plans/2026-11-16-m3-progress-plan-a.audit.md`.

Numbering:

- `M3-U1` to `M3-U9` are plan A's rulings P1 to P9, with the same number.
- `M3-U10` to `M3-U13` are the design's decisions that spec §7 asks to record: the job's result, the snapshot, the pool
  and the budget. Fetch versus XHR is `M3-U6`, which records P6 together with spec §4.1.
- `M3-U14` upward are rulings taken while executing plan A that change behaviour or a public contract. Each names its
  source: an execution ledger ruling ("ledger"), a task report's ruling (`task 3 R1`, `R5-1`, `R6-1`) or a plan audit
  finding (`audit M12`). Task reports are kept with the plan's execution notes, not in the repository; each entry says
  what the ruling was.

Two decisions spec §7 lists come with plan B and get their entries there: the failed-file rule that amends `M3-S15`
(spec §4.7: a failed file keeps its parts for `retry()` instead of the background `/abort`) and the part-size outcome
(spec §5). Until then `M3-S15` holds unchanged.

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
  removed when `done` settles) changes nothing a caller sees.
- `R5-4` to `R5-7`: the rows of the snapshot tests and where they live.
- `R6-3` (a round sends the file's parts that have not landed, so a `PARTS_MISSING` list naming a part outside
  `1..partCount` sends nothing): the answer checks of `M3-S16` already refuse such a list.
- `R7-1` to `R7-7`: the example's `/lab` page (which requests its wrappers record, notes per file, the "resumed" note,
  an extra browser row, the background `/abort` after a run, the status words, the ending sentence). The example is
  not a library contract; `examples/next/README.md` describes the lab.
- Audit C1 (the provisional 7.5 kB budget during plan A, so every task's `verify` could pass): `M3-U13` records the
  budget it led to.

Commit ids below are on the branch `feat/m3-progress-a`. Paths are under `packages/cloudrop/src/` unless they say
otherwise.

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
- **Status:** in force (`c7f43d0`, `21c96cf`).
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
  its snapshot is empty (`R5-3`).
- **Why:** owner decision 2026-11-16 (spec §2.2). `UploadResult` departs from `Result<T>`, where `data` is null
  whenever `error` is set, on purpose: a partial failure must not hide the files that succeeded. It keeps the
  `{ data, error }` shape, so `if (error)` still works.
- **If wrong:** a caller that treats every `error` as "nothing happened" misses the files that succeeded; the type's
  doc comment and the README say so. `error.file` is a new public field (a minor semver change).
- **Status:** in force (`21c96cf`, `07f235b`, `1850ba1`). Supersedes `M3-S1`; spec §1 says so.
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
  `M3-U17`.
- **Why:** spec §2.1, §4.2 and §4.3. The throttle keeps a page from rendering on every progress event; an immediate
  status change keeps buttons and labels correct.
- **If wrong:** a page that renders on every listener call still renders up to ten times a second per job.
- **Status:** in force (`d75c21a`, `07f235b`).
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
- **Status:** in force (`c7f43d0`, `21c96cf`).
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
- **Status:** in force (the commit that adds this entry). Supersedes `M3-S32` (4.7 kB); the provisional 7.5 kB during
  plan A came from audit C1.
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
