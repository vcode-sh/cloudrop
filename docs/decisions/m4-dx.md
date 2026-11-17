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
  every export, gzip, limit 23.5 kB (21.33 kB measured plus about 10%), beside the summed 36 kB budget, which stays.
- **Why:** audit F14. The summed budget counts the published files with their doc comments and messages (34.08 kB
  now); what a Workers app ships is the bundle, which the summed figure overstates by about 60%.
- **If wrong:** an app that imports only part of the server ships less than this budget, so it bounds the worst case,
  not the typical one.
- **Status:** in force.
- **Source:** design §4, audit F14.
- **Visible in:** `scripts/size-limit.config.ts`.

<!-- Task B appends its entries above this line. -->

### API, configuration and documentation (design §5, `M4-F15` to `M4-F21`)

<!-- Tasks C and E append their entries above this line. -->

## Bindings (`M4-B`)

`M4-B1` to `M4-B6` are the design's §6 as built; `M4-B7` onwards are task D's execution rulings. Fix round 1 of the
task D review amended `M4-B1` to `M4-B4`, `M4-B10` and `M4-B12` in place, before the branch merged, and added `M4-B13`
to `M4-B15`.

### M4-B1: `createUploadHooks<typeof cloudrop>(options?)`, with a lazy client

- **Decision:** a factory returns `{ useUpload, useResumable }`. It takes `createCloudropClient`'s options, or
  `{ client }` to share one. With options, the client is created at the first `upload()`, input pick, drop, `resume()`
  or `useResumable` read: in a handler or an effect, so never during a server render. A wrong option is caught there
  (`createCloudropClient` throws only its configuration error) and kept: `upload()`, `resume()` and `refresh()` resolve
  `{ data: null, error }` with that `INVALID_CONFIG`, and nothing throws from a handler or rejects unhandled from an
  effect. Fix round 1 (review M1) replaced a synchronous throw.
- **Why:** a factory lets `useUpload("documents")` infer the route's metadata and result without a second type
  argument; a client created at module load would run on the server, which loads `"use client"` modules too.
- **If wrong:** an eager option check would need the client to export its option reader; adding it is non-breaking.
- **Status:** in force (`542ae74`, `99f795a`).
- **Source:** design §6.1; task D review M1.
- **Visible in:** `src/react.ts`, `docs/guide/react.md#set-up`.

### M4-B2: `useUpload(route, options?)`

- **Decision:** as design §6.1. `files` lists the files of the hook's jobs in start order, each the client's snapshot
  plus `pause`, `resume`, `abort` and `retry` bound to its handle; `totals` sums the jobs' totals with the client's own
  rule (failed and aborted files out of the bytes; an all-empty set is finished once its counted files are done);
  `upload()` takes a `File`, an array or a `FileList` (`M4-B14`) and resolves `null` for none; `clear()` drops the jobs
  whose every file ended done or aborted, and keeps a job with a running or failed file, since the client keeps a failed
  file's ticket, parts, record and lock for `retry()` (review M2). `metadata`, `multiple` and `accept` are read from the latest committed render (assigned in
  `useInsertionEffect`), so `upload`, `pause`, `resume`, `abort`, `retry` and `clear` never change identity, while
  `getInputProps()` and `getDropProps()` are built per render.
- **Why:** design §6.1; stable functions keep an effect that lists `upload` in its dependencies from uploading again on
  every render.
- **If wrong:** per-render functions would be a breaking change for code that relies on identity.
- **Status:** in force (`542ae74`, `99f795a`).
- **Source:** design §6.1; task D review M2.
- **Visible in:** `src/react/use-upload.ts`, `src/react/upload-store.ts`, `src/react/types.ts`.

### M4-B3: `useResumable(route?)`

- **Decision:** `{ uploads, refresh }`. `uploads` is the client's `resumable()` list of the route (or of every route)
  minus every upload this page holds through the factory's hooks: one whose file, in a job those hooks started or
  resumed, is `queued`, `uploading`, `paused`, `completing`, or `failed` and kept for `retry()`. A held upload is
  matched by the record's route, name, size, type and `lastModified` against that file, because a file's snapshot does
  not carry the upload's id. So a failed file of this page is never listed (it is continued with `files[n].retry()`;
  `resume()` would be refused, since this page holds its lock), a listed upload leaves the list when its resume starts,
  and the same file uploaded anew hides an earlier unfinished upload of it until the new one ends done or aborted. The
  list is read after mount, when a job of the hooks starts, and whenever one of its files ends or starts again (its
  `done + failed + aborted` changes), in a microtask: the client queues a cancelled file's record removal right after
  its status publishes, and the store reads in order, so a deleted record is gone from the next read. `[]` on the
  server, before the first read and when the read failed. `refresh()` reads again and resolves with the listed
  `Result`, so a failure is not lost. A read that answers after a newer read started does not replace the newer list.
