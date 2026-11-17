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
