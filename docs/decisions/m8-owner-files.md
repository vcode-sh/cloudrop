# M8-A: the 0.2.0 owner file API

Rulings for the server-side file API that applications built on the store kept writing themselves (found in the
first production integration, 2026-11-20): listing an owner's files, erasing an owner, one file per owner on a route,
and sweeping every page in one call. Entries continue from `M8-A1`.

### M8-A1: `api.files` lists an owner's completed files, newest first, by keyset pages

- **Decision:** `api.files({ owner, route?, limit?, cursor? })` answers `{ items: FileRecord[], cursor: string | null }`:
  the owner's `completed` rows, newest upload first (`created_at`, then id, both descending, ids in byte order), at most
  `limit` (1 to 1000, default 100) per page. `route` must name one of the server's routes (`INVALID_INPUT` otherwise,
  listing the names); without it every route is listed. The cursor is the store's `<milliseconds>:<id>` of the last
  row, refused before the store sees it when it has another shape. The store gains `list({ owner, statuses, route,
  limit, cursor })`; `api.files` asks for `completed` alone, and `eraseOwner` reads several statuses in one statement
  (`M8-A5`).
- **Why:** the production integration wrote this query itself against the tables. The items are the `FileRecord`s
  `api.file` already answers, so there is no second public shape. `created_at` never changes, so a page cursor stays
  valid while the caller deletes the files it read (the contract proves it); `completed_at` would serve "newest" as well
  but is null for every other status, which `eraseOwner` also lists.
- **If wrong:** an app that needs "newest by completion" for long multipart uploads sorts a page itself; a search or a
  type filter stays the app's own query over its tables.
- **Status:** in force. Contract cases `list …` on every backend; `src/server/store-api.test.ts`.
- **Visible in:** `src/server/owner-files.ts`, `src/store/sql/reads.ts`, `src/testing/memory-store-reads.ts`,
  `src/testing/store-contract/list.ts`, `docs/guide/store.md#list-an-owners-files`.

### M8-A2: the owner index becomes `(owner, status, created_at)`

- **Decision:** The index `<files>_owner_status_idx (owner, status)` is replaced by
  `<files>_owner_status_created_at_idx (owner, status, created_at)` in the SQL DDL of both dialects, the Drizzle tables
  (Postgres and SQLite), both Prisma models and the Next example's SQL. The new index serves every query the old one
  did (`revoke`, `reconcile`, the replaced-file update of `M8-A6`) as its prefix. Existing databases migrate with
  `CREATE INDEX "cloudrop_files_owner_status_created_at_idx" ON "cloudrop_files" (owner, status, created_at); DROP
  INDEX "cloudrop_files_owner_status_idx";`; Drizzle and Prisma users regenerate their migration (drizzle-kit asks
  whether the index is renamed: it is created). The Hono example's migration `20261120192648_owner_files_index` does
  exactly that.
- **Why:** `api.files` reads `owner = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT n`. With `(owner,
  status)` every page would read and sort all of an owner's completed rows; with `created_at` in the index a page reads
  `n + 1` rows.
- **If wrong:** the migration is optional for correctness: without it the store still works, only slower for owners
  with many files.
- **Status:** in force. `src/testing/db/fixtures.db.integration.test.ts` pins the index on Postgres and SQLite, and the
  Prisma and Drizzle lanes diff their schemas against the DDL.
- **Visible in:** `docs/guide/store.md#upgrading-from-01`, `src/testing/db/schema.ts`, `src/adapters/drizzle/*-tables.ts`,
  `src/testing/db/prisma/*/cloudrop.prisma`, `examples/next/lib/cloudrop-tables.sql`, `examples/hono/drizzle/`.

### M8-A3: `CloudropStore` gains `list` and `complete(…, { replace })`

- **Decision:** `list` is a required store method, checked by `createCloudrop` like the others. `complete` takes an
  optional fifth argument `{ replace?: boolean }` and answers `Completion`, a `Transition` with `replaced: FileRecord[]`
  (empty without `replace` and whenever nothing changed). `Completion` is exported. Every shipped store goes through
  the SQL core or the memory store, so all of them have both.
- **Why:** both features need a guarantee only the store can give in one unit: a keyset page by owner, and a
  replacement atomic with the completion. Separate methods would let a store implement the completion and forget the
  replacement; one method with an option keeps them in one unit.
- **If wrong:** this breaks a store written by hand against 0.1 (it fails at `createCloudrop` naming `list`, and its
  `complete` misses `replaced` at compile time). None is known; the changelog says so.
- **Status:** in force.
- **Visible in:** `src/server/store.ts`, `src/server/store-config.ts`.

### M8-A4: a key is checked for the last time only once its URLs and the grace have run out

- **Decision:** `settledAt(record, graceMs)` is `min(expiresAt, (claimedAt ?? endedAt ?? expiresAt) + 15 minutes) +
  graceMs`: the last moment one of the row's URLs could start a `PUT` (URLs are signed while the row is `pending`, each
  works 15 minutes and none outlives the token; a row leaves `pending` at its last claim, or at its end), plus a grace
  that is only the time a `PUT` under way gets to land. `deleteFile`, and the removal after a replacing completion,
  still delete the object at once, but mark the row cleaned only once `settledAt` under the default grace (1 hour) has
  passed; otherwise `cleaned_at` stays null and the sweep's cleanup pass checks the key again an hour after the end.
