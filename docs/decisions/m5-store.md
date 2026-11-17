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
  - `graceMs` is at least 900,000 ms (15 minutes, the life of an upload URL); a smaller one is refused with
    `INVALID_INPUT` naming the minimum. Both passes use it as given: the expire pass after the deadline, the cleanup pass
    after the row ended. (Amended 2026-11-17 by the controller's closing ruling; the first version allowed 0 or more and
    floored only the cleanup pass.)
- **Why:**
  - The review (I1) showed the first order could delete a completed file. A `/complete` that verified in time could
    claim the row between the sweep's delete and its `end`.
  - With the row taken first, a `/complete` that claims first keeps its object.
  - A `/complete` that comes later is refused (`UPLOAD_EXPIRED`) with nothing recorded.
- **If wrong:** no URL outlives its token's deadline (`presign.ts` caps it at `exp`) or lives longer than 15 minutes, so
  with the floor a PUT in flight at the deadline always lands before its row can be cleaned. If URL lifetimes grow,
  the floor must grow with them.
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
  - The sweep always answers `ok(report)`. When it cannot even list its work, it answers the report so far, with the
    cursor it was given.
- **Why:**
  - The review (I2): a failure mid-page threw away the `reported` stuck completions the sweep had already ended, which
    are reported only once.
  - A row that failed every time blocked every later row for good.
- **If wrong:** `failed` is public (`SweepReport`); removing it later is a breaking change.
- **Status:** decided by the controller (fix round 1); it amends M5-T30.
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

<!-- Task C appends its entries above this line. -->

## Drizzle adapter (task D)

<!-- Task D appends its entries above this line. -->

## Prisma adapter (task E)

<!-- Task E appends its entries above this line. -->

## Lanes, example and docs (task F)

<!-- Task F appends its entries above this line. -->
