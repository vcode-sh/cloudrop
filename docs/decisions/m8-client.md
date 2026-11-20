# M8-L: the 0.2.0 client lifecycle

Rulings for the client changes in 0.2.0: a client-wide stop (`M7-P3`), request options for the upload server only
(`M7-P4`), and the React bindings that follow from them. Entries continue from `M8-L1`.

### M8-L1: `close()` stops a client for good; afterwards uploads answer `CLIENT_CLOSED`

- **Decision:** The client gets `close(options?: { abort: true }): void`. Afterwards `start()`, `upload()` and
  `resume()` are refused before any request with the new client-only code `CLIENT_CLOSED`, not retryable,
  whose message says to use the client of the user signed in now; a job created earlier cannot send again, since every
  file of it has ended (`M8-L2`). `resumable()`, `discard()` and `forget()` keep working: sign-out calls `forget()`
  after `close()`, and `discard()` sends `/abort` with the record's own token. `close()` returns nothing and never
  throws; each job's `done` and snapshot report how its files stopped.
- **Why:** `M7-P3`: an app had to find and cancel each route's jobs itself, and nothing stopped a file still waiting
  for its ticket from asking `/upload` with the next user's session. `close` names an end, like a tab's: a client is
  tied to one user's `namespace`, so it is never reopened, and the next user gets a new client. A promise would let a
  sign-out wait for a `/complete` of up to 120 s for nothing: each `/abort` goes with `keepalive`, no record is saved
  after `close()`, and `forget()` and the cancelled uploads' own deletes remove the same records in either order.
- **If wrong:** an app that wants to know when every `/abort` was answered awaits its jobs' `done`.
- **Status:** in force.
- **Visible in:** `src/client.ts`, `src/client/close.ts`, `src/client/job.ts`, `src/client/failures.ts`,
  `src/errors.ts`, `docs/guide/client.md#close-the-client`, `docs/guide/errors.md`.

### M8-L2: what `close()` sends, with and without `abort`

- **Decision:** The client keeps the jobs that have a file which may still send or be retried (every file done or
  aborted, or failed in an `upload()` job, which has no handle to retry with, takes a job out), and `close()` runs
  `abort()` of each. That cancels every file in any phase: one waiting for its ticket ends `aborted` at once and its
  `/upload` in flight is cancelled; a ticket that arrives anyway gets its `/abort` and no record; a paused file is woken
  to end; a file in its `/upload` re-ask backoff stops waiting. Then:
  - `close({ abort: true })`, for sign-out, is exactly `job.abort()`: every held ticket gets its `/abort`, which with a
    store ends its row `aborted` and frees its reservation, and its record is deleted.
  - `close()` without options, for a user who changed in another tab, ends each cancelled file as a closing tab would:
    a multipart upload with persistence on sends no `/abort`, keeps its record, and lets its lock and claim go, so the
    same user resumes it on a new client after signing in again, in this page or after a reload. A single `PUT`, and
    every file with persistence off or unavailable, cannot resume and is cancelled with its `/abort`.
  - Either way, a file whose `/complete` may have finished sends no `/abort` and is kept (`M3-H16`); one whose
    `/complete` succeeds after the cancel ends `done`.
- **Why:** the two outcomes `M7-P3` asks for differ in one thing: whether the records survive for the same user. A
  record whose upload got its `/abort` resumes nothing, so the user-change stop must not send one, and must not leave
  the lock held, or a new client in the same page would find the upload `UPLOAD_IN_USE`. Sign-out must send them, or
  the rows hold quota until the sweep (`M7-P2`). Reusing `job.abort()` keeps one cancel path: the keep branch is two
  checks in `file-run.ts` (`keptForResume`).
- **If wrong:** a user-change `close()` leaves a single `PUT` aborted and the other user's rows open until the sweep
  when that user never signs in again; the bucket's lifecycle rule removes their parts as it removes any tab's.
