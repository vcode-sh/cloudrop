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

<!-- Task A appends its entries above this line. -->

### Server and storage (design §4, `M4-F10` to `M4-F14`)

<!-- Task B appends its entries above this line. -->

### API, configuration and documentation (design §5, `M4-F15` to `M4-F21`)

<!-- Tasks C and E append their entries above this line. -->

## Bindings (`M4-B`)

<!-- Task D appends its entries above this line. -->
