# M10-D: delete hooks and file filters

Rulings for the `onDelete` route hook and the `api.files` filters, designed in
`docs/superpowers/specs/2026-11-21-0.4.0-design.md`. Entries continue from 1.

### M10-D1: `api.files` filters by name and type, newest or oldest first, identically on every backend

- **Decision:** `api.files` takes `name`, `type` and `order`, and the store's `list` takes `name`, `type` (null for
  none) and `order` (`"newest"` or `"oldest"`). `name` is a substring search, `strpos` on Postgres and `instr` on
  SQLite, not `LIKE`, so `%` and `_` mean themselves with no escaping; both sides fold ASCII letters only, with
  `translate(name, 'A…Z', 'a…z')` on Postgres and `lower` on SQLite. `api.files` normalizes the name to NFC, as
  `/upload` stores names, accepts at most 255 characters without NUL, and reads `""` as no filter. `type` is exact, or
  with a trailing slash (`"image/"`) a prefix; it is lowercased and must be a type or a top-level type with its slash
  (`"image/*"` is refused with a message naming `"image/"`). `"oldest"` orders by `created_at`, then id, ascending, ids
  in byte order like `"newest"`. The store contract runs the same cases on Postgres, SQLite (node:sqlite and the Drizzle
  and Prisma adapters), D1 and the memory store.
- **Why:** the pilot filtered with `ilike` and its own escaping (`vstack/packages/storage/src/owner-files.ts`), which
  on Postgres folds non-ASCII letters by the database's locale while SQLite's `LIKE` folds ASCII only, so one search
  could answer different files per backend. A substring function needs no escape character, which `LIKE` on D1 and
  Postgres would each need spelled out. SQLite's `lower` folds ASCII only unless the ICU extension replaces it.
- **If wrong:** an app that loads SQLite's ICU extension gets Unicode case folding there; the contract case "Ä" against
  "ä" shows it. A custom `CloudropStore` written for 0.3 still compiles and ignores the new fields, answering
  unfiltered pages, until it implements them.
- **Status:** in force.
- **Visible in:** `src/server/owner-files.ts`, `src/server/store.ts`, `src/store/sql/reads.ts`,
  `src/testing/memory-store-reads.ts`, `src/testing/store-contract/list-filters.ts`, `docs/guide/store.md`.

### M10-D2: a cursor belongs to its listing

- **Decision:** A cursor of a listing with a `route`, `name`, `type` or `"oldest"` order is `<fingerprint>.<store
  cursor>`, the fingerprint eight hex digits of FNV-1a over the JSON of `[route, name, type, order]` after
  normalization. The default listing (no filter, newest first) keeps the plain `<milliseconds>:<id>` of 0.3. A cursor
  passed with other options than the page that made it is refused with `INVALID_INPUT`: "cursor belongs to a listing
  with another route, name, type or order. Pass the options of the page that returned it, or leave cursor out to start
  again."
- **Why:** the keyset position means nothing in another order, and silently in another filter: a page would skip or
  repeat files. The owner is left out, as in 0.3. A 0.3 cursor of an unfiltered listing still pages across the deploy;
  one of a route-filtered listing is refused once, and the page starts again. A hash is not a signature: a caller who
  forges a cursor only pages their own owner's files from another position.
- **If wrong:** two listings whose fingerprints collide (one in 2^32) accept each other's cursors, as 0.3 did for all.
- **Status:** in force.
- **Visible in:** `src/server/owner-files.ts`, `src/server/store-api.test.ts`.

### M10-D3: no new index and no migration

- **Decision:** 0.4.0 adds no index. The `(owner, status, created_at)` index of 0.2.0 reads an owner's completed files
  in either order; `route`, `name` and `type` are checked on each row it finds.
- **Why:** listings stay per owner (listing across owners is out of scope), and an index cannot serve a substring
  search anyway. The cost is stated in the guide's known costs: a narrow search over an owner with very many files
  reads them all to fill a page.
- **If wrong:** an app with owners of very many files and frequent searches adds its own index (such as a trigram one
  on Postgres); the store's statements do not stop it from being used.
- **Status:** in force.
- **Visible in:** `docs/guide/store.md#known-costs`.

### M10-D4: `onDelete` runs for a completed file that becomes `deleted`, with the row as it was

