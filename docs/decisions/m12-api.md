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
