# M12-A: names frozen at 1.0

Rulings for the names and defaults of the public API that change once, before semver freezes them at 1.0, designed in
`docs/superpowers/specs/2026-11-22-1.0.0-design.md` §6. Each change has an "Upgrading to 1.0" entry in the changelog.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-A1: a row's status is `FileRecordStatus`

- **Decision:** the status of a store row, exported from `cloudrop` and `cloudrop/store`, is `FileRecordStatus`
  (`"pending" | "completing" | "completed" | "aborted" | "rejected" | "failed" | "expired" | "deleted"`). The name
  `FileStatus` stays only on `cloudrop/client`, where it is a file's state in an upload job. There is no alias: 1.0 is
  the break (spec 1.0 §6).
- **Why:** two frozen types with one name and different members, one per entry, read the same in an import list and
  in an editor's hover; an app that imports both had to rename one.
- **If wrong:** a hand-written store or an admin view that imported `FileStatus` from `cloudrop` fails to compile
  with "has no exported member", and the changelog's "Upgrading to 1.0" gives the new name.
- **Status:** in force.
- **Visible in:** `src/server/file-record.ts`, `src/server/store.ts`, `src/index.ts`, `src/store.ts`, the stores and
  adapters under `src/store/**`, `src/adapters/**`, `src/testing/**`.

### M12-A2: the calls by key are `*Object`, so none of them reads as `deleteFile`

- **Decision:** `api.head`, `put`, `delete`, `deleteMany` and `copy` are `headObject`, `putObject`, `deleteObject`,
  `deleteObjects` and `copyObject`, with the same signatures and answers. `FileApi` now declares them itself instead of
  picking the driver's methods, so each carries its own doc: the `*Object` calls work on the bucket by key and never
  touch the store. `putObject`'s options refusal names the new call. `deletePrefix`, `getUrl` and `checkBucket` keep
  their names: none of them has a by-id twin. The storage driver keeps `head`, `put`, `delete`, `deleteMany` and
  `copy`: `StorageDriver` is what a custom storage implements (`M12-A12`), and the driver has no store to confuse
  it with.
- **Why:** spec 1.0 §6: with a store, `api.delete(file.key)` deleted the object and left the row and the owner's quota
  as they were, while looking like the same operation as `api.deleteFile(file.id)`.
- **If wrong:** the names are frozen at 1.0; an app that wants the old names writes its own wrapper.
- **Status:** in force.
- **Visible in:** `src/server/api.ts`, `docs/guide/server.md` ("File API"), `docs/guide/store.md`,
  `docs/guide/errors.md`.

### M12-A3: `revokeUploads` takes the owner itself