- **Decision:** A route callback `onDelete({ file, owner, reason })`, `reason` one of `"deleted"` (`api.deleteFile`),
  `"replaced"` (a `replace: true` completion) and `"erased"` (`api.eraseOwner`). It runs only when a `completed` row
  becomes `deleted`; `/abort`, `revokeUploads`, refusals and the sweep end rows that never completed and run nothing,
  and `api.delete(key)` touches no row. `file` is the `FileRecord` as it was before the deletion (`status:
  "completed"`, `endedAt: null`); `owner` is `file.owner`. The hook is the one of the route the row names; a row whose
  route is no longer configured is deleted without one. It needs a store (`INVALID_CONFIG` otherwise, like `owner` and
  `afterComplete`) and must be a function. Its context is typed like `onComplete`'s: `WithExtra<DeleteContext,
  TExtra>`, so a store's `route()` adds `tx` and a plain `route()` does not. `DeleteContext` and `DeleteReason` are
  exported from `cloudrop`.
- **Why:** the pilot wrote its own deletion path (`vstack/packages/storage/src/deletion.ts`) to keep an audit row and
  its avatar pointer in step with `deleteFile` and `replace`. The row before the deletion is the same shape for every
  reason: a replaced file's record comes back from the store already `deleted`, while `deleteFile`'s hook runs before
  the row changes (`M10-D5`), so the context reports the one state every caller saw. The design names `owner` beside
  `file` so a hook can destructure it.
- **If wrong:** a hook that needs the deletion time reads `new Date()`; the row's `endedAt` is written after it.
- **Status:** in force.
- **Visible in:** `src/server/route.ts`, `src/server/store.ts`, `src/server/store-delete.ts`,
  `src/server/store-config.ts`, `src/server/route-config.ts`, `docs/guide/store.md#ondelete`, `docs/guide/server.md`.

### M10-D5: with a transaction, `onDelete` runs before cloudrop's locks and commits exactly once

- **Decision:** On a store with `transaction`, `deleteFile` and `eraseOwner` delete each file in its own transaction:
  read the row, run `onDelete` with `tx`, then `end(completed → deleted)`. When `end` finds the row no longer completed
  (another deletion committed first), the transaction rolls back, so only one deletion's writes ever commit. A
  replacing completion, inside its transaction and after `onComplete`, lists the owner's completed files on the route,
  runs `onDelete` for each, then records the completion; when the files it replaced are not exactly the ones listed
  (another call deleted or completed one in between), it rolls back and answers the retryable unfinished error, and the
  client's retry runs again. A throw rolls the whole completion back, `onComplete`'s writes included. When `onDelete`
  throws and the file turns out to be deleted after all (the hook lost a race, such as on a duplicate audit row), the
  caller answers as for a file already deleted.