- **Status:** in force. Regressions: `src/client/close.test.ts` (both modes, three files in three phases, a file
  mid-`/complete`, a failed file holding its ticket) and the Vite example's browser pass "Sign out during a multipart
  upload ends its row as aborted".
- **Visible in:** `src/client/close.ts`, `src/client/file-run.ts`, `src/client/job-run.ts`, `src/client/upload.ts`.

### M8-L3: the first `close()` decides

- **Decision:** A second `close()`, with or without `abort`, does nothing. `close()` followed by
  `close({ abort: true })` aborts nothing more: the records the first kept are dropped through `discard()`, or deleted
  by `forget()`.
- **Why:** after the first call every file has ended, so a later `abort` would have to `/abort` records rather than
  jobs, which is `discard()`'s work under the upload's lock (`M3-U93`). In the React recipe both calls happen in the
  common order: sign-out's `close({ abort: true })`, then the session change's `close()` on the same client, which must
  change nothing.
- **If wrong:** an app that closes without `abort` first and then signs out leaves the kept uploads' rows open until the
  sweep unless it discards them.
- **Status:** in force.
- **Visible in:** `src/client/close.ts`.

### M8-L4: a failed file that holds its ticket is kept by `close()` like a running one

- **Decision:** Without `abort`, a failed multipart file of `start()` that keeps its ticket for `retry()` keeps its
  record and gets no `/abort`, whatever its error, as a running file does. `pagehide`'s `giveUp` drops a failure the
  same ticket cannot fix (`M4-F1`); `close()` does not make that distinction.
- **Why:** one rule for every file is easier to state and to rely on. A kept record whose token can no longer finish
  costs one probe: a resume asks `/complete` first, and an upload that is gone starts over with a new ticket
  (`M3-U74`), while a refusal fails with its own error.
- **If wrong:** a user who signs in again may see an unfinished upload that a resume cannot finish and has to discard.
- **Status:** in force.
- **Visible in:** `src/client/file-run.ts` (`abortFile`).

### M8-L5: the `headers` option, for the upload server only

- **Decision:** `ClientOptions.headers` is `HeadersInit` or a function, possibly async, that returns it. Its headers
  go with every request to `/upload`, `/sign`, `/complete` and `/abort`, never with a bucket `PUT`, which keeps
  `XMLHttpRequest`. A function is called before each request; an object is read once, when the client is created, and a
  value `new Headers()` refuses, or one that is not an object or a function, throws `INVALID_CONFIG` then. Names are
  sent in lower case, and the client's `content-type: application/json` replaces one among them. No server-only
  `fetch` option is added, and `fetch` keeps its meaning: everything, `PUT`s included.
- **Why:** `M7-P4`: a bearer token needed a `fetch` that told the server's URLs from presigned ones by hand, which also
  moved `PUT`s off `XMLHttpRequest` and its byte progress (`M3-U6`). Headers are what that case needs; a second fetch
  would be one more option for a need nobody reported. A function per request lets a token expire during a long upload.
  Fixed headers are built once so that no request without a function waits before `fetch`: `pagehide`'s keepalive
  `/abort` must start within the event (`M3-U33`).
- **If wrong:** an app that needs its own transport for the server only still passes `fetch` and loses `XMLHttpRequest`.
- **Status:** in force. Contract: `src/client/endpoints-headers.test.ts`.
- **Visible in:** `src/client/options.ts`, `src/client/endpoints.ts`, `docs/guide/client.md#send-a-bearer-token`,
  `docs/guide/deployment.md`, `docs/guide/troubleshooting.md`.

### M8-L6: a `headers` function that fails fails its request unsent, as `NETWORK_ERROR`

- **Decision:** When the function throws, rejects, returns what `new Headers()` refuses, or has not settled when the
  request's timeout or the caller's signal fires, the request is not sent. A cancel answers `ABORTED`; anything else
  answers `NETWORK_ERROR`, retryable, with the message "The headers option gave no headers for a request to the upload
  server, so it was not sent. Check the function passed as headers, then try again." and the function's error as
  `cause`. The client's retries run on it as on any network failure.
