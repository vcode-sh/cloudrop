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

### M12-T5: a plugin is typed by the authorize result it reads, and every hook gets the token's JSON snapshot

- **Decision:** `CloudropPlugin<TAuth = unknown>`, `ServerHooks<TAuth>` and the three hook contexts type `auth` as
  `Jsonified<TAuth>`. The plugin carries a type-only `readonly "~auth"?: (auth: Jsonified<TAuth>) => void`, a function
  property, so it is checked contravariantly where the hooks, written as methods, are bivariant. `Route` gains `TAuth`
  (`Route<TMetadataInput, TResult, TAuth = object, TDeleted, TErased>`), which `route()` and a store's `route()` fill
  from `authorize`, and `CloudropOptions.plugins` is `readonly NoInfer<CloudropPlugin<AuthOf<TRoutes>>>[]`, where
  `AuthOf` (`src/server/route-types.ts`) is the union of every route's result. A `CloudropPlugin<{ userId: string }>`
  beside a route with `authorize: allowAnyone` is a type error; `CloudropPlugin` alone, and `contentChecks()`, fit
  every server. `NoInfer` wraps the whole plugin type, not only `AuthOf`: inside it, an inline plugin's hook was typed
  from a merged object (`{ userId: string; since: never; teamId: never }`) instead of the union. At runtime
  `handleUpload` passes `beforeUpload`, and the `onAbort` of files it ends, a second parse of the JSON it signs into
  the token (`pluginAuth` in `upload.ts`), so a hook that writes to `auth` cannot change the token that `afterVerify`,
  `onComplete` and `/abort` trust; `afterVerify` and the `onAbort` of `/abort` and `/complete` already read the token.
  To make the check possible, `Jsonified<T>` now uses `T` only as the type being checked: its first branch
  `unknown extends T ? unknown` is gone (an `unknown` now reaches a last branch that answers `unknown`), and `void`
  is handled as `undefined` is, so an `onComplete` that returns nothing still sends `null`. With `T` on the other side
  of a conditional, TypeScript could not relate `Jsonified<A>` to `Jsonified<B>` (prototyped: `Ctx<object>` was not
  assignable to `Ctx<unknown>`), and the check would have refused even `contentChecks()`.
- **Why:** spec 1.0 §3a: `auth` was `unknown`, which forced the pilot's `isUploadActor` guard, and the same plugin
  saw a `Date` in `beforeUpload` and its ISO string in `afterVerify`, so no one type was true in every hook.
- **If wrong:** a plugin whose `beforeUpload` read a `Date`, a `Map` or a class instance from `auth` now reads its JSON
  form; it reads what `afterVerify` always read. `Jsonified<any>` is now `any` rather than `unknown`: an `authorize`
  typed `any` gives `any` in `onComplete`, which is what `any` asks for. A plugin typed for a field only some routes
  have must narrow inside its hooks; typing it `CloudropPlugin` restores `unknown`.
- **Status:** in force.
- **Visible in:** `src/server/plugins.ts`, `src/server/route.ts`, `src/server/route-types.ts`, `src/server/config.ts`,
  `src/server/upload.ts`, `src/protocol/types.ts`, `src/server/store-types.test.ts`, `src/server/plugins.test.ts`,
  `fixtures/consumer-types/app.ts`, `scripts/check-package.sh`.

### M12-T6: the deletion context is declared per route, by annotating `onDelete`'s parameter

- **Decision:** `DeleteContext<TDeleted = unknown, TErased = TDeleted>` is `DeleteBase` (`file`, `owner`) and a union
  by `reason`: `"deleted"` carries `context: TDeleted`, `"erased"` `context: TErased`, and `"replaced"`
  `context: undefined` with `request: Request`. `route()` and a store's `route()` infer `TDeleted` and `TErased` from
  the annotation of `onDelete`'s parameter (`({ context }: DeleteContext<FileDeleter, undefined>) => ...`) and carry
  them on `Route`. `Cloudrop["api"]` is `StoreFileApi<R, DeletedOf<TRoutes>, ErasedOf<TRoutes>>`, each the
  intersection of what the routes declare (read through a parameter position); a route without an annotation adds
  `unknown`. `deleteFile(id, ...options)` and `eraseOwner(owner, ...options)` take their options as an optional tuple
  element when the context admits `undefined` and a required one otherwise, and `context` inside them follows the same
  rule (`ContextOption` in `delete-context.ts`). `DeleteFileOptions<T>` and `EraseOptions<T>` are now type aliases.
  `WithExtra` in `route.ts`, which adds a store's `tx`, is a plain intersection without `Omit`: measured, with `Omit`
  a store route annotated `DeleteContext<FileDeleter, undefined> & { tx }` inferred `TErased` as `FileDeleter` (the
  `Omit` merged the union by `reason`), so `eraseOwner("u1")` was refused. M12-A8 forbids an authorize field named
  `tx`, so the intersection is exact. The runtime is unchanged; `store-delete.ts` casts the context it builds to the
  union, as each caller pairs a reason with its context or request. Declaring the context once on `createCloudrop`
  was rejected: a type argument there turns off inference of the routes (spec §3a).
- **Why:** spec 1.0 §3a: the context was `unknown`, which forced the pilot's 14-line `deleterOf` guard, and nothing
  told a caller of `api.deleteFile` that a route's audit row needs to know who deletes.
- **If wrong:** an app that calls `deleteFile` with a context of another type than the routes declare now fails to
  compile; that is the point. `interface X extends DeleteContext` no longer compiles, since it is a union; use
  `type X = DeleteContext & { ... }`. Two routes that declare contexts with no common value make the context
  `never`, and `deleteFile` cannot be called with any; the fix is a shared type. An unannotated `onDelete` that
  destructures `context` keeps `unknown`, as before.
- **Status:** in force.
- **Visible in:** `src/server/delete-context.ts`, `src/server/route.ts`, `src/server/store-route.ts`,
  `src/server/route-types.ts`, `src/server/cloudrop.ts`, `src/server/store-api.ts`, `src/server/erase.ts`,
  `src/server/store-delete.ts`, `src/server/store-types.test.ts`, `fixtures/consumer-types/app.ts`.
