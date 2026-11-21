# M11-L: files of every owner

Rulings for `api.allFiles`, designed in `docs/superpowers/specs/2026-11-21-0.6.0-design.md`.
Each entry: Decision, Why, If wrong, Status, Visible in.

Measurements in `M11-L5` to `M11-L7` were taken on 2026-11-21: Postgres 18.6 in the `test:db` container (database
collation `en_US.utf8`) with 303,322 files of 4,967 owners (8% without an owner; one owner with 15,898 files; 80%
completed, 8% deleted, 5% aborted, 2.9% pending, 0.1% completing; five routes from 59% of the files to 23 files; the
files of one `/upload` share `created_at`, and one instant holds 5,000 files), after `VACUUM ANALYZE`, each statement
with `EXPLAIN (ANALYZE, BUFFERS)`, best of five, a page of 100 (`LIMIT 101`). SQLite 3.53.4 through `node:sqlite` with
the same rows, `EXPLAIN QUERY PLAN` and the best of five timed runs, without statistics and again after `ANALYZE`
(the same plans).

### M11-L1: `api.allFiles` is a method of its own, with `api.files`'s options and two more

- **Decision:** `api.allFiles({ owner?, status?, route?, name?, type?, order?, limit?, cursor? })` answers the
  `{ items, cursor }` page of `api.files`. Every option may be left out, and so may the argument: `api.allFiles()` is
  the newest 100 files of every owner. `owner` narrows to one owner in any status; left out (`undefined`), it is every
  owner, files without an owner included. An `owner` that is present and not an owner (`null`, `""`, over 255
  characters, with NUL) is refused with `INVALID_INPUT`, never read as "every owner". `status` is one `FileStatus`;
  anything else is refused with "status must be one of pending, completing, completed, aborted, rejected, failed,
  expired, deleted." `route`, `name`, `type`, `order`, `limit` and `cursor` are read by the code that reads them for
  `api.files`, so the checks and messages are the same. `AllFilesOptions` is exported from `cloudrop`; the JSDoc of
  the method says it crosses owners and belongs behind the app's own admin check.
- **Why:** the spec's reason: `api.files({ owner: undefined })` is refused today, and must stay refused, so a user id
  lost by a bug never lists everyone's files. A separate name makes crossing owners something an app writes on
  purpose. The pilot's admin inventory read cloudrop's table itself for this.
- **If wrong:** an app that wants several statuses in one listing calls once per status or keeps its own query.
- **Status:** in force.
- **Visible in:** `src/server/all-files.ts`, `src/server/store-api.ts`, `src/index.ts`, `src/server/all-files.test.ts`,
  `docs/guide/store.md#list-every-owners-files`.

### M11-L2: creation time, then id in byte order, by keyset pages

