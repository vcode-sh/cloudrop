# M12-T: types that need no guards

Rulings for the types 1.0 freezes: `FileRecord` as a union by status, route names and store methods in the types, typed
`auth` in plugins and a typed deletion `context`, designed in `docs/superpowers/specs/2026-11-22-1.0.0-design.md` §3.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-T1: a file's record is a union by status, and the store contract proves it on every backend

- **Decision:** `FileRecord<R>` is the union of `PendingRecord`, `CompletingRecord`, `CompletedRecord`,
  `DeletedRecord`, `AbortedRecord`, `ExpiredRecord`, `RejectedRecord` and `FailedRecord`, each fixing which of
  `claimedAt`, `completedAt`, `endedAt`, `cleanedAt` and `result` are set, as spec 1.0 §3b's table gives them.
  `FailedRecord` has two shapes: never started (`claimedAt` null) and a stuck completion (`claimedAt` and `cleanedAt`
  set, as the sweep ends it cleaned). `RecordOf<S, R>` extracts one status or a union of them. The types live in
  `src/server/file-record.ts` with the statuses and `NewFile`, re-exported from `src/server/store.ts`, `cloudrop` and
  `cloudrop/store`. Both stores' `toRecord` cast the mapped row to the union; the runtime is unchanged. There are no
  database CHECK constraints for the table (spec §3b). The store contract wraps every target's store and table reader
  (`checkedStore`, `checkedTables` in `src/testing/store-contract/well-formed.ts`) so `expectWellFormed` checks every
  record a case reads, through the store's `get`, `claim`, `complete`, `end`, `stale`, `list` and `listAll` (inside a
  transaction too) and past it, with one `toEqual([])` over named violations such as `"f-1: completed without
  completedAt"`. Writing it found one mismatch, in the suite and not a store: `advance` took a pending row straight to
  `rejected`, a row the server never makes (a refusal claims the row first, `store-complete.ts`), so it now goes
  through `completing` like the server.
- **Why:** spec §3b: an app reading `record.completedAt` of a completed file wrote a guard for a `null` that cannot
  happen. The table is derived from the store's writes and the server's transitions; a cast is only honest with a
  check of every backend's rows behind it.
- **If wrong:** a hand-written store that writes another shape compiles and lies to its callers; the contract suite,
  which such a store should run, names the row. A new transition that breaks the table fails the oracle on every
  lane before release; the fix is a new member of the union, which is a breaking type change after 1.0.
- **Status:** in force.
- **Visible in:** `src/server/file-record.ts`, `src/store/sql/records.ts`, `src/testing/memory-store-reads.ts`,
  `src/testing/store-contract/well-formed.ts`, `src/testing/store-contract.ts`, `src/testing/store-contract/suite.ts`,
  `src/server/types.test.ts`.

### M12-T2: route names are a type, and a retired route stays declared until its rows are erased

- **Decision:** `route` on every record `api` answers, and the `route` filter of `api.files` and `api.allFiles`, is
  the server's route names, `keyof TRoutes & string`, threaded as `R` through `StoreFileApi<R>`, `FilesOptions<R>`,
  `AllFilesOptions<R, S>` and the records. A row of a route that was removed is still typed as one of the current
  names: the guide (written later in 1.0) says to keep a retired route declared, with an `authorize` that refuses,
  until its rows are erased. No new exported `RouteName<TRoutes>`: the name is taken by `RouteName<TCloudrop>` of
  `cloudrop` and `cloudrop/client`, which gives the same names from the server's type, so `cloudrop.ts` writes
  `keyof TRoutes & string` where it needs them.
- **Why:** spec §3c: a typo in a route filter was a runtime `INVALID_INPUT`, and a `switch (record.route)` had no
  exhaustiveness. The filter is already refused at runtime for a name the server lacks, so the type says what the
  runtime enforces.
- **If wrong:** an app that removed a route without erasing its rows reads `route` values its type does not list; the
  runtime answers them as they are. Widening `R` back to `string` is a type-only change.
- **Status:** in force.
- **Visible in:** `src/server/cloudrop.ts`, `src/server/store-api.ts`, `src/server/owner-files.ts`,
  `src/server/all-files.ts`, `src/server/types.test.ts`.

### M12-T3: `api` has the store's calls only when a store is surely configured

- **Decision:** `createCloudrop` gains `TStore`, inferred from `store`, and `Cloudrop<TRoutes, TStore = undefined>`
  types `api` as `StoreFileApi<R>` when `[TStore] extends [CloudropStore<unknown>]`, otherwise as `FileApi`.
  `FileApi` is now the storage calls alone (`getUrl`, `head`, `put`, `delete`, `deleteMany`, `copy`, `deletePrefix`,
  `checkBucket`); `StoreFileApi<R>` extends it with `file`, `files`, `allFiles`, `usage`, `revokeUploads`,
  `deleteFile`, `eraseOwner`, `reconcile` and `sweep`. A store that may be undefined (`store: flag ? s : undefined`)
  gives the store-less `api`. The parameter is `CloudropOptions<TRoutes> & ({ store?: undefined } | { store: TStore })`
  rather than `{ store?: TStore }`: inference through an optional property drops the `undefined` of
  `flag ? s : undefined`, which would type the store's calls on a server that may have none. At runtime nothing
  changes: a store-less server keeps one stub per store call (`withoutStore` in `api.ts`) answering `INVALID_CONFIG`,
  for JavaScript callers, and `createCloudrop` casts the full api to the conditional type.
- **Why:** spec §3c: on a stateless server `api.files` compiled and answered `INVALID_CONFIG` at runtime; leaving out
  `store` should say so in the editor.
- **If wrong:** code that holds a `Cloudrop` or a `FileApi` and calls a store method breaks at compile time; it names
  `Cloudrop<typeof routes, typeof store>` or `StoreFileApi` instead. A wrapper that passes the store through an
  `options` object typed `CloudropStore | undefined` loses the store's calls in the type; it passes the store itself.
- **Status:** in force.
- **Visible in:** `src/server/cloudrop.ts`, `src/server/api.ts`, `src/server/store-api.ts`,
  `src/server/types.test.ts`.

### M12-T4: a listing page is typed by its records, and `api.allFiles` by the status asked for

- **Decision:** `FilesPage<TRecord extends FileRecord = FileRecord>` carries the record type rather than the route
  names: `api.files` answers `FilesPage<CompletedRecord<R>>`, and `api.allFiles<S>({ status?: S })` answers
  `FilesPage<RecordOf<S, R>>`, `S` defaulting to every status. `listPage` casts its page to `TRecord` after its own
  check (`answersQuery`) has refused any record outside the status asked for, so the cast rests on a runtime check of
  every page, not only on the store.
- **Why:** the brief left the shape of `FilesPage` open. One parameter for the record says what the items are for
  both listings; a `FilesPage<R, S>` would have repeated the status logic of `RecordOf`.
- **If wrong:** an explicit type argument without the matching option (`api.allFiles<"failed">()`) types every status
  as failed; that is the caller's assertion, like any explicit type argument. Changing the parameter after 1.0 is a
  breaking type change.
- **Status:** in force.
- **Visible in:** `src/server/owner-files.ts`, `src/server/all-files.ts`, `src/server/store-api.ts`.
