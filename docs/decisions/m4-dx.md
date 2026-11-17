# M4a decisions: audit fixes, developer experience and React hooks

Design: [`2026-11-17-m4-dx-and-react-design.md`](../superpowers/specs/2026-11-17-m4-dx-and-react-design.md). Each
entry: decision, why, what it costs if wrong, status, source, where it is visible. `M4-F<n>` numbers follow the design's
§3 to §5; `M4-B<n>` follow §6. Execution rulings continue each series from the next free number.

## Fixes and developer experience (`M4-F`)

### Client (design §3, `M4-F1` to `M4-F9`)

### M4-F1: a failed multipart file keeps its record for a reload, without `/abort`

- **Decision:** a failed file whose ticket is multipart and whose client keeps records (persistence on, with
  `indexedDB` and Web Locks) gives its ticket up without `/abort`: the ticket is marked dropped, the lock is let go and
  the record stays, so a reload lists the upload and `resume()` sends only the parts the bucket lacks. This is what a
  failure of `upload()` does at once, and what `pagehide` does to a failed file of `start()` (and of `resume()`). A
  dropped ticket sends no later `/abort` from this page: `abort()` of the file, `job.abort()` and the caller's signal
  then only settle it `aborted`. A single `PUT`, and every ticket of a client that keeps no records, still sends
  `/abort` (`M3-S15`); the caller's `abort()` of a failed file that still holds its ticket still sends it (`M3-U32`).
- **Why:** design §3 F1. A resumed 10 GB upload whose parts all failed (the network gone without an `offline` event)
  ended `failed`; the reload a user makes to recover then fired `pagehide`, whose `/abort` deleted the parts and the
  record, so every byte was sent again. `/abort` is needed for a single `PUT`, whose object no lifecycle rule removes;
  multipart parts nobody resumes are removed by the bucket's abort-incomplete-multipart rule. A given-up ticket must not
  `/abort` later: another tab may resume and complete the upload, and an `/abort` with a live token would then delete
  the finished object (the `M3-U88` hazard).
- **If wrong:** parts of a failed upload nobody resumes stay in the bucket until the lifecycle rule removes them (a day
  on the recommended rule) instead of at once, and a plugin's `onAbort` hook does not run for them. "Keeps records" is
  read from the client (`records.enabled`), not from the record's own save: where the browser refuses the lock request
  (`M3-U88`) or can no longer read the file to hash it, nothing was saved and still no `/abort` is sent, so those
  parts too wait for the lifecycle rule. After a back-forward cache restore, `abort()` of a given-up file leaves its
  record listed until it expires or `forget()` runs.
- **Status:** in force. Amends `M3-S15`, `M3-U29` and `M3-U33`.
- **Source:** design §3 F1; code audit of `main` at `907cc77`.
- **Visible in:** `client/file-run.ts` (`giveUp`, `end`), `client.ts` (`leftovers`), `client/lifecycle.ts`,
  `client/persist.test.ts` (the `pagehide` row), `client/persist-failures.test.ts` (the `upload()` rows),
  `docs/guide/client.md` ("What gets cleaned up"), `docs/guide/resume.md` ("When a record is deleted").

### M4-F2: a file cancelled before its ticket ends at once

- **Decision:** cancelling a file that is queued or paused without a ticket (waiting for the job's `/upload`, a re-ask,
  a retry's new ticket, a start over or `resume()`'s checks) ends it `aborted` at once, with its own `ABORTED` error
  naming the file. A ticket `/upload` brings for it later gets one background `/abort` and nothing else: no lock, no
  record, no `PUT`. `job.abort()` and the caller's signal cancel such files the same way, so each ends with its own
  `ABORTED` error; `done` still answers `{ data: null, error }` with the job's `ABORTED` when the job's own `/upload`
  was cancelled.
- **Why:** design §3 F2. A file cancelled while the job's `/upload` was in flight stayed `queued` until `/upload`
  answered, against `M3-U11` ("a page shows a cancel at once"), and then took a ticket, a Web Lock and an IndexedDB
  save only to delete them with its `/abort`. A file with no ticket has nothing to tell the server, so nothing needs to
  wait.
- **If wrong:** after `job.abort()` during `/upload`, a page that compared a file's snapshot error with `done`'s error
  by identity now finds two errors with the same code; `error.file` is now set on them, as `M3-U10` asks of every error
  that belongs to one file.
- **Status:** in force.
- **Source:** design §3 F2; code audit of `main` at `907cc77` (probe: statuses `['queued','queued']` 20 ms after the
  cancel, then `POST /upload, POST /abort, PUT object, POST /complete`).