- **Decision:** `api.revokeUploads(owner: string)`, like `usage(owner)` and `eraseOwner(owner)`. Anything but a valid
  owner, 0.6's `{ owner }` included, answers `INVALID_INPUT` with `usage`'s message ("Pass the owner, a string of 1
  to 255 characters ...") before the store is called. The old object form is not read as a fallback.
- **Why:** spec 1.0 §6: one convention for the three calls that act on one owner. Refusing the old form, instead of
  reading `.owner` from it, keeps one shape and tells a JavaScript caller that skipped the changelog what to pass;
  silently revoking nothing would leave a signed-out user's uploads open.
- **If wrong:** a JavaScript caller still on `{ owner }` gets `INVALID_INPUT` at sign-out, which the guides tell apps
  to check; TypeScript names it at compile time.
- **Status:** in force.
- **Visible in:** `src/server/store-api.ts`, `src/server/store-api.test.ts`, `docs/guide/store.md`,
  `docs/guide/resume.md`.

### M12-A4: `namespace` defaults to `account` when it is a string

- **Decision:** `createCloudropClient`'s `namespace` defaults to `account` when `account` is a string, so a client
  created with `{ account: userId }` keeps, lists, resumes and forgets its records under `userId`. An explicit
  `namespace` wins, `""` included. A function `account` keeps the default `""`: its value is read before each
  `/upload`, after the client has already listed its records, and may change between calls, while a namespace is fixed
  when the client is created. `namespace: null` is still refused as before, not read as "use the default". The examples
  and guides pass `account` alone where they passed both.
- **Why:** spec 1.0 §6: the examples passed the same id twice. It must land before 1.0 because it moves where a
  client finds resume records: a client of 0.6 that passed only `account` kept them under `""`.
- **If wrong:** an app that passes `account` alone and upgrades no longer lists the unfinished uploads it saved under
  `""` before; they expire within 24 hours, and a page that must keep them passes `namespace: ""` until then. The
  changelog says so.
- **Status:** in force.
- **Visible in:** `src/client/options.ts`, `src/client/forget.test.ts`, `docs/guide/client.md`,
  `docs/guide/resume.md`, `docs/guide/react.md`, `docs/guide/hono.md`, `examples/vite-react/src/lib/upload.ts`.

### M12-A5: `useUpload().resumeUpload(upload, file)`; `resume()` only un-pauses

- **Decision:** the hook's two-argument `resume(upload, file)` is `resumeUpload(upload, file)`, with the same answer and
  types: a listed upload of the hook's route continues as one more upload in `files`. `resume()` takes no arguments
  and un-pauses every paused file, as before; passing it a record is a type error. Both keep their identity across
  renders. The client's `client.resume(upload, file)` and a job's `resume()` keep their names: on the client, the
  two meanings live on different objects (a client, a job), so nothing reads two ways there.
- **Why:** spec 1.0 §6: one name with two meanings on one object, told apart only by the argument count; a page that
  wrote `resume(upload)` without the file un-paused everything and resumed nothing.
- **If wrong:** the names are frozen at 1.0; the changelog gives the rename.
- **Status:** in force.
- **Visible in:** `src/react/types.ts`, `src/react/use-upload.ts`, `src/react/types.test.ts`,
  `src/react/use-upload.test.ts`, `src/react/use-resumable.test.ts`, `docs/guide/react.md`, both examples'
  `unfinished-uploads.tsx`.

### M12-A6: `useResumable().discardingIds`

- **Decision:** `discarding: ReadonlySet<string>` is `discardingIds`, the same set: the ids of the listed uploads the
  hook's `discard()` is dropping, from the call until the list is read again.
- **Why:** spec 1.0 §6: `discarding` reads as a boolean, and `if (discarding)` compiles and is always true, since a
  set is truthy even when empty.
- **If wrong:** the names are frozen at 1.0.
- **Status:** in force.
- **Visible in:** `src/react/types.ts`, `src/react/use-resumable.ts`, `src/react/use-resumable.test.ts`,
  `docs/guide/react.md`, both examples' `unfinished-uploads.tsx`.

### M12-A7: the browser's own storage fails with `BROWSER_STORAGE_ERROR`

- **Decision:** `BROWSER_STORAGE_ERROR`, not retryable, joins `CloudropErrorCode` and `ClientErrorCode`, so the
  server's status table has no entry for it. The client answers it in exactly the two places that reported the
  browser's own failures as `STORAGE_ERROR`: IndexedDB failing to read or write resume records (`resumable()`,
  `resume()`'s checks, `discard()`, `forget()`, through `storageUnavailable`), and the browser refusing `discard()` a
  Web Lock (`lockRefused`). The messages are unchanged. `STORAGE_ERROR` stays for everything about the bucket and the
  server's storage: a bucket `PUT` answered `408`, `5xx` or `RequestTimeout` (`bucket.test.ts` keeps it), and the
  server's own storage failures. `resume()` where the browser refuses Web Locks keeps `NOT_FOUND` (`M3-U88`): nothing
  can be resumed in such a browser, which is not a failure of one call. Saving a record still fails silently, as
  before: a browser storage failure never stops an upload.
- **Why:** spec 1.0 §6: one code meant two different fixes, a server or bucket to check, and a browser profile
  (private mode, full disk, blocked storage) where only resuming is lost. A page that shows `STORAGE_ERROR` as "the
  upload failed" was wrong for the browser's case.
- **If wrong:** a page that branched on `STORAGE_ERROR` from `resumable()`, `discard()` or `forget()` must name the new
  code; TypeScript does not catch a string comparison that can no longer match, so the changelog lists the four calls.
- **Status:** in force.
- **Visible in:** `src/errors.ts`, `src/client/failures.ts`, `src/client/records.test.ts`,
  `src/client/forget.test.ts`, `src/client/discard.test.ts`, `src/client/resume-checks.test.ts`,
  `docs/guide/errors.md`, `docs/guide/client.md`, `docs/guide/resume.md`.

### M12-A8: seven names are reserved in the route context, as a type constraint

- **Decision:** `route()` and a store's `route()` (`RouteFunction`) constrain the authorize result to `AuthResult`,
  `object & { [K in ReservedName]?: never }`, with `ReservedName` `"request" | "metadata" | "file" | "data" | "tx" |
  "route" | "signal"`. An `authorize` that returns one of them, such as `{ data: 1 }`, does not compile. `request`,
  `metadata` and `file` were already replaced at runtime and are now refused in the types too. `data` (`afterComplete`)
  and `tx` (a store route) are set today; `route` and `signal` are kept free for later fields. The runtime is unchanged:
  cloudrop's own fields still win, and plain JavaScript that returns `tx` from a plain route's `authorize` still sees
  it in `onComplete`. `ReservedName` and `AuthResult` are not exported. The test of a plain route keeping an authorize
  field `tx` became a test that a plain route on a transactional store has no `tx` at all.
- **Why:** spec 1.0 §6: the authorize result is spread into every context, so adding a context field after 1.0 would
  silently shadow, or be shadowed by, an app's own field of that name: a breaking change hidden in a minor release.
  Reserving the names before the freeze makes later additions safe.
- **If wrong:** an app that returns one of these names gets a compile error naming the field and wraps it, as the
  server guide shows. A name needed later that is not on the list is a breaking change, as before.
- **Status:** in force, with a limit (`M12-R21`): the constraint reads the result's declared keys, so a result typed
  with an index signature (`Record<string, string>`, jose's `JWTPayload`) compiles and may carry a reserved name at
  runtime. The route-context JSDoc and the server guide say so and show returning a plain object of named claims.
- **Visible in:** `src/server/route-context.ts`, `src/server/route.ts`, `src/server/store-route.ts`,
  `src/server/types.test.ts`, `src/server/store-types.test.ts`, `src/server/store-transaction.test.ts`,
  `docs/guide/server.md`.

### M12-A9: `storage` defaults to `r2()`, still read lazily

- **Decision:** `createCloudrop`'s `storage` is optional; left out (or `undefined`), it is `r2()`, which reads
  `CLOUDROP_R2_BUCKET`, `CLOUDROP_R2_ACCOUNT_ID`, `CLOUDROP_R2_ACCESS_KEY_ID` and `CLOUDROP_R2_SECRET_ACCESS_KEY` as an
  explicit `r2()` does: on the first request in production, so `next build` needs no secrets (`M4-F16`, `M4-F17`),
  and at construction with `NODE_ENV=development`. A missing variable is the same `INVALID_CONFIG` naming each one,
  the bucket included. `r2()` is called only when `storage` is absent, so a server on `s3()` never reads an R2
  variable. A value that is not a driver says what to pass and that leaving it out means `r2()`. With nothing passed
  at all, the first refusal outside development is now the missing routes, since storage has a default; with
  `NODE_ENV=development` it is the missing R2 settings, because `storage` is read before `routes` and `r2()` reads
  its variables at construction there (corrected by `M12-R23`).
- **Why:** spec 1.0 §6: one line less on the simple path, and the missing-settings error already names the variables.
- **If wrong:** an app that meant to configure S3 and forgot `storage` gets an R2 error naming R2 variables on its
  first request, not at start; the message says which variables, which points at the missing option.
- **Status:** in force.
- **Visible in:** `src/server/config.ts`, `src/server/environment.test.ts`, `src/server/config.test.ts`,
  `docs/guide/server.md` (options table).

### M12-A10: a route without `prefix` writes under its own name

- **Decision:** a route that defines neither `prefix` nor `key` generates `<route name>/<ulid><ext>`, such as
  `avatar/01JD5Z3K7Q2X8M4N6P9R0S1T2V.png`. `prefix: () => ""` keeps the bucket root, as an explicit choice. The route
  name is safe as a key segment: `ROUTE_NAME` allows only letters, digits, `-` and `_`. A `key` function is unchanged.
  Objects already stored at the root stay where they are; their keys live in the app's rows or the store's, and nothing
  looks them up by prefix.
- **Why:** spec 1.0 §6: no silent mixing of routes at the root, and a whole route can be found, listed or emptied by
  prefix (`deletePrefix("avatar/")`), as long as no other route's `prefix` starts with that route's name as its first
  folder; the guide's `prefix` row warns about it (amended by `M12-R63`).
- **If wrong:** an app that relied on root keys and lists the bucket root by prefix finds new files under the route's
  folder; `prefix: () => ""` restores the old keys, and the changelog says so.
- **Status:** in force.
- **Visible in:** `src/server/upload-request.ts`, `src/server/upload-requests.test.ts` ("POST /upload: keys"),
  `docs/guide/server.md` (route options).

### M12-A11: the plugins-list message names a plugin that exists

- **Decision:** `plugins` that is not a list is refused with "plugins must be a list, such as plugins:
  [contentChecks()]." instead of `[limits()]`.
- **Why:** `limits()` was cut from 1.0 (spec 1.0, "Cut from 1.0"); a message must not suggest an import that fails.
- **If wrong:** nothing depends on the text.
- **Status:** in force.
- **Visible in:** `src/server/config.ts`, `src/server/config.test.ts`.

### M12-A12: three stability tiers, and the names 1.0 keeps

- **Decision:** semver covers the public surface in three tiers:
  - **Implemented by apps:** `StorageDriver`, `CloudropStore` and `SqlExecutor` may gain optional members in a minor
    release and required members only in a major one.
  - **The plugin API** (`CloudropPlugin`, `ServerHooks`, `extendRoute`) is `@experimental`, outside semver: it has one
    user, and the plugins it was designed for are cut from 1.0.
  - **The 20 wire types** from `cloudrop/client` change only with the protocol.

  The names 1.0 keeps, each considered and left as it is: `allowAnyone` beside `unauthorized()` and `forbidden()` (a
  function, against return values); `onComplete` beside `afterComplete` (inside the completion and repeatable, against
  once after the record); `visibility`, `multipartThreshold` (documented as MiB) and `completionLeaseMs`;
  `getUrl({ download })`, and `expiresIn` in seconds (S3's convention); `NO_SUCH_UPLOAD` beside `UPLOAD_EXPIRED`, and
  `INVALID_TOKEN`. This entry only records the ruling; Task 11 writes `docs/guide/stability.md` and the
  `@experimental` marks.
- **Why:** spec 1.0 §6: an app that implements an interface breaks on a new required member, while an app that only
  calls it does not; the plugin API has too little use to freeze; the wire types are shared with a server of the same
  version.
- **If wrong:** a required member needed in a minor waits for a major, or becomes optional with a default; a plugin
  API change in a minor breaks the rare app that wrote a plugin, which `@experimental` warned.
- **Status:** in force; written up in `docs/guide/stability.md`. The mark is `@beta` plus the word in the prose since
  `M12-P7`.
- **Visible in:** spec 1.0 §6, `docs/guide/stability.md` (Task 11).
