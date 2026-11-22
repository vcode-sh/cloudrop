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

### M12-A9: `storage` defaults to `r2()`, still read lazily

- **Decision:** `createCloudrop`'s `storage` is optional; left out (or `undefined`), it is `r2()`, which reads
  `CLOUDROP_R2_BUCKET`, `CLOUDROP_R2_ACCOUNT_ID`, `CLOUDROP_R2_ACCESS_KEY_ID` and `CLOUDROP_R2_SECRET_ACCESS_KEY` as an
  explicit `r2()` does: on the first request in production, so `next build` needs no secrets (`M4-F16`, `M4-F17`),
  and at construction with `NODE_ENV=development`. A missing variable is the same `INVALID_CONFIG` naming each one,
  the bucket included. `r2()` is called only when `storage` is absent, so a server on `s3()` never reads an R2
  variable. A value that is not a driver says what to pass and that leaving it out means `r2()`. With nothing passed
  at all, the first refusal is now the missing routes, since storage has a default.
- **Why:** spec 1.0 §6: one line less on the simple path, and the missing-settings error already names the variables.
- **If wrong:** an app that meant to configure S3 and forgot `storage` gets an R2 error naming R2 variables on its
  first request, not at start; the message says which variables, which points at the missing option.
- **Status:** in force.
- **Visible in:** `src/server/config.ts`, `src/server/environment.test.ts`, `src/server/config.test.ts`,
  `docs/guide/server.md` (options table).

### M12-A11: the plugins-list message names a plugin that exists

- **Decision:** `plugins` that is not a list is refused with "plugins must be a list, such as plugins:
  [contentChecks()]." instead of `[limits()]`.
- **Why:** `limits()` was cut from 1.0 (spec 1.0, "Cut from 1.0"); a message must not suggest an import that fails.
- **If wrong:** nothing depends on the text.
- **Status:** in force.
- **Visible in:** `src/server/config.ts`, `src/server/config.test.ts`.

### M12-A10: a route without `prefix` writes under its own name

- **Decision:** a route that defines neither `prefix` nor `key` generates `<route name>/<ulid><ext>`, such as
  `avatar/01JD5Z3K7Q2X8M4N6P9R0S1T2V.png`. `prefix: () => ""` keeps the bucket root, as an explicit choice. The route
  name is safe as a key segment: `ROUTE_NAME` allows only letters, digits, `-` and `_`. A `key` function is unchanged.
  Objects already stored at the root stay where they are; their keys live in the app's rows or the store's, and nothing
  looks them up by prefix.
- **Why:** spec 1.0 §6: no silent mixing of routes at the root, and a whole route can be found, listed or emptied by
  prefix (`deletePrefix("avatar/")`).
- **If wrong:** an app that relied on root keys and lists the bucket root by prefix finds new files under the route's
  folder; `prefix: () => ""` restores the old keys, and the changelog says so.
- **Status:** in force.
- **Visible in:** `src/server/upload-request.ts`, `src/server/upload-requests.test.ts` ("POST /upload: keys"),
  `docs/guide/server.md` (route options).
