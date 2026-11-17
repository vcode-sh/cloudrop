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
  then only settle it `aborted`, and a later `retry()`'s new ticket leaves its record in place. Only a failure the same
  ticket could fix qualifies: one that is retryable and outside `M3-U31`'s set (`NEEDS_NEW_TICKET`, now in
  `client/failures.ts` and shared with `retry-file.ts`). A refusal (`UPLOAD_REJECTED`, `VERIFICATION_FAILED`, any
  other non-retryable error) or a dead ticket (`UPLOAD_EXPIRED`, `INVALID_TOKEN`, `NO_SUCH_UPLOAD`) still sends
  `/abort` and loses its record, as do a single `PUT` and every ticket of a client that keeps no records (`M3-S15`);
  the caller's `abort()` of a failed file that still holds its ticket still sends it (`M3-U32`).
- **Why:** design §3 F1. A resumed 10 GB upload whose parts all failed (the network gone without an `offline` event)
  ended `failed`; the reload a user makes to recover then fired `pagehide`, whose `/abort` deleted the parts and the
  record, so every byte was sent again. `/abort` is needed for a single `PUT`, whose object no lifecycle rule removes;
  multipart parts nobody resumes are removed by the bucket's abort-incomplete-multipart rule. A given-up ticket must not
  `/abort` later: another tab may resume and complete the upload, and an `/abort` with a live token would then delete
  the finished object (the `M3-U88` hazard). A refused file is excluded because a reload cannot recover it: `resume()`
  would repeat the refusal, and a file `afterVerify` refused, whose object the server deleted, would be found gone and
  sent again whole by a start over at every load (fix round 1, review I1). Exactness about the save is not worth its
  cost: knowing at `pagehide`, synchronously, whether the save committed takes a three-state flag in which a pending
  save still counts as saved. When no record was saved no other tab can know the upload's id, so an `/abort` there
  could not hit the `M3-U88` hazard; that is the refinement to make if the cost below ever matters.
- **If wrong:** parts of a failed upload nobody resumes stay in the bucket until the lifecycle rule removes them (a day
  on the recommended rule) instead of at once, and a plugin's `onAbort` hook does not run for them. "Keeps records" is
  read from the client (`records.enabled`), not from the record's own save, so where nothing was saved still no
  `/abort` is sent and those parts too wait for the lifecycle rule: where IndexedDB exists but cannot be used (opening
  it throws, as in an opaque-origin frame, or storage is blocked or full), which costs that for every failed multipart
  file of the page and leaves nothing to resume; where the browser refuses the lock request (`M3-U88`); and where it can
  no longer read the file to hash it. After a back-forward cache restore, `abort()` of a given-up file, and a `retry()`
  that takes a new ticket, leave its record listed (a second one for the same file, after that retry) until it
  expires, a resume of it ends, or `forget()` runs: deleting it could take a record another tab is resuming.
- **Status:** in force; narrowed in fix round 1 to failures the same ticket could fix, and a retry's new ticket no
  longer deletes a given-up record (review I1, M4). Amends `M3-S15`, `M3-U29` and `M3-U33`.
- **Source:** design §3 F1; code audit of `main` at `907cc77`.
- **Visible in:** `client/file-run.ts` (`giveUp`, `end`), `client/failures.ts` (`NEEDS_NEW_TICKET`),
  `client/job-run.ts` (`forgetTicket`), `client.ts` (`leftovers`), `client/lifecycle.ts`, `client/persist.test.ts`
  (the `pagehide` rows, the retry after a restore), `client/persist-failures.test.ts` (the `upload()` rows),
  `docs/guide/client.md` ("What gets cleaned up"), `docs/guide/resume.md` ("When a record is deleted").

### M4-F2: a file cancelled before its ticket ends at once

- **Decision:** cancelling a file that is queued or paused without a ticket (waiting for the job's `/upload`, a re-ask,
  a retry's new ticket, a start over or `resume()`'s checks) ends it `aborted` at once, with its own `ABORTED` error
  naming the file. A ticket `/upload` brings for it later gets one background `/abort` and nothing else: no lock, no
  record, no `PUT`. `job.abort()` and the caller's signal cancel such files the same way, so each ends with its own
  `ABORTED` error; `done` still answers `{ data: null, error }` with the job's `ABORTED` when the job's own `/upload`
  was cancelled. `done` does not wait for a late ticket's `/abort`: the file had settled before the ticket came.
- **Why:** design §3 F2. A file cancelled while the job's `/upload` was in flight stayed `queued` until `/upload`
  answered, against `M3-U11` ("a page shows a cancel at once"), and then took a ticket, a Web Lock and an IndexedDB
  save only to delete them with its `/abort`. A file with no ticket has nothing to tell the server, so nothing needs to
  wait.
- **If wrong:** after `job.abort()` during `/upload`, a page that compared a file's snapshot error with `done`'s error
  by identity now finds two errors with the same code; `error.file` is now set on them, as `M3-U10` asks of every error
  that belongs to one file.
- **Status:** in force. Amends `M3-U10`, `M3-U11` and `M3-S15` (dated lines, fix round 1, review M2).
- **Source:** design §3 F2; code audit of `main` at `907cc77` (probe: statuses `['queued','queued']` 20 ms after the
  cancel, then `POST /upload, POST /abort, PUT object, POST /complete`).
- **Visible in:** `client/file-run.ts` (`abortFile`), `client/entry.ts` (`settle`), `client/launch.ts` (`runEntry`),
  `client/resume.ts` (`resumeRun`), `client/job.test.ts` ("cancels one file while /upload is in flight"),
  `client/persist.test.ts` ("takes no lock and saves nothing").

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
  ("a server that never answers", including a body that never ends).

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

### M4-F5: a resumed file's run is assigned once

- **Decision:** `resume()`'s file gets one `entry.run`, the whole resume run from its checks to its settling, assigned
  where the run starts (`resumeJob`), instead of one for the checks and another for the upload. A start over hands it
  to its `/upload`'s run (`launch` assigns `entry.run` again), which the resume run awaits, so nothing waits on a run
  that settled before its file.
- **Why:** design §3 F5. With two assignments, a `retry()` during the checks waited correctly only because of the order
  of microtasks, and `allSettled` could spin on a file that had not settled while its `run` already had, which is how
  `M3-U90` once froze a tab.
- **If wrong:** nothing known; `client/resume-checks.test.ts` and the resume tests cover it, but a fault probe that
  drops the assignment hangs the lane rather than failing a test: `allSettled`'s spin is a microtask loop, which keeps
  Vitest's timeout from firing. The CI job's timeout is the backstop.
- **Status:** in force.
- **Source:** design §3 F5; code audit of `main` at `907cc77`.
- **Visible in:** `client/resume.ts` (`resumeJob`, `resumeRun`).

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

### M4-F7: a resumed upload's probe looks missing parts up in a `Set`

- **Decision:** the first answer of a resumed upload's probe counts the landed parts against a `Set` of the parts
  `PARTS_MISSING` named, not an array.
- **Why:** design §3 F7. `missing.includes(part)` for every landed part is O(L×M): 20.3 ms against 0.59 ms with a `Set`
  at 10,000 parts with 9,000 missing (audit measurement).
- **If wrong:** nothing known.
- **Status:** in force.
- **Source:** design §3 F7; code audit of `main` at `907cc77`.
- **Visible in:** `client/upload.ts` (`probed`).

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
  resumes", "fails keeping its record and lock"), `client/resume.test.ts` ("takes no repair round"),
  `client/pause.test.ts` ("a URL renewed before the pause is not renewed again").

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
  `client/progress.ts`, `client/upload-refusals-wait.test.ts` (the offline rows, and "a one-file /upload on its way"),
  `docs/guide/client.md` ("When /upload refuses one file", "Offline"). Fix round 1 moved `Entry`, `createEntry`,
  `outcomeOf`, `settle`, `held`, `pauseFile` and `resumeFile` from `client/file-run.ts` to `client/entry.ts`, which
  takes `file-run.ts` from 242 lines to 125; M3 entries that name those symbols in `file-run.ts` now find them there.

### M4-F22: `resumable()` leaves out the uploads this page holds

- **Decision:** the client keeps the ids of the uploads it holds (`UploadContext.claims`), and `resumable()` leaves them
  out. Each holder makes its own claim with `claim()`, which returns the release for that claim alone: a persisted
  multipart ticket from its arrival (`uploadOf`) until its unlock, which every way of giving the ticket up calls
  (`letGo`, `giveUp`, a `/complete` in doubt of `upload()`), and a `resume()` from its call, before its first await,
  until its checks refuse it or its upload's unlock. An upload is left out while any claim on it remains, so a refused
  resume of an upload a file of the client holds (`UPLOAD_IN_USE`) does not list it, and of two resumes in flight the
  one that ends first does not unhide the other. An upload another tab holds is still listed.
- **Why:** `resumable()` listed a running upload and a failed file of `start()` kept for `retry()`, which `resume()`
  refuses with `UPLOAD_IN_USE` in the same page. `cloudrop/react` matched held files by name, size, type and
  `lastModified` to hide them, which also hid an earlier unfinished upload of the same file (task D re-review). By id
  it is exact, and the hooks drop their matching (`M4-B3`). Fix round 2 claimed an id only when no claim existed, so
  two resumes in flight shared one and the first to end released it while the other ran (re-review 2, N4); one release
  per claim is exact under any interleaving.
- **If wrong:** listing held uploads again is a behaviour change in a minor version; a page that wants them can keep its
  own jobs' files.
- **Status:** in force (`516bac5`, `8b864a9`). The final review (M3) renamed `held` and `hold()` to `claims` and
  `claim()`: `held` already names a paused entry's wait (`client/entry.ts`) and the failed tickets of `pagehide`
  (`client/lifecycle.ts`).