- **Why:** the common failure is a token refresh that found no network, which a retry fixes; a bug in the function
  fails after the retry budget with a message that names the option. The wait sits inside the request's timeout and
  signal, so a function that never settles cannot hold a file queued or a cancel unanswered (`M4-F3`).
- **If wrong:** for `/complete`, `NETWORK_ERROR` marks the file as one a `/complete` may have finished (`M3-H16`),
  though nothing was sent: a cancel then keeps its parts for the lifecycle rule instead of sending `/abort`. The cost is
  storage until that rule runs, never a lost file. With an async function, the `/abort` a closing page sends for a
  failed file waits for it and may never leave.
- **Status:** in force.
- **Visible in:** `src/client/endpoints.ts`, `src/client/failures.ts`, `docs/guide/errors.md`.

### M8-L7: the React factory's `close()` and the signed-in users recipe

- **Decision:** `createUploadHooks()` returns `close()` beside `useUpload` and `useResumable`: the client's `close()`,
  creating the client first when no hook has. The React guide's [Signed-in users](../guide/react.md#signed-in-users),
  the Hono guide, the resume guide and `examples/vite-react` replace `useStopUploads` and `StopUploadsOnUserChange`
  (`M7-P2`) with two calls: sign-out runs `close({ abort: true })`, then `forget()`, then the auth library's sign-out;
  a `useCloseOtherUsers(userId)` effect in the app's root closes every other user's client and drops it from the
  per-user cache once the page shows another user.
- **Why:** the stop needs no route list, so a route added later is stopped too. `close()` is permanent, which rules out
  the 0.1.1 recipe's effect cleanup: StrictMode runs a cleanup once on mount, and would close the client before its
  first upload. An effect keyed by the user that closes the others is idempotent, so StrictMode's second run finds
  nothing. A closed client is dropped from the cache so that the same user's next sign-in in the page gets a new one,
  whose `resumable()` lists what `close()` kept.
- **If wrong:** a session hook that reports no user for a moment during a refetch closes that user's client; their
  uploads stop as on a user change and stay resumable. The 0.1.1 recipe cancelled them in that case.
- **Status:** in force. Amends `M7-P2`.
- **Visible in:** `src/react.ts`, `src/react/types.ts`, `src/react.test.ts`, `docs/guide/react.md`,
  `docs/guide/hono.md`, `docs/guide/resume.md`, `examples/vite-react/src/lib/upload.ts`, `examples/vite-react/src/app.tsx`,
  `examples/vite-react/src/components/auth-panel.tsx`.

### M8-L8: `useResumable` reports what it is discarding

- **Decision:** `useResumable()` returns `discarding`, a `ReadonlySet` of the ids of the listed uploads whose
  `discard()` through this hook is running, from the call until the list has been read again, in the same render as
  that list.
- **Why:** the gap check of `M7-P3`'s brief: the production app that reported `M7-P2`
  (`apps/web/src/components/files/unfinished-uploads.tsx` there) and `examples/vite-react` each built this state
  themselves, to disable Discard while it runs, since a second `discard()` of one upload finds the first one's lock
  and answers `UPLOAD_IN_USE`. Everything else that app built is its own: its translations, a storage-usage refresh
  after a discard, and an account-generation check that drops a discard's result after the user changed, which the
  keyed provider and `close()` now cover. Removing the row at once instead was rejected: a row that unmounts loses the
  error a page shows in it when the discard fails.
- **If wrong:** two hooks listing the same upload do not see each other's discards; the second press still answers
  `UPLOAD_IN_USE`, as before.
- **Status:** in force.
- **Visible in:** `src/react/use-resumable.ts`, `src/react/types.ts`, `docs/guide/react.md`,
  `examples/vite-react/src/components/unfinished-uploads.tsx`.