- **Why:** design §6.1. The first version read only when `job.done` settled, once per job, and listed this page's own
  uploads, so a retried or cancelled file left a stale entry and a failed one offered a resume the client refuses
  (review I1). "Every job of the client" is read as every job the hooks started (`M4-B12`).
- **If wrong:** an exact match needs the upload id on the client's file snapshot, a client API change; exposing an
  `error` field later is non-breaking.
- **Status:** in force (`542ae74`, `99f795a`).
- **Source:** design §6.1; task D review I1 and the controller's ruling on it.
- **Visible in:** `src/react/use-resumable.ts`, `src/react/job-tracker.ts`, `docs/guide/react.md#resume-after-a-reload`.

### M4-B4: behaviour under server rendering, StrictMode and unmounting

- **Decision:** `useSyncExternalStore` with a module-level server snapshot (`EMPTY_VIEW`), which is also the browser's
  state before any upload. Uploads start only from `upload()`, the input's `onChange`, a drop and `resume()`, never in
  an effect or during render. The hook's store listens to its jobs only while React listens to it, and rebuilds its view
  when React subscribes again, so a component hidden by `<Activity>` shows what its jobs did meanwhile; unmounting
  unsubscribes and cancels nothing, so the jobs finish and their resume records stay. Tested on React 19.3; React 18.3
  passed the same tests in a one-off run (all but the `<Activity>` row, an API React 18 lacks), and the library source
  type-checks against `@types/react` 18.3.
- **Why:** design §6.1.
- **If wrong:** an opt-in cancel on unmount is a non-breaking option; the guide shows `useEffect(() => abort, [abort])`.
- **Status:** in force (`542ae74`).
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

### M4-B10: the `cloudrop/react` ceiling is 2.3 kB, not 1.5 kB

- **Decision:** the budget is 2.3 kB gzip: the 2.07 kB size-limit measured after fix round 1, plus about 10%, the rule
  `size-limit.config.ts` states. Like the client's chunk, the client's errors chunk (`CloudropError`) is left out: an
  app that uses the hooks ships both with the client.
- **Why:** with every promise of §6.1 kept (the per-file identity cache, the latest-options handlers, drag counting,
  the stale-read guard), the hooks measured 1.66 kB; the review's fixes added the resumable list's tracking of held
  uploads (`M4-B3`), configuration errors as results (`M4-B1`) and file-drag checks (`M4-B13`), for 2.07 kB. The
  controller accepted the raised ceiling with about 10% headroom.
- **If wrong:** the owner may hold 1.5 kB; then a promise of §6.1 has to go, or the code be minified by hand.
- **Status:** in force (`542ae74`, `99f795a`); accepted by the controller, for owner confirmation.
- **Source:** task D measurement (`bun run package:check`, 2026-11-17).
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

- **Decision:** `useResumable` follows the jobs started or resumed through the same factory's `useUpload`: it reads
  again when one starts and when one of its files ends or starts again, and leaves out the uploads they hold
  (`M4-B3`). A job started on a shared client directly (`client.start()`) is neither followed nor left out; `refresh()`
  reads again after it.
- **Why:** the client offers no event for every job it runs, and task D does not change `src/client/**`.
- **If wrong:** a client-wide settle event would need a client API; the hook would then use it.
- **Status:** in force (`542ae74`, `99f795a`).
- **Source:** task D ruling; amended by review I1.
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

- **Decision:** the `client` option is typed `CloudropClient<T> & { resumable(route?: RouteName<T>): unknown }`. The
  added, non-generic member makes a client of another server's routes a type error.
- **Why:** `CloudropClient`'s methods are generic over the route name, and TypeScript compares generic methods by their
  constraints, so any `CloudropClient` was assignable to any other (review M6). A client whose route names include
  `T`'s still passes; results with the same route names are not compared.
- **If wrong:** a phantom type member on `CloudropClient` would make the check exact; that is a client API change.
- **Status:** in force (`d85022a`).
- **Source:** task D review M6.
- **Visible in:** `src/react/types.ts` (`UploadHooksOptions`), `src/react/types.test.ts`.

<!-- Task D appends its entries above this line. -->
