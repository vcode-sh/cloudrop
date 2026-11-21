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