- **Source:** task D re-review's client proposal; controller rulings, fix rounds 2 and 3.
- **Visible in:** `client/upload.ts` (`claims`, `claim`), `client/persist.ts` (`uploadOf`), `client/resume.ts`
  (`resumable`, `check`), `client/forget.test.ts`, `client/resume-job.test.ts`, `docs/guide/resume.md#two-tabs`.

### M4-F23: the client's ceiling is 11.5 kB

- **Decision:** the bundled `cloudrop/client` ceiling rises from 11 kB to 11.5 kB gzip, the step design §5.7 allows.
- **Why:** the M4a client fixes ended at 10.95 kB; `M4-F22` took it to 11.03 kB. Moving the resume's claim into
  `check()`, which owns the refusals and the lock, kept `resumeRun` unchanged but saved nothing measurable, and no
  other change keeps the behaviour and cuts 30 B.
- **If wrong:** spec §1's "client plus React" target of about 12 kB is now 11.03 + 1.96 kB, 12.99 kB after the final
  review: about 1 kB over the round figure, for the owner to confirm with `M4-B10`.
- **Status:** in force (`516bac5`). Supersedes `M3-U91`'s 11 kB.
- **Source:** design §5.7; task D measurement (`bun run package:check`, 2026-11-17).
- **Visible in:** `scripts/size-limit.config.ts`.

<!-- Task A appends its entries above this line. -->

### Server and storage (design §4, `M4-F10` to `M4-F14`)

### M4-F10: keys and other identifiers from storage XML keep their edge whitespace

- **Decision:** `xmlText` decodes an element's text exactly as sent; a new `xmlValue` (and `xmlValues`, which replaces
  `xmlTexts`) trims, for numbers, dates, booleans, codes, ETags (quoted hex, never meaningful whitespace) and the CORS
  lists. Keys, upload IDs, continuation tokens and the lifecycle rule's ID and prefix are read with `xmlText`.
- **Why:** audit F10. `keyProblem` accepts `"users/42/a "` and `"users/42/b\u00a0"`, and a route's `key()` can produce
  them, but `list()` returned them trimmed: `delete()` then removed a key that never existed, and `deletePrefix` failed
  forever with "Some keys were still listed after they were deleted". Whitespace inside a typed value carries no meaning
  in the S3 schema, so trimming stays there.
- **If wrong:** a backend that pads a key or an upload ID with whitespace would hand it back padded; none of the four
  backends does (contract case "lists and deletes keys with edge whitespace exactly as stored").
- **Status:** in force.
- **Source:** design §4, audit F10.
- **Visible in:** `storage/xml.ts`, `storage/s3/objects.ts`, `storage/s3/multipart.ts`, `storage/s3/bucket-settings.ts`,
  `storage/s3/objects.test.ts`, `server/api.test.ts` (`api.deletePrefix`), `testing/storage-contract/list.ts`.

### M4-F11: `/upload` aborts the multipart upload when signing its first parts throws

- **Decision:** `startFile` aborts the multipart upload it just created when signing the first part URLs or the token
  throws, then rethrows, so `startFileSafely` rejects that file with `SERVER_ERROR` as before. A `presignPart` that
  returns an error already aborted it.
- **Why:** audit F11. `StorageDriver` is public; a custom driver whose `presignPart` throws left an open upload that
  held its parts until the bucket's lifecycle rule removed it.
- **If wrong:** an `abortMultipart` that throws too replaces the first error in the log line `startFileSafely` writes;
  the file is rejected either way.
- **Status:** in force.
- **Source:** design §4, audit F11.
- **Visible in:** `server/upload.ts` (`startFile`), `server/upload-storage.test.ts`.

### M4-F12: no retry before `NO_SUCH_UPLOAD`; overlapping completions measured on live R2

- **Decision:** `completedBefore` keeps answering `NO_SUCH_UPLOAD` on the first HEAD that finds no object of this
  upload; no delayed second HEAD. Nothing in the code changed.
- **Why:** audit F12 feared that a `/complete` retried while the first `CompleteMultipartUpload` still ran could see
  `NoSuchUpload` before HEAD showed the object. 23 trials on live R2 (4 to 200 parts, the second Complete 0 to 600 ms
  after the first, ListParts and HEAD polled every ~35 ms) never showed it: every HEAD started after any `NoSuchUpload`
  answer saw the object. ListParts during a completion answers `500 InternalError` (a retryable `STORAGE_ERROR`), and
  a second Complete that starts early succeeds too, so both calls run `onComplete` (`M3-U84`).
- **If wrong:** a completion much longer than the 0.6 s measured could still open the window; then a cancel after
  `NO_SUCH_UPLOAD` deletes a recorded file (`M3-U83`, "If wrong"). The fix is the one the design names: retry the HEAD
  once after a short delay.
- **Status:** in force.
- **Source:** design §4, audit F12; `docs/research/r2-spike-findings.md`, "Overlapping completions, 2026-11-17".
- **Visible in:** `server/complete.ts` (`completedBefore`), unchanged.

### M4-F13: four simplifications of the server, two of them narrowed

- **Decision:** `verifyObject` does its own HEAD and `handleComplete` picks it or `completeParts` in one expression;
  `presignParts` returns `allOk(signed)`; `readJson` joins the body through `new Blob(chunks).arrayBuffer()`; one
  `abortContexts(shared, files, reason)` in `plugins.ts` builds the `onAbort` contexts for `runBeforeUpload`, `/upload`
  and `tokenAbortContexts` (which replaces `abortContext` for `/abort` and `/complete`). Two parts of the design's list
  were narrowed: `allOk` stays in `storage/s3/responses.ts` instead of moving to `errors.ts`, and `node.ts` keeps its
  copy loop.
- **Why:** design §4 accepted the simplifications. In `errors.ts`, `allOk` lands in the chunk `cloudrop/next` and
  `cloudrop/node` import, measured +0.11 kB gzip on both summed budgets (1.12 of 1.1 kB, 3.21 of 3.2 kB) for code
  neither runs. `NodeRequest` yields `Uint8Array<ArrayBufferLike>`, which `BlobPart` accepts only through an `as`;
  narrowing the public type would break only hand-built requests (a real Node stream is typed `any`), still not worth
  it for a loop of six lines.
- **If wrong:** none in behaviour: every existing test passes unchanged. `server/presign.ts` importing from
  `storage/s3/` is the cost of the first narrowing.
- **Status:** in force.
- **Source:** design §4, audit F13 (S1 to S4).
- **Visible in:** `server/complete.ts`, `server/presign.ts`, `server/http.ts` (`readJson`), `server/plugins.ts`
  (`abortContexts`), `server/token-request.ts` (`tokenAbortContexts`), `server/upload.ts`, `server/abort.ts`.

### M4-F14: a bundled-and-minified budget for `cloudrop`

- **Decision:** `scripts/size-limit.config.ts` adds "cloudrop (bundled)": `dist/index.js` bundled and minified with
  every export, gzip, limit 23.5 kB (21.33 kB measured plus about 10%), beside the summed 36 kB budget, which stays
  (M4-F16 later raised the summed budget to 40 kB; the final review measured 36.7 kB summed and 22.36 kB bundled).
- **Why:** audit F14. The summed budget counts the published files with their doc comments and messages (34.08 kB
  now); what a Workers app ships is the bundle, which the summed figure overstates by about 60%.
- **If wrong:** an app that imports only part of the server ships less than this budget, so it bounds the worst case,
  not the typical one.
- **Status:** in force.
- **Source:** design §4, audit F14.
- **Visible in:** `scripts/size-limit.config.ts`.

<!-- Task B appends its entries above this line. -->

### API, configuration and documentation (design §5, `M4-F15` to `M4-F21`)

### M4-F15: `route(policy, callbacks?)`; the single-object form is gone

- **Decision:** `route()` takes two arguments. The first, `RoutePolicy`, holds `accept`, `maxSize`, `maxFiles`,
  `metadata`, `visibility` and `authorize`; the second, optional `RouteCallbacks`, holds `prefix`, `key` and
  `onComplete`. Inside each object any order compiles. The single-object form is removed with no shim (pre-1.0), and
  the public type `RouteOptions` is replaced by `RoutePolicy` and `RouteCallbacks`. An option in the wrong argument is a
  type error (excess property) and, for JavaScript callers, `route()` throws `INVALID_CONFIG` naming the option and the
  argument it belongs in; `route-config.ts` still validates the merged definition at `createCloudrop`, and plugins'
  `extendRoute` still sees one merged `RouteDefinition`.
- **Why:** TypeScript infers type arguments from context-sensitive callbacks left to right within one object literal,
  so a callback written before `authorize` fixed `TAuth` at `object` (design §5.1, verified on tsc 7.0.2; `NoInfer`,
  inferring the whole `authorize` and wrapper helpers do not fix it). Callbacks in a later argument are inferred after
  the whole first argument. The placement check runs in `route()` because it is the only place that sees the two
  objects apart; silently ignoring a misplaced `prefix` would store files at the bucket root.
- **If wrong:** every route in an app moves to the new form, a mechanical change. A third-party wrapper that built
  routes from one object must split it.
- **Status:** in force. Amends M2-X6 (the ordering rule).
- **Source:** design §5.1, owner request 2026-11-17.
- **Visible in:** `server/route.ts`, `server/types.test.ts` (callbacks in every order, `metadata` after `authorize`),
  `server/route.test.ts`, every `route(` call in `src/`, `examples/next/lib/cloudrop.ts`, `README.md`,
  `docs/guide/server.md`, the design spec §4 sample.

### M4-F16: settings from the environment are read on the first request