- **Visible in:** `client/file-run.ts` (`abortFile`), `client/launch.ts` (`runEntry`), `client/resume.ts`
  (`resumeRun`), `client/job.test.ts` ("cancels one file while /upload is in flight"), `client/persist.test.ts` ("takes
  no lock and saves nothing").

### M4-F3: endpoint calls time out

- **Decision:** every call to the server has a deadline for its whole answer, body included: 30 s for `/upload` and
  `/sign`, 120 s for `/complete`, 10 s for `/abort` (as before). A call that misses it ends as no answer does: a
  retryable `NETWORK_ERROR`, which the retry budget (`M3-S9`) tries again. Only the caller's own cancel answers
  `ABORTED`. A `/complete` that timed out counts as one that may have finished (`M3-S14`), so a cancel or a failure
  then keeps the file. One `AbortController` per call takes both the timer and the caller's signal, without
  `AbortSignal.any` (`M3-U16`).
- **Why:** design §3 F3. Without a deadline a server that accepted the connection and never answered left a file
  `queued` (at `/upload`) or `completing` for good, and a cancelled `upload()` waited for the browser to drop the
  connection. `/complete` gets four times as long because the server verifies up to 10,000 parts with `ListParts`
  pages before it answers.
- **If wrong:** a server slower than 30 s at `/upload` (an `authorize` that calls a slow service) or 120 s at
  `/complete` is asked again, up to six times; a second `/complete` of a finished upload runs `onComplete` again, which
  must be idempotent by `file.id` (`M3-U84`), and a second `/upload` leaves the first ticket's multipart upload to the
  lifecycle rule.
- **Status:** in force. Amends `M3-S14` (its known cost of a `/complete` that never answers).
- **Source:** design §3 F3; code audit of `main` at `907cc77`.
- **Visible in:** `client/endpoints.ts` (`post`, `ASK_TIMEOUT_MS`, `COMPLETE_TIMEOUT_MS`), `client/endpoints.test.ts`
  ("a server that never answers").

### M4-F6: `/abort` relies on the browser floor's timers, without a guard

- **Decision:** `abort()` no longer wraps its request in a `try/catch`. Its deadline is the same timer as every other
  call's (`M4-F3`) instead of `AbortSignal.timeout`, and `post` never rejects, so nothing is left to catch.
- **Why:** design §3 F6. The `try/catch` could only catch a missing `AbortSignal.timeout`, and then it silently skipped
  every `/abort`. The browser floor (ES2023: Chrome 103, Safari 16, Firefox 100) has that API, and with one timer for
  all calls it is no longer used at all.
- **If wrong:** nothing known: `post` maps every failure, a synchronous throw of `fetch` included, to a result.
- **Status:** in force.
- **Source:** design §3 F6; code audit of `main` at `907cc77`.
- **Visible in:** `client/endpoints.ts` (`abort`), `client/endpoints.test.ts` (the `abort` rows; the row for a missing
  `AbortSignal.timeout` is gone).

### M4-F4: a cancel during `/complete` starts no repair

- **Decision:** when a `/complete` answers `PARTS_MISSING` after the file's cancel fired, the file ends there,
  `aborted`, without moving to `uploading` for a repair round. Its `/abort` follows as for any cancel (`PARTS_MISSING`
  clears the doubt, `M3-S31`).
- **Why:** design §3 F4. The repair moved the file to `uploading` before its first `PUT` noticed the cancel, so a page
  was shown `uploading, completing, uploading, aborted`: a cancelled file that looked as if it started again.
- **If wrong:** nothing known; the repair's `PUT`s already stopped on the cancel, so no request changes.
- **Status:** in force.
- **Source:** design §3 F4; code audit of `main` at `907cc77`.
- **Visible in:** `client/upload.ts` (`sendAndComplete`), `client/upload-failures.test.ts` ("ends aborted, never
  uploading again").

### M4-F8: an upload keeps the URLs signed for it across passes

- **Decision:** the URLs of an upload, the ticket's and every one `/sign` answers (a lazy batch or a renewal), live on
  the upload (`Upload.urls`) for as long as it keeps its ticket: passes after a pause, repair rounds and same-ticket
  retries reuse them, renewing only one that expires within a minute (`S11`). A single `PUT`'s URL is part 1 of the
  same map. `newUpload` builds an upload for `/upload`'s ticket and for `resume()`'s record alike.
- **Why:** design §3 F8. The map was rebuilt from the ticket on every pass: after a pause, or in each repair round,
  parts signed in an earlier pass were signed again (up to 20 per `/sign`, one call per pass), and a renewed URL fell
  back to the ticket's expired one, costing a refused `PUT` and another renewal. A resumed upload, whose ticket carries
  no URLs, paid one `/sign` per repair round.
- **If wrong:** a URL is reused until a minute before its expiry, as within one pass already; nothing new is trusted.
- **Status:** in force.
- **Source:** design §3 F8; code audit of `main` at `907cc77`.
- **Visible in:** `client/upload.ts` (`Upload.urls`, `newUpload`, `senderFor`), `client/parts.ts` (`PartSender.urls`),
  `client/persist.ts` (`uploadOf`), `client/resume.ts` (`resumeRun`), `client/resume-job.test.ts` ("pauses and
  resumes", "fails keeping its record and lock"), `client/resume.test.ts` ("takes no repair round").

### M4-F5: a resumed file's run is assigned once

- **Decision:** `resume()`'s file gets one `entry.run`, the whole resume run from its checks to its settling (a start
  over included), assigned where the run starts (`resumeJob`), instead of one for the checks and another for the upload.
- **Why:** design §3 F5. With two assignments, a `retry()` during the checks waited correctly only because of the order
  of microtasks, and `allSettled` could spin on a file that had not settled while its `run` already had, which is how
  `M3-U90` once froze a tab.
- **If wrong:** nothing known; `client/resume-checks.test.ts` and the resume tests cover it (a fault probe that drops
  the assignment freezes them, as `M3-U90` froze the tab).
- **Status:** in force.
- **Source:** design §3 F5; code audit of `main` at `907cc77`.
- **Visible in:** `client/resume.ts` (`resumeJob`, `resumeRun`).

### M4-F7: a resumed upload's probe looks missing parts up in a `Set`

- **Decision:** the first answer of a resumed upload's probe counts the landed parts against a `Set` of the parts
  `PARTS_MISSING` named, not an array.
- **Why:** design §3 F7. `missing.includes(part)` for every landed part is O(L×M): 20.3 ms against 0.59 ms with a `Set`
  at 10,000 parts with 9,000 missing (audit measurement).
- **If wrong:** nothing known.
- **Status:** in force.
- **Source:** design §3 F7; code audit of `main` at `907cc77`.
- **Visible in:** `client/upload.ts` (`probed`).

### M4-F9: the client's simplifications S1 to S9

- **Decision:** S1: `job.retry()` is written inline; the one-caller `retryJob` is gone. S2: `launch`'s `Alone
  { reask, first }` is `first?: number` (a re-ask is `first > 1`; a one-file `retry()` and a start over pass 1), and
  `whole` is `(first ?? 1) === 1` with every file of the job. S3: `classifyAnswer(status, body, retryAfterHeader)` reads
  the S3 code and `Retry-After` itself; `STORAGE_CODE` is no longer exported. S4 is `M4-F6`. S5: `Alone`, `UploadLock`,
  `Step` and `PARTS_IN_FLIGHT` are no longer exported (no importer). S6: `createMeter()` takes no start time: `restart()`
  always runs before the first `add()`. S7: `startJob` passes its arguments inline. S8 is `M4-F5`. S9: `refused()`'s
  wait is `askAlone`'s first wait (`launch(job, [entry], attempt + 1, waitMs)`), inside one `job.watch` for the whole
  one-file ask, so `offline` pauses a file waiting to ask again, after a refusal or in the backoff after an `/upload`
  that failed as a whole, whatever the job's other files do.
- **Why:** design §3 F9, every candidate accepted: fewer exported symbols, parameters and hops for the same behaviour,
  and S9 one wait loop instead of two, which also closes the gap where `offline` reached a re-ask's backoff only while
  another file ran.
- **If wrong:** S9 watches connectivity while a one-file `/upload` is on its way: `offline` then pauses the file, whose
  ticket, if the `/upload` answers, waits paused until `online`, as a job's own ticket does (`M3-U39`). Tests that
  pinned the removed details changed: `bucket.test.ts`'s `classifyAnswer` rows pass an XML body and a header,
  `progress.test.ts` calls `createMeter()`, `parts.test.ts`'s double builds `urls` (`M4-F8`), and
  `retry-abort.test.ts`'s `M3-U39` row uses a retry `/upload` for two files, the kind still not watched.
- **Status:** in force. S9 amends `M3-U92` and `M3-U49`.
- **Source:** design §3 F9; code audit of `main` at `907cc77`.
- **Visible in:** `client/job.ts`, `client/launch.ts` (`refused`, `askAlone`, `launch`), `client/retry-file.ts`,
  `client/job-run.ts` (`startOver`), `client/bucket.ts`, `client/transport.ts`, `client/locks.ts`, `client/parts.ts`,
  `client/progress.ts`, `client/upload-refusals-wait.test.ts` (the offline rows), `docs/guide/client.md` ("When /upload
  refuses one file", "Offline").

<!-- Task A appends its entries above this line. -->

### Server and storage (design §4, `M4-F10` to `M4-F14`)

<!-- Task B appends its entries above this line. -->

### API, configuration and documentation (design §5, `M4-F15` to `M4-F21`)

<!-- Tasks C and E append their entries above this line. -->

## Bindings (`M4-B`)

<!-- Task D appends its entries above this line. -->
