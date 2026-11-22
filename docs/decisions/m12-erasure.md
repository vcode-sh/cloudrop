# M12-O: erasing an owner in one call

Rulings for `eraseOwner` as one call that also covers an `/upload` racing the erasure, the owner's erase mark in
`cloudrop_usage`, and the sweep finishing an erasure, designed in `docs/superpowers/specs/2026-11-22-1.0.0-design.md`
§4.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-O1: an owner's erase mark lives on their usage row

- **Decision:** `cloudrop_usage` gains `erase_requested_at` and `erased_at` (`timestamptz(3)` on Postgres, integer
  milliseconds on SQLite and D1), after `updated_at`, with the partial index `cloudrop_usage_erasing_idx` on `(owner)`
  `WHERE erase_requested_at IS NOT NULL AND erased_at IS NULL`. The store has four new required methods
  (`StoreErasure` in `src/server/store-erasure.ts`, part of `CloudropStore`): `markErasure({ owner, now })` upserts the
  usage row (zero counters when there is none) and sets `erase_requested_at` only where it is null, then answers the
  mark as it is, in one batch whose read takes its own snapshot; `erased({ owner, requestedAt, now })` sets `erased_at`
  only for that exact `requestedAt`, and answers true when that mark is finished after the call, by this call or an
  earlier one, so two runs at once both report done; `reopen({ owner, now })` clears both columns; `erasing({ cursor,
  limit })` pages the marked, unfinished owners by keyset in byte order, as `owners` does, through one shared
  statement in `src/store/sql/reads.ts`. `OwnerUsage` gains `erasure: { requestedAt, erasedAt } | null`, which
  `api.usage` answers; `EraseReport` gains `requestedAt`. `checkSchema` requires both columns; a usage table without
  them fails the first call with `INVALID_CONFIG` naming the missing column and the exact `ALTER TABLE` and
  `CREATE INDEX` for the dialect and the configured names (`eraseMarkUpgrade` in `src/store/sql/tables.ts`). The
  Drizzle tables declare the columns and the index; the Prisma models declare the columns only, and the guide adds
  the index with `--create-only`, as for the CHECKs. `createCloudrop` refuses a store without the four methods.
- **Why:** spec 1.0 §4. The pilot kept a marker table of its own and compared a usage watermark across two
  `eraseOwner` passes, with timestamps from different clocks. A mark beside the counters is read under the lock the
  quota already takes (`M12-O2`), and makes `done` durable: once `erased_at` is set, `eraseOwner` answers done at once,
  reading no rows. Measured on Postgres 18 and SQLite: the erasing index is used by the erase pass's query
  (`SCAN cloudrop_usage USING INDEX cloudrop_usage_erasing_idx` on node:sqlite); Prisma 7.10's `migrate diff` reports
  no difference between the models and tables that have the index (`prisma.db.integration.test.ts`), so leaving it out
  of the models does not make Prisma drop it. drizzle-kit 1.0.0-rc.5 writes the index's condition with qualified
  column names on SQLite, which SQLite accepts and uses (checked on node:sqlite).
- **If wrong:** a store written by hand before 1.0 fails `createCloudrop` until it adds the four methods; an app that
  deploys 1.0 before migrating answers `INVALID_CONFIG` on every store call until it runs the printed SQL. A store
  that answers the mark without keeping it is caught by nothing at run time; eraseOwner's last reads (`M8-A5`) still
  catch an upload that starts during a run there, and the store contract names the store.
- **Status:** in force. Store contract `src/testing/store-contract/erasure.ts` on the memory store, node:sqlite,
  Postgres through node-postgres, postgres.js, Drizzle and Prisma, and D1 through the SQL and Drizzle adapters. Fault
  probes, each seen failing: a second mark that overwrites the first time, `erased` without its `requestedAt` guard,
  `erasing` without `erased_at IS NULL`. `src/store/sql/erase-upgrade.db.integration.test.ts` runs the printed SQL on a
  0.6 table, in a schema on Postgres and under another name on SQLite, and the store then works.
- **Visible in:** `src/server/store-erasure.ts`, `src/store/sql/erasure.ts`, `src/store/sql/reads.ts`,
  `src/store/sql/tables.ts`, `src/testing/memory-store-erasure.ts`, `src/adapters/drizzle/*-tables.ts`,
  `src/testing/db/prisma/*/cloudrop.prisma`, `docs/guide/store.md#upgrading-from-06`.

### M12-O2: `reserve` refuses every file of a marked owner; amends `M8-A5`

- **Decision:** `reserve` answers `"erased"` for every file of an owner whose usage row has `erase_requested_at` set,
  finished or not, and writes nothing, superseding included (`ReserveOutcome`). On Postgres the statement reads the
  mark in its `locked` CTE, the `SELECT … FOR UPDATE` of the usage row that the quota already reads, so a reserve that
  waited for the mark's lock re-reads the row and sees it. The no-limit path's `ON CONFLICT (owner) DO UPDATE`, which
  added a first reserve's bytes to a row created after its snapshot, is gone: every path now fails on the unique owner
  and runs once more, on a new snapshot whose `FOR UPDATE` reads the mark. A supersede reads the mark from the
  statement's snapshot, before the lock, which keeps the lock order of `M11-R61`: a mark committed between the two may
  let a refused retry end its own earlier attempt, whose bytes it releases in the same statement and which the erasure
  ends anyway. On SQLite and D1 every statement of the batch tests the mark, and a first statement tells the outcome
  apart from the quota; one batch is one writer. The memory store checks the row first. `/upload` answers each such
  file `FORBIDDEN`, "This account is being erased, so it can no longer upload files." (`store-upload.ts`, where the
  reserve outcomes become per-file answers; the `authorize` handling is untouched).
- **Why:** `M8-A5` left a race open: an `/upload` that passed `authorize` before the account was deleted could reserve
  a file after eraseOwner's last read, and `done` spoke only for its moment. With the mark under the quota's lock, a
  reserve either committed before the mark, and the row passes that follow it see its rows, or is refused. The
  `ON CONFLICT` removal was found by the race row: with it, a first reserve without a limit whose snapshot predates the
  mark's new row would add its bytes to that row and reserve past the mark.
- **If wrong:** an owner id reused for a new account cannot upload until `api.reopenOwner` (`M12-O5`). A first reserve
  of a new owner without a limit that races another now runs its statement twice instead of once, as a limited one
  always did.
- **Status:** in force; amends `M8-A5`'s "If wrong" residual, which no longer applies to a store that keeps the mark.
  `src/store/sql/erase-race.db.integration.test.ts` holds each side's lock in a transaction and starts the other only
  once the holder holds it, with and without a usage row: a mark waits for a reserve, which commits first; a reserve
  waits for a mark, then answers erased and writes nothing. Fault probes, each seen failing: the old `ON CONFLICT`
  restored (the reserve without a usage row reserves past the mark), the Postgres mark check removed (all four race
  rows and the contract rows), the memory store's guard removed (the contract rows and the server row in
  `src/server/erase-mark.test.ts` whose `authorize` resolves after the mark), and SQLite's outcome read removed.
- **Visible in:** `src/store/sql/postgres.ts`, `src/store/sql/sqlite.ts`, `src/testing/memory-store-methods.ts`,
  `src/server/store-upload.ts`, `src/server/store.ts`.
