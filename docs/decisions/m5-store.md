# M5 decisions: the database store

Design: [`2026-11-17-m5-store-design.md`](../superpowers/specs/2026-11-17-m5-store-design.md); its sections carry the
decisions `M5-T1` to `M5-T15` (data model, interface, server rules, file API, adapters, tests). Each entry below:
decision, why, if wrong, status, source, visible in. Execution rulings continue from `M5-T16`.

## Interface and memory store (task A)

### M5-T16: the store types are public from `cloudrop`, with a named `OwnerUsage`

- **Decision:** `src/index.ts` exports `CloudropStore`, `ClaimOutcome`, `EndedStatus`, `FileRecord`, `FileStatus`,
  `NewFile`, `Transition` and `OwnerUsage`, all type-only. `OwnerUsage` (`reservedBytes`, `activeBytes`, `files`) names
  the shape spec §4 wrote inline for `usage()`, so `api.usage` (task B) and a store author share one name.
- **Why:** a store author implements the interface, so it is public (§4); the inline shape would otherwise be repeated
  by every adapter and by `api.usage`. `Usage` alone was too generic for the package's root namespace.
- **If wrong:** the extra name is a semver commitment; renaming it later is a breaking type change.
- **Status:** decided.
- **Source:** task A, 2026-11-17.
- **Visible in:** `src/server/store.ts`, `src/index.ts`.

### M5-T17: the columns spec §4 left open, per method

- **Decision:** every write sets `updated_at = now`. `claim` sets `claim` and `claimed_at`; `release` clears both (the
  row is `pending` as if never claimed); `complete` and `end` keep them, so a completed row still says which claim
  completed it and when. `cleaned` sets `cleaned_at` only where it is null (the first cleanup time stays) and ignores a
  missing row. `reconcile` writes only when a counter differs, and then stamps `updated_at` with the database's clock,
  because the interface passes it no time; a missing usage row counts as zeros, so an owner without rows gets no row.
  `end` from an ended status releases nothing (the bytes were released when it ended).
- **Why:** the contract compares whole rows (`raw.files()`), so every column must have one answer on every backend.
  Clearing on `release` keeps "a claim is set only on a row that was claimed past `pending`"; keeping it on `complete`
  costs nothing and helps an operator.
- **If wrong:** each is one assignment in the SQL core and the memory store, plus the contract row that pins it.
- **Status:** decided.
- **Amended 2026-11-17 (fix round 1):** a change that moves no bytes (an owner-less row, `end` from an ended status)
  does not write the usage row at all, so its `updated_at` stays. `reconcile` of an owner with rows but no usage row
  creates the row (Postgres: insert `ON CONFLICT DO NOTHING`, lock, recount); an all-zero recount still creates none.
  Both are in the TSDoc and pinned by cases, with the reserve rules the contract already enforced (a duplicate id
  throws; the usage row comes from the first reserved file).
- **Source:** task A, 2026-11-17.
- **Visible in:** `src/server/store.ts` TSDoc, `src/testing/store-contract/claim.ts`, `end.ts`, `usage.ts`.

### M5-T18: quota without an owner, and which writes an over-quota file makes

- **Decision:** with `owner: null` the `limit` is ignored and no usage is written (spec §5.7 counts rows with an owner).
  An `"over-quota"` file writes nothing: no row, no usage. The usage row is created by the first reserved file, so an
  `/upload` refused entirely leaves no row behind. `owners()` pages the usage table: `reserve` creates a usage row for
  every owner that has rows, so it lists every owner `reconcile` can repair, short of someone deleting usage rows by
  hand.
- **Why:** a quota needs someone to charge; refusing an owner-less file over a limit would refuse uploads of routes
  that never defined `owner` (`createCloudrop` only warns about them, §5.1). Paging the usage table's primary key is
  one indexed scan; a `DISTINCT owner` over the files table is not.
- **If wrong:** an app that deletes usage rows by hand must reconcile those owners by name.
- **Status:** decided.
- **Source:** task A, 2026-11-17.
- **Visible in:** `src/server/store.ts` (`reserve`, `owners`), `src/testing/store-contract/reserve.ts`, `usage.ts`.

### M5-T19: claim boundaries

- **Decision:** a claim is live through exactly `leaseMs`: a `completing` row is taken over only when
  `claimed_at < now - leaseMs`, so at `claimed_at + leaseMs` it is still `busy` and one millisecond later it is not.
  `claim` does not read `expires_at`: the server refuses a dead token before it claims (§5.5 step 2). A second claim
  with the same token on a live claim is `busy` too; the store does not know who holds a token.
- **Why:** "older than the lease" (§4) read as a strict comparison, the same direction as every other cut-off in the
  store (`stale` uses `<` throughout), so one rule covers them all.
- **If wrong:** a one-millisecond shift; the contract's boundary rows name it.
- **Status:** decided.
- **Source:** task A, 2026-11-17.
- **Visible in:** `src/testing/store-contract/claim.ts`.

### M5-T20: keyset paging for `stale` and `owners`

- **Decision:** `stale("expire")` orders by `(expires_at, id)`, `stale("cleanup")` by `(ended_at, id)`, `owners` by
  owner; each page holds at most `limit` rows and continues strictly after the previous page's last key. The cursor is
  null exactly when no row follows the page (a store looks one row ahead), so a page that ends at the last row is the
  last page. Cut-offs are strict (`expires_at < before`, `claimed_at < claimedBefore`, `ended_at < before`), and an
  `expired` row is never cleanup work, even uncleaned (§4 lists `aborted | rejected | failed | deleted`). Cursors are
  opaque strings; the memory store uses fixed-width milliseconds and the id.
- **Why:** keyset paging is what lets the sweep end the rows of one page before asking for the next without skipping
  any (offset paging would skip as many rows as it just ended); the look-ahead saves the sweep a last empty call.
- **If wrong:** a SQL backend whose collation orders ids or owners differently from another still pages correctly
  within itself; the contract uses ASCII ids that sort alike under every collation, so it does not pin a collation.
- **Status:** decided; amended 2026-11-17 (M5-T64): an `expired` row whose `cleaned_at` is null is now cleanup work.
- **Source:** task A, 2026-11-17.
- **Visible in:** `src/server/store.ts` (`stale`, `owners`), `src/testing/store-contract/stale.ts`, `usage.ts`.

### M5-T21: the store contract's setup, gaps and raw reader

- **Decision:** `describeStoreContract(name, setup)` calls `setup` before every case and `teardown` after it, also
  after a failure; setup returns empty tables, so a case compares whole tables. The target is `{ store, raw, gaps,
  injectFailure?, tables?, teardown }`. `gaps` follows the storage contract's name and meaning (an entry names what the
  backend lacks; the case calls `ctx.skip(reason)`): `transaction`, `concurrency`, `failureInjection`, `tables`. `raw`
  is `{ files(), usage(), putUsage(row) }` in one normalised shape (`src/testing/store-rows.ts`: camelCase, sizes as
  numbers, times as `Date`), `putUsage` being how a case makes counters drift. `reserve`'s atomicity is proven on every
  backend by a call whose second file reuses an existing id; injected failures (memory store) add the quota path and
  `complete`. The table-name and schema-check cases run through the optional `tables` member (a store over renamed
  tables with its own reader; a store over a files table missing a column), declared as the `tables` gap elsewhere.
- **Why:** per-case setup lets every assertion be exact, the oracle the brief asks for. A duplicate primary key is a
  failure mid-call that every database produces, where injection is possible only in memory.
- **If wrong:** setup per case costs a truncate per case on a database (milliseconds); a lane that wants one schema per
  run truncates in `setup` and drops in its own `afterAll`.
- **Status:** decided.
- **Amended 2026-11-17 (fix round 1):** `injectFailure` is now `() => Promise<void>` and means "the next write to the
  usage table fails, once", which a SQL lane implements with a trigger whose armed state survives the failed
  statement's rollback (a sequence on Postgres, a registered JS function in `WHEN` on SQLite; D1, which has neither,
  declares the gap); it is injected into `reserve` (with a
  quota), `complete`, `end` (completed to deleted) and `revoke`, each asserting both tables unchanged, so
  `failureInjection` need be a gap only on D1 (re-review N1). `RawTables` gains `deleteUsage(owner)` and is final. A single-connection
  backend should not declare `concurrency`: its concurrent cases run as stated, not as proof (spec §8). The
  transaction cases need a pool of at least two connections.
- **Source:** task A, 2026-11-17.
- **Visible in:** `src/testing/store-contract.ts`, `src/testing/store-rows.ts`.

### M5-T22: the memory store's transaction undoes key by key

- **Decision:** `memoryStore().transaction` records, for every row the transaction writes, its value before the write,
  and on a throw restores those rows newest first; it does not snapshot whole maps. Writes made meanwhile by calls
  outside the transaction, to other rows, survive. Reads see the transaction's writes before it commits: an overlapping
  `/complete` sees `completing` and gets `busy`, where Postgres would wait for the row lock and time out to `busy`. The
  handle is `MemoryTx { calls, write(entry) }`: `calls` lists the store methods called through the transaction's
  store, `write` adds an app row that commits or rolls back with it, read through `memoryStore().appRows()`.
  `injectFailure(method, afterWrites)` arms a one-shot failure in any writing method.
- **Why:** a whole-map snapshot restored on a throw would also undo a `reserve` or `revoke` that ran during a slow
  `onComplete`, which no database does, and the handler tests of task B race exactly those.
- **If wrong:** an outside write to a row the transaction also wrote is overwritten by the rollback; under Postgres it
  would have waited. No handler path writes such a row outside the claim the transaction holds.