- **Why:** in 0.1 `deleteFile` marked a just-completed file cleaned at once, so a duplicate `PUT` with one of its URLs
  (a retry whose answer was lost) could put the object back after the delete, with no row left to find it; the
  production integration worked around it by hand. The first version anchored the grace at the moment the row left
  `pending`, without the URL's 15 minutes: at the minimum grace a `PUT` started a moment before its URL ran out could
  land after a check called final (found in review, reproduced with `graceMs: 900000`). `/sign` reads the row and then
  signs, and `/upload` signs after `reserve` without reading it again, so a URL may be signed a moment after the row
  left `pending`; that moment is a request's length, well inside the grace. The sweep keeps its own rule (`ended_at +
  graceMs`, with a `PUT` still under way after cleanup a documented cost); `eraseOwner` re-checks what it cleaned.
- **If wrong:** a deletion within the hour after completion costs the sweep one more `HEAD`.
- **Status:** in force. `src/server/store-api.test.ts` ("deleteFile marks a file cleaned once its URLs and the grace
  after them have passed") and the first case of `src/server/erase.test.ts`, at the millisecond on both sides.
- **Visible in:** `src/server/leftovers.ts`, `src/server/store-api.ts`, `docs/guide/store.md#file-operations`.

### M8-A5: `api.eraseOwner(owner, { graceMs?, signal? })`, and when it reports done