- **Decision:** `CLOUDROP_SECRET` (when `secret` is omitted) and a storage preset's variables are read on the first
  request through one memoized reader, `ServerConfig.ready()` (`server/environment.ts`), which the handler awaits
  before any endpoint and every `cloudrop.api` call awaits too. Endpoints receive the resolved token keys
  (`EndpointConfig.tokenKeys`). Every option that needs no environment value, and every value passed explicitly
  (including `secret`), is still checked at construction. With `NODE_ENV === "development"` exactly, the environment
  is read at construction too, so `next dev` fails at start. A value missing at request time:
  1. The handler answers `SERVER_ERROR` 500, retryable, "The upload server is not ready. Try again in a moment."
     (with CORS headers for a trusted origin) and logs once
     `cloudrop: every request answers 500 until this is fixed. <message>` with the `INVALID_CONFIG` as the error; it
     logs again only when the message changes (a partial fix). Preflight, 404 and 405 answers need no environment.
  2. `cloudrop.api.*` resolve `{ data: null, error }` with that `INVALID_CONFIG`.
  3. Recovery, ruled: each request reads the environment again until it is complete, then `ready()` returns the cached
     result for the life of the server (a setting that is already complete, token keys or storage driver, is kept
     meanwhile). A fixed environment recovers without a restart; a later change to the environment is not picked up.
  4. The message is the one construction used to throw, and when the storage and the secret are both missing the two
     messages are joined into one `INVALID_CONFIG`, so a first setup sees everything at once. In development the
     environment is read at construction, where `r2()` or `s3()` throws its storage message at its own call before
     `createCloudrop` reads the secret: a first development setup missing both sees two messages, one after the other.
     Joining them there too would cost more code than one extra round is worth.
  5. An invalid value read from a variable names the variable, since no stack points at the app's code: "CLOUDROP_SECRET
     must be text of at least 32 characters", and for a preset the message ends "Environment variables with an invalid
     value: CLOUDROP_R2_ACCOUNT_ID." (fix round 1, M4-F17).
- **Why:** `next build` evaluates the route module while collecting page data, so a construction-time read made every
  build need production secrets (M3-H14's predicted cost). Workers bind the environment per request; reading at the
  first request, never at import, works there. Re-reading until success costs one failed lookup per request on a
  broken server and saves a restart once it is fixed; memoizing after success keeps the hot path free of environment
  reads and key imports.
- **If wrong:** a misconfigured production server starts and fails on its first request instead of at boot, which a
  health check that hits the handler catches; development still fails at start. The 500 is retryable (final review
  M6): a non-retryable one made a file in flight when a deploy went live without a variable give its ticket up, send
  `/abort` and delete its resume record (`M4-F1` keeps a record only for a retryable failure), so fixing the variable
  could not recover it. The cost: a server that stays broken is asked up to six times per request, the client's retry
  budget.
- **Size:** M4-F15 to M4-F18 together take the summed `cloudrop` budget from 34.09 to 36.66 kB gzip (published files
  with their doc comments) and the bundled one from 21.32 to 22.32 kB, measured 2026-11-17 after the fix round. The
  bundled budget (23.5 kB, M4-F14) holds; the summed one rises from 36 to 40 kB, the measured size plus about 10% as
  `scripts/size-limit.config.ts` prescribes. `readSetting` lives in `storage/lazy-driver.ts`, not `errors.ts`, which
  would have put it in the chunk `cloudrop/next` and `cloudrop/node` import (+0.15 kB each, measured).
- **Status:** in force. Amends M3-H14; the retryable 500 is the final review's M6.
- **Source:** design §5.2.
- **Visible in:** `server/environment.ts`, `server/config.ts` (`ready`, `EndpointConfig`), `server/handler.ts`,
  `server/api.ts`, `server/cloudrop.ts` (TSDoc), `server/environment.test.ts`, `client/persist-failures.test.ts` (the
  deploy missing its environment), `storage/lazy-driver.ts`
  (`readSetting`), `scripts/size-limit.config.ts`.

### M4-F17: `r2()` and `s3()` read every setting from the environment, lazily

- **Decision:** `s3()` reads `CLOUDROP_S3_ENDPOINT`, `CLOUDROP_S3_REGION`, `CLOUDROP_S3_BUCKET`,
  `CLOUDROP_S3_ACCESS_KEY_ID` and `CLOUDROP_S3_SECRET_ACCESS_KEY`; `r2()` adds `CLOUDROP_R2_BUCKET` to its three. Both
  take no argument at all. An option wins over its variable; an unset or empty option, and an empty variable, count as
  unset (so an empty `bucket` option is no longer a bucket-name error: it falls back to the variable). One
  `INVALID_CONFIG` names every missing setting by option and variable: "Missing S3 settings: region
  (CLOUDROP_S3_REGION), … Pass them to s3() or set the environment variables in parentheses." When any setting comes
  from the environment, the preset returns a lazy driver (`storage/lazy-driver.ts`) that builds the real driver on
  first use under M4-F16's rules: every method answers that `INVALID_CONFIG` until the settings are complete, and the
  server reads its state through a module-private `WeakMap`, so `StorageDriver` gains no public member. When every
  setting is passed, the preset returns the real driver, as before. When a build from the environment fails a check,
  each variable read is tried alone, with stand-ins for the rest, and the variables at fault are appended: "…
  Environment variables with an invalid value: CLOUDROP_S3_REGION." (fix round 1; the checks stay in one place, and
  the extra builds run only on that failure path).
- **Why:** design §5.3: a cold-developer test found `s3()` read nothing. Explicit values are checked at construction by
  building the driver once with valid stand-ins for the settings the environment will supply: every check stays in
  `createS3Driver` and the presets, in one place, instead of a second per-setting copy that could drift. `rules` and
  `publicUrl` need no environment value, so route checks at construction still see them.
- **If wrong:** an app that relied on an empty `bucket` throwing at construction now learns at the first request. A lazy
  driver that the app copies or wraps (`{ ...r2(), put }`) is not found in the `WeakMap`: with a storage setting
  missing, `ready()` succeeds, every upload fails with `STORAGE_ERROR` and the logger records `cloudrop: a storage
  request failed.` with the `INVALID_CONFIG` on every request, not the single not-ready line; nothing reaches the
  browser (final review M5, probed). `docs/guide/server.md` says to pass the driver as returned; a public readiness
  member on `StorageDriver` would close it, at the cost of the contract this entry keeps.
- **Status:** in force.
- **Source:** design §5.3.
- **Visible in:** `storage/presets.ts`, `storage/lazy-driver.ts`, `storage/presets-env.test.ts`,
  `storage/presets.test.ts`, `examples/next/lib/cloudrop.ts` (`CLOUDROP_S3_ENDPOINT ? s3() : r2()`),
  `docs/guide/server.md`.

### M4-F18: `forbidden(message?)` answers `403 FORBIDDEN`

- **Decision:** `forbidden(message = "You are not allowed to upload files here. Ask the site owner for access if you
  think this is wrong.")` is exported beside
  `unauthorized()` and returned from `authorize`; `/upload` answers `403` with code `FORBIDDEN`, not retryable.
  Both return the public type `Refusal`, which replaces `Unauthorized`: the same `Symbol.for("cloudrop.unauthorized")`
  brand plus `code: "UNAUTHORIZED" | "FORBIDDEN"`. A branded refusal without a code (another copy of cloudrop, plain
  JavaScript) still means `UNAUTHORIZED`, and a missing message takes the default of its code. Plugin hooks return a
  `CloudropError`, never a `Refusal`, so a plugin refuses with `new CloudropError("FORBIDDEN", message)`.
  `FORBIDDEN` joins `CloudropErrorCode` and the handler's status table; the client keeps no list of server codes, so
  it needs no change.
- **Why:** design §5.4: a quota, plan or role refusal answered `UNAUTHORIZED`, telling the user to sign in when they
  already had. One brand keeps foreign copies' refusals recognised; one type keeps `authorize`'s return type
  `TAuth | Refusal`, so TypeScript never infers a second refusal type into `TAuth`.
- **If wrong:** code naming the `Unauthorized` type renames it to `Refusal`.
- **Status:** in force.
- **Source:** design §5.4.
- **Visible in:** `server/route.ts` (`forbidden`, `Refusal`, `refusalError`), `server/upload.ts`, `server/http.ts`,
  `errors.ts`, `index.ts`, `docs/guide/errors.md`, `docs/guide/server.md` (the quota plugin example).

### M4-F19: the npm package ships a README and the LICENSE, and `package:check` requires both

- **Decision:** `packages/cloudrop/README.md` is a short page for npm: what cloudrop is, the install line, a quickstart
  (server with `route(policy, callbacks)`, the Next.js mount, `createUploadHooks` and `useUpload` with
  `getInputProps`), bucket CORS in one paragraph, absolute links to the guides on GitHub and the license line.
  `packages/cloudrop/LICENSE` is a committed copy of the repository's `LICENSE`. `files` stays `["dist"]`: the pack
  adds a README and LICENSE next to `package.json` by itself (checked with `bun pm pack`). `scripts/check-package.sh`
  lists the packed tarball and fails, naming the file, when `package/README.md` or `package/LICENSE` is missing, and
  fails when the copy differs from the repository's `LICENSE`.
- **Why:** design §5.5: a cold-developer test found a tarball with neither, so npm showed no page and the license did
  not travel with the code. A committed copy is the least fragile way to ship it: no build step to forget, and the
  `cmp` check catches drift. The check reads the tarball, which is what a publish uploads, rather than the source tree.
  Links are absolute because npm resolves relative links against its own site.
- **If wrong:** the check looks for the exact names `README.md` and `LICENSE`, so renaming either (to `readme.md` or
  `LICENSE.md`) fails it until the check changes too. Changing the license means changing both files.
- **Status:** in force.
- **Source:** design §5.5.
- **Visible in:** `packages/cloudrop/README.md`, `packages/cloudrop/LICENSE`, `scripts/check-package.sh`.

### M4-F20: the guides describe the code as merged, with the recipes cold developers missed

