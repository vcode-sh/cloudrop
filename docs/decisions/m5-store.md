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
- **Status:** decided.
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

<!-- Task B appends its entries above this line. -->

## SQL core and the sql adapter (task C)

<!-- Task C appends its entries above this line. -->

## Drizzle adapter (task D)

<!-- Task D appends its entries above this line. -->

## Prisma adapter (task E)

<!-- Task E appends its entries above this line. -->

## Lanes, example and docs (task F)

<!-- Task F appends its entries above this line. -->