- **Decision:** One run revokes the owner's `pending` rows (`store.revoke`), ends the owner's `completed` rows as
  `deleted`, then reads the owner's `pending`, `completing` and `completed` rows together (`list` with three statuses,
  one statement per page) and counts each as `waiting`. Then each ended status (`aborted`, `rejected`, `failed`,
  `expired`, `deleted`) is read: a row is proven when it is not `failed` and its `cleaned_at` is at or after
  `settledAt` (`M8-A4`, with the run's `graceMs`, default 1 hour, at least 15 minutes); any other ended row has its
  leftovers removed (`removeLeftovers`: only the object whose `cloudrop-id` is the row's, and its multipart upload),
  and is marked cleaned and counted `cleaned` once `settledAt` has passed, or counted `waiting` before (the time is
  taken before the check, so a slow check never counts as one made after the settle time). When nothing is waiting by
  then, the owner's newest row in any status is read, and counts as `waiting` when it was created at or after the
  run's start; then the live statuses are read once more. The answer is `{ revoked, deleted, cleaned, failed, waiting,
  done }`, with `done` true when nothing failed, nothing is waiting and the signal did not stop the run. A storage or
  database error on one row is logged with the row's id and counted in `failed`; a failed listing answers the store's
  retryable `SERVER_ERROR`. `signal` is checked before the run, each page and each row.
- **Why:** the production integration erased accounts by deleting files through `deleteFile` and then emptying its own
  folders with `deletePrefix`, which needs the app's key layout. The rows already say which objects an owner has, so
  the store's states prove emptiness without it: completed rows still hold an object, completing ones may still
  complete, and an ended row is final only after its URLs and the grace ran out, which is why a recent upload takes a
  second run an hour later. `failed` rows are always checked: the sweep marks a stuck completion cleaned while it keeps
  the object for the app to check (`M5` sweep), so `cleaned_at` proves nothing there; an erasure removes it. A row
  cleaned early by 0.1's `deleteFile` is checked again in every run, since `cleaned` never stamps a cleaned row again.
  The order is the proof: once one statement finds nothing of the owner live, nothing of theirs can end afterwards
  (only a new `/upload` adds a row), so the ended passes read a set that no longer changes. The first version read the
  eight statuses one at a time, the live ones last, and review reproduced a miss: a lease-mode completion whose
  `onComplete` threw handed its file back to `pending` between the `pending` and the `completing` read, the run said
  done, and the client's retry then completed the file. Re-review found that a final live read alone misses an upload
  that starts and is cancelled during the ended passes (never live at a read, ended after its status was read); the
  newest-row check catches any upload that started during the run, whatever its status. A reserve that began before
  the run and commits during it is caught by the last live read while it is unfinished; the rest of that race is the
  residual below.
- **If wrong:** `done` speaks for the moment of the run: an `/upload` that passed `authorize` before the app revoked
  the owner's access can reserve a file after the last read. The guide says to revoke access first and run it once
  more if a request may still be in flight. Rows and the usage row stay (ended, and at zeros); an app whose erasure
  policy forbids keeping file names deletes them with its own SQL after `done`.
- **Status:** in force. `src/server/erase.test.ts`, with fault probes: without the `failed` rule the stuck completion's
  object stays; without the live reads an upload started mid-run is missed; without the settle wait a late `PUT`
  survives a run that said done. The release race, the URL-life boundary and the upload cancelled mid-run were each
  seen failing before their fix.
- **Visible in:** `src/server/erase.ts`, `docs/guide/store.md#erase-an-owner`.

### M8-A6: `replace: true` keeps one file per owner on a route

- **Decision:** `replace` is a route policy option (`route()`'s first argument). It needs a store and `owner`, and sets
  `maxFiles` to 1; `createCloudrop` refuses a replacing route without a store, without `owner`, with another
  `maxFiles`, or with a non-boolean `replace`, with `INVALID_CONFIG`. A completion on it calls
  `store.complete(…, { replace: true })`, which in the completion's own unit ends the owner's other `completed` rows on
  the route as `deleted` (`ended_at` now, `cleaned_at` null) and releases their bytes; a row whose `owner` answered null
  replaces nothing. On Postgres the store runs two statements in one batch: a transaction-scoped advisory lock on
  `hashtextextended('cloudrop replace ' || files table || owner || route)`, then one statement that completes, replaces
  and counts, with a snapshot taken after the lock. On SQLite and D1 the batch puts the replaced rows' usage first,
  then their end, then the completion, each guarded on the new row still being `completing` with this claim. After the
  record, and before `afterComplete`, the server removes each replaced file's object (`M8-A4`); a failure is logged
  ("could not remove the replaced file … The sweep removes it later.") and the sweep's cleanup pass finishes it.
  `onComplete` sees the previous file still completed; `afterComplete` runs after its row is deleted and its object's
  removal was tried; neither context gains a field. Under a quota the owner needs room for both files until the new
  one completes, since its bytes are reserved while the previous file still counts; the guide says so.
- **Why:** one statement cannot do it on Postgres: under READ COMMITTED its snapshot predates the other completion's
  commit, so two completions at once would each keep their file (the contract's concurrency case fails that way when
  the lock is moved after the statement). The advisory lock is taken only by replacing completions, before any row
  lock; the statement then locks the new row, the replaced rows, then the usage row (the replaced sum sits in the usage
  update's SET list, computed before that row is locked), the order every other writer keeps, so no deadlock cycle
  forms. The lock's result is read as a count because Prisma cannot read `void`. Deleting the previous file in
  `afterComplete`, as the Hono example did, left both files when two first uploads raced and when `afterComplete` was
  skipped by a crash.
- **If wrong:** a 64-bit hash collision with another lock only makes two completions take turns.
- **Status:** in force. Contract cases `complete with replace …`, eight owners completing two files at once (in plain
  calls, and in transactions where the backend has them), a replacement racing a delete of the replaced file, and the
  atomicity case, on every backend; `src/server/store-replace.test.ts` in both transaction and lease mode.
- **Visible in:** `src/server/route.ts`, `src/server/route-config.ts`, `src/server/store-config.ts`,
  `src/server/store-complete.ts`, `src/store/sql/postgres-replace.ts`, `src/store/sql/sqlite.ts`,
  `docs/guide/store.md#one-file-per-owner-replace`.

### M8-A7: `api.sweep({ all: true, signal? })` sweeps every page in one call

- **Decision:** With `all: true` the sweep runs one bounded call after another, each of `limit` rows (default 100), from
  `cursor` when given, until every row has been seen, and answers the reports summed (`reported` concatenated) with
  `cursor: null`. `signal` (allowed only with `all`, refused otherwise) is checked before each page; once aborted, the
  answer carries the cursor to continue from (`"expire:"` when no page ran). A listing that fails on the first page
  answers the store's error; on a later page, what was done with that listing counted in `failed` and no cursor, as
  within one call.
- **Why:** every integration wrote the same cursor loop. An option keeps one method and one report shape; checking the
  signal between pages keeps every page's cursor valid, and a page of 100 rows is a few seconds of storage calls.
- **If wrong:** a page of slow storage calls can run past the signal by up to one page; a lower `limit` shortens it.
- **Status:** in force. `src/server/sweep-all.test.ts`.
- **Visible in:** `src/server/sweep.ts`, `docs/guide/store.md#the-sweep` (cron recipes for Node and Cloudflare
  Workers), `examples/hono/src/worker.ts`.

### M8-A8: the Hono example uses `replace` and `sweep({ all: true })`

- **Decision:** The example's avatar route is `replace: true` and its `onComplete` only upserts the app's `avatar` row
  through `tx`; the `FOR UPDATE` read, the `{ replaced }` result and the `afterComplete` that called `deleteFile` are
  gone. The worker sweeps with `sweep({ all: true, signal: AbortSignal.timeout(10 minutes) })`. The router's `list`
  keeps its own Drizzle query, so the web app's types and the browser pass do not change.
- **Why:** the example showed the hand-written replacement the production integration copied, with its two races.
  Two avatar completions at once take turns on the `avatar` row's lock in `onComplete` and on the advisory lock in the
  completion, in the same order, so the row and the kept file agree.
- **If wrong:** none known.
- **Status:** in force; the browser pass runs it after merge.
- **Visible in:** `examples/hono/src/uploads.ts`, `examples/hono/src/worker.ts`, `examples/hono/README.md`,
  `docs/guide/hono.md`.