- **Decision:** design §5.6, against the code on `feat/m4a`: an install line and "pre-release; the API may change
  before 0.1" in the README, which also says that the `0.0.0` on npm only reserves the name until 0.1 is published;
  the README quickstart uploads through `cloudrop/react`, with one `cloudrop/client` call for apps without React; Hono
  and Bun mounting recipes, better-auth and a raw `Cookie` header in `authorize`, `forbidden()` beside
  `unauthorized()`, `accept: "*/*"`, the `maxFiles` default and `r2()`/`s3()` with no argument in `server.md`; a new
  `deployment.md` (same-origin versus cross-origin, absolute `basePath`, `trustedOrigins`, cookies across sites, the
  bucket's CORS rule lists the page's origin, a TLS proxy, building without secrets, Workers); AWS CLI commands with
  `--endpoint-url` and the lifecycle JSON in `bucket-setup.md`; a bearer-token `fetch`, resetting a file input and
  testing pause locally in `client.md`; a troubleshooting entry for cookies across sites. Stale text the merged code
  made false is gone: `examples/next`'s "the build needs the settings" (`M4-F16`), and its Wrangler sentence, since
  the home page now keeps a failed file for retry until `pagehide` (`M4-B6`).
- **Why:** design §1 and §5.6 list the friction the cold-developer tests met. The bearer `fetch` sends the token only to
  `basePath`: the option carries bucket `PUT`s too, the bucket's CORS rule allows no `Authorization` header, so the
  browser would block those `PUT`s, and the token has no business reaching the storage service. The
  Wrangler wording follows the code, not the notes' first draft: a missing `ListParts` answers `501`, which the
  driver maps to a `STORAGE_ERROR` that is not retryable (`storage/storage-error.ts`), so `M4-F1` keeps no record and
  `/abort` still runs, at once for `upload()` and at `pagehide` for `start()`. The AWS CLI commands and the lifecycle
  JSON were run against RustFS 1.0.5, and `checkBucket` then reported CORS and lifecycle `ok`.
- **If wrong:** a guide that disagrees with the code misleads; the code wins and the guide is fixed. The README's
  `0.0.0` sentence goes when 0.1 is published.
- **Status:** in force.
- **Source:** design §5.6; task E notes collected during tasks A to D.
- **Visible in:** `README.md`, `docs/guide/server.md`, `docs/guide/deployment.md`, `docs/guide/bucket-setup.md`,
  `docs/guide/client.md`, `docs/guide/troubleshooting.md`, `examples/next/README.md`.

### M4-F24: size ceilings with wide headroom (owner decision)

- **Decision:** the owner asked on 2026-11-17 for "a big margin for what comes". New gzip ceilings, measured size in
  brackets: `cloudrop` summed 50 kB (36.7), `cloudrop` bundled 30 kB (22.36), `cloudrop/next` 1.5 kB (1.01),
  `cloudrop/node` 4.5 kB (3.1), `cloudrop/client` 15 kB (11.03), `cloudrop/react` 3 kB (1.96). The spec's goal becomes
  client plus React at most 18 kB. A ceiling is a guard against accidents, not a target: a change that grows an entry by
  more than 5% says so in its commit and decision entry, so growth stays visible without a raise.
- **Why:** the store interface, the M5 plugins and the registry (dropped since, `M4-E1`) will add code; ceilings set at
  measured + 10% forced a decision per task (M3-U91, M4-F23, M4-B10) and spent review time on bytes rather than
  behaviour.
- **If wrong:** a slow drift goes unnoticed until it is large; the 5% rule and the measured sizes kept in
  `scripts/size-limit.config.ts` are the check.
- **Status:** decided. Supersedes the ceilings of M4-F14, M4-F16's summed budget, M4-F23 and M4-B10.
- **Source:** owner, 2026-11-17.
- **Visible in:** `scripts/size-limit.config.ts`, spec §1.

### M4-F25: the shipped `.js` carries no JSDoc; the `.d.ts` files keep it

- **Decision:** the build drops JSDoc comments from the emitted `.js` (`outputOptions.comments`: legal and annotation
  comments such as `@__PURE__` stay, `jsdoc: false`). The `.d.ts` files, which editors read, keep every doc comment
  (counted after the change: `dist/index.d.ts` 69 blocks, `dist/adapters/drizzle.d.ts` 12, as before), and the source
  maps still point at `src/`. Ceilings stay as M4-F24 set them, so the headroom grows.
- **Why:** the post-M5 review measured JSDoc at about a quarter of the adapters' published bytes. An app whose bundler
  minifies loses them anyway, so the size-limit entries measured as a minified bundle (`cloudrop` bundled,
  `cloudrop/client`, `cloudrop/react`) do not change; the summed entries do, and so does every unminified consumer: a
  Worker built without `--minify`, a server bundle, `node_modules`. Measured 2026-11-17 on `feat/post-m5`, summed gzip
  before → after: `cloudrop` 46.27 → 37.01 kB, `cloudrop/next` 1.16 → 0.78 kB, `cloudrop/node` 3.24 → 2.26 kB,
  `adapters/sql` 14.63 → 10.84 kB, `adapters/drizzle` 16.72 → 12.64 kB, `adapters/prisma` 13.69 → 10.41 kB.
- **If wrong:** someone reading `dist/*.js` without source maps sees no docs; they are in the `.d.ts` beside it and in
  `src/` through the source maps. One line in `tsdown.config.ts` restores them.
- **Status:** decided.
- **Source:** controller, after the task S review (M6 there), 2026-11-17.
- **Visible in:** `packages/cloudrop/tsdown.config.ts`, `scripts/size-limit.config.ts`.

<!-- Tasks C and E append their entries above this line. -->

## Bindings (`M4-B`)

`M4-B1` to `M4-B6` are the design's §6 as built; `M4-B7` onwards are task D's execution rulings. Fix round 1 of the
task D review amended `M4-B1` to `M4-B4`, `M4-B10` and `M4-B12` in place, before the branch merged, and added `M4-B13`
to `M4-B15`; fix round 2 amended `M4-B1`, `M4-B3`, `M4-B10`, `M4-B12` and `M4-B15`, with `M4-F22` and `M4-F23` in the
client section; fix round 3 amended `M4-F22` (one release per claim) and `M4-B3` (the microtask again); the final
review amended `M4-B2` to `M4-B4`, `M4-B10`, `M4-F14`, `M4-F16`, `M4-F17`, `M4-F22` and `M4-F23` in place.

### M4-B1: `createUploadHooks<typeof cloudrop>(options?)`, with a lazy client

- **Decision:** a factory returns `{ useUpload, useResumable }`. It takes `createCloudropClient`'s options, or
  `{ client }` to share one. With options, the client is created at the first `upload()`, input pick, drop, `resume()`
  or `useResumable` read: in a handler or an effect, so never during a server render. A wrong option is caught there
  (`createCloudropClient` throws only its configuration error) and kept: `upload()`, `resume()` and `refresh()` resolve
  `{ data: null, error }` with that `INVALID_CONFIG`, and nothing throws from a handler or rejects unhandled from an
  effect. A pick or a drop has no caller to resolve to, so there the error is thrown in a `setTimeout`, as the client
  reports a throwing listener (`M3-U8`): the handler returns normally and the error still reaches the console. Fix
  round 1 (review M1) replaced a synchronous throw; fix round 2 (re-review N2) stopped the pick and drop path from
  being silent.
- **Why:** a factory lets `useUpload("documents")` infer the route's metadata and result without a second type
  argument; a client created at module load would run on the server, which loads `"use client"` modules too.
- **If wrong:** an eager option check would need the client to export its option reader; adding it is non-breaking.
- **Status:** in force (`542ae74`, `99f795a`, `83fc0a7`).
- **Source:** design §6.1; task D review M1, re-review N2.
- **Visible in:** `src/react.ts`, `docs/guide/react.md#set-up`.

### M4-B2: `useUpload(route, options?)`

- **Decision:** as design §6.1. Each factory keeps the jobs started through it in one store per route
  (`HookSource.storeOf`), and every `useUpload(route)` of that factory renders that store: two components on one route
  share one list, and a component that unmounts and mounts again finds its running and failed files. `files` lists the
  files of the route's jobs in start order, each the client's snapshot plus `pause`, `resume`, `abort` and `retry` bound
  to its handle; `totals` sums the jobs' totals with the client's own rule (failed and aborted files out of the bytes;
  an all-empty set is finished once its counted files are done); `upload()` takes a `File`, an array or a `FileList`
  (`M4-B14`) and resolves `null` for none; the hook's `pause`, `resume`, `abort` and `retry` act on every job of the
  route; `resume(upload, file)` adds its job to the hook's route, which is the record's route whenever the record came
  from `useResumable(route)` of the same route; `clear()` drops, for every component on the route, the jobs whose every
  file ended done or aborted, and keeps a job with a running or failed file, since the client keeps a failed file's
  ticket, parts, record and lock for `retry()` (review M2). `metadata`, `multiple` and `accept` are read from the
  latest committed render (assigned in `useInsertionEffect`), so `upload`, `pause`, `resume`, `abort`, `retry`, `clear`
  and `getDropProps` never change identity; `getInputProps` keeps its identity while `multiple` and `accept` do, since
  it returns this render's values (final review M2, which added the test and made the two getters stable).
- **Why:** design §6.1; stable functions keep an effect that lists `upload` in its dependencies from uploading again on
  every render. One store per component stranded a failed file: unmounting cancels nothing (`M4-B4`), the failed file
  keeps its ticket for `retry()`, and `resumable()` leaves out an upload the page holds (`M4-F22`), so after a
  navigation and back no list showed it and `resume()` was refused with `UPLOAD_IN_USE` until a reload (final review
  I1, probed). Keyed by route, not by component, because a remounted component has no identity to find its old store
  by; sharing a route's list between two mounted components follows from that.
- **If wrong:** per-render functions would be a breaking change for code that relies on identity. A page that wants two
  separate lists on one route creates a second factory. A factory created inside a component loses the list on every
  mount; the guide says to create it at module level. The factory holds every job until `clear()` or a reload.
- **Status:** in force (`542ae74`, `99f795a`); the per-route store is the final review's I1. The final review (M4)
  renamed the per-file type `UploadFile` to `UploadItem` before the first publish: `UploadFile` sat one letter from
  `UploadedFile`, the stored file a done file's `result.file` holds.