- **Status:** decided.
- **Amended 2026-11-17 (fix round 1):** the review found a rollback losing an outside `reserve` for the same owner (a
  usage row is shared by all of an owner's files). A rolled-back write to a usage row that an outside call rewrote
  meanwhile now takes back only its own change (inverse deltas); an untouched row is restored as it was. Files rows
  are still restored whole. In memory, reads see a transaction's uncommitted writes; Postgres shows `pending` under
  READ COMMITTED, so handler tests must not assert `busy` against a replay for overlapping transactional completions.
- **Source:** task A, 2026-11-17.
- **Visible in:** `src/testing/memory-store.ts`.

### M5-T23: `QUOTA_EXCEEDED` wording, and no client change

- **Decision:** the code is declared with the server's codes, 403 in `http.ts`'s status table, not retryable, built by
  `quotaExceeded()` in `src/errors.ts` with the message "Your storage limit is reached. Delete some files or ask for
  more space, then try again." The client needs no change: a file refused at `/upload` has no ticket, so `retry()`
  already asks `/upload` again (`retry-file.ts`), and a client that does not know the code passes it through with its
  message (`answers.ts`). It is not added to `NEEDS_NEW_TICKET`, which is about tickets that exist.
- **Why:** one constructor keeps the wording in one place for task B; the status table entry is required by its
  `satisfies Record<ServerErrorCode, number>`.
- **If wrong:** a client-side treatment (say, not offering retry) would need the code in the client's sets.
- **Status:** decided.
- **Source:** task A, 2026-11-17.
- **Visible in:** `src/errors.ts`, `src/server/http.ts`, `docs/guide/errors.md`.

<!-- Task A appends its entries above this line. -->

## Server integration (task B)

### M5-T24: store configuration checks

- **Decision:** `createCloudrop` reads `store`, `quota` and `completionLeaseMs` (`src/server/store-config.ts`). A store
  must have the 13 methods of `CloudropStore` (and `transaction`, if present, must be a function); the error names the
  first missing one. `quota` and `completionLeaseMs` without a store, and a route's `owner` or `afterComplete` without a
  store, throw `INVALID_CONFIG` naming the option and the fix. `completionLeaseMs` is a whole number of at least
  1,000 ms (default 300,000). `quota` with routes that define no `owner` logs one warning naming them, after every
  check has passed.
- **Why:** spec §5.1 names `quota`, `owner` and `afterComplete`; `completionLeaseMs` means nothing without a store either,
  so it is refused the same way rather than ignored. A lease under a second could not outlast any `onComplete`.
- **If wrong:** relaxing a refusal is compatible; tightening one later would not be.
- **Status:** decided.
- **Source:** task B, 2026-11-17.
- **Visible in:** `src/server/store-config.ts`, `src/server/config.ts`, `src/server/store-config.test.ts`.

### M5-T25: `owner` sees no file and runs before `beforeUpload`; the quota fails closed on a bad answer

- **Decision:** `owner(context)` gets `OwnerContext` (the authorize result, `request`, `metadata`), not a file: one
  `/upload` has one owner (spec §4 `reserve`). It runs right after the per-file policy and before plugins'
  `beforeUpload`, and only with a store and at least one accepted file. It must return null or a string of 1 to 255
  characters; anything else (`undefined` included) is the route's bug, a `TypeError` the handler answers with a 500,
  like `prefix`. `quota(owner)` is asked only when it is set and the owner is not null; an answer that is not null or a
  non-negative safe integer counts as a failed lookup.
- **Why:** spec §5.2 lists owner resolution after `beforeUpload`. Resolving it first changes no outcome the spec
  describes but means a broken `owner` throws before any plugin has reserved anything, so no `onAbort` is owed; the
  quota stays after `beforeUpload`, as written. A quota that answers garbage must not let an upload through.
- **If wrong:** moving `owner` after `beforeUpload` needs `onAbort("failed")` for the plugins on its throw.
- **Status:** decided.
- **Source:** task B, 2026-11-17.
- **Visible in:** `src/server/store-upload.ts` (`readOwner`, `readLimit`), `src/server/route.ts` (`OwnerContext`).

### M5-T26: what `/upload` answers for each store failure

- **Decision:** a failed quota lookup or a failed `reserve` refuses every accepted file of the call with a per-file
  retryable `SERVER_ERROR` ("The server could not check your storage limit…" and "The server could not save the
  upload…"); nothing is signed or created, and plugins that accepted the files get `onAbort("failed")`. A file over
  the quota gets `QUOTA_EXCEEDED` and its plugins `onAbort("rejected")`. `attach` answering false gives the file
  `UPLOAD_EXPIRED` with "This upload was cancelled or has expired. Start it again."; a throw gives the retryable store
  error; both abort the multipart upload first. Every reserved file that does not start ends `pending → failed`, best
  effort and logged.
- **Why:** spec §5.2, with per-file answers so the other files' answers and the response shape stay as they are.
- **If wrong:** a whole-request failure would be one branch in `handleUpload`; clients already handle both.
- **Status:** decided; amended 2026-11-17 (fix round 1): the store error now reads "The server could not reach its
  upload records. Try again in a moment.", since it also answers failed reads.
- **Source:** task B, 2026-11-17.
- **Visible in:** `src/server/store-upload.ts`, `src/server/upload.ts`, `src/server/store-upload.test.ts`.

### M5-T27: `/complete` with a store, the points spec §5.5 left open

- **Decision:**
  - A `deleted` row replays its stored answer, as a `completed` one does: it completed, and answering
    `UPLOAD_EXPIRED` would make a resumed client upload again a file the app deleted on purpose (review I3).
  - Past `exp` and not completed: the standard expiry message. Ended or missing rows: the "cancelled or has expired"
    message.
  - A `completing` row is busy while `claimed_at + completionLeaseMs >= now` (the M5-T19 boundary), checked from the
    row before any storage call.
  - No `onComplete`, or a result of `undefined` or `null`, stores `result` null. The cap is 16,384 bytes of UTF-8 JSON,
    inclusive; over it is handled like a throw.
  - The answer's `data` and `afterComplete`'s `data` are the JSON form read back from the stored text, so a fresh
    answer and a replay are the same value.
  - `afterComplete` is awaited before the answer is sent, so a serverless runtime does not stop it halfway.
  - The busy answer is recognised by identity (`busy()` in `http.ts`), which adds `Retry-After: 2` and, for a
    cross-origin caller, `Access-Control-Expose-Headers: Retry-After`; no wire field or public type changes.
  - The claim token is `crypto.randomUUID()`. In transaction mode, a hook failure or a lost claim throws to roll back;
    a flag set before that throw tells it from a store failure even if an adapter wraps the error.
  - A failed `release` is only logged; the lease then frees the row.
- **Why:** each is the reading of §5.5 that keeps its promises (one `onComplete`, no storage call on replay) without a
  new column or wire change.
- **If wrong:** the `deleted` replay is the one visible choice; reverting it is one condition in `settled`.
- **Status:** decided; amended 2026-11-17 (fix round 1): `tx` reaches only routes from the store's own `route()`
  (M5-T66); the 16 KiB cap and its encoding run only on the stored path (M5-T67).
- **Source:** task B, 2026-11-17.
- **Visible in:** `src/server/store-complete.ts`, `src/server/complete-steps.ts`, `src/server/http.ts`.

### M5-T28: `/abort` leaves a row the sweep has settled

- **Decision:** with a store, `/abort` runs the abort-and-delete when its `end(pending → aborted)` changed the row, or
  when the row is `aborted`, `rejected`, `failed` or `expired` **and its `cleaned_at` is null**. A `deleted`,
  `completed` or `completing` row, a cleaned one, and a missing one answer `ok` with nothing deleted and no `onAbort`.
- **Why:** spec §5.6 runs the delete for every `failed` row, but the sweep ends a stuck completion as `failed` with
  `cleaned_at` set and keeps its object because its `onComplete` may have recorded it (§6). Without the `cleaned_at`
  condition, the client's own `/abort` after its retries ran out would delete that object. An expired row is always
  cleaned already, so nothing else changes.
- **If wrong:** a cleaned row whose late object appeared after the cleanup is left to nobody; the URL lifetime (15 min)
  is shorter than the cleanup's minimum age, so none can.
- **Status:** decided; refines spec §5.6.
- **Source:** task B, 2026-11-17.
- **Visible in:** `src/server/abort.ts`, `src/server/sweep.test.ts` (stuck completion).

### M5-T29: the file API's store operations

- **Decision:** `file(id)` answers `FileRecord | null`; `usage(owner)` `OwnerUsage`; `revokeUploads({ owner })`
  `{ revoked }`; `deleteFile(id)` `{ id }`, `NOT_FOUND` for an id without a completed (or deleted) row, idempotent: an
  already deleted and cleaned row answers at once, a deleted row not yet cleaned is finished. `deleteFile` and the sweep
  delete an object only after a HEAD shows its `cloudrop-id` is the row's id, since a key may hold a later upload.
  `reconcile({ owner? })` answers `{ checked, repaired }`, paging owners 100 at a time. Without a store each answers
  `INVALID_CONFIG`: "api.<name> needs a database store. Pass store to createCloudrop." Ids and owners are 1 to 255
  characters, else `INVALID_INPUT`. A store throw is logged and answered with the retryable store error.
- **Why:** spec §6 gives the operations; the shapes follow `api.head` (null for absent) and the `{ data, error }` rule.
- **If wrong:** each shape is a public type (`StoreFileApi`): a change is a semver decision.
- **Status:** decided.
- **Source:** task B, 2026-11-17.
- **Visible in:** `src/server/store-api.ts`, `src/server/store-api.test.ts`.

### M5-T30: the sweep's options, cursor and failures

- **Decision:** `sweep({ limit = 100, cursor?, graceMs = 3_600_000 })`: `graceMs` carries its unit (the spec wrote
  `grace`), `limit` is 1 to 1,000 rows per call, shared by both passes. One opaque cursor (`expire:<…>` or
  `cleanup:<…>`) continues the pass it stopped in; the expire pass runs first and the cleanup pass gets what is left of
  the limit. A storage or store failure stops the call and answers that error; rows already handled stay handled.
  `reported` holds the `FileRecord`s of stuck completions ended as `failed`. `cleaned` counts the rows this call
  cleaned, so two concurrent cleanup sweeps may both count one row (the work is idempotent).
- **Why:** spec §6; a unit in the name follows the human-friendly rules; one cursor lets a cron call `sweep` in a loop
  without knowing about passes.
- **If wrong:** renaming `graceMs` later is breaking; decide before 1.0.
- **Status:** decided; amended 2026-11-17 (fix round 1): the expire pass takes the row first (M5-T64), and a failing
  row no longer stops the call (M5-T65). `graceMs` is at least 15 minutes (M5-T64).
- **Source:** task B, 2026-11-17.
- **Visible in:** `src/server/sweep.ts`, `src/server/sweep.test.ts`.

### M5-T31: `RouteCallbacks<…, TExtra>`, `routeFor` and the new public types

- **Decision:** `RouteCallbacks<TAuth, TMetadata, TResult, TExtra extends object = Record<never, never>>`;
  `onComplete`'s context is `Omit<CompleteContext, keyof TExtra> & TExtra`, so a store's `tx` replaces an authorize
  field of the same name (the handler spreads `tx` last); with no extra the context type is exactly as before.
  `routeFor<TExtra>(store)` (internal, for adapters) returns a `RouteFunction<TExtra>` whose routes carry the store
  object itself under `Symbol.for("cloudrop.store")`; `createCloudrop` refuses such a route when the configured store
  is another one or none, or has no `transaction`. `afterComplete` gets `AfterCompleteContext` (the completion context
  plus `data`). Newly exported types: `OwnerContext`, `AfterCompleteContext`, `RouteFunction`, `StoreFileApi`,
  `StoreOptions`, `Quota`, `SweepOptions`, `SweepReport`; `FileApi` now extends `StoreFileApi`.
- **Why:** spec §5.5 and review I6. The store object as its own brand needs no second id to keep in sync; `Symbol.for`
  lets an adapter from another copy of cloudrop be recognised.
- **If wrong:** an adapter must pass the very object it returns as the store; documented on `routeFor`.
- **Status:** decided.
- **Source:** task B, 2026-11-17.
- **Visible in:** `src/server/route.ts`, `src/server/store-config.ts`, `src/index.ts`, `src/server/store-types.test.ts`.

### M5-T32: the abort-incomplete rule is reported as required with a store

- **Decision:** `checkBucket` already reports a missing rule as a `problem`; with a store its message adds "With a store
  it is required: an upload created just before a crash has no row to clean it up."
- **Why:** spec §5.2 names the rule as the backstop for a crash between `createMultipart` and `attach`.
- **If wrong:** wording only.
- **Status:** decided.
- **Source:** task B, 2026-11-17.
- **Visible in:** `src/server/bucket-check.ts`, `src/server/store-config.test.ts`.

### M5-T33: the store integration grows `cloudrop` by about a fifth (M4-F24)

- **Decision:** accepted. Measured 2026-11-17 with `bun run package:check`: `cloudrop` summed 36.72 kB → 44.5 kB
  (+21%), bundled 22.38 kB → 26.97 kB (+20.5%); `cloudrop/next` 1.01 → 1.16 kB and `cloudrop/node` 3.1 → 3.24 kB
  through shared chunks; `cloudrop/client` and `cloudrop/react` unchanged. All stay under their ceilings (50, 30, 1.5,
  4.5 kB).
- **Why:** the server now carries the row-before-signing, claim, refusal, abort, file API and sweep paths (§5, §6) and
  their messages. They are server code: a browser bundle (`cloudrop/client`) does not grow. The stateless path pays for
  them only through the shared entry.
- **If wrong:** the store paths could move behind a separate entry (`cloudrop/store`) so apps without a store do not
  ship them; that is a public API change.
- **Status:** decided; over the 5% line, so stated here and in the commit.
- **Source:** task B, 2026-11-17.
- **Visible in:** `scripts/size-limit.config.ts` (ceilings unchanged).

### M5-T64: the sweep's expire pass takes the row before it deletes; cleanup includes uncleaned expired rows

- **Decision:**
  - For a `pending` row, the expire pass first runs `end(id, "pending", "expired")` without `cleaned`.
  - Only when that changed the row does it abort the multipart upload, HEAD-check and delete the object, then call
    `cleaned(id)`.
  - `stale({ kind: "cleanup" })` now also returns `expired` rows whose `cleaned_at` is null, so a crash or a failure
    between the `end` and the cleanup is finished by the cleanup pass.
  - `graceMs` is at least the life of an upload URL, 900,000 ms (15 minutes, `MIN_GRACE_MS` derived from
    `URL_LIFETIME_SECONDS`); a smaller one is refused with `INVALID_INPUT` naming the minimum. No URL outlives its
    token's deadline, so no new PUT can start once a row may be cleaned up. Both passes use it as given: the expire pass after the deadline, the cleanup pass
    after the row ended. (Amended 2026-11-17 by the controller's closing ruling; the first version allowed 0 or more and
    floored only the cleanup pass.)
- **Why:**
  - The review (I1) showed the first order could delete a completed file. A `/complete` that verified in time could
    claim the row between the sweep's delete and its `end`.
  - With the row taken first, a `/complete` that claims first keeps its object.
  - A `/complete` that comes later is refused (`UPLOAD_EXPIRED`) with nothing recorded.
- **If wrong:** the floor guarantees only that no new PUT starts after the deadline. A PUT already under way (signed
  before the deadline, slow to upload) may still land after its row was ended and cleaned; the cleanup pass does not
  return cleaned rows, so that object is left in the bucket, a known cost (at most one object per such upload, never a
  completed file's). The floor follows `URL_LIFETIME_SECONDS` if URL lifetimes change.
- **Status:** decided by the controller (fix round 1); it amends M5-T20 ("`expired` rows are never cleanup work") and
  spec §4 and §6.
- **Source:** task B fix round 1, 2026-11-17.
- **Visible in:**
  - `src/server/sweep.ts`;
  - `src/testing/memory-store-methods.ts` (`CLEANUP`) and `src/store/sql/reads.ts` (`CLEANUP_STATUSES`, both
    dialects);
  - `src/server/store.ts` (`stale` TSDoc);
  - `src/testing/store-contract/stale.ts` (the cleanup case);
  - spec §4 and §6.

### M5-T65: a sweep row that fails is logged and skipped; `SweepReport.failed`

- **Decision:**
  - When a row fails (a storage or database error), the sweep logs "the sweep could not finish file <id>. The next
    sweep tries again." with the error.
  - It counts the row in a new `failed: number` field of `SweepReport`, leaves the row as the failure left it, and goes
    on with the rest of the page.
  - `expired` counts only rows that were ended **and** cleaned.
  - A failing row never makes the sweep answer an error. A failing listing does when no row was handled yet in the
    call; after some rows it answers the report so far, the listing counted in `failed`, with `cursor: null` (fix
    round 2, below).
- **Why:**
  - The review (I2): a failure mid-page threw away the `reported` stuck completions the sweep had already ended, which
    are reported only once.
  - A row that failed every time blocked every later row for good.
- **If wrong:** `failed` is public (`SweepReport`); removing it later is a breaking change.
- **Status:** decided by the controller (fix round 1); it amends M5-T30. Amended 2026-11-17 (fix round 2): a listing that fails no
  longer answers `ok` with the cursor it was given, on which a `while (cursor)` loop would spin. Before any row was
  handled in the call it answers the store's error; after, the report so far, the listing counted in `failed`, and
  `cursor: null`.
- **Source:** task B fix round 1, 2026-11-17.
- **Visible in:** `src/server/sweep.ts`, `src/server/sweep.test.ts`.

### M5-T66: `tx` reaches only routes made by the store's own `route()`

- **Decision:** in transaction mode, the handler adds `tx` to `onComplete`'s context only for a branded route. A plain
  `route()` still runs inside the transaction, and its authorize result's own `tx` field stays as it was.
- **Why:** the review (I3). The types and the `onComplete` TSDoc already promised this; the runtime overwrote the field.
- **If wrong:** nothing else depends on it.
- **Status:** decided.
- **Source:** task B fix round 1, 2026-11-17.
- **Visible in:** `src/server/store-complete.ts`, `src/server/store-transaction.test.ts`.

### M5-T67: with a store configured, a token without the stored mark keeps every old answer

- **Decision:**
  - `readTokenRequest` lets an expired token through only when it is stored and a store is configured. Every other
    expired token is refused with `UPLOAD_EXPIRED` before the route lookup, as without a store.
  - The 16 KiB result cap and its `TextEncoder` measurement run only on the stored path. `encodeResult` only
    stringifies.
- **Why:** review Minor 8 and Minor 2. With a store configured, an expired, unstored token whose route had been removed
  answered `UNKNOWN_ROUTE`. The stateless path also measured every result for nothing.
- **If wrong:** nothing; this restores the stateless behaviour exactly.
- **Status:** decided.
- **Source:** task B fix round 1, 2026-11-17.
- **Visible in:**
  - `src/server/token-request.ts`, `src/server/complete-steps.ts`, `src/server/store-complete.ts`;
  - `src/server/store-stateless.test.ts`.

### M5-T68: write `afterComplete` after `onComplete`

- **Decision:**
  - Written before a context-sensitive `onComplete`, `afterComplete` makes TypeScript fix `TResult` to null, so
    `onComplete`'s result becomes a type error. `NoInfer` does not help (measured by the review).
  - There is no API change. The `afterComplete` TSDoc says to write it after `onComplete`, and that the client's answer
    waits for it.
  - A type test pins the reversed order's error, so the advice is re-checked if TypeScript changes.
- **Why:** review Minor 1 and Minor 10.
- **If wrong:** if a TypeScript release infers it, the `@ts-expect-error` fails and the note can go.
- **Status:** decided.
- **Source:** task B fix round 1, 2026-11-17.
- **Visible in:** `src/server/route.ts`, `src/server/store-types.test.ts`.

### M5-T69: the store paths stay statically imported; stateless server apps pay about 4.7 kB

- **Decision:**
  - The store modules stay statically imported by the endpoints and the file API. No lazy chunk.
  - Measured 2026-11-17 with `bun run package:check` after this round:
    - `cloudrop` bundled is 27.05 kB, against 22.38 kB before task B: +4.67 kB gzip, which every server app pays,
      store or not;
    - `cloudrop` summed is 44.88 kB.
  - The review's simplifications are applied:
    - `encodeResult` without `maxBytes`;
    - the refusal reason derived from the error code;
    - one `jsonResponse` in `errorResponse`;
    - the ticket refusal folded;
    - `unstarted` picked by index;
    - no `as number` casts;
    - the duplicate TSDoc removed.
- **Why:** the controller's ruling. An `await import()` costs every store app a cold-start round trip and a packaging
  surface, for 4.7 kB of server code that a browser never ships.
- **If wrong:** a lazy chunk, or a `cloudrop/store` entry, can be added later without an API change in the first case.
- **Status:** decided; it extends M5-T33.
- **Source:** task B fix round 1, 2026-11-17.
- **Visible in:** `scripts/size-limit.config.ts` (ceilings unchanged).

<!-- Task B appends its entries above this line. -->

## SQL core and the sql adapter (task C)

### M5-T34: the executor seam, and shipped executors typed by hand

- **Decision:** `SqlExecutor<TTx = never>` is `{ dialect, query(sql, params), batch(statements), transaction?(run) }`,
  as spec §7 has it, made generic in the handle `onComplete` receives as `tx`. `sqlStore(executor, { tables? })`
  returns `CloudropStore<TTx>`, with `transaction` exactly when the executor has one. `cloudrop/adapters/sql` ships
  `pgExecutor(pool)` (`tx` is the checked-out client), `postgresJsExecutor(sql)` (`tx` is the transaction's `sql`),
  `sqliteExecutor(db)` and `d1Executor(d1)`, the last two without `transaction`. Each driver is described by hand by
  the members the executor calls (`PgPool`, `PostgresJsSql`, `SqliteDatabase`, `D1Database` and their parts, exported
  as types), so the library imports no driver and no driver types; `tsconfig.test.json` proves a real `pg.Pool`,
  `postgres()` and `DatabaseSync` fit. Inside a transaction an executor's `batch` runs its statements in order on the
  transaction's connection: Postgres aborts the transaction on the first failure, so nothing of the batch commits alone.
- **Why:** spec review I12 (ship code, not snippets). Hand-written shapes follow `src/node.ts` and keep
  `types: []`. A generic `tx` lets Drizzle and Prisma pass their own transaction types through the same core.
- **If wrong:** a driver whose real type does not fit the shape needs a one-line cast in the app, or a wider shape.
  `D1Database` is unchecked against `@cloudflare/workers-types` here (not installed); the Wrangler lane checks it.
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `src/store/sql/executor.ts`, `src/store/sql/store.ts`, `src/adapters/sql.ts`, `src/adapters/sql/*`.

### M5-T35: Postgres `reserve` is one statement that locks the usage row first

- **Decision:** with an owner, `reserve` is one statement. The files arrive as one JSON parameter
  (`json_to_recordset`). A CTE locks the owner's usage row (`FOR UPDATE`), a recursive CTE walks the files in order
  adding each that fits (`reserved + active + size <= limit`), and data-modifying CTEs insert the reserved rows and add
  their bytes to the usage row, or create it. Without an owner it is one plain insert. An existing id fails the
  statement, so nothing of the call is written. For an owner with no usage row yet, two first reserves racing each
  other behave differently. Without a limit, the later one adds to the row the other created (`ON CONFLICT … DO
  UPDATE`). With a limit, the later one fails on the unique owner, and the server answers it with a retryable
  `SERVER_ERROR`, because its quota decisions assumed no row.
- **Why:** spec §4 asks for one statement on Postgres, atomic per call. Data-modifying CTEs share one snapshot and
  cannot see each other's writes, so the per-file decisions must be computed, not read back. The lock is taken before
  any decision, so concurrent reserves of one owner queue and none overshoots. Measured: 8 racing reserves against
  room for 5 reserve exactly 5 on both Postgres executors. The quota applies from an owner's first file, and a call
  refused entirely leaves no usage row (M5-T18).
- **If wrong:** the new-owner race with a limit costs one client retry. Creating the usage row first, in a separate
  statement, would remove it but break the single-statement rule and leave zero rows behind (M5-T18).
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `src/store/sql/postgres.ts`.
- **Amended 2026-11-17 (fix round 1):** the new-owner race no longer reaches the client. A unique violation (`23505`)
  on the usage row re-runs the statement once, with an owner and a limit only: see M5-T74.

### M5-T36: SQLite batches put the usage write first, guarded on the files row as it was

- **Decision:** on SQLite, `complete`, `end` and `revoke` are batches whose usage `UPDATE` runs first. It is guarded on
  the files row's state before the change (`status = from`, and for `complete` the claim token too), and the files
  `UPDATE` with the same guard follows. Both statements test the same condition on a row nothing has changed yet, so
  they apply together or not at all. `reserve` runs, per file in order, a guarded `INSERT … SELECT … WHERE <quota fits>
  RETURNING id` and then a usage upsert guarded by the same quota condition: the usage row is unchanged between the
  two, so they agree. No statement reads another's row count. `end` from an ended status, and an owner-less row, write
  no usage at all. Times are integer milliseconds bound as numbers. Booleans are never bound: optional clauses
  (`cleaned_at`) are built into the SQL text.
- **Why:** spec review C1. Guarding the usage write on the state *after* the files change (`status = 'completed' AND
  claim = ?`) would count a replay of the same claim twice. Measured: the replay row of the contract catches it.
- **If wrong:** the contract's usage-write fault can only fail the first statement of `complete`, `end` and `revoke`
  on SQLite, so on SQLite it proves their rollback trivially. `reserve`'s injected fault, and every method's injected
  fault on Postgres, do roll back a files change already made.
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `src/store/sql/sqlite.ts`.

### M5-T37: `reconcile` locks, recounts, and creates a missing row only when the count is not zero

- **Decision:** on Postgres, `reconcile` is a two-statement batch: `SELECT … FOR UPDATE` on the usage row, then one
  `INSERT … SELECT <recount> … ON CONFLICT DO UPDATE … WHERE IS DISTINCT FROM … RETURNING`. The second statement takes
  a new snapshot after the lock (READ COMMITTED), so a reserve committed while reconcile waited is counted. On SQLite
  it is the same upsert alone, since one writer runs at a time. The insert happens only when the owner has
  pending/completing/completed rows or already has a usage row, so an owner with nothing gets no row. `updated_at` is
  the database clock: `now()` on Postgres, `julianday('now')` in milliseconds on SQLite (valid on every SQLite version,
  unlike `unixepoch('subsec')`).
- **Why:** spec review I10. Measured: a row holds a reserve open in a transaction until reconcile blocks
  (`pg_stat_activity` shows the lock wait), then commits it. Without the lock statement, the reserve's 5 bytes are
  lost (fault probe P8).
- **If wrong:** one race remains: an owner whose usage row was deleted by hand, a first reserve and a reconcile all at
  once. The lock then finds no row to hold, so the recount can overwrite the reserve. A `reconcile` afterwards repairs
  it.
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `src/store/sql/postgres.ts`, `src/store/sql/sqlite.ts`, `src/store/sql/outcomes.ts`.

### M5-T38: every Postgres placeholder is cast; times as ISO text; JSON bound as text

- **Decision:** statements are built with a binder that adds each value as it writes its placeholder. On Postgres the
  placeholder is `$n::type` (`text`, `bigint`, `integer`, `timestamptz`). Times are bound as ISO strings, sizes as
  numbers. The reserve's JSON is bound as `$n::text::json`. On SQLite the placeholder is `?`, so the template's
  evaluation order is the binding order, and times are integer milliseconds. Results decode through one
  `toSafeInteger` (number, decimal text, bigint, a decimal-like object; it throws on fractions and beyond 2^53) and one
  `toDate` (Date, ISO text, milliseconds).
- **Why:** spec review I9. Drivers that send typed parameters (Prisma sends strings as text) fail without casts.
  Measured: postgres.js JSON-encodes a string bound to a `json` parameter a second time ("cannot call
  json_to_recordset on a scalar"), and binding it as text first fixes it. A size of 2^53 − 1 round-trips through all
  three executors.
- **If wrong:** a driver that rejects ISO text for `timestamptz` would need Dates; none of the three does.
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `src/store/sql/bind.ts`, `src/store/sql/records.ts`.

### M5-T39: keyset paging compares bytes; the cursor is `<ms>:<id>`

- **Decision:** `stale` asks for `limit + 1` rows ordered by `(time, id)` and continues with a row-value comparison
  `(time, id) > (cursor time, cursor id)`. `owners` does the same over `owner`. On Postgres, `id` and `owner` compare
  with `COLLATE "C"` in both the comparison and the `ORDER BY`. SQLite's default collation already compares bytes. A
  `stale` cursor is the last row's time in milliseconds and its id; an owners cursor is the last owner. A cursor the
  store did not make throws.
- **Why:** task A's note (M5-T20): with the database's default collation (often `en_US`), the order of mixed-case ids
  would differ between Postgres, SQLite and the memory store. Byte order is the same everywhere. Times are written
  with millisecond precision, so a millisecond cursor is exact.
- **If wrong:** the `COLLATE "C"` comparison cannot use a plain index on `id` built with another collation. The sweep
  pages by `(status, time)` first, so the cost is small.
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `src/store/sql/reads.ts`, `src/store/sql/records.ts`.

### M5-T40: the schema check runs once, lazily, and blames the schema only when the database answers

- **Decision:** on a store's first call it reads every column of both tables with `WHERE 1 = 0`. When that fails and a
  bare `SELECT 1` succeeds, it probes the table and then each column in spec §3's order, and throws `INVALID_CONFIG`.
  The message names the table, and the missing column when the table exists, then says to create the tables as the
  docs show or pass `{ tables }`. When `SELECT 1` fails too (the database is down), the original error is rethrown.
  A failed check is not cached, so the next call checks again. Concurrent first calls share one check. A transaction
  runs the check before it opens.
- **Why:** spec §3. Probes run only on the error path, so the normal path costs two reads per store instance.
- **If wrong:** a database user without `SELECT` rights on a column is reported as a missing column. The message still
  names the place to look.
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `src/store/sql/tables.ts`, `src/store/sql/store.ts`.

### M5-T41: transaction mode caps the row lock wait at 2 s and answers `busy`, on both Postgres drivers

- **Decision:** `store.transaction(run)` runs `SET LOCAL lock_timeout = '2s'` on Postgres, then hands `run` methods
  whose `claim` turns Postgres's lock timeout (`55P03`, also found through a wrapper's `cause`) into `{ kind: "busy" }`.
  When that happened and `run` finished, a transaction that then fails with the same lock timeout returns `run`'s
  answer. Outside a transaction no lock timeout is set, so a claim never waits long: its single `UPDATE` waits only for
  another single statement.
- **Why:** spec §5.5 step 5. Measured: node-postgres commits an aborted transaction as a silent `ROLLBACK`, while
  postgres.js rethrows the first failed statement of a transaction even after the code caught it. Both now answer
  `busy` after 2 s (two 2-second rows in the db lane). Nothing was written either way.
- **If wrong:** another driver that reports the lock timeout differently needs its code added to `isLockTimeout`
  (Prisma is checked in its own task).
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `src/store/sql/store.ts`, `src/store/sql/executor.ts`.
- **Amended 2026-11-17 (fix round 1):** the 2 s cap now covers the claim alone. It is set before each claim and reset
  to the default after it, so the app's statements through `tx` are not capped: see M5-T76.

### M5-T42: packaging of the three adapter subpaths

- **Decision:** `package.json` exports `./adapters/sql`, `./adapters/drizzle` and `./adapters/prisma`, built by tsdown
  to `dist/adapters/<name>.js` (named entries). `drizzle-orm >=0.45.0` is an optional peer. Prisma needs none:
  `prismaStore` will take a structurally typed client. `drizzle.ts` and `prisma.ts` export nothing until their tasks
  land, which keeps publint and attw green with no stub that throws. The size budgets are summed with their chunks:
  sql 14 kB (measured 9.62 kB; 5.89 kB bundled and minified, mostly SQL text); drizzle and prisma 13 kB each (the core
  plus 3 kB). The size config now follows `../` imports from `dist/adapters/`. Two Biome fences: `src/store/**`
  imports no adapter, entry, server (except `server/store`), client, storage, protocol or testing code; `src/adapters/**`
  imports the same set minus adapters, so it reaches only the core, the store types and errors. The core gets its own
  chunk once a second adapter imports it; today it is inlined into `adapters/sql.js`.
- **Why:** spec §7 and review I13: tasks D and E touch only their own files.
- **If wrong:** the budgets are guards (M4-F24); tasks D and E re-measure theirs.
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `packages/cloudrop/package.json`, `tsdown.config.ts`, `scripts/size-limit.config.ts`, `biome.json`.
- **Amended 2026-11-17 (fix round 1):** the adapters' fence also allows `server/route` (for `routeFor`, M5-T77). The
  `biome.json` hunks that only re-wrapped existing objects were reverted, so the file's diff is the two fences.

### M5-T43: one contract target for every SQL store, with failure injection that survives rollback

- **Decision:** `src/testing/db/sql-target.ts` exports `sqlStoreTarget(db, storeOver, gaps?)`, the contract setup for
  any SQL store, and `src/testing/db/raw-tables.ts` exports `rawTables(db, tables?)`, the final `RawTables` over C0's
  reader. Per case, Postgres starts from an empty schema, and SQLite gets a new database from its fixture. Setup
  creates the default, `renamed_*` and `broken_*` tables (the broken files table without `result`). `injectFailure`
  arms a one-shot trigger on the usage table. On Postgres it is a `RAISE EXCEPTION` gated on `nextval` of a fresh
  sequence, which a rollback does not undo. On node:sqlite it is a `RAISE(ABORT)` whose `WHEN` calls a registered JS
  function holding the armed flag. Gaps: node:sqlite declares only `transaction`, and Postgres none. Tasks D and E
  call `sqlStoreTarget` with their own store factory.
- **Why:** a trigger that drops itself or clears a flag row rolls back with the failed statement and fires every time
  (the controller's measurement). One target keeps the contract's setup identical across adapters.
- **If wrong:** D1 has no user functions, so its lane declares `failureInjection` and `transaction` as gaps.
- **Status:** decided.
- **Source:** task C, 2026-11-17.
- **Visible in:** `src/testing/db/sql-target.ts`, `src/testing/db/raw-tables.ts`, `src/adapters/sql.db.integration.test.ts`.

### M5-T74: a reserve that raced another first reserve of a new owner runs again, once

- **Decision:** when Postgres `reserve` with an owner and a limit fails with a unique violation (`23505`, found by
  `isUniqueViolation` in the `code`/`cause` chain), the store runs the same statement once more. The failed statement
  ran alone and rolled back whole. The re-run takes a new snapshot, and its `FOR UPDATE` locks the usage row that the
  other reserve created. A real duplicate file id fails again and is thrown. Without a limit the statement already adds
  to that row (`ON CONFLICT … DO UPDATE`) and never retries.
- **Why:** review I1. Measured before the fix: 8 racing first reserves for a new owner gave up to 7 `SERVER_ERROR`s, on
  both drivers. A single-statement fix cannot work: every CTE shares one snapshot, so the statement cannot see, lock and
  increment a row created after it began (the reviewer's P2). Ensuring the row in a batch would cost a round trip on
  every reserve and leave zero rows behind (M5-T18).
- **If wrong:** two retries would be needed only if a second new row could appear between the attempts. It cannot: the
  usage row exists after the first failure.
- **Status:** decided.
- **Source:** task C fix round 1, 2026-11-17.
- **Visible in:** `src/store/sql/postgres.ts`, `src/store/sql/executor.ts`, `src/adapters/sql.db.integration.test.ts`
  (concurrent first reserves of new owners, with and without a limit).

### M5-T75: an unchanged Postgres transition answers the row as it is now

- **Decision:** when `complete` or `end` changes nothing, and the row its statement returns still shows the status the
  update required (`completing`, or `from`), the store reads the row again in a new statement and answers that row.
- **Why:** review I2, a breach of spec §4's `Transition`. The guarded UPDATE waited for another transaction's row lock,
  re-checked its guard on the new version and found it false. The statement's own `SELECT` still sees its snapshot,
  the row as it was before. Measured: a refusal racing a transaction-mode completion answered `pending`, so B's handler
  sent a non-retryable `UPLOAD_EXPIRED` for a completed upload. It now answers `completed`, on both drivers. The extra
  read happens only in that race.
- **If wrong:** a row still in the guarded status can only mean a stale snapshot, because the guard would otherwise
  have matched. A lost claim (`completing` under another token) costs one extra read.
- **Status:** decided.
- **Source:** task C fix round 1, 2026-11-17.
- **Visible in:** `src/store/sql/postgres.ts`, `src/adapters/sql-postgres.db.integration.test.ts`.

### M5-T76: the 2 s lock timeout covers the claim alone

- **Decision:** in transaction mode the store caps only the claim. Before each claim one statement reads the session's
  `current_setting('lock_timeout')` and sets `set_config('lock_timeout', '2s', true)`. After the claim,
  `set_config('lock_timeout', <saved>, true)` puts the saved value back. The app's statements through `tx` therefore
  run at exactly the lock timeout their session had, whether it came from the server, the role, a startup option or a
  `SET` on the connection. After a claim that timed out, the transaction is aborted and nothing more runs.
- **Amended 2026-11-17 (fix round 2):** the first version reset to `DEFAULT`, which drops a session-level `SET` (the
  re-review's N1: an app's `SET lock_timeout = '7s'` came back as `0`). The saved value is now restored instead, at the
  same round-trip count. Measured: `onComplete` sees `7s`.
- **Why:** review M1. `onComplete`'s statements through `tx` inherited the cap, so an app statement waiting more than
  2 s for a lock it would get failed the completion. Measured: such a statement now waits 2.5 s and commits.
- **If wrong:** it costs one round trip per transactional claim.
- **Status:** decided.
- **Source:** task C fix round 1, 2026-11-17.
- **Visible in:** `src/store/sql/store.ts`, `src/adapters/sql-postgres.db.integration.test.ts`.

### M5-T77: `sqlStore` over a transactional executor has `route`, typed with the executor's `tx`

- **Decision:** `pgExecutor` and `postgresJsExecutor` return `TransactionalSqlExecutor<TTx>`, whose `transaction` is
  required. For such an executor `sqlStore` returns `TransactionalSqlStore<TTx>`: a `CloudropStore<TTx>` with
  `transaction` and `route = routeFor<{ tx: TTx }>(store)` (B's `routeFor`, branded with that very store object). For
  any other executor it returns `CloudropStore<TTx>` with no `route`.
  - node-postgres: `tx` is the transaction's client, typed `PgQueryable` (`query`).
  - postgres.js: `tx` is postgres.js's own `TransactionSql`, so tagged templates type-check. To get that, `PostgresJsSql`
    mirrors both `begin` overloads, because TypeScript infers from an overloaded method's last signature.
  - The core's `sqlStore` stays the same. The public one in `cloudrop/adapters/sql` wraps it. Drizzle and Prisma attach
    their own `route` the same way, with their own `tx`.
- **Why:** the controller's ruling on review M8 (spec §5.5, "store.route" for transactional adapters).
- **If wrong:** `adapters/sql` now carries B's route chunk: 12.33 kB summed, up from 9.62 kB, under its 14 kB budget.
  The drizzle and prisma budgets (13 kB) must be re-measured in their tasks.
- **Status:** decided.
- **Source:** task C fix round 1, 2026-11-17.
- **Visible in:** `src/adapters/sql.ts`, `src/adapters/sql/pg.ts`, `src/adapters/sql/postgres-js.ts`,
  `src/store/sql/executor.ts`, `src/adapters/sql.test.ts`.

### M5-T78: READ COMMITTED is required; node:sqlite files shared by writers need a busy timeout

- **Decision:** the TSDoc of `sqlStore` (both the core's and the entry's), `pgExecutor` and `postgresJsExecutor` says
  that Postgres must run at its default isolation, READ COMMITTED. `sqliteExecutor`'s TSDoc advises
  `new DatabaseSync(path, { timeout: 5000 })` when another connection or process writes the same file.
- **Why:** review M2 and M3. Measured by the reviewer: under REPEATABLE READ, concurrent reserves fail with `40001`.
  With node:sqlite's default timeout of 0, a second writer fails at once with "database is locked". Neither corrupts
  data; both turn normal traffic into errors.
- **If wrong:** documentation only; task F carries it into the guide.
- **Status:** decided.
- **Source:** task C fix round 1, 2026-11-17.
- **Visible in:** `src/adapters/sql.ts`, `src/store/sql/store.ts`, `src/adapters/sql/pg.ts`,
  `src/adapters/sql/postgres-js.ts`, `src/adapters/sql/sqlite.ts`.

<!-- Task C appends its entries above this line. -->

## Drizzle adapter (task D)

### M5-T44: `drizzleStore`'s overloads, structural database types, and Drizzle's own `tx`

- **Decision:** `drizzleStore(db, { dialect, tables?, transaction? })` has three overloads. Postgres with the literal
  `transaction: true` returns `DrizzleTransactionalStore<DrizzleTransaction<TDb>>`: a `CloudropStore` with
  `transaction` and `route = routeFor<{ tx }>(store)`, attached to the store object itself as M5-T77 does for
  `sqlStore`. Postgres without it, and SQLite, return a plain `CloudropStore`: no `transaction`, so completions use the
  lease. The database is typed structurally (`DrizzlePostgres`: `execute` and `transaction`; `DrizzleSqlite`: `all`,
  `run` and a synchronous `transaction`), so any Drizzle Postgres driver fits and no Drizzle class type, with its schema
  generics, is named. `DrizzleTransaction<TDb>` is the parameter of `TDb["transaction"]`'s callback, which is Drizzle's
  `PgTransaction<…>` with the app's schema (type tests pin it for node-postgres with a schema and for postgres.js).
- **Why:** spec §5.5 (typed `tx`) and §7. A structural type avoids the variance trouble of `PgDatabase<…>`'s schema
  parameters and keeps the import to `SQL` and `sql`.
- **If wrong:** a `transaction` option passed as a `boolean` variable matches no overload; an app that decides at run
  time writes two calls. A fourth overload can be added without breaking anyone.
- **Status:** decided.
- **Source:** task D, 2026-11-17.
- **Visible in:** `src/adapters/drizzle.ts`, `src/adapters/drizzle/postgres.ts`, `src/adapters/drizzle.test.ts`.
- **Amended 2026-11-17 (fix round 1):** the option interfaces no overload could take (`DrizzleStoreOptions`, with a
  `dialect` union) are no longer exported; callers use the overloads' literal options. The SQLite overload also takes
  `DrizzleAsyncSqlite` (M5-T46).

### M5-T45: Postgres through Drizzle: statements cut at placeholders, two result shapes, times as text

- **Decision:** each core statement becomes Drizzle SQL by cutting the text at the binder's placeholders: `$n` takes
  `params[n-1]`, SQLite's `?` the next value. Each placeholder becomes `sql.param`, the text between them `sql.raw`,
  and Drizzle numbers them again while the `::type` casts stay in the text. `execute()`'s answer is read as rows when it
  is an array (postgres.js) or has `rows` (node-postgres); any other shape fails with a message naming the supported
  drivers. Batches and transaction mode run in `db.transaction`, and the store's methods inside it use that `tx`.
  `isLockTimeout` needed no change: Drizzle's `DrizzleQueryError` keeps the driver's error as `cause` (measured at the
  handler on both drivers).
- **Why:** `sql.raw` takes no parameters. Drizzle's node-postgres and postgres.js drivers return `timestamptz` as
  Postgres text (`2026-11-17 10:20:30.123+00`), not Dates. The core's `toDate` parses it with `Date.parse`, measured
  exact to the millisecond on Node 24 (V8) and Bun 1.4.4 (JavaScriptCore), including offsets such as `-04:30`.
- **If wrong:** a server with `DateStyle` other than `ISO` prints times `Date.parse` cannot read, and every read fails
  loudly rather than wrongly. The fix would be an explicit `to_char` or epoch read in the core.
- **Status:** decided.
- **Source:** task D, 2026-11-17.
- **Visible in:** `src/adapters/drizzle/statement.ts`, `src/adapters/drizzle/postgres.ts`.
- **Amended 2026-11-17 (fix round 1):** an unsupported result shape is a configuration fault: it throws
  `INVALID_CONFIG` naming the shape by its keys (`{ records, numberOfRecordsUpdated }` for the AWS Data API driver),
  never its values.

### M5-T46: SQLite through Drizzle needs a synchronous driver; batches in an immediate transaction

- **Decision:** on SQLite, `drizzleStore` takes a synchronous Drizzle database (better-sqlite3, the one tested). A
  statement runs through `all` when it starts with `SELECT` or contains `RETURNING`, otherwise through `run`. A batch
  runs in `db.transaction(…, { behavior: "immediate" })`. An asynchronous Drizzle SQLite database (libsql, D1, the
  proxy) is refused with `INVALID_CONFIG`, which points D1 users to `d1Executor`. `transaction: true` on SQLite is
  refused with `INVALID_CONFIG` naming why. `better-sqlite3` ^12.11.1 (2026-06-15) and `@types/better-sqlite3` ^9.6.0
  (2026-08-01) are devDependencies. The contract's failure trigger is armed on the store's own better-sqlite3
  connection, because a trigger calls the function registered on the connection whose statement fired it.
- **Why:** Drizzle has no node:sqlite driver (C0). better-sqlite3 refuses `all` for a statement that returns no rows.
  A synchronous transaction cannot wait for an asynchronous driver's statements, so an asynchronous database would
  commit before its batch ran. The type already rejects one; the runtime check is for JavaScript callers.
- **If wrong:** supporting libsql means an `async` batch over `await db.transaction(async (tx) => …)`, proven on its
  own lane. bun:sqlite should work like better-sqlite3 but is not tested.
- **Status:** decided.
- **Source:** task D, 2026-11-17.
- **Visible in:** `src/adapters/drizzle/sqlite.ts`, `src/adapters/drizzle.db.integration.test.ts`,
  `packages/cloudrop/package.json`.
- **Amended 2026-11-17 (fix round 1):** asynchronous SQLite is supported, not refused. A Drizzle database with
  `batch` (libsql/Turso, D1) gets `DrizzleAsyncSqlite`: `query` awaits `all` or `run`, and a batch goes through
  `db.batch`, which runs its statements in order and atomically (libsql's `client.batch` wraps them in one
  transaction; D1's batch is atomic). `transaction: true` stays Postgres only. The read/write test is now
  `/^\s*SELECT\b|\bRETURNING\s/i`: a table named `returning` is quoted, so the word is followed by `"`, not whitespace.
  `@libsql/client` ^0.18.0 (2026-09-02) is a devDependency, and the store contract runs on a local libsql file
  database in `test:db`. It declares `transaction` and `failureInjection` as gaps:
  - libsql 0.5.29's `Database.function` throws "not implemented", and no SQLite state survives the rollback the
    failure causes. A flag row rolls back with it, and `total_changes()` does not move when the usage write is the
    statement that fails.
  - Batch atomicity on libsql is proven by reserve's duplicate-id case (probe F4: sequential statements fail it).
  Drizzle over D1 is task F's to run, in the Wrangler lane.

### M5-T47: `cloudropTables({ dialect, tables? })`, with explicit types, matched against the DDL

- **Decision:** `cloudropTables` takes the same `{ dialect, tables? }` as `drizzleStore`, not spec §3's
  `cloudropTables({ files?, usage? })`, so one options object can feed both. It returns `pg-core` or `sqlite-core`
  tables with spec §3's columns, the plain DDL's index names (`<table>_<columns>_idx`) and, on Postgres, the CHECKs
  named as Postgres names an unnamed column CHECK (`<table>_<column>_check`). `status` is typed `FileStatus`. Sizes
  and counters read as numbers. Times read as Dates: `timestamptz` on Postgres, `timestamp_ms` integers on SQLite. The
  column types are written by hand, because the package emits declarations without inference (`isolatedDeclarations`);
  the compiler checks the builders against them, and type tests pin `$inferSelect` for both dialects. A db-lane test
  compares every column, index and CHECK with the catalogue of tables made from the plain DDL, for the default and
  renamed tables.
- **Why:** spec §3, so an app's drizzle-kit migration builds the tables the store was proven on. Table names are
  validated as the store validates them.
- **If wrong:** a Drizzle release that renames its builder types breaks the declared types at compile time, not at
  run time; the peer range may then need an upper bound. (Fix round 2: the types now name no builder types; see
  M5-T51.)
- **Status:** decided.
- **Source:** task D, 2026-11-17.
- **Visible in:** `src/adapters/drizzle/tables.ts`, `src/adapters/drizzle/postgres-tables.ts`,
  `src/adapters/drizzle/sqlite-tables.ts`, `src/adapters/drizzle-tables.db.integration.test.ts`.
- **Amended 2026-11-17 (fix round 1):** `cloudropTables` is replaced by `cloudropPgTables(options?)` and
  `cloudropSqliteTables(options?)`, with options `{ tables? }` (`CloudropTablesOptions`). Each lives in its own module
  and imports only its dialect's Drizzle core, so an app's schema file bundles one of them. The db-lane comparison
  now includes each index's uniqueness (§3: the `key` index is not unique). Spec §3 and §7 are amended to match.

### M5-T48: `cloudrop/adapters/drizzle` is 13.76 kB summed; its ceiling is 15 kB (M4-F24)

- **Decision:** the drizzle budget goes from 13 kB to 15 kB. Measured: 13.76 kB summed with its chunks (the SQL core
  8.51 kB, the `routeFor` chunk 1.51 kB, errors 0.88 kB, input 0.39 kB, the entry 2.54 kB). Bundled and minified it is
  7.49 kB, against 6.53 kB for `cloudrop/adapters/sql`.
- **Why:** the 13 kB ceiling was "the core plus 3 kB" when the core was smaller. Since then the core grew in task C's
  fix round, and the adapters share the `routeFor` chunk (M5-T77). Drizzle's own code is about 1 kB minified. The
  ceiling is a guard against accidents, not a target, so it gets about the same headroom as `adapters/sql`.
- **If wrong:** the prisma ceiling (13 kB) will likely need the same raise when task E lands.
- **Status:** decided.
- **Source:** task D, 2026-11-17.
- **Visible in:** `scripts/size-limit.config.ts`.
- **Amended 2026-11-17 (fix round 1):** after the libsql/D1 batch path, the single-`Client` check and the longer
  TSDoc, the entry is 3.36 kB and the sum 14.84 kB (7.81 kB bundled and minified, against 6.65 kB for
  `adapters/sql`). The ceiling is now 17 kB, about the headroom prisma has at 16 kB for 12.37 kB.

### M5-T49: a single node-postgres `Client` is refused

- **Decision:** `drizzleStore` refuses, with `INVALID_CONFIG`, a Drizzle database whose `$client` is a node-postgres
  client that is not a pool. The test is Drizzle's own: `query` and `connect` are present and the constructor's name
  does not contain "Pool". The message says why and what to pass instead (`drizzle(new Pool(…))`, or postgres.js).
  The factory's TSDoc says the same.
- **Why:** Drizzle's node-postgres driver checks out a connection for a transaction only from a pool. With a `Client`,
  it runs `BEGIN` on the one connection every other request uses. The review measured the result: a reserve made by
  another request while an `onComplete` transaction was open answered `reserved`, then vanished when that
  transaction rolled back.
- **If wrong:** a pool-like client whose class name lacks "Pool" is refused; renaming the class or wrapping it in a
  pool fixes it. PGlite and other single-connection drivers are not detected; they are not tested.
- **Status:** decided.
- **Source:** task D fix round 1, 2026-11-17 (review I1).
- **Visible in:** `src/adapters/drizzle/postgres.ts`, `src/adapters/drizzle.ts`, `src/adapters/drizzle.test.ts`.

### M5-T50: one set of driver rows for every SQL store

- **Decision:** `src/testing/db/driver-rows.ts` exports `driverRows(storeOver)`: 2^53 − 1 and millisecond times round
  trip, and eight concurrent reserves of one owner fill a quota exactly. The sql, Drizzle and Prisma db tests call it
  for each of their drivers. Drizzle's copied `encodingRow` is gone. The raced first reserves of new owners
  (M5-T74) are a store-contract case since task E's merge, so they run on every Drizzle store: node-postgres,
  postgres.js, better-sqlite3 and libsql.
- **Why:** these rows break only through a driver's encodings and connections, so every adapter must run them.
- **If wrong:** nothing; a driver that needs more rows adds them beside the call.
- **Status:** decided.
- **Source:** task D fix round 1, 2026-11-17 (review I2).
- **Visible in:** `src/testing/db/driver-rows.ts`, `src/adapters/{sql,drizzle,prisma}.db.integration.test.ts`.

### M5-T51: the `drizzle-orm` peer range (`>=0.45.0 <2` since fix round 2)

- **Decision:** the optional peer is `drizzle-orm >=0.45.0 <1`.
- **Why:** checked against `drizzle-orm@1.0.0-rc.5` (2026-10-21), the newest RC that is two weeks old, which the
  owner's app-a uses. At run time it passes: the store contract on node-postgres, postgres.js, better-sqlite3 and
  libsql, the handler rows and the table comparison all pass (182 passed, 10 gap skips). The types do not:
  - the declared table types name builder types that 1.0 renamed: `PgTextBuilderInitial`, `PgBigInt53BuilderInitial`,
    `PgIntegerBuilderInitial`, `PgTimestampBuilderInitial` and the `SQLite…BuilderInitial` types are gone, and
    `TableConfig` gained `isAlias`;
  - a synchronous database's `transaction` now returns a conditional type, which `DrizzleSqlite` does not accept.
  The tests' own Drizzle types changed too (`PgTransaction`, `ExtractTablesWithRelations`, `SQLiteSyncDialect`).
- **If wrong:** supporting 1.0 needs a second set of declared table types for 1.0's builders, chosen through the
  peer's version, and a looser `DrizzleSqlite.transaction`. The executors themselves need no change.
- **Status:** decided.
- **Source:** task D fix round 1, 2026-11-17 (review M7).
- **Visible in:** `packages/cloudrop/package.json`.
- **Amended 2026-11-17 (fix round 2):** the peer range is now **`>=0.45.0 <2`**. drizzle-orm 1.0 must work, types
  included, because app-a is on 1.0.0-rc.5. What was needed:
  - **Table types without builder type names.** Each column type is now built from what both lines export: the
    builder functions' return types (`ReturnType<typeof text>`, `ReturnType<typeof timestamp>`, the `data: number`
    member of `bigint`'s return union), their `this`-typed methods (`ReturnType<B["notNull"]>`, `["primaryKey"]`),
    `$type<FileStatus>` instantiated on a type-only `declare const` stand-in, and each table's type as
    `ReturnType<typeof pgTable<string, Columns>>` (`sqliteTable` on SQLite).
  - **Two SQLite builders by instantiation expression.** `text` erases to `any` through its named overload on both
    lines, so it comes from `typeof text<string, [string, ...string[]], never>`: `never` satisfies 0.45's length
    parameter and 1.0's mode parameter alike. The millisecond timestamp comes from `typeof integer<"timestamp_ms">`.
    Those are the name-less overloads, typed `""` on 0.45, so the SQLite text and time helpers cast their builders
    to them. That is the only cast, and only the name and length type differ. The row-type tests and the catalogue
    test pin the result.
  - **`DrizzleSqlite.transaction` is non-generic**, `(run: (tx) => SqlRow[][], config?) => unknown`. 0.45 types the
    answer as the callback's; 1.0 uses a conditional type that refuses async callbacks; both fit this shape. The
    batch casts the answer back to `SqlRow[][]`.
  - **The type tests name only what both lines export.** The expected `tx` type is Drizzle's own: the parameter of
    `db.transaction`'s callback. `drizzleSql` on SQLite is checked by running it on better-sqlite3.
  - **Proof.** Against 1.0.0-rc.5, from a scratch install in the worktree:
    - `tsconfig.drizzle.json` (the adapter, its tests and their imports) type-checks;
    - the unit file passes (10);
    - the Drizzle db files pass (182 passed, 10 gap skips);
    - a consumer of the built `dist` pins the §3 row types.
    The same checks pass against the installed 0.45.4.
  - **Regression guard.** `scripts/check-drizzle-versions.sh [version]` type-checks that config against another
    drizzle-orm in a temporary copy of the package, with every other dependency pinned to the installed version. The
    CI job `drizzle-1` runs it for 1.0.0-rc.5. Restoring round 1's generic `transaction` makes it fail (two
    "No overload matches" errors).

<!-- Task D appends its entries above this line. -->

## Prisma adapter (task E)

### M5-T54: `prismaStore` over raw queries, with `transaction: true` as a typed overload

- **Decision:** `prismaStore(prisma, { dialect, tables?, transaction?, transactionOptions? })` builds a `SqlExecutor`
  over `$queryRawUnsafe` and hands it to `sqlStore`. A batch is `$transaction([...])`, the array form, which Prisma runs
  in order in one transaction. `transaction: true` is an overload whose options require `dialect: "postgres"`; it adds
  the executor's `transaction` over `prisma.$transaction(async (tx) => …, transactionOptions)`, with batches run in order
  on `tx`, already inside the transaction, and returns `PrismaTransactionalStore<TTx>`: `transaction`
  required and `store.route = routeFor<{ tx: TTx }>(store)` on the very store object. `TTx` is
  `PrismaTransactionClient<TClient>`, the callback parameter of the client's last `$transaction` overload, which is the
  callback form in Prisma 7's generated client, so `onComplete({ tx })` is `Omit<PrismaClient, ITXClientDenyList>`. The
  client is typed by hand (`PrismaClientLike`); `src/` imports nothing from Prisma. `transactionOptions` takes only
  `maxWait` and `timeout`. `INVALID_CONFIG` at construction for an unknown dialect, `transaction: true` on SQLite, and
  `transactionOptions` without `transaction: true`. The 2 s `lock_timeout` stays the core's (around the claim only, M5-T76).
- **Why:** spec §5.5 and §7. No `isolationLevel`: the claim's busy answer relies on Read Committed re-reading a row it
  waited for (`outcomes.ts`), so Serializable would turn overlaps into serialization failures. Prisma's 5 s default
  timeout counts `onComplete`; a completion that outlasts it is rolled back and answered as a retryable store failure
  (measured, `prisma-handler.db.integration.test.ts`).
- **If wrong:** a caller that needs another isolation level gets a new option later; an exported one cannot be taken
  back. On Postgres the raw SQL finds its tables through the connection's search path, while PrismaPg's `schema` option
  reaches model queries only (measured): tables outside `public` need both, as the factory's TSDoc says, preferably
  `ALTER ROLE <user> SET search_path = …`, which survives connection poolers (M5-T59).
- **Status:** decided.
- **Source:** task E, 2026-11-17.
- **Visible in:** `src/adapters/prisma.ts`, `src/adapters/prisma.test.ts`.

### M5-T55: Prisma's raw results need no new decoding; its SQLSTATE is found under `meta`, as `originalCode`

- **Decision:** measured through `$queryRawUnsafe` (Prisma 7.10.1).
  - Postgres (`@prisma/adapter-pg`): `bigint` and `count(*)` come back as `BigInt`, `sum(...)` (numeric) as `Decimal`,
    `boolean` as boolean, `timestamptz` as `Date`, and a bound JS number cast `$1::bigint` as `BigInt`.
  - SQLite (`@prisma/adapter-better-sqlite3`): a column declared `INTEGER` comes back as a number (2^53 − 1 exactly), and
    an expression without a declared type (`sum`, `count`, `1`, `1 = 2`) as `BigInt`.
  - A statement without `RETURNING` answers `[]` on both. The core's `toSafeInteger` and `toDate` already accept all of
    these, so the decoder is unchanged.
  - Prisma reports a raw query's failure as `P2010` with the driver adapter's error under `meta.driverAdapterError`.
    That error's `cause` holds the SQLSTATE as `originalCode`, on every error the adapter maps, and as `code` only on the
    ones it does not name. 55P03 arrives as `{ originalCode: "55P03", kind: "postgres", code: "55P03" }`, and 23505 as
    `{ originalCode: "23505", kind: "UniqueConstraintViolation", constraint, table }`, with no `code`.
  - The core's SQLSTATE walk (behind `isLockTimeout` and `isUniqueViolation`) follows `cause`, or
    `meta.driverAdapterError` when there is no `cause`, and matches `code` or `originalCode`.
- **Why:** the brief's one allowed edit to the core.
  - Without the `meta` hop, a claim that times out on the row lock fails the completion instead of answering `busy`.
  - Without `originalCode`, the loser of two racing first reserves of a new owner with a quota throws 23505 instead of
    running again (M5-T74). The review measured that (fix round 1), and the contract row "concurrent first reserves of
    new owners" failed through `prismaStore` in 4 of 4 runs before the fix and passed in 5 of 5 after.
  - The first version of this entry claimed the reserve rerun already worked; it did not, because its unit row
    invented a `code` Prisma never sets for 23505.
- **If wrong:** another Prisma major may move the field. The contract row (every store that takes concurrent calls),
  the Prisma lock-timeout row and the measured-shape rows in `src/store/sql/executor.test.ts` fail first.
- **Status:** decided; corrected in task E fix round 1.
- **Source:** task E, 2026-11-17.
- **Visible in:** `src/store/sql/executor.ts`, `src/store/sql/executor.test.ts`, `src/testing/store-contract/usage.ts`.

### M5-T56: the shipped Prisma models are the test client's schema files

- **Decision:** the test schemas became Prisma multi-file schema folders, `src/testing/db/prisma/postgres/` and
  `sqlite/`. Each holds `cloudrop.prisma`, the two models the docs ship with a header for users, and `schema.prisma`,
  the lane's generator and datasource. `scripts/test-db.sh` generates from the folders, so the snippet is the file the
  lane generates, migrates and round-trips. The store guide (task F) links to `cloudrop.prisma`. Measured:
  - On Postgres `prisma migrate diff` from C0's DDL to the models finds no difference, and a db row keeps it so.
  - On SQLite it reports both tables as redefined, only because Prisma declares `BigInt` columns `BIGINT` where the DDL
    says `INTEGER`; with `BIGINT` in the DDL the diff is empty.
  - The DDL stays `INTEGER`: both names have INTEGER affinity, so storage and behaviour are the same, and Drizzle's
    `sqlite-core` (task D) declares `integer`.
  - Prisma's models read every column the store wrote and the store reads a row the models wrote, on both dialects.
  - CHECK constraints are outside Prisma's schema language and outside `migrate diff`, so "no difference" covers
    columns, types, nullability, keys and indexes. Tables created by `prisma migrate` from the models lack §3's
    `CHECK (… >= 0)` on the usage counters; the guide gives the one `ALTER TABLE` line to add them (task E notes for F).
  - `cloudrop.prisma` carries only user-facing comments; the test-only sentence is in `schema.prisma`. The guide links
    to the shipped file, or checks a pasted copy against it (fix round 1).
- **Why:** the brief's "one source" for the snippet; C0's schema header claimed the migration check for task E.
- **If wrong:** if the docs' DDL should satisfy a Prisma migration on SQLite too, declare the 64-bit columns `BIGINT`
  in `schema.ts` and have task D's comparison read affinities rather than declared names.
- **Status:** decided.
- **Source:** task E, 2026-11-17.
- **Visible in:** `src/testing/db/prisma/`, `scripts/test-db.sh`, `src/testing/db/schema.ts`,
  `src/adapters/prisma.db.integration.test.ts`.

### M5-T57: failure injection on Prisma's SQLite connection, no gap

- **Decision:** the Prisma fixture's `openPrismaClient(db, { onSqliteConnection })` wraps the better-sqlite3 adapter
  factory's `connect` and hands over the connection the adapter keeps as `client`. Prisma's SQLite contract target
  registers the same one-shot `cloudrop_fail_once` function there, after `sqlStoreTarget` creates the triggers. The
  trigger then fails the first usage write on Prisma's own connection. Prisma on SQLite declares only `transaction` as
  a gap, like node:sqlite.
- **Why:** M5-T43's function lives on the fixture's node:sqlite connection, which Prisma never writes through. A
  probe that never arms the function fails the four atomicity rows.
- **If wrong:** the adapter's `client` property is not public API. If a Prisma release renames it, the fixture fails
  loudly ("Prisma has not opened its SQLite connection yet"), and the fallback is to declare the gap.
- **Status:** decided.
- **Source:** task E, 2026-11-17.
- **Visible in:** `src/testing/db/prisma.ts`, `src/adapters/prisma.db.integration.test.ts`.

### M5-T58: `cloudrop/adapters/prisma` is budgeted 16 kB summed

- **Decision:** measured after the build on `ce8c637`:
  - `cloudrop/adapters/prisma` is 12.18 kB summed, which breaks down as:
    - its own file, 0.88 kB;
    - the SQL core chunk, 8.59 kB;
    - `route()` for `store.route` with `errors` and `input`, 2.78 kB.
  - Its budget rises from task C's 13 kB to 16 kB.
  - Importing `routeFor` (allowed by M5-T77) moved `route()` into a chunk that `cloudrop` also loads. Summed `cloudrop`
    grew 0.8 kB when Prisma first imported it (44.5 to 45.3 kB on `d9a4ec1`) and is 45.87 kB now. The bundled and
    minified build barely moved (27.14 kB).
- **Why:** M4-F24 sets ceilings with wide headroom. The 13 kB scaffold predates `routeFor`. It would leave 0.8 kB,
  about 7%, which would force a raise at the first change to the core.
- **If wrong:** if the summed `cloudrop` budget gets tight, move `routeFor` and the brand into a module of their own,
  imported only by `route()` and the adapters.
- **Status:** decided.
- **Source:** task E, 2026-11-17.
- **Visible in:** `scripts/size-limit.config.ts`.

### M5-T59: no Prisma-only `schema` option; a core-wide `tables.schema` is a later option

- **Decision:** `prismaStore` gets no option naming a Postgres schema. Tables outside `public` are reached through the
  connection's search path, set preferably with `ALTER ROLE <user> SET search_path = …` (or `ALTER DATABASE`), which
  works behind connection poolers. A per-connection `options=-c search_path=…` is the alternative, which some poolers
  drop (unverified here). The factory's TSDoc says both.
- **Why:** the table names are quoted once in the core (`quoteTables`), and Drizzle `pgSchema` and plain-SQL users have
  the same need. An adapter-only option would split one concept across adapters.
- **If wrong:** if the owner wants it, rule it once for every adapter: `tables: { schema?: string }`, validated like
  the names and emitted as `"app"."cloudrop_files"` everywhere, including the schema check. That would be a new entry.
- **Status:** decided (review M2, fix round 1).
- **Source:** task E, 2026-11-17.
- **Visible in:** `src/adapters/prisma.ts`.

<!-- Task E appends its entries above this line. -->

## Lanes, example and docs (task F)

<!-- Task F appends its entries above this line. -->