- **Why:** `end` locks the file row and then the owner's usage row; a completion locks its own row, runs `onComplete`
  (the app's locks), then the replaced rows and the usage row. Run after `end`, an `onDelete` that writes a row
  `onComplete` also writes (a per-user counter, the user row) waits for that row while holding the usage row the
  completion waits for: measured on Postgres 18 through Drizzle on both drivers, a fault probe that moved the hook after
  `end` failed the case in `drizzle-handler.db.integration.test.ts` with `40P01 deadlock detected` after Postgres's 1 s
  `deadlock_timeout`. Run first, the app's locks come before cloudrop's in every path and the two take turns (the case
  passes). The first version ran a replacing completion's `onDelete` after `store.complete`, with the replaced row
  already locked, which the review showed deadlocks against a `deleteFile` of that file when `onDelete` writes a row
  keyed by the file (the guide's own pointer example); listing first gives every path one order.
- **If wrong:** a replacing completion that races another completion or a deletion of the owner's files on the route
  is answered with a retry more often than before; each retry lists again.
- **Status:** in force.
- **Visible in:** `src/server/store-delete.ts`, `src/server/store-complete.ts`,
  `src/adapters/drizzle-handler.db.integration.test.ts`, `src/server/store-delete.test.ts`, `docs/guide/store.md`.

### M10-D6: without a transaction, `onDelete` runs before the deletion, at least once

- **Decision:** Under a lease (SQLite, D1, Postgres without `transaction: true`) `deleteFile` and `eraseOwner` read the
  row, run `onDelete`, then `end` it; a throw keeps the file, unless another deletion took it meanwhile (`M10-D5`). A
  replacing completion, after `onComplete`, lists the owner's completed files on the route, runs `onDelete` for each,
  then records the completion; a throw hands the claim back and records nothing. A file that completed in between is
  replaced too, and its `onDelete` runs right after the record, where a throw is only logged.
- **Why:** this is `onComplete`'s rule under a lease (`M5`): before the record, so a throw keeps things as they were,
  and at least once. A completed row has no claim to hold, so two deletions of one file at once can both run the hook,
  and a deletion that fails after it (a database error, a replacing completion whose record fails or loses its lease)
  runs it again on the retry, or leaves the file with a hook run for it. Running it after the record instead would
  skip it on a crash and could not keep the file on a throw.
- **If wrong:** an app that needs exactly once uses `transaction: true` on Postgres, or makes the hook idempotent by
  `file.id`, as the guide says. One gap remains, stated in the guide: the late file's `onDelete` runs after the record,
  so a crash, or a database answer lost after the commit, between the two skips it.
- **Status:** in force.
- **Visible in:** `src/server/store-delete.ts` (`deleteCompleted`, `beforeReplacing`, `afterReplacing`),
  `src/server/store-complete.ts` (`withLease`), `docs/guide/store.md#ondelete`.

### M10-D7: what each caller answers when `onDelete` throws

- **Decision:** The throw is logged as `cloudrop: onDelete failed for route "<route>" while deleting file <id>.` with
  the error, and the file stays completed with its bytes and object. `api.deleteFile` answers a retryable
  `SERVER_ERROR`: "onDelete failed for route "<route>", so the file was kept. Its error is in the server log; fix it and
  try again." `api.eraseOwner` counts the file in `failed` (and in `waiting`, as it is still completed), goes on with
  the next file and reports `done: false`. A replacing `/complete` answers the retryable `SERVER_ERROR` a throw in
  `onComplete` gives ("The file was uploaded, but the server could not finish processing it. Try again in a moment."),
  and the client's retry runs the hooks again.
- **Why:** each caller already has a way to report a file it could not handle: `deleteFile` an error, `eraseOwner`
  its counters, `/complete` the unfinished answer. Retryable, as the hook's own failure is often a database or network
  blip; the message names the route and points at the log, never the thrown error, which may hold anything.
- **If wrong:** a caller that must tell a hook's failure from the store's reads the message or the log.
- **Status:** in force.
- **Visible in:** `src/server/store-delete.ts`, `src/server/store-delete.test.ts`, `docs/guide/store.md#ondelete`.

### M10-D8: a server without `onDelete` deletes as 0.3 did

- **Decision:** When no route has `onDelete`, `deleteFile` and `eraseOwner` make exactly the store calls of 0.3 (one
  `end` per file, no read and no transaction), and a replacing completion lists nothing.
- **Why:** the hook costs a read and, in transaction mode, a transaction per file; apps that do not use it should not
  pay that, and their behaviour, M9-H52's measured waits included, stays as recorded.
- **If wrong:** none known.
- **Status:** in force.
- **Visible in:** `src/server/store-delete.ts`.

### M10-D9: the Hono example keeps its avatar route as it is

- **Decision:** `examples/hono` does not use `onDelete`.
- **Why:** the brief allowed it only if it removed code. Its avatar pointer is cleared by one statement in the delete
  RPC; an `onDelete` would be three lines more in the route for one fewer in the router.
- **If wrong:** none; the example may adopt it once it has a reason to, such as an audit trail.
- **Status:** in force.
- **Visible in:** `examples/hono/src/uploads.ts`, `examples/hono/src/rpc/router.ts`.

### M10-D10: the bundled server budget goes from 30 to 32 kB (for owner confirmation)

- **Decision:** `scripts/size-limit.config.ts` raises the "cloudrop (bundled)" ceiling from 30 kB to 32 kB. Measured
  gzip, 0.3.0 → this change: `cloudrop` bundled 29.55 → 30.77 kB (+4.1%), `cloudrop` summed 39.76 → 41.63 kB (+4.7%),
  `adapters/sql` 11.86 → 12.17 kB, `adapters/drizzle` 13.58 → 13.89 kB, `adapters/prisma` 11.33 → 11.65 kB,
  `cloudrop/testing` 13.18 → 13.35 kB; `cloudrop/client`, `cloudrop/react`, `cloudrop/next` and `cloudrop/node`
  unchanged. Every other ceiling stays.
- **Why:** `M4-F24` set the ceilings with a wide margin for the store and plugins, and 0.3.0 left 0.45 kB of it on the
  bundled server. `onDelete` (its transaction and lease paths, and the replacing completion's) and the filters with
  their checks and messages add 1.22 kB; none of it is dead weight an app could drop, as every export ships in this
  budget. No entry grew by 5% or more.
- **If wrong:** the owner sets another ceiling; nothing depends on this number.
- **Status:** in force until the owner confirms or changes it.
- **Visible in:** `scripts/size-limit.config.ts`.