- **Source:** design §6.1; task D review M2.
- **Visible in:** `src/react/use-upload.ts`, `src/react/upload-store.ts`, `src/react/types.ts`.

### M4-B3: `useResumable(route?)`

- **Decision:** `{ uploads, refresh }`. `uploads` is the client's `resumable()` list of the route (or of every route),
  which leaves out the uploads this page holds, by id (`M4-F22`): a running, paused or completing file, a failed file
  kept for `retry()`, and an upload while its resume runs. So a failed file of this page is never listed (it is
  continued with `files[n].retry()`), a listed upload leaves the list when its resume starts, and a refused resume lists
  it again. The list is read after mount, when a job of the hooks starts, whenever one of its files ends or starts again
  (its `done + failed + aborted` changes), and when the job settles: a resume cancelled while its checks run ends at
  once and lets the upload go only when they end. Each read waits for a microtask: a file cancelled while its
  `/complete` is in doubt settles and publishes before the client deletes its record and releases its claim, so a read
  started inside the publish would list the deleted upload (re-review 2, N5; fix round 2 had dropped the microtask).
  Changes in one burst share that microtask, and a job whose every file has settled holds the read back until its `done`
  settles, which reads anyway: one `abort()` of a 20-file job, or one `/upload` that refuses 20 files, costs one read,
  not 20 (final review M1, measured 21 before). The hold covers every job of the factory, not one route: while a
  settled job waits for its `done` (a cancelled resume's checks, or a cancelled file's `/abort` answer, up to its 10 s
  deadline), reads other jobs ask for wait too, then run once (final-fix re-review N1, probed); `refresh()` is not
  held. `[]` on the server, before the first read and when
  the read failed. `refresh()` reads again and resolves with the client's `Result`, so a failure is not lost. A read
  that answers after a newer read started does not replace the newer list.
- **Why:** design §6.1. The first version read only when `job.done` settled and listed this page's own uploads (review
  I1); fix round 1 matched held files by name, size, type and `lastModified` in the hooks, which hid an earlier upload
  of the same file; fix round 2 moved the filter into the client by id. "Every job of the client" is read as every job
  the hooks started (`M4-B12`).
- **If wrong:** exposing an `error` field later is non-breaking.
- **Status:** in force (`542ae74`, `99f795a`, `9cacad8`, `eafa4d4`); one read per burst is the final review's M1.
- **Source:** design §6.1; task D review I1, the controller's rulings on it and on the re-review's client proposal;
  re-review 2 N5.
- **Visible in:** `src/react/use-resumable.ts`, `src/react/job-tracker.ts`, `docs/guide/react.md#resume-after-a-reload`.

### M4-B4: behaviour under server rendering, StrictMode and unmounting

- **Decision:** `useSyncExternalStore` with a module-level server snapshot (`EMPTY_VIEW`), which is also the browser's
  state before any upload. Uploads start only from `upload()`, the input's `onChange`, a drop and `resume()`, never in
  an effect or during render. A route's store (`M4-B2`) listens to its jobs only while React listens to it, and
  rebuilds its view when React subscribes again, so a component hidden by `<Activity>` shows what its jobs did
  meanwhile; unmounting unsubscribes and cancels nothing, so the jobs finish, their resume records stay, and the next
  component on the route lists them, with a failed file's `retry()` working. Giving a failed file's ticket up on
  unmount is ruled out: React runs the same cleanup under `<Activity>` and in StrictMode's simulated unmount, and a
  ticket given up cannot be taken back. Tested on React 19.3; React 18.3
  passed the same tests in a one-off run (all but the `<Activity>` row, an API React 18 lacks), and the library source
  type-checks against `@types/react` 18.3.
- **Why:** design §6.1.
- **If wrong:** an opt-in cancel on unmount is a non-breaking option; the guide shows `useEffect(() => abort, [abort])`,
  which cancels every upload of the route, other components' included.
- **Status:** in force (`542ae74`); amended by the final review's I1 (the route's list survives an unmount).
- **Source:** design §6.1.
- **Visible in:** `src/react/upload-store.ts`, `src/react/hooks.test.ts`, `src/react/upload-store.test.ts`,
  `docs/guide/react.md`.

### M4-B5: a size budget of its own

- **Decision:** `cloudrop/react` has its own size-limit entry, bundled and minified without `react` and the client's
  chunk. The design's 1.5 kB is amended by `M4-B10`.
- **Why:** design §6.1.
- **If wrong:** —
- **Status:** amended by `M4-B10`.
- **Source:** design §6.1.
- **Visible in:** `scripts/size-limit.config.ts`.

### M4-B6: tests

- **Decision:** unit tests on happy-dom with React Testing Library drive the real client against the fake server
  (`src/react/*.test.ts`); the server render runs on Node with `renderToString`; type tests compile in `typecheck`. The
  example's home page uses the hooks, so the browser lane's three uploads, including picking the same file twice, prove
  them in Chromium.
- **Why:** design §6.1.
- **If wrong:** —
- **Status:** in force (`542ae74`); the browser lane runs after merge.
- **Source:** design §6.1.
- **Visible in:** `src/react/`, `examples/next/app/page.tsx`, `examples/next/lib/upload.ts`.

### M4-B7: `react` is an optional peer dependency of `cloudrop/react` only

- **Decision:** `packages/cloudrop` declares `react >=18` as an optional peer dependency; only `src/react.ts` and
  `src/react/**` import it. The AGENTS.md rule "zero runtime dependencies, web-platform APIs only" now names this one
  exception. React's types reach `src/react` through its own `import ... from "react"`: `types: []` only stops
  automatic global types, so neither tsconfig changes, and every other source file still has no React types. Biome
  turns its React rules on for a package that depends on `react`; an override in `biome.json` keeps them to
  `cloudrop/react`, since the chaos tests' `useChaosFixture()` is a Vitest fixture, not a hook.
- **Why:** the hooks need React; an app that does not import `cloudrop/react` installs and bundles nothing of it.
- **If wrong:** a separate `@cloudrop/react` package would move the entry; the import path would change.
- **Status:** in force (`542ae74`).
- **Source:** task D brief; code-quality `dependencies.md` ("optional integrations are optional peer dependencies").
- **Visible in:** `packages/cloudrop/package.json`, `AGENTS.md`, `biome.json`.

### M4-B8: a file keeps its object while its fields do

- **Decision:** a `files` entry is reused while every field of the file's new snapshot equals the last one's, compared
  per handle; it is not keyed by the snapshot object.
- **Why:** the client builds a new snapshot of every file of a job when one file changes (`snapshotOf` in
  `client/job-snapshot.ts`), so object identity would replace every row of a multi-file job on each progress tick.
- **If wrong:** if the client keeps unchanged file snapshots one day, the comparison still holds; it only does more
  work than needed.
- **Status:** in force (`542ae74`).
- **Source:** task D ruling, from reading `client/job-snapshot.ts`.
- **Visible in:** `src/react/upload-store.ts` (`isSameFile`).

### M4-B9: a hook without `multiple` takes only the first dropped file

- **Decision:** a drop on a hook whose `multiple` is false uploads the first file and ignores the rest.
- **Why:** the drop zone then behaves as the hook's input, which lets the user pick one file.
- **If wrong:** uploading every dropped file instead is a behaviour change in a minor version.
- **Status:** in force (`542ae74`).
- **Source:** task D ruling.
- **Visible in:** `src/react/use-upload.ts`, `docs/guide/react.md#drag-and-drop`.

### M4-B10: the `cloudrop/react` ceiling is 2.05 kB, not 1.5 kB

- **Decision:** the budget is 2.05 kB gzip: the 1.87 kB size-limit measured after fix round 2 (1.88 kB after round 3's
  microtask), plus about 10%, the rule `size-limit.config.ts` states. The final review's fixes (per-route lists
  `M4-B2`, stable prop getters, one read per burst `M4-B3`) took the entry to 1.96 kB, 90 B under the ceiling, which
  stays. Like the client's chunk, the client's errors chunk (`CloudropError`) is left out: an
  app that uses the hooks ships both with the client.
- **Why:** with every promise of §6.1 kept (the per-file identity cache, the latest-options handlers, drag counting,
  the stale-read guard), the hooks measured 1.66 kB. Fix round 1 added held-upload matching, configuration errors as
  results (`M4-B1`) and file-drag checks (`M4-B13`), for 2.07 kB under a 2.3 kB ceiling. Fix round 2 moved the matching
  into the client (`M4-F22`), for 1.87 kB.
- **If wrong:** the owner may hold 1.5 kB; then a promise of §6.1 has to go, or the code be minified by hand.
- **Status:** in force (`542ae74`, `99f795a`, `9cacad8`); accepted by the controller, for owner confirmation.
- **Source:** task D measurement (`bun run package:check`, 2026-11-17); final review measurement, same day.
- **Visible in:** `scripts/size-limit.config.ts`.

### M4-B11: a paused file is not uploading

- **Decision:** `isUploading` is true while a file of the hook is `queued`, `uploading` or `completing`; `paused`,
  `done`, `failed` and `aborted` are not.
- **Why:** a spinner or a "leave page?" prompt should not run for files the user stopped; the network's offline pause
  also shows `paused`.
- **If wrong:** counting `paused` in is a behaviour change in a minor version.
- **Status:** in force (`542ae74`).
- **Source:** task D ruling.
- **Visible in:** `src/react/upload-store.ts` (`UPLOADING`).

### M4-B12: `useResumable` follows the jobs the hooks start

- **Decision:** `useResumable` re-reads for the jobs started or resumed through the same factory's `useUpload`, at the
  moments `M4-B3` lists. A job started on a shared client directly (`client.start()`) is left out of the list by the
  client like any held upload (`M4-F22`), but does not trigger a read; `refresh()` reads again after it.
- **Why:** the client offers no event for every job it runs.
- **If wrong:** a client-wide change event would need a client API; the hook would then use it.
- **Status:** in force (`542ae74`, `99f795a`, `9cacad8`).
- **Source:** task D ruling; amended by review I1 and fix round 2.
- **Visible in:** `src/react/job-tracker.ts`, `docs/guide/react.md#resume-after-a-reload`.

