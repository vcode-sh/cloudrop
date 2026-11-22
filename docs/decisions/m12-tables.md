# M12-Q: the tables are a contract

Rulings for the columns of `cloudrop_files` and `cloudrop_usage` that 1.0 guarantees for an app's own reads under
semver, and what stays internal, designed in `docs/superpowers/specs/2026-11-22-1.0.0-design.md` §7.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-Q1: the guaranteed columns, and how an app reads them

- **Decision:** an app may read `cloudrop_files` and `cloudrop_usage` with its own SQL, and these columns keep their
  names, types and meaning across 1.x: on `cloudrop_files`, `id` (a ULID that sorts by creation to the millisecond),
  `route`, `key`, `owner`, `status`, `name`, `type`, `size`, `metadata`, `result`, `claimed_at`, `expires_at`,
  `created_at`, `completed_at`, `ended_at` and `cleaned_at`, each set per status as `M12-T1`'s table says; on
  `cloudrop_usage`, `owner`, `reserved_bytes`, `active_bytes`, `files`, `erase_requested_at` and `erased_at`. Removing
  or renaming one, changing its type or what it holds, is a major release. A minor may add a column, an index or a
  value of `status`, as the stability policy lets a union grow, so the guide tells queries to list the statuses they
  want. `updated_at` is guaranteed only to exist and move on writes, never as a watermark. `upload_id`, `claim`,
  `request_key` and the index names are internal; that the indexes of the guide's DDL exist on their columns is
  guaranteed. The guide's "Your own queries" gives the reading rules (one snapshot per statement, SQLite times in
  integer milliseconds, `bigint` as text from the Postgres drivers, order by `created_at, id`, NFC keys and names,
  owner-less rows) and five recipes, each runnable on Postgres and on SQLite or D1: an admin inventory joined with the
  app's users and its next page, stuck completions (`failed` with `claimed_at`), the failures of the last day, usage per
  owner, and the anti-join for owners who no longer exist, followed by a loop over `eraseOwner`. Every SQL block of the
  section carries a `<!-- recipe:<name>[:<dialect>] -->` marker; `recipes.db.integration.test.ts` reads each block by
  its marker and runs it as printed on Postgres 18 and `node:sqlite`, on rows the store's own methods write, against
  hand-written ids, and fails when the guide has a marker it does not run.
- **Why:** spec 1.0 §7. The pilot's admin inventory, usage page and stuck-completion check all query the tables, and
  the withdrawn `api.allFiles` filters and `owners` hook (spec 1.0, "Withdrawn") leave such joins to the app's SQL; that
  is safe only when the columns are a promise. Reading the blocks from the page, as `schema.test.ts` does for the DDL,
  keeps the copy people paste and the copy the lane runs one text.
- **If wrong:** a column that must change waits for 2.0, or a new column carries the new meaning beside the old. A
  recipe that is slow on a large table is a documented cost (the inventory's search reads in upload order), not a
  wrong answer; the guide names the app's own index as the fix.
- **Status:** in force.
- **Visible in:** `docs/guide/store.md` ("Your own queries"), `src/store/sql/recipes.db.integration.test.ts`.

### M12-Q2: the only delete an app may run is a retention purge

- **Decision:** an app never inserts or updates a row of either table and never deletes a usage row: the usage row
  holds the quota counters and the erase mark, and deleting it lets a marked owner upload again. Drift is fixed with
  `api.reconcile`. Two deletes are allowed, both given as SQL in the guide and run by the recipe lane: the purge of
  ended rows proven clean before a cutoff of at least a day ago, `status IN ('aborted', 'rejected', 'expired',
  'deleted') AND cleaned_at < $1`, and, once an owner's erasure is finished, the rows of that owner
  (`owner IN (SELECT owner FROM cloudrop_usage WHERE erased_at IS NOT NULL)`), its usage row kept. `failed` rows are
  never purged, since a stuck completion's row is the only record of the object the sweep keeps, and neither is a row
  without `cleaned_at`, which the sweep still needs to remove a late `PUT`.
- **Why:** spec 1.0 §7 ("Never write"). A day after `cleaned_at` no upload token naming the row is valid any more (a
  token lives 24 hours from `/upload`, before `cleaned_at`), so a purged row can only be missed by a `/complete` that
  would have been refused anyway; every other write is the store's, whose counters and transitions assume no other
  writer.
- **If wrong:** an app that purged earlier than a day answers a late `/complete` of a deleted file `UPLOAD_EXPIRED`
  instead of its stored answer. A purge of `failed` rows would leave an object no sweep reaches; the guide's statement
  excludes them, and the lane proves it.
- **Status:** in force.
- **Visible in:** `docs/guide/store.md` ("Never write"), `src/store/sql/recipes.db.integration.test.ts`.