- **Decision:** `"newest"` is `created_at` then id, both descending; `"oldest"` both ascending; ids compare in byte
  order (`COLLATE "C"` on Postgres, SQLite's default). A page is one statement that reads `limit + 1` rows after the
  cursor's `(created_at, id)`, so rows of one `created_at` page by id without a skip or a repeat, and a row that
  arrives between two pages appears only if it sorts after the cursor.
- **Why:** this is `list`'s order (`M8-A1`, `M10-D1`), which every backend already answers identically, and the files
  of one `/upload` always share `created_at`, so a tie is the normal case. The store contract pins it on every backend:
  ties across three owners with a page boundary inside them in both orders, rows arriving at the cursor's instant
  between pages, and 1,001 rows of one instant read with `limit` 1000.
- **If wrong:** none known; an app that wants another order sorts a page itself.
- **Status:** in force.
- **Visible in:** `src/store/sql/reads.ts`, `src/testing/memory-store-reads.ts`,
  `src/testing/store-contract/list-all-pages.ts`.

### M11-L3: a cursor carries the mark of its method and its listing

- **Decision:** A cursor of `api.allFiles` is `all.<fingerprint>.<store cursor>`, the fingerprint the eight hex digits
  of FNV-1a (`M10-D2`) over the JSON of `[owner, status, route, name, type, order]` after normalization; every
  `api.allFiles` listing has one, the unfiltered listing included. `api.files` is unchanged: no mark for its default
  listing, eight hex digits for the others. Each method refuses a cursor whose mark is not exactly its listing's, with
  `INVALID_INPUT`: "cursor belongs to a listing with another owner, status, route, name, type or order. Pass the
  options of the page that returned it, or leave cursor out to start again." (`api.files` keeps its own wording.)
- **Why:** the two listings cannot be kept apart by the hash alone: the default `api.files` listing has no mark, and
  two hashes can collide. The prefix makes it structural: a mark of `api.files` is empty or exactly eight hex digits,
  a mark of `api.allFiles` always starts with `all.`, and a store cursor starts with digits and a colon, so no string
  is a valid cursor of both, whatever the options. The owner and the status are in the fingerprint because here they
  are options of the listing; a page of one owner continued with another's cursor would silently change the listing.
- **If wrong:** a hash is not a signature, and a caller can copy a mark in front of any position. That never widens a
  listing: the owner, the status and the filters reach the store from the call's options, never from the cursor, which
  only says where to continue, and the page is checked against the options (`M11-L4`). A test forges positions in the
  future and on another owner's file under a one-owner mark and gets that owner's files only. Two `api.allFiles`
  listings whose fingerprints collide (one in 2^32) accept each other's cursors.
- **Status:** in force.
- **Visible in:** `src/server/owner-files.ts` (`markOf`, `readCursor`), `src/server/all-files.test.ts`.

### M11-L4: the store contract gains an optional `listAll`, sharing `list`'s code

- **Decision:** `CloudropStore.listAll?({ owner, status, route, name, type, order, limit, cursor })`: `list` across
  owners, `owner` null for every owner and `status` null for every status. It is optional: `createCloudrop` does not
  ask for it, and `api.allFiles` on a store without it (or with something that is not a function there) answers
  `INVALID_CONFIG`: "api.allFiles needs the store's listAll method. Add it to your store as CloudropStore describes
  it; cloudrop's own stores have it." The SQL core and the memory store each build `list` and `listAll` from one
  function, so `sqlStore`, `drizzleStore`, `prismaStore`, D1 and the testing memory store all have it. `api.allFiles`
  checks the answered page as `M10-D11` does, with the same function: the owner and the status when the call names
  them, the route, name, type and order; a page outside them is a non-retryable `SERVER_ERROR`, logged naming `listAll`.
- **Why:** `M8-A3` made `list` required and broke hand-written stores at `createCloudrop`; an admin listing is not
  worth that. A store written for 0.5 compiles and runs every other call unchanged. A second method, not `list` with a
  nullable owner: a 0.5 store given `owner: null` would answer the rows without an owner, or throw, as if that were
  the listing. In `store.ts` the two methods share the `ListQuery` type, which keeps the file under its size limit;
  `list`'s parameter is the same shape as before.
- **If wrong:** an app with its own store adds `listAll`; until then the error says so.
- **Status:** in force.
- **Visible in:** `src/server/store.ts`, `src/store/sql/reads.ts`, `src/testing/memory-store-reads.ts`,
  `src/server/all-files.ts`, `src/server/owner-files.ts` (`listPage`, `answersQuery`),
  `src/testing/store-contract/list-all.ts`.

### M11-L5: the new index is `<files>_created_at_idx (created_at)`

- **Decision:** One index, `(created_at)`, in the SQL DDL of both dialects, the Drizzle tables (Postgres and SQLite),
  both Prisma models, the Next example's SQL and a new migration of the Hono example. Measured on Postgres, a page of
  100, milliseconds (shared buffers):

  | Listing | no new index | `(created_at)` | `(created_at, id)` | `(created_at, id COLLATE "C")` | `(status, created_at)` |
  | --- | --- | --- | --- | --- | --- |
  | every owner, newest | 33.0 (10,122) | 0.05 (26) | 0.04 (29) | 0.02 (28) | 33.5 (10,122) |
  | every owner, oldest | 33.1 (10,122) | 0.05 (30) | 0.05 (37) | 0.02 (36) | 33.3 (10,122) |
  | `limit` 1000 | 34.2 (10,122) | 0.43 (225) | 0.41 (271) | 0.18 (270) | 34.7 (10,122) |
  | status `completed` (80%) | 27.9 (10,122) | 0.05 (32) | 0.05 (38) | 0.03 (37) | 0.05 (30) |
  | status `pending` (2.9%) | 3.52 (5,892) | 0.29 (811) | 0.32 (966) | 0.30 (955) | 0.05 (101) |
  | status `completing` (0.1%) | 0.13 (316) | 0.12 (316) | 0.14 (316) | 0.12 (316) | 0.05 (105) |
  | route with 59% of the files | 24.2 (10,122) | 0.06 (43) | 0.05 (49) | 0.03 (48) | 24.7 (10,122) |
  | route with 1% | 0.90 (664) | 0.61 (1,986) | 0.68 (2,382) | 0.56 (1,999) | 0.90 (664) |
  | route with 23 files | 0.01 (9) | 0.01 (9) | 0.01 (9) | 0.01 (9) | 0.01 (9) |
  | name in 12% of the files | 160 (10,122) | 1.22 (183) | 1.28 (225) | 1.21 (223) | 162 (10,122) |
  | name in 0.05% | 159 (10,122) | 323 (45,261) | 320 (54,415) | 331 (54,078) | 160 (10,122) |
  | name in no file | 158 (10,122) | 479 (68,919) | 489 (82,969) | 491 (82,969) | 161 (10,122) |
  | status, route and name together | 41.5 (8,865) | 1.60 (938) | 1.86 (1,128) | 1.55 (1,125) | 1.58 (894) |
  | deep page (from row 150,000) | 23.8 (10,062) | 0.06 (31) | 0.08 (39) | 0.02 (38) | 24.3 (10,062) |
  | deep page, oldest first | 23.1 (10,062) | 0.09 (29) | 0.07 (32) | 0.02 (30) | 26.2 (10,062) |
  | page inside 5,000 files of one instant | 20.6 (10,062) | 0.92 (412) | 1.37 (409) | 0.02 (6) | 24.3 (10,062) |
  | index size | | 3.4 MB | 17.1 MB | 17.1 MB | 5.7 MB |

  One owner's listings are in `M11-L6`. Every existing statement keeps its plan and its time under every candidate:
  `api.files` (`owner_status_created_at_idx`, 0.05 ms for the owner of 15,898 files, 0.02 ms for a small one), the
  sweep's `expire` (3.6 to 4.5 ms) and `cleanup` (0.74 to 1.02 ms), `revoke`, `reconcile` and the supersede lookup,
  with one exception, the listing of one owner in several statuses, which `M11-L6` fixes. The statement also runs
  under a forced generic plan (a prepared statement) on the same index.

  SQLite, the same listings, milliseconds:

  | Listing | no new index | `(created_at)` | `(created_at, id)` |
  | --- | --- | --- | --- |
  | every owner, newest | 15.6 | 0.11 | 0.09 |
  | `limit` 1000 | 20.4 | 1.14 | 1.08 |
  | name in 12% of the files | 23.9 | 0.24 | 0.22 |
  | name in 0.05% | 22.4 | 53.9 | 53.7 |
  | deep page (from row 150,000) | 17.1 | 0.11 | 0.10 |
  | page inside 5,000 files of one instant | 18.2 | 1.04 | 0.09 |
  | one owner (15,898 files) | 5.04 | 5.08 | 5.09 |
  | `api.files`, the same owner | 0.11 | 0.11 | 0.11 |
  | sweep `expire` / `cleanup` | 5.11 / 0.86 | 5.11 / 0.78 | 5.07 / 0.78 |
  | index size | | 4.4 MB | 8.1 MB |

- **Why:** `(created_at)` turns every listing whose options most files match from a read and sort of the table into a
  read of about one page, on both databases, at a fifth of the size of the next candidate on Postgres. Postgres reads
  it with an incremental sort, so the id only orders the few rows of one instant. `(created_at, id)` buys nothing on
  Postgres: the listing orders ids in byte order (`COLLATE "C"`), which an index in the database's own collation
  cannot serve, so the planner uses it exactly as it uses `(created_at)` and it is five times larger. The `COLLATE "C"`
  form does serve it and wins inside a large tie (0.02 against 0.92 ms for 5,000 files of one instant), but Prisma's
  schema cannot declare a collation on an index column, so its users could not have it from their models, and a
  tie is normally the files of one `/upload`, at most `maxFiles` of them. `(status, created_at)` helps only listings with a status
  (rare ones most) and leaves the listing without one at 33 ms; as a second index it would cost every upload two more
  index writes for an admin screen. On SQLite `(created_at, id)` is the better index only inside a large tie, at
  nearly twice the size; one definition for every adapter is worth more than that.
- **If wrong:** two costs are stated in the guide's known costs. A search that almost no file matches reads every file
  through the index, slower than the read and sort it replaces (0.3 to 0.5 s against 0.16 s on Postgres, 54 against
  22 ms on SQLite): the planner assumes a third of the rows match a `strpos`, and no index serves a substring. And a
  page inside a very large tie sorts the tie (0.9 ms for 5,000 files). An app whose imports write tens of thousands of
  files to one instant, or that searches narrowly and often, adds an index of its own (`(created_at, id COLLATE "C")`,
  a trigram index); the store's statements do not stop it from being used.
- **Status:** in force. `src/testing/db/fixtures.db.integration.test.ts` pins the index on both dialects, and the
  Drizzle and Prisma lanes diff their schemas against the DDL.
- **Visible in:** `src/testing/db/schema.ts`, `src/adapters/drizzle/*-tables.ts`,
  `src/testing/db/prisma/*/cloudrop.prisma`, `docs/guide/store.md`, `examples/next/lib/cloudrop-tables.sql`,
  `examples/hono/drizzle/20261121174715_all_files_index/`.

### M11-L6: one owner in several statuses is never read along `created_at`

- **Decision:** When a listing names an owner and not exactly one status (`api.allFiles({ owner })`, and `list` with
  several statuses, which is `eraseOwner`'s), the statement orders by an expression no index has
  (`created_at + interval '0'` on Postgres, `+created_at` on SQLite) instead of the column. The rows, their order and
  the cursor are the same; only the plan is fixed: the owner's rows are found through
  `owner_status_created_at_idx` and sorted. An owner with exactly one status keeps the plain order, which that index
  serves directly.
- **Why:** the new index gave Postgres a second way to read these listings: walk `created_at` from the newest row and
  keep the owner's, which it prices as if the owner's rows were spread evenly in time. It chose that for
  `eraseOwner`'s existing listing as soon as the index existed (an owner of 4,297 files: 1,022 buffers before, 1,889
  after). For an owner whose files are all old, the account an erasure usually meets, the walk passes every newer row
  of every other owner first. Measured, an owner of 6,000 files older than the other 303,322: `eraseOwner`'s listing
  7.2 ms and 2,442 buffers without the index, 51.9 ms and 68,931 buffers with it, for every page, growing with the
  table; `api.allFiles({ owner })` 6.6 ms and 2,700 buffers against 55.8 ms and 68,931. With this ruling, measured
  through the store, they read 2,436 and 2,694 buffers in about 2 ms whether the index exists or not: the plan of 0.5. The cost is the best
  case: an owner of 15,898 recent files without a status is 5.3 ms sorted against 0.2 ms walked. A bounded 5 ms was
  chosen over a fast case that can turn into a read of the table. A materialized CTE gives the same plan but copies
  the rows first (15.7 ms for that owner).
- **If wrong:** an owner with hundreds of thousands of files listed without a status sorts them all for each page;
  passing a `status` reads one page from the index (0.05 ms).
- **Status:** in force. `src/store/sql/list-all.db.integration.test.ts` builds 22,000 rows with such an owner and
  fails when the order is the plain column (fault probe: it then reads `created_at_idx`).
- **Visible in:** `src/store/sql/reads.ts` (`listedBy`), `src/store/sql/list-all.db.integration.test.ts`.

### M11-L7: on SQLite a listing of every owner always walks `created_at`

- **Decision:** On SQLite and D1, when a listing names no owner, its `status` and `route` conditions are written
  `+status` and `+route`, which keeps SQLite's planner off the indexes that start with those columns, so the rows are
  read along `created_at_idx` and each is checked. Postgres gets the plain conditions and chooses by its statistics.
- **Why:** SQLite has no per-value statistics (with or without `ANALYZE` it chose the same plans), and it prefers an
  index with an equality to one that gives the order: it read every row of the status or the route and sorted them.
  Measured, a page of 100, before and after the `+`: status `completed` 23.5 → 0.12 ms, status `pending` 4.1 → 0.86
  ms, a route with 59% of the files 32.5 → 0.12 ms, `completed` on one route 22.5 → 0.19 ms. Without this the new
  index would not serve the most common admin listings on SQLite at all, and D1 bills the rows a statement reads.
- **If wrong:** the walk is the wrong plan when very few files match: status `completing` (314 files) 0.20 → 22.4 ms,
  a route with 23 files 0.03 → 72 ms, one read of the table through the index. An app that lists a nearly empty
  status or route on a large D1 database pays for the rows read; the guide says so.
- **Status:** in force. `src/store/sql/list-all.db.integration.test.ts` reads SQLite's plan for the store's own
  statements and fails without the `+` (fault probe: `status_cleaned_at_ended_at_idx (status=?)`).
- **Visible in:** `src/store/sql/reads.ts` (`offItsIndex`), `docs/guide/store.md#known-costs`.

### M11-L8: a database without the index still answers; the guide gives the statement per adapter

- **Decision:** No statement names the index, so `api.allFiles` answers the same pages on a 0.5 schema, by reading and
  sorting the table (measured through the store, Postgres: 16 to 32 ms a page, 162 ms with a name, against 0.04 to
  1.2 ms with the index; one owner's listings are the same either way). The guide's "Upgrading from 0.5" gives the
  statement for each adapter: plain SQL `CREATE INDEX "cloudrop_files_created_at_idx" ON "cloudrop_files"
  (created_at);` on both dialects; Drizzle, whose tables declare it, where `drizzle-kit generate` writes `CREATE INDEX
  "cloudrop_files_created_at_idx" ON "cloudrop_files" ("created_at");` without a question (run for the Hono example);
  Prisma, `@@index([createdAt])` in the model, where `prisma migrate` writes `CREATE INDEX
  "cloudrop_files_created_at_idx" ON "cloudrop_files"("created_at");` (both read from the tools' output). On a large
  Postgres table: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` by hand first, then `IF NOT EXISTS` in the migration.
- **Why:** as `M8-A2`: an upgrade must not break an app that has not migrated, and an app that never calls
  `api.allFiles` may skip the index. Unlike `M8-A2` nothing is dropped, so drizzle-kit has nothing to ask.
- **If wrong:** an app that calls `api.allFiles` on a large table before migrating gets slow pages, not wrong ones.
- **Status:** in force. `src/store/sql/list-all.db.integration.test.ts` drops the index on Postgres and SQLite and
  compares the pages.
- **Visible in:** `docs/guide/store.md#upgrading-from-05`, `src/store/sql/list-all.db.integration.test.ts`.

### M11-L9: what `api.allFiles` adds to each entry

- **Decision:** No ceiling changes. Measured gzip, before → after: `cloudrop` bundled 31.32 → 31.70 kB (+1.2%, ceiling
  32), `cloudrop` summed 42.47 → 42.88 kB, `adapters/sql` 12.17 → 12.43 kB, `adapters/drizzle` 13.89 → 14.17 kB,
  `adapters/prisma` 11.65 → 11.91 kB, `cloudrop/testing` 13.35 → 13.41 kB; `cloudrop/next`, `cloudrop/node`,
  `cloudrop/plugins`, `cloudrop/client` and `cloudrop/react` unchanged. No entry grew by 5%.
- **Why:** the listing reuses `api.files`'s option readers, cursor reader, page check and store statement; what it
  adds is its own options (owner, status), the cursor mark, three messages and the two plan rulings above. The filter
  readers moved to `src/server/files-filters.ts` to keep `owner-files.ts` near 200 lines.
- **If wrong:** the bundled server entry has 0.30 kB left under its ceiling for the rest of 0.6.0.
- **Status:** in force.
- **Visible in:** `scripts/size-limit.config.ts` (unchanged), `bun run package:check`.