### M4-B13: drop zones take only drags that carry files

- **Decision:** the drop handlers count, and cancel the default of, only events whose `dataTransfer.types` includes
  `"Files"`. A drag of text or a link leaves `isDragOver` false and keeps the browser's behaviour.
- **Why:** cancelling every drag broke dropping text into an input inside the zone and lit the zone for drags it could
  not upload (review M3).
- **If wrong:** a zone that wants other drags would need an option; adding one is non-breaking.
- **Status:** in force (`d3c3a82`).
- **Source:** task D review M3.
- **Visible in:** `src/react/drop.ts`, `docs/guide/react.md#drag-and-drop`.

### M4-B14: `upload()` takes what the client takes

- **Decision:** `upload()` resolves `null` for `null` or an empty list; otherwise it passes a list (an array, a
  `FileList`, anything with a numeric `length`) or one value to `client.start()`, which checks every item is a `File`
  (`readFiles` in `client/arguments.ts`). A `File` of another realm, such as an iframe's, resolves `INVALID_INPUT`.
- **Why:** the first version tested `instanceof File` itself and turned anything else into an empty list, so a foreign
  `File` resolved `null` silently (review M4). The client's check is the one the rest of the library uses.
- **If wrong:** if the client ever accepts a foreign `File`, the hooks follow it unchanged.
- **Status:** in force (`99f795a`).
- **Source:** task D review M4 and the controller's ruling on it.
- **Visible in:** `src/react/use-upload.ts`.

### M4-B15: `{ client }` must be created for the same server's routes

- **Decision:** the `client` option is typed `CloudropClient<T> & { resumable: (route?: RouteName<T>) => unknown }`.
  The added, non-generic member makes a client of another server's routes a type error; written as a property, its
  parameter is compared strictly, so a client of a server with fewer routes is refused too (re-review N1).
- **Why:** `CloudropClient`'s methods are generic over the route name, and TypeScript compares generic methods by their
  constraints, so any `CloudropClient` was assignable to any other (review M6). A client whose route names include
  `T`'s still passes; results with the same route names are not compared.
- **If wrong:** a phantom type member on `CloudropClient` would make the check exact; that is a client API change.
- **Status:** in force (`d85022a`, `43c1269`).
- **Source:** task D review M6, re-review N1.
- **Visible in:** `src/react/types.ts` (`UploadHooksOptions`), `src/react/types.test.ts`.

### M4-B16: `useResumable` gives `discard(upload)` and `forget()`

- **Decision:** `useResumable(route?)` returns `{ uploads, refresh, discard, forget }`. `discard(upload)` calls the
  client's `discard()` (`M3-U93`) and `forget()` the client's `forget()`, without arguments; each then reads the list
  again whatever the answer, and resolves the client's `Result` (or the factory's `INVALID_CONFIG`, as `refresh()`
  does). `forget()` deletes the records of the client's namespace, every route's, not only the hook's route: the store
  has no per-route clear, and sign-out, its use, clears them all.
- **Why:** an app that created its hooks with options never holds the client, and needed `{ client }` only to discard
  or forget (task B's `M4-E9`). Reading again after the call keeps `uploads` in step without the app calling
  `refresh()`; after a failed discard the upload stays listed.
- **If wrong:** a route-scoped `forget(route)` would need a records API that clears by route.
- **Status:** in force (task B fix round 1, M4b). `cloudrop/react` measures 2.02 kB, from 1.96 kB.
- **Source:** controller ruling on task B's concern 2, 2026-11-17.
- **Visible in:** `src/react/use-resumable.ts`, `src/react/types.ts`, `src/react/use-resumable.test.ts`,
  `docs/guide/react.md#resume-after-a-reload`.

<!-- Task D appends its entries above this line. -->

## M4b: decisions and the Next example (task B)

M4b's series is `M4-E` (examples and UI guidance). Task B, the Next example's home page and the "Build your upload UI"
guide, holds `M4-E1` to `M4-E19`; the Hono and Vite React examples number from `M4-E20`.

### M4-E1: no shadcn registry

- **Decision:** cloudrop ships no shadcn registry and no UI components. The hooks stay headless; the Next example's
  home page and the React guide's "Build your upload UI" show how an app builds its own upload UI on them.
- **Why:** the owner's ruling, 2026-11-17. Generated components impose a style and an icon set (the owner's apps use
  Tabler, not the lucide icons a registry would default to), and with the hooks an AI or a developer builds an upload
  UI from the app's own shadcn components in minutes. A registry would be a second public surface to version for
  little gain.
- **If wrong:** a registry can be added later over the same hooks without changing them.
- **Status:** in force. Base spec §2 and §14, the M4 design §7 item 2 and the plans README no longer list it.
- **Source:** owner, M4b brief.
- **Visible in:** `docs/guide/react.md#build-your-upload-ui`, `examples/next/app/page.tsx`.

### M4-E2: the example's UI is shadcn on Base UI, Tailwind v4 and Tabler icons, vendored

- **Decision:** `examples/next` runs `shadcn init` with the Base UI library and the `luma` preset (style `base-luma`,
  as the owner's projects), `iconLibrary: "tabler"`, Tailwind v4 through `@tailwindcss/postcss`, and
  `@tabler/icons-react`; lucide is not installed. `shadcn add attachment button progress` writes `components/ui/`,
  which is vendored: not edited by hand, and left out of Biome (`"!**/components/ui"` in the root `biome.json`). The
  vendored files are under the 250-line cap, so `scripts/check-file-size.ts` is unchanged. `examples/next/biome.json`
  extends the root and turns on Biome's `tailwindDirectives`, so it parses `app/globals.css`. The CLI needs an import
  alias, so the example's `tsconfig.json` maps `@/*` to its root.
- **Why:** the owner's apps (app-a, app-c) use this stack; an example in the same stack is one they can copy from.
  Vendored files stay as the CLI writes them, so a later `shadcn add` or update applies cleanly.
- **If wrong:** the components are app code; swapping the kit touches `components/upload/` only.
- **Status:** in force.
- **Source:** M4b brief, ruling 1 and 2.
- **Visible in:** `examples/next/components.json`, `examples/next/components/ui/`, `examples/next/biome.json`.

### M4-E3: Tailwind's styles load on the home page only

- **Decision:** `app/globals.css` (Tailwind, its preflight and the shadcn theme) is imported by `app/page.tsx`, not by
  the root layout, so `/lab` keeps its own CSS module and its look.
- **Why:** the brief keeps `/lab` unchanged; Tailwind's preflight resets margins, lists, tables and form controls the lab
  relies on. Measured after `next build`: `/` links the Tailwind stylesheet (about 40 kB), `/lab` only its 1.7 kB module.
- **If wrong:** a route group with its own layout would scope it as well.
- **Status:** in force.
- **Source:** M4b brief, ruling 1.
- **Visible in:** `examples/next/app/page.tsx`.

### M4-E4: no web font

- **Decision:** the Inter font `shadcn init` added to the root layout through `next/font/google` is removed, with the
  `--font-sans: var(--font-sans)` line of `globals.css` that pointed at it; the page uses Tailwind's system font stack.
- **Why:** `next/font/google` downloads the font during `next build`, which every browser lane runs; a build that needs
  the network for a font fails offline and slows the lane. That line is the only hand edit of a generated file outside
  `components/ui/`, and `globals.css` says so.
- **If wrong:** a self-hosted font through `next/font/local` would need no network.
- **Status:** in force.
- **Source:** task B.
- **Visible in:** `examples/next/app/layout.tsx`, `examples/next/app/globals.css`.

### M4-E5: the client's seven statuses on the Attachment's five states

- **Decision:** `queued`, `paused` and `aborted` show as `idle`, `uploading` as `uploading`, `completing` as
  `processing`, `failed` as `error` and `done` as `done`. The line under the name says the rest: waiting, paused at n %,
  bytes and speed, finishing, `stored as <key>`, `CODE: message`, or Cancelled.
- **Why:** the owner's apps style exactly those five states; a file that moves no bytes and has not failed is idle in
  their sense. The text keeps the distinctions the state merges.
- **If wrong:** the map is one record in `components/upload/file-status.ts`.
- **Status:** in force.
- **Source:** M4b brief, ruling 1.
- **Visible in:** `examples/next/components/upload/file-status.ts`.

### M4-E6: each component calls the hook itself

- **Decision:** the drop zone, the upload list and the unfinished-uploads panel each call `useUpload("files")` (the drop
  zone with `multiple: true`) and share the route's list through the factory, instead of one parent passing props. The
  drop zone is a `<label>` with `getDropProps()` around an `sr-only` input with `getInputProps()`: a click anywhere opens
  the picker, Tab reaches the input and Enter opens the picker (the browser test presses it), and a focus ring shows on
  the label through `has-focus-visible`.
- **Why:** it is what `M4-B2` makes possible and what an app with an upload button in one place and a list in another
  needs; a hidden input that stays in the layout keeps its focus and its name, where `display: none` would lose both.
- **If wrong:** passing the hook's result down works the same.
- **Status:** in force.
- **Source:** task B.
- **Visible in:** `examples/next/components/upload/`.

### M4-E7: progress reaches a screen reader in steps of 10 %

- **Decision:** a visually hidden `role="status"` line (polite) says how many files are uploaded, how many failed and,
  while uploading, the progress rounded down to 10 %. It is rendered before the first file, so assistive technology is
  listening when it first changes. Each row's bar is a labelled `progressbar` (`<name> progress`).
- **Why:** a polite region announces every change; one fed every progress event, or the visible line with its speed
  and time left, would talk without pause.
- **If wrong:** per-file announcements on status changes would give more detail.
- **Status:** in force.
- **Source:** M4b brief, ruling 1.
- **Visible in:** `examples/next/components/upload/upload-list.tsx`.

### M4-E8: an error line is never cut

- **Decision:** the row's description shows `CODE: message` in full, wrapping (`whitespace-normal wrap-anywhere` over
  the Attachment's `truncate`).
- **Why:** cloudrop's messages say what to do next; a truncated sentence says nothing. Keys wrap at any character.
- **If wrong:** a tooltip could carry the full text.
- **Status:** in force.
- **Source:** task B.
- **Visible in:** `examples/next/components/upload/upload-row.tsx`.

### M4-E9: "Discard all" forgets the browser's records; the hooks have no per-upload discard

- **Decision:** the unfinished-uploads panel's **Discard all** calls `client.forget()` and then `refresh()`. For that,
  `lib/upload.ts` creates the client at module load and passes `{ client }` to `createUploadHooks`. There is no
  per-upload discard: neither the hooks nor the client can forget or abort one listed record without its file.
- **Why:** `forget()` is the only record API besides `resume()`. Creating the client at load sends nothing and touches
  no storage (it probes IndexedDB and Web Locks; on the server it finds neither and is never used), so the lazy client
  of `M4-B1` is not needed here. `forget()` deletes records, not uploads: the bucket's abort-incomplete-multipart rule
  removes the parts.
- **If wrong:** a `client.discard(upload)` that sends `/abort` with the record's token and deletes the record would allow
  a per-row Discard; it is a new client API, listed as a follow-up, not built here.
- **Status:** superseded by `M4-E12` (fix round 1): `discard()` came to the client (`M3-U93`) and to `useResumable`
  (`M4-B16`), and `lib/upload.ts` creates its client lazily again.
- **Source:** task B (M4b brief, ruling 1, "discard").
- **Visible in:** `examples/next/lib/upload.ts`, `examples/next/components/upload/unfinished-uploads.tsx`.

### M4-E10: the home page's browser rows fault the bucket through Playwright routing

- **Decision:** `app/upload.browser.test.ts` causes its faults with `page.route` on requests that leave the example's
  origin: a 400 with the CORS header for a refused file, PUTs held unanswered for cancel, and every part but part 1
  held so that a reload falls between parts. The rows assert what a person sees through accessible locators (the
  upload list, a row's buttons by name, the unfinished-uploads list), plus the bytes read back through the example's
  storage and the bucket PUTs the page sent.
- **Why:** routing runs inside Chromium, so the rows run unchanged on live R2, where no proxy can sit in front of the
  bucket (`M3-K1`). The proxy lane's chaos rows stay where they were.
- **If wrong:** a row that needs a real network fault moves to a `*.chaos.browser.test.ts` file.
- **Status:** in force.
- **Source:** M4b brief, ruling 3.
- **Visible in:** `examples/next/app/upload.browser.test.ts`, `examples/next/app/home-page.ts`.

### M4-E11: the React guide's "Build your upload UI"

- **Decision:** `docs/guide/react.md` gains a section with why there are no ready-made components, the hook-to-UI map
  (drop zone, list, Attachment states, resume panel) in short code from the example, and a note that the pattern works
  with any UI kit or icon set.
- **Why:** with no registry (`M4-E1`), the guide is where an app learns the shape of a full upload UI.
- **If wrong:** the example's README links the same files.
- **Status:** in force.
- **Source:** M4b brief, ruling 4.
- **Visible in:** `docs/guide/react.md#build-your-upload-ui`, `examples/next/README.md`.

### M4-E12: the panel discards per row; the example's client is lazy again

- **Decision:** each row of the unfinished-uploads panel has **Discard <name>**, and **Discard all** discards every
  listed upload, both through `useResumable`'s `discard()` (`M4-B16`): each upload is aborted on the server, which with
  a store ends its row and frees its reservation. A failed discard shows its message in a `role="alert"` line and the
  upload stays listed. `lib/upload.ts` is back to `createUploadHooks<typeof cloudrop>()`, the lazy client of `M4-B1`.
  While an upload's discard runs, its Discard button, and Discard all, are disabled: a second press would find the
  first one's lock and show `UPLOAD_IN_USE` although nothing is being sent (fix round 2, re-review N4).
- **Why:** with `discard()` in the hooks, nothing in the app needs the client. Discard all goes through `discard()`
  rather than `forget()` so that it means what Discard on one row means; `forget()`, which aborts nothing, stays for
  sign-out. Supersedes `M4-E9`.
- **If wrong:** Discard all through `forget()` is one line, and leaves the parts and reservations to the lifecycle rule
  and the sweep.
- **Status:** in force.
- **Source:** controller rulings on task B's concerns 1 and 2; task B review "Not re-raised".
- **Visible in:** `examples/next/components/upload/unfinished-uploads.tsx`, `examples/next/lib/upload.ts`,
  `examples/next/app/upload.browser.test.ts` (the Discard row), `examples/next/app/upload.store.browser.test.ts`.

### M4-E13: row controls keep keyboard focus

- **Decision:** Pause and Resume are one button whose label and icon follow the status, so React keeps the element and
  its focus. Retry and Cancel, which remove their own button, move focus to the row (`<li tabIndex={-1}>`, with a
  visible outline) before they act. The spinner spins only under `motion-safe`. In the unfinished-uploads panel,
  Discard first moves focus to the next row's Discard (else the previous row's), and Discard all, or the last row's
  Discard, to the drop zone's input, since the panel unmounts with its last row (fix round 2, re-review N3).
- **Why:** with two conditional buttons, Enter on Pause unmounted the focused button and focus fell to `<body>`, so the
  next Tab started from the top of the page and a screen reader heard nothing (review I1). The row keeps focus inside
  the list and reads the row's new state.
- **If wrong:** focusing the list's heading would also keep focus in the list, a step further from the file.
- **Status:** in force; the browser row "keyboard focus stays on Pause and Resume, and Cancel moves it to the row"
  asserts it.
- **Source:** task B review I1.
- **Visible in:** `examples/next/components/upload/upload-row.tsx`.

### M4-E14: bulk buttons are enabled from the hooks' contracts

- **Decision:** **Pause all** is enabled while a file is queued or uploading; **Cancel all** while a file has not ended
  done or aborted, failed files included; **Clear finished** while no file has failed and one has ended done or
  aborted. The totals line leaves out the bytes when nothing is counted ("0 of 1 uploaded, 1 failed"), and time left
  above 90 s reads in whole minutes.
- **Why:** `isUploading` counts completing files, which pause ignores, and leaves out failed files, which abort cancels;
  `clear()` keeps any upload with a failed file, so the old rule offered buttons that did nothing (review M1, M2).
- **If wrong:** a hook field per bulk action (`canPause`, `canClear`) would move the rule into the library; not needed
  while it is one line each.
- **Status:** in force.
- **Source:** task B review M1, M2.
- **Visible in:** `examples/next/components/upload/upload-list.tsx`, `examples/next/components/upload/file-status.ts`.

## M4b: the Hono and Vite examples (task A)

Rulings of M4b task A: `examples/hono` and `examples/vite-react`, shaped like the owner's Bun + Hono + better-auth + Drizzle app, the reference for
its pilot. Task B numbers the `M4-E` series from 1 to 19; these start at 20. Paths are from the repository root.

### M4-E20: the workspace installs drizzle-orm 1.0.0-rc.5; the 0.45 line is type-checked on the side

- **Decision:** `packages/cloudrop`'s dev dependency is `drizzle-orm` 1.0.0-rc.5, the version `examples/hono` and the
  pilot app use, so the workspace has one copy. `scripts/check-drizzle-versions.sh` now defaults to 0.45.4 and the CI
  job, renamed `drizzle-0-45`, type-checks the adapter and its tests against it; the peer range stays
  `>=0.45.0 <1 || >=1.0.0-rc.5 <2`. Two test fixtures were adapted to 1.0 (`fixtures.db.integration.test.ts`: execute's
  answer is one result or a list, read with `.flat()`; the SQLite file is opened with Drizzle's `node-sqlite` driver
  instead of the proxy driver 0.45 needed). No source file changed.
- **Why:** with 0.45 in the package and 1.0 in the example, bun's workspace link resolved `drizzle-orm` from the
  package's folder, so `cloudrop/adapters/drizzle` loaded 0.45 while the app loaded 1.0. Measured: `drizzle-kit
  generate` (1.0) failed with "Cannot read properties of undefined (reading 'getColumnCasing')" on `cloudropPgTables()`.
  The first fix round copied the built package into the example's `node_modules`; the controller ruled for one copy
  instead. With 1.0 installed: `test:db` 594 passed, 12 skipped; `test:wrangler` (Drizzle over D1) 104 passed, 23
  skipped; `drizzle-kit generate` in the example reports no schema change through the link; the 0.45.4 check passes.
- **If wrong:** the 0.45 line loses its runtime proof (the db and Wrangler lanes run 1.0 only); the side check catches
  type drift, and `scripts/check-drizzle-versions.sh 0.45.4` can be paired with a runtime copy if 0.45 users report
  behaviour differences.
- **Status:** decided.
- **Source:** M4b task A, fix round 1 (controller ruling), 2026-11-17.
- **Visible in:** `packages/cloudrop/package.json`, `scripts/check-drizzle-versions.sh`, `.github/workflows/ci.yml`,
  `packages/cloudrop/src/testing/db/fixtures.db.integration.test.ts`,
  `packages/cloudrop/src/adapters/drizzle-tables.db.integration.test.ts`, `AGENTS.md`.

### M4-E21: cloudrop is mounted for POST and OPTIONS, outside the global hono/cors

- **Decision:** `createApp` mounts the handler like better-auth, `app.on(["POST", "OPTIONS"], "/api/cloudrop/*", …)`,
  the two methods it serves. A global `hono/cors` (exact web origin, credentials) covers the app's own routes and skips
  every path under `/api/cloudrop/`, with a comment saying why; `docs/guide/hono.md` step 4 says the same.
- **Why:** measured with the skip removed: `hono/cors` answered cloudrop's preflight itself with its own list
  (`Allow-Methods: GET,POST,OPTIONS`, `Allow-Headers: Content-Type`, `Max-Age: 86400`) and cloudrop never saw it. A
  cookie upload still passed, because that list happens to allow `Content-Type`; a preflight asking for
  `authorization` (a bearer token) got the middleware's `Content-Type` only. With the skip, cloudrop answers
  `Allow-Methods: POST`, `Allow-Headers: content-type,authorization`, `Cache-Control: no-store`. So the honest claim is
  "uploads work only while the app's list happens to cover them", not "uploads fail". The browser row "cloudrop answers
  its own preflight through the app's global CORS middleware" pins cloudrop's answer through the real app; a fault probe
  that removed the skip failed that row alone, and every upload row passed with the global middleware in place.
- **If wrong:** wording only; the skip costs nothing.
- **Status:** decided.
- **Source:** M4b task A, 2026-11-17.
- **Visible in:** `examples/hono/src/app.ts`, `examples/vite-react/src/app.browser.test.ts`, `docs/guide/hono.md`.

### M4-E22: the example's routes, quota and multipart threshold

- **Decision:** `avatar`: `image/*`, at most 2 MB, one file per `/upload`, one PUT; `store.route` with `tx`, so
  `onComplete` reads the user's `avatar` row `FOR UPDATE`, upserts it (`user_id`, `key`, `file_id`) in the
  completion's transaction and returns `{ replaced }` (the key is already in the response's `file`), and
  `afterComplete` deletes the replaced avatar with `api.deleteFile`, which frees its quota. The row lock makes two
  replacements of one avatar take turns, so neither orphans the other's file (review M1). `attachments`: `*/*`, 100
  MB, 10 files, no `onComplete` (review M2: it only echoed `file.id`). Both have `owner: userId`; the quota is `UPLOAD_QUOTA_MB` (500 by default, 50
  in the lane). `multipartThreshold: "8MB"`, so a 20 MiB demo file goes in three parts; the comment and the guide say an
  app keeps the 64 MiB default. The store runs in transaction mode on a node-postgres `Pool` under Drizzle 1.0 with
  `defineRelations`, as that app's database package does.
- **Why:** the brief's routes; a deleted-on-replace avatar shows `afterComplete` doing the network call that
  `onComplete`'s transaction must not hold. The 8 MB threshold keeps the browser rows' files small (the quota row sends
  51 MiB instead of more than 64 MiB plus a quota above it).
- **If wrong:** a failed delete of the replaced avatar is logged and leaves that file in the list for a manual delete;
  so does the loser of two first avatars uploaded at once, which have no row to lock.
- **Status:** decided.
- **Source:** M4b task A, 2026-11-17.
- **Visible in:** `examples/hono/src/uploads.ts`, `examples/hono/src/db/schema/avatars.ts`.

### M4-E23: `files.list` reads cloudrop's table; `delete` goes through the file API

- **Decision:** the oRPC router `files` has `list` (a Drizzle select on `cloudropFiles` where `owner` is the session's
  user and `status` is `completed`, newest first), `delete` (`api.file(id)` to check owner and status, `NOT_FOUND`
  otherwise, then `api.deleteFile(id)` and the `avatar` row if it named that file) and `avatar` (a 10-minute
  `api.getUrl`). The context carries the session's user id, read once per `/rpc` request as that app does. The
  `RPCHandler` takes oRPC's `SimpleCsrfProtectionHandlerPlugin` and the page's `RPCLink` its
  `SimpleCsrfProtectionLinkPlugin`; the app's CORS middleware allows the `X-CSRF-Token` header they use (review I1).
- **Why:** the tables are the app's, so reading them with the app's own Drizzle is the intended pattern (controller
  ruling), not a gap: a query the app can join and page beats a store listing call. Writes stay with the store so usage
  stays in step. The CSRF pair because oRPC deserialises `multipart/form-data`, which another origin of the same site
  can post without a preflight, with the `SameSite=Lax` session cookie: measured, such a post to `/rpc/files/list`
  answered 200 as the signed-in user before the fix and 403 `CSRF_TOKEN_MISMATCH` after; the browser row "a form posted
  to an oRPC procedure from another origin of the site is refused" pins it. cloudrop's endpoints were never exposed:
  they require `application/json` and check `Origin`.
- **If wrong:** an app whose client cannot send a custom header refuses `/rpc` requests whose `Origin` is not the web
  origin instead.
- **Status:** decided.
- **Source:** M4b task A, 2026-11-17.
- **Visible in:** `examples/hono/src/rpc/router.ts`.

### M4-E24: discarding unfinished uploads uses `forget()`, all at once; sign-out forgets first

- **Decision:** the unfinished-uploads panel lists `useResumable("attachments")`, resumes a record with the file picked
  again, and offers "Discard all", which calls the client's `forget()`. Sign-out calls `forget()`, then better-auth's
  `signOut()`, then reloads the page, which drops the hooks' in-memory uploads and the cached queries. The page creates
  its client once (`createCloudropClient` with the API's absolute `basePath`) and passes it to `createUploadHooks` as
  `{ client }`, so it can call `forget()`.
- **Why:** the client has no call that forgets one record (`forget()` takes nothing or `{ all: true }`), and a record
  cannot be resumed and aborted without its file. A per-record discard is a client API change outside this task; it is
  reported as a pilot gap. What a discarded upload left in the bucket goes with the sweep (after its ticket expires plus
  grace) and the bucket's lifecycle rule.
- **If wrong:** add `forget(upload)` to the client and a per-row Discard here.
- **Status:** decided.
- **Source:** M4b task A, 2026-11-17.
- **Visible in:** `examples/vite-react/src/components/unfinished-uploads.tsx`,
  `examples/vite-react/src/components/auth-panel.tsx`, `examples/vite-react/src/lib/upload.ts`.

### M4-E25: Postgres for the example and the lane, and the lane's third pass

- **Decision:** `scripts/postgres.sh up|down` starts `postgres:18.6` (the db lane's image) with its data in a tmpfs:
  the dev container `cloudrop-example-postgres` on port 19600 (`CLOUDROP_EXAMPLE_POSTGRES_NAME`, `_PORT`) with no
  `cloudrop.test` label, and with `CLOUDROP_EXAMPLE_POSTGRES_TEST=1` the label, as the browser lane starts it.
  `scripts/test-browser.sh` runs a third pass after the two Next passes: it checks ports 5181 and the Postgres port
  (`CLOUDROP_EXAMPLE_POSTGRES_PORT`, default 19610) up front, starts `cloudrop-browser-postgres-<pid>`, which the EXIT
  trap removes with the RustFS container, runs the Hono example's `setup:rustfs` (bucket `cloudrop-example-hono`,
  straight to RustFS, not through the chaos proxy) and `db:migrate`, then Playwright starts the API and `vite preview`.
  `test:browser:live` stays Next-only. `test-db.sh` keeps its own container code.
- **Why:** the brief; a shared script for two container lifecycles with different names, labels and readiness would
  save little, so the db lane is unchanged.
- **If wrong:** chaos rows for this pass would point the API's `CLOUDROP_S3_ENDPOINT` at the proxy.
- **Status:** decided.
- **Source:** M4b task A, 2026-11-17.
- **Visible in:** `scripts/postgres.sh`, `scripts/test-browser.sh`, `examples/vite-react/playwright.config.ts`.

### M4-E26: shadcn on Base UI with Tabler icons, vendored and outside Biome

- **Decision:** `bunx shadcn@4.23.0 init -b base -p luma` (style `base-luma`, the pilot app's), then `iconLibrary` set to
  `tabler` in `components.json` and `lucide-react` removed before `shadcn add attachment button card input label badge
  table progress`. The registry offers `Attachment`, so the app uses it unchanged. `src/components/ui/` is excluded
  from Biome by the root line `"!**/components/ui"` (task B adds the same line); no vendored file passes 250 lines, so
  `check-file-size.ts` is unchanged. The generated `src/index.css` uses Tailwind directives Biome's CSS parser refuses
  by default: a nested `examples/vite-react/biome.json` (`"root": false`, `"extends": "//"`) turns on
  `css.parser.tailwindDirectives` for this example only, so the root file keeps the one agreed line. Buttons that open a
  file picker are `<label>`s styled with `buttonVariants` around the input, which Biome's a11y rule can follow.
- **Why:** the brief's UI stack; a root `css` setting would be a second edit to a file shared with task B.
- **If wrong:** move `tailwindDirectives` to the root config once both examples use Tailwind.
- **Status:** decided.
- **Source:** M4b task A, 2026-11-17.
- **Visible in:** `examples/vite-react/components.json`, `examples/vite-react/biome.json`, `biome.json`.

### M4-E27: settings, auth and the server's types for the web app

- **Decision:** `src/settings.ts` reads the environment once per process with a typed reader (`readSettings(env)`:
  `DATABASE_URL` and `BETTER_AUTH_SECRET` required, `PORT` 5181, `API_ORIGIN`, `WEB_ORIGIN` http://localhost:5173 as
  exact origins, `UPLOAD_QUOTA_MB`, `SWEEP_INTERVAL_MINUTES`); cloudrop reads its own variables. better-auth uses its
  Drizzle adapter (`relations-v2`), email and password, a fixed `baseURL`, the web origin as its only trusted origin,
  host-only `SameSite=Lax` cookies under the prefix `cloudrop-example`. The Hono package exports `./types`
  (`Uploads`, `AppRouterClient`), which the web app imports with `import type` through a workspace dev dependency, as
  a monorepo's web app types its client from its API package. The worker sweeps on a timer; its comment and the guide
  show the job-queue form, a scheduled queue and a handler.
- **Why:** the brief (no env-schema dependency, the pilot app's composition-root and factory shape).
- **If wrong:** nothing outside the examples depends on these names.
- **Status:** decided.
- **Source:** M4b task A, 2026-11-17.
- **Visible in:** `examples/hono/src/settings.ts`, `examples/hono/src/auth.ts`, `examples/hono/src/types.ts`,
  `examples/hono/src/worker.ts`.
