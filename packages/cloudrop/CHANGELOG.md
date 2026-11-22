# Changelog

Every notable change to the `cloudrop` package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). From 1.0, what semver covers is in
the stability guide (`docs/stability.md` in the package); before 1.0, a minor version could change the API.

## Unreleased

## 1.0.0 - 2026-11-22

**Upgrading to 1.0.**

- Node.js 26 or newer. Before: `"engines": { "node": ">=24" }`. After: `"engines": { "node": ">=26" }`, and CI tests
  Node 26 only. On Node 24 npm warns at install (`EBADENGINE`). Why: the owner's floor for 1.0, and Node 26 is the
  active LTS from October 2026 (`M12-P2`).
- TypeScript 7.0 or newer for cloudrop's types. Before: the README said 5.4 or newer. After: 7.0 or newer. Why: the
  owner's floor for 1.0; the workspace and every lane already compile with TypeScript 7 (`M12-P3`).
- A database store you wrote yourself is wrapped with `defineStore` from the new entry `cloudrop/store`. Before:
  `createCloudrop({ store: myStore, ... })`. After: `import { defineStore } from "cloudrop/store"` and
  `createCloudrop({ store: defineStore(myStore), ... })`. Without it the server logs `INVALID_CONFIG` at start, every
  request answers a retryable 500 and every `api` call answers that `INVALID_CONFIG`. The adapters' stores (`sqlStore`,
  `drizzleStore`, `prismaStore`) and `memoryStore` need nothing, and neither does a store copied from one with spread
  (`M12-S1`, `M12-S2`).
- A wrapper around an adapter's store that copies it any other way than spread, such as
  `Object.fromEntries(Object.entries(store).map(...))` or a class that copies the methods, loses the store code and
  answers as above. Before: `createCloudrop({ store: logged(sqlStore(executor)), ... })`. After: copy with spread
  (`{ ...store, get: logged(store.get) }`), or wrap the result: `store: defineStore(logged(sqlStore(executor)))`
  (`M12-S1`, `M12-S2`). A `transaction: true` store is copied with spread only: its `route()` ties each route to a
  property of the store that only spread keeps, so `createCloudrop` refuses the routes of any other copy (`M12-R1`).
- `api` has the store's calls only when `store` is passed. Before: a server without a store typed `api.files`,
  `api.file`, `api.allFiles`, `api.usage`, `api.revokeUploads`, `api.deleteFile`, `api.eraseOwner`, `api.reconcile`
  and `api.sweep`, which answered `INVALID_CONFIG`. After: they are type errors there, and a store that may be
  undefined (`store: flag ? s : undefined`, or a spread `...(store && { store })`) counts as none. An app with an
  opt-in store writes one view of `api` with the store's calls next to its server and calls them through it:
  `export const storeApi = store ? (cloudrop.api as StoreApiOf<typeof cloudrop>) : null;` (`StoreApiOf` from
  `cloudrop`), then `if (storeApi) await storeApi.usage(userId)` where it wrote `cloudrop.api.usage(userId)`.
  At runtime the calls still answer `INVALID_CONFIG` without a store (`M12-T3`).
- `FileApi` is the storage calls alone. Before: `FileApi` had the store's calls too. After: a type holding them is
  `StoreFileApi` (or `Cloudrop<typeof routes, typeof store>["api"]`) (`M12-T3`).
- `FileRecord` is a union by status. Before: every time field was `Date | null` whatever the status. After:
  `record.status === "completed"` narrows `completedAt` to `Date`, and code that builds a `FileRecord` by hand (a
  fake store in a test) must give each status its own times, or name the status's type, such as `CompletedRecord`
  (`M12-T1`).
- `route` is the server's route names. Before: `route` on records and in the `api.files` and `api.allFiles` filters
  was `string`. After: `"avatar" | "docs"` for those routes, so `api.files({ owner, route: "nope" })` is a type
  error. Keep a retired route declared until its rows are erased (`M12-T2`).
- `FilesPage` is typed by its records. Before: `FilesPage` with `items: FileRecord[]`. After:
  `FilesPage<CompletedRecord<R>>` from `api.files` and `FilesPage<RecordOf<S, R>>` from `api.allFiles({ status })`;
  plain `FilesPage` still means every status (`M12-T4`).
- The row status type is `FileRecordStatus`. Before: `import type { FileStatus } from "cloudrop"`. After:
  `import type { FileRecordStatus } from "cloudrop"`. `FileStatus` from `cloudrop/client`, a file's state in an upload
  job, keeps its name (`M12-A1`).
- The `api` calls by key end in `Object`. Before: `api.head(key)`, `api.put(key, body, options)`, `api.delete(key)`,
  `api.deleteMany(keys)`, `api.copy(from, to)`. After: `api.headObject(key)`, `api.putObject(key, body, options)`,
  `api.deleteObject(key)`, `api.deleteObjects(keys)`, `api.copyObject(from, to)`, with the same answers. They never
  touch the store: with a store, delete an uploaded file with `api.deleteFile(id)`. The storage driver keeps `head`,
  `put`, `delete`, `deleteMany` and `copy` (`M12-A2`).
- `revokeUploads` takes the owner itself. Before: `api.revokeUploads({ owner: userId })`. After:
  `api.revokeUploads(userId)`, like `usage(owner)` and `eraseOwner(owner)`. The old form answers `INVALID_INPUT`
  (`M12-A3`).
- `storage` is optional and defaults to `r2()`. Before: `createCloudrop({ storage: r2(), routes })`, and leaving it
  out threw `INVALID_CONFIG`. After: `createCloudrop({ routes })` reads the four `CLOUDROP_R2_*` variables, lazily as
  `r2()` does, so a build still needs no secrets. Nothing changes for an app that passes `storage`. A value that is not
  a driver is refused with "storage must be a storage driver, such as r2({ bucket }) or s3({ ... })" (`M12-A9`).
- A route without `prefix` (or `key`) writes under its own name. Before: `avatar: route({ ... })` stored
  `01JD5Z3K7Q2X8M4N6P9R0S1T2V.png` at the bucket root. After: `avatar/01JD5Z3K7Q2X8M4N6P9R0S1T2V.png`. To keep the
  root: `route({ ... }, { prefix: () => "" })`. Files already stored keep their keys (`M12-A10`).
- A value `authorize` may give as undefined is optional in the JSON types, as JSON leaves out its key. Before: with
  `authorize: (): { userId: string; teamId: string | undefined } => ...`, a plugin's `auth.teamId` and `onComplete`'s
  `teamId` were typed `string`, so `auth.teamId.length` compiled and threw when the key was missing. After: they are
  `teamId?: string`; check the value before using it. The same holds for an `onComplete` result's properties in the
  client's `data` type. Nothing changes at runtime (`M12-R20`).
- `authorize` may not return a field named `request`, `metadata`, `file`, `data`, `tx`, `route` or `signal`: it is a
  type error. Before: `authorize: () => ({ userId, route: "admin" })` compiled, and cloudrop's own `request`,
  `metadata` and `file` replaced fields of those names. After: wrap the value, such as
  `authorize: () => ({ userId, scope: { route: "admin" } })`. The runtime is unchanged. The check cannot see into an
  index signature: a result typed `Record<string, string>` or as a JWT payload compiles and may still carry one of
  these names, so return the claims you need as a plain object (`M12-A8`, `M12-R21`).
- The client's `namespace` defaults to `account` when `account` is a string. Before:
  `createCloudropClient({ namespace: userId, account: userId })`, and `{ account: userId }` alone kept records under
  `""`. After: `createCloudropClient({ account: userId })` keeps them under `userId`. A function `account` keeps `""`,
  and an explicit `namespace` wins. A page that passed `account` alone stops listing the unfinished uploads it saved
  under `""` before the upgrade; pass `namespace: ""` for a day to keep them resumable (`M12-A4`).
- The browser's own storage fails with `BROWSER_STORAGE_ERROR`. Before: `resumable()`, `resume()`, `discard()` and
  `forget()` answered `STORAGE_ERROR` when IndexedDB failed, and `discard()` when the browser refused a Web Lock.
  After: `error.code === "BROWSER_STORAGE_ERROR"`, not retryable, with the same messages. `STORAGE_ERROR` now always
  means the bucket or the server's storage. Code that maps every code, in an exhaustive `switch` or a
  `Record<CloudropErrorCode, string>` (`CloudropErrorCode` is exported by `cloudrop` and `cloudrop/client`), handles
  the new code (`M12-A7`).
- The React hook continues a listed upload with `resumeUpload`. Before: `const { resume } = useUpload("files")`, then
  `resume(upload, file)`. After: `const { resumeUpload } = useUpload("files")`, then `resumeUpload(upload, file)`.
  `resume()` without arguments still un-pauses every paused file; in plain JavaScript the old `resume(upload, file)`
  call now only un-pauses, and resumes no record. The client's `client.resume(upload, file)` keeps
  its name (`M12-A5`).
- `useResumable().discarding` is `discardingIds`. Before: `disabled={discarding.has(upload.id)}`. After:
  `disabled={discardingIds.has(upload.id)}` (`M12-A6`).
- A plugin's `beforeUpload` sees the JSON form of `authorize`'s result, as `afterVerify` and `onAbort` always did.
  Before: with `authorize: () => ({ userId, since: new Date(0) })`, `beforeUpload({ auth })` read `auth.since` as a
  `Date`, and so did the `onAbort` of a file `/upload` refused. After: `auth.since` is
  `"1970-01-01T00:00:00.000Z"` in every hook, the snapshot signed into the upload token. Read a `Date` back with
  `new Date(auth.since)` (`M12-T5`).
- A plugin typed for an authorize result is checked against every route. Before: `CloudropPlugin` typed `auth` as
  `unknown`. After: `const limits: CloudropPlugin<{ userId: string }> = { ... }` reads `auth.userId` as a `string`,
  and `createCloudrop({ routes: { avatar, open }, plugins: [limits] })` is a type error when `open`'s `authorize` can
  answer without a `userId` (`allowAnyone`). A plugin typed `CloudropPlugin`, such as `contentChecks()`, is unchanged
  (`M12-T5`).
- `DeleteContext` is a union by `reason`, and its `context` is typed from `onDelete`'s annotation. Before:
  `onDelete: ({ context }) => ...` read `context` as `unknown`, and `api.deleteFile(id)` never asked for one. After:
  `onDelete: ({ reason, context }: DeleteContext<FileDeleter, undefined>) => ...` reads `context` as a `FileDeleter`
  when `reason === "deleted"`, `api.deleteFile(id)` is a type error and `api.deleteFile(id, { context: deleter })`
  compiles; `eraseOwner(owner)` still compiles, as the erased context admits `undefined`. Without an annotation nothing
  changes. `interface Audit extends DeleteContext` no longer compiles: write `type Audit = DeleteContext & { ... }`.
  `request` is set only with `reason: "replaced"`, and its `context` is `undefined` (`M12-T6`).
- `DeleteFileOptions` and `EraseOptions` are generic type aliases. Before: interfaces,
  `interface DeleteFileOptions { context?: unknown }` and `EraseOptions` with `context?: unknown` beside `graceMs` and
  `signal`. After: `type DeleteFileOptions<T = unknown>` and `type EraseOptions<T = unknown>`, where `context` is
  required when `T` does not admit `undefined`. Unparameterised they mean what they meant. A module augmentation
  (`declare module "cloudrop" { interface DeleteFileOptions { ... } }`) no longer merges into them: declare your own
  type with `DeleteFileOptions & { ... }` (`M12-T6`).
- `DeleteContext["request"]` depends on `reason`. Before: `request?: Request` with every reason. After:
  `request?: undefined` unless `reason` is `"replaced"`, where it is `request: Request`. An object literal that sets
  `request` beside `reason: "deleted"` or `"erased"`, such as a test calling an `onDelete` by hand with
  `{ file, owner, reason: "deleted", context, request }`, no longer compiles: drop `request` there, or use
  `reason: "replaced"` with `context: undefined` (`M12-T6`).
- `Route` has three more type parameters: `Route<TMetadataInput, TResult, TAuth, TDeleted, TErased>`. Before: `route()`
  returned `Route<M, R>`. After: it returns `Route<M, R, TAuth, TDeleted, TErased>`, so an exact-equality type test
  such as `expectTypeOf(avatar).toEqualTypeOf<Route<undefined, null>>()` names the new parameters up to the last one
  that differs from its default (`TAuth = object`, `TDeleted = unknown`, `TErased = TDeleted`): for a route whose
  `authorize` returns `{ userId: string }`, `toEqualTypeOf<Route<undefined, null, { userId: string }>>()`. Assigning a
  route to `Route` or `Route<M, R>` still compiles (`M12-T5`, `M12-T6`).
- `RATE_LIMITED` answers HTTP 429 from every source. Before: storage throttling, and a plugin's `RATE_LIMITED`,
  answered 503. After: 429, with `Retry-After` when the bucket or `rateLimited()` gave a wait. A proxy, monitor or
  custom client that keyed on 503 from the upload server keys on 429 (`M12-E3`).
- A plugin's `beforeUpload` refuses only with the codes `authorize` may use. Before: any server code was sent as
  returned, such as `NOT_FOUND` with 404 or `STORAGE_ERROR` with 502. After: such a refusal answers the generic,
  non-retryable `SERVER_ERROR` with 500, and the log says `cloudrop: a plugin's beforeUpload returned NOT_FOUND, which
  /upload cannot send. Return one of …`. Return one of the listed codes, such as `FORBIDDEN` (`M12-E1`).
- A plugin's `afterVerify`, and a replacing completion's `onDelete`, refuse `/complete` only with `UNAUTHORIZED`,
  `FORBIDDEN`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`, `INVALID_METADATA`,
  `VERIFICATION_FAILED` or `SERVER_ERROR`. Before: any server code was sent as returned, `parts` included, such as
  `STORAGE_DENIED` with 502 and the operator's advice from `return read.error`. After: such a refusal answers the
  generic, non-retryable `SERVER_ERROR` with 500, the log says `cloudrop: a plugin's afterVerify returned
  STORAGE_DENIED, which /complete cannot send. Return one of …`, and `afterVerify`'s object is kept. Throw a storage
  call's error, or return one of the listed codes (`M12-R31`).
- A retryable error from `afterVerify` keeps the object. Before: `rateLimited(5)` or any retryable error deleted it,
  so the client's retry after the wait got `NOT_UPLOADED` (`UPLOAD_EXPIRED` with a store). After: it is answered as
  it is, the object and the row stay, no `onAbort` runs, and the retry completes the file. A plugin that means to
  refuse for good returns an error that is not retryable (`M12-R30`).
- The client no longer waits out a `Retry-After` longer than its 20-second backoff cap, at `/upload`, `/sign` or
  `/complete`. Before: a server or proxy asking for 600 seconds was asked again five times, 20 seconds apart. After:
  the file fails at once with the retryable error, such as `RATE_LIMITED`, and `retry()` asks again when the app
  chooses. `error.retryAfter` gives the wait in seconds when the answer carried `Retry-After`; without one, pick the
  delay before `retry()` yourself (`M12-E4`, `M12-R41`, `M12-R42`, `M12-R70`).
- A bucket the browser cannot reach while the upload server answers fails the file with `BUCKET_BLOCKED`. Before: a
  CORS rule that misses the page's origin or a signed header ended the file after about 15 s of retries with
  `NETWORK_ERROR`, retryable. After: in a browser without a `fetch` option, when all six `PUT` attempts failed before
  the browser reported a byte sent, around a `/sign` that answered, the file ends with
  `error.code === "BUCKET_BLOCKED"`, still retryable, after the same retries; `retry()` keeps the ticket, and a
  multipart file keeps its resume record at a failed `upload()` or `pagehide`, sending no `/abort`. In Firefox
  a file whose connection keeps dropping, or whose signature is bad, ends the same way, since Firefox reports
  no progress for a fast body whose answer is an error; the message names those causes too. Code that maps every code
  in an exhaustive `switch` or a `Record<CloudropErrorCode, string>` handles the new code. With a `fetch` option and
  outside a browser nothing changes: the rule needs `navigator.onLine === true`, which React Native does not report
  (`M12-E7`, `M12-R40`, `M12-R60`).
- The usage table has two more columns and an index, for an owner's erase mark. Before: `cloudrop_usage` was
  `owner, reserved_bytes, active_bytes, files, updated_at`. After: it also has `erase_requested_at` and `erased_at`,
  and until it does, the store's first call answers `INVALID_CONFIG` with the SQL to run. On Postgres:
  `ALTER TABLE "cloudrop_usage" ADD COLUMN erase_requested_at timestamptz(3), ADD COLUMN erased_at timestamptz(3);`
  then `CREATE INDEX "cloudrop_usage_erasing_idx" ON "cloudrop_usage" (owner) WHERE erase_requested_at IS NOT NULL AND
  erased_at IS NULL;`. On SQLite and D1: `ALTER TABLE "cloudrop_usage" ADD COLUMN erase_requested_at INTEGER;`,
  `ALTER TABLE "cloudrop_usage" ADD COLUMN erased_at INTEGER;` and the same `CREATE INDEX`. Drizzle: `drizzle-kit
  generate` writes it from `cloudropPgTables()` or `cloudropSqliteTables()`. Prisma: add
  `eraseRequestedAt DateTime? @map("erase_requested_at") @db.Timestamptz(3)` and
  `erasedAt DateTime? @map("erased_at") @db.Timestamptz(3)` (on SQLite `BigInt?`) to `CloudropUsage`, then add the
  `CREATE INDEX` to the migration with `--create-only` (`M12-O1`, guide: "Upgrading from 0.6").
- A database store you wrote yourself has four more methods and a third `reserve` answer. Before: `reserve` answered
  `"reserved"` or `"over-quota"` per file. After: it also answers `"erased"`, for every file of an owner whose usage row
  carries an erase mark, and writes nothing then; and the store has `markErasure`, `erased`, `reopen` and `erasing`,
  which `createCloudrop` requires ("Its markErasure method is missing."). Their contract is in `CloudropStore`'s
  documentation and the store contract suite (`M12-O1`, `M12-O2`).
- `eraseOwner` refuses the owner's uploads from its first call on. Before: an `/upload` after `eraseOwner`, or one
  that passed `authorize` before it, stored a file again. After: each such file is refused with `FORBIDDEN`, "This
  account is being erased, so it can no longer upload files.", until `api.reopenOwner(owner)` (`M12-O2`, `M12-O5`).
- `api.usage(owner)` answers the erase mark. Before: `{ reservedBytes, activeBytes, files }`. After:
  `{ reservedBytes, activeBytes, files, erasure }`, with `erasure` null unless the owner is marked; a test that
  compares the whole object with `toEqual` adds `erasure: null` (`M12-O1`).
- `EraseReport` and `SweepReport` have more fields. Before: `{ revoked, deleted, refused, cleaned, failed, waiting,
  done }` and `{ expired, cleaned, failed, reported, cursor }`. After: `EraseReport` also has `requestedAt` and
  `prefixed`, and `SweepReport` `erasing` and `erased` (`M12-O1`, `M12-O3`, `M12-O4`).
- `api.sweep` carries every unfinished erasure on, in a pass between its two passes over rows. Before: an erasure went
  on only while the app called `eraseOwner` again. After: one call at account deletion is enough. For an owner being
  erased, the object of a stuck completion the sweep ends is removed by that pass instead of kept, and each owner counts
  as one row of `limit`. A sweep its `signal` stops in that pass answers the cursor `erase:<owner>` after the last owner
  it ran, so continuing from it skips no owner it did not run. `SweepOptions` is a generic type alias whose `context`
  reaches `onDelete` for the files it deletes there: required when the routes' `onDelete` declare an erased context that
  does not admit `undefined` (`M12-O4`, `M12-T6`).

### Added

- `useUpload` options `onUploaded(file)` and `onError(error)`: called once per mounted `useUpload` for each file of the
  route that ends done or failed, so a component with two `useUpload` calls on one route is called twice, and `onError`
  for a start refused before it had a file; never for a cancel, and never late for a file that ended while nothing was
  mounted (`M12-H1`, `M12-H3`).
- `useUpload().startError`: the route's last start refused before it had a file row, such as `CLIENT_CLOSED` for a
  file picked after `close()`, which a pick or a drop used to lose; cleared by the route's next start and by `clear()`
  (`M12-H2`).
- `cloudrop/store`: `defineStore` and the store types, for a database store you write yourself (`M12-S2`).
- `content.kind` on a `contentChecks()` refusal with `reason: "refused"`: `"web-page"`, `"program"`, `"installer"`,
  `"script"`, `"svg"`, `"xml"` or `"denied"`, and the type `RefusedKind` from `cloudrop` and `cloudrop/client`. A
  client drops a kind it does not know, and an older client ignores it (`M12-E6`).
- The client error code `BUCKET_BLOCKED`, retryable, when the browser reports no byte sent to the bucket on any
  attempt: its message names the bucket's CORS rule and `npx cloudrop doctor --origin <origin>`, and the look-alikes, a
  firewall or extension, a connection that keeps dropping and a bad signature (`M12-E7`, `M12-R60`).
- A type per record status, from `cloudrop` and `cloudrop/store`: `PendingRecord`, `CompletingRecord`,
  `CompletedRecord`, `DeletedRecord`, `AbortedRecord`, `ExpiredRecord`, `RejectedRecord`, `FailedRecord`, and
  `RecordOf<S>` to pick one. `api.allFiles({ status: "failed" })` answers `FailedRecord`s (`M12-T1`, `M12-T4`).
- `CloudropPlugin<TAuth>` types `auth` in every hook of a plugin, checked against the routes' authorize results
  (`M12-T5`).
- `rateLimited(seconds, message?)` from `cloudrop`: `authorize` refuses with `RATE_LIMITED`, answered 429 with
  `Retry-After`, at most 86400 seconds (`M12-E2`, `M12-E3`). A `RATE_LIMITED` returned from `authorize` or
  `beforeUpload` is always sent retryable (`M12-E1`).
- `authorize` may return a `CloudropError`, and it and a plugin's `beforeUpload` refuse `/upload` with any of
  `UNAUTHORIZED`, `FORBIDDEN`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`,
  `TOO_MANY_FILES`, `INVALID_METADATA`, `INVALID_INPUT` and `SERVER_ERROR`, sent without its `parts`, `file` or
  `cause`. Any other code answers the generic 500 and is logged with that list (`M12-E1`).
- `DeleteContext<TDeleted, TErased>`: annotate `onDelete`'s parameter and `api.deleteFile` and `api.eraseOwner` take a
  `context` of that type, required when it does not admit `undefined` (`M12-T6`).
- `erase: { prefixes }` in `createCloudrop`'s options: folders no row tracks, emptied with `deletePrefix` once an
  owner's rows are erased. Each must hold the owner, as it is or URI-encoded, as a whole segment (`M12-O3`).
- `api.reopenOwner(owner)` clears an owner's erase mark and answers `{ reopened }` (`M12-O5`).
- The types `OwnerErasure`, `ReserveOutcome` and `EraseSettings` (`M12-O1`, `M12-O3`).
- `llms.txt` and `llms-full.txt` at the package root: a summary, rules for coding agents, and every guide, for an agent
  reading `node_modules/cloudrop` (`M12-P10`).
- Two guides: "Stability and versioning" (`docs/stability.md`), what semver covers from 1.0, and "Security model"
  (`docs/security.md`), the threat model (`M12-P8`, `M12-P9`).
- The columns of `cloudrop_files` and `cloudrop_usage` an app may read are guaranteed under semver, and the store
  guide's "Your own queries" gives the reading rules and five recipes in Postgres and SQLite: an admin inventory
  joined with your users, stuck completions, the failures of the last day, usage per owner, and the owners who no
  longer exist, followed by `eraseOwner`. It also gives the only delete an app may run, a purge of ended rows proven
  clean, and of an erased owner's rows (`M12-Q1`, `M12-Q2`).
- Guides: mounting on Express 5, Fastify 5, Elysia, SvelteKit, React Router 7, Astro, Nuxt and Nitro, Deno and
  Workers, each with its trap (`M12-P4`); a malware-scanning recipe, an `afterVerify` plugin of about ten lines; a Hono
  and Bun quick start without a store; what `close()` promises when nothing awaits it; and the opt-in store's
  `StoreApiOf` view.
- `CloudropError.retryAfter`: the wait an answer named, in whole seconds (at most 86,400), or `undefined`. Set by
  `rateLimited(seconds)` and by a storage error with the bucket's `Retry-After` on the server, and on the client from
  the `Retry-After` of your server's or a proxy's answer, or of the bucket's on a `PUT`. It covers a file failed at
  once on a wait over 20 seconds, so the app can say "try again in 600 s". Nothing is added to the JSON body: the
  client reads the header (`M12-R70`).
- `StoreApiOf<typeof cloudrop>` from `cloudrop`: the store-backed `api` of a server, with its route names and the
  `context` its routes' `onDelete` declare, for the view of an opt-in store. With a store it is `typeof cloudrop.api`
  (`M12-R71`).
- The guides say that a refusal returned from `authorize` is answered before the account check (`ACCOUNT_CHANGED`)
  and before any plugin runs (`M12-R72`).

### Changed

- CI runs the React tests on React 18.3.1 too, in a job of its own, `react-18` (`M12-R53`).
- The refusal of a `plugins` option that is not a list suggests `[contentChecks()]`, not the removed `limits()`
  (`M12-A11`).
- A server without a store no longer carries the store's code: it travels with the store object. The bundled server
  is 29.47 kB instead of 34.71 kB (gzip), and a server with a SQL store 46.4 kB, measured 2026-11-22 (`M12-S1`).
- The size ceilings of every entry are raised for 1.0, so they guard against accidents and never block work (`M12-P1`).
  Bundle size is not covered by semver; the release notes give the sizes measured.
- `Jsonified<any>` is `any`. Before: `unknown`. After: `any`, so an `authorize` or an `onComplete` typed `any` gives
  `any` in the contexts and results that read its JSON form, as `any` asks for. `Jsonified<unknown>` stays `unknown`
  (`M12-T5`).
- The plugin API is experimental, outside semver: `CloudropPlugin`, `ServerHooks`, their hooks' contexts and
  `extendRoute` are marked `@beta` and experimental, and a minor release may change them. Using `contentChecks()` is
  covered as before; a plugin you wrote yourself may need a change on a minor upgrade, which the changelog will say
  (`M12-A12`, `M12-P8`).
- The doc comments in the published `.d.ts` explain themselves in plain words instead of citing internal decision ids
  (`M12-P10`).

### Fixed

- A `Retry-After` given as an HTTP date counts from the answer's own `Date` header when the client can read it. Before:
  a proxy whose clock ran minutes ahead of the browser's asked for a 3-second wait, the client read minutes, and the
  file failed at once. After: it waits the 3 seconds (`M12-R43`).
- A bucket `PUT` through an `XMLHttpRequest` that fails inside `send()` no longer leaves a listener on the upload's
  signal (`M12-R44`).
- A route whose `authorize` only refuses, such as `() => forbidden("closed")`, authorizes no one in the types. Before:
  its auth type was the refusal itself (or `AuthResult` for `() => rateLimited(30)`), so a typed plugin such as
  `CloudropPlugin<{ userId: string }>` beside it failed to compile, and `prefix`'s context offered `code` and
  `message`. After: the route is `Route<M, R, never>`, the plugin compiles, and its callbacks see no auth fields
  (`M12-T7`).
- The bucket's `Retry-After` reaches the client when `/upload` refuses a file storage could not start. Before: the
  driver dropped the header, so the client asked again after its own short backoff while the bucket was throttling.
  After: the 200 carries `Retry-After` with the longest wait of those files, exposed to a cross-origin page, and the
  client waits it out for each of them (`M12-E5`).
- A spread copy of a `transaction: true` store, such as the store guide's logging wrapper, keeps its routes. Before:
  `createCloudrop({ store: { ...store, get: logged(store.get) }, routes: { avatar: copy.route(...) } })` threw
  `Route "avatar" was made by another store's route()`, even with the copy's own `route()`. After: it is accepted; a
  route from another store is still refused, and the message names the spread copy (`M12-R1`).
- A `CloudropError` from a second installed copy of cloudrop 1.x refuses as the server's own. Before: returned from
  `authorize`, a plugin's `beforeUpload` or `onDelete` (or the app's error read by a store from the other copy), it
  answered a 500 and logged "from the same cloudrop the server uses", and a second copy's `rateLimited(30)` lost its
  `Retry-After`. After: every `CloudropError` carries the registered brand `Symbol.for("cloudrop.error")` and is
  recognised, with its wait; only an error from a cloudrop older than 1.0 is not, and the logged message says so
  (`M12-R2`).
- `defineStore` refuses what it cannot wrap with `INVALID_CONFIG`. Before: `defineStore(undefined)` threw a raw
  `TypeError`, a string came back as a `String` object, and a frozen store threw `object is not extensible`. After:
  each throws `INVALID_CONFIG` naming the fix (`M12-R4`).
- The sweep never marks an owner for erasure. Before: an owner the app reopened with `reopenOwner` while the sweep was
  erasing an earlier owner of the same page was marked again, had their files deleted, and ended erased for good.
  After: the sweep reads each owner's mark and carries on only that one; an owner without a mark is skipped and not
  counted in `erasing` (`M12-R3`).
- `erase.prefixes` refuses a folder that starts in the folder of a route without its own `prefix`. Before: with a route
  `docs`, `(owner) => [owner + "/"]` and an owner named `docs`, `eraseOwner("docs")` emptied every owner's files of
  that route. After: it answers `INVALID_CONFIG` naming the route, before the owner is marked (`M12-R6`).
- A sweep whose erasure of an owner fails logs one warning for that owner, saying that the owner holds a row of every
  sweep's `limit` ahead of the owners after it until the cause is fixed or the sweep continues from its cursor. Before:
  an error was logged with `logger.error` and a run with failed files said nothing more (`M12-R5`).
- The `erase.prefixes` refusal says to use `encodeURIComponent(owner)` when owner ids can contain `/`: with owners
  `acme` and `acme/alice`, `exports/acme/` also holds `exports/acme/alice/` (`M12-R7`).
- An error body's `retryable` is always a boolean, and its `parts` come only with `PARTS_MISSING`, as safe positive
  integers. Before: `{ retryable: 1 }` from plain JavaScript was sent as `1`, which the client could not read, so the
  app's message was lost (`M12-R34`, `M12-R31`).
- `rateLimited("30")` from plain JavaScript logs `It got the string "30".` instead of `It got 30.` (`M12-R33`).
- errors.md no longer promises `Retry-After` for a `RATE_LIMITED` built by hand: only `rateLimited()` and a storage
  wait send one (`M12-R32`). The `svg` and `xml` refusal kinds are described as the code gives them, also for a type
  in `deny` that the route names (`M12-R35`).
- `createUploadHooks` with options that are not an object, such as `createUploadHooks("/api/cloudrop")` from plain
  JavaScript, resolves `INVALID_CONFIG` from `upload()`, `resumeUpload()` and `refresh()` and shows it in
  `startError`. Before: `upload()`, a pick, a drop and `close()` threw a `TypeError`, and a function was ignored, so
  uploads went to the default basePath (`M12-R50`).
- `useUpload().upload(file, null)`, or any options that are not an object, resolves `INVALID_INPUT` as the client's
  `upload()` does and shows it in `startError`. Before: it threw a `TypeError` (`M12-R51`).
- A `useUpload` that React has committed hears every end of its route. Before: an end that landed after the commit and
  before React ran its passive effects reached the route's other hooks, not this one's `onUploaded` or `onError`
  (`M12-R54`).
- The React guide no longer says `refresh()`'s `INVALID_CONFIG` reaches `startError` and `onError`; only `upload()`
  and `resumeUpload()`, which start an upload, set them (`M12-R52`).

## 0.6.0 - 2026-11-21

In short: four things the first production app could not do with 0.5.0 are now built in (a deletion says what it
did, a hook can say no to a deletion, a refused file says what it really is, and the command reads your own variable
names), and you can list every owner's files. Then every part of the library was read again, file by file, by
reviewers who had to prove each problem with a failing test. Everything they proved is fixed below, and one of those
fixes stops a rare loss of a finished file.

**Upgrading from 0.5.0.** Most apps change nothing. Check these:

- A `trustedOrigins` entry that is not an exact origin (a pattern such as `https://*.example.org`, a wrong port) now
  stops the server at start with a message naming it. It never matched a request before; write each origin out.
- `api.deleteFile` answers `{ id, deleted, cleaned }` and no longer answers an error once the row is deleted.
- An `onDelete` written in JavaScript that returns anything but `undefined` or a `CloudropError` now fails the deletion
  (the value was ignored before). Return nothing to let it go on.
- `graceMs` or `completionLeaseMs` over 30 days now stops the server at start with a message naming the option.
- Smaller refusals: `api.put` refuses options that are not an object, and an `OPTIONS` request that is not a preflight
  for `POST` answers 405 instead of 403.
- A store you wrote by hand: add `listAll` if you call `api.allFiles`; a `stale` cursor must be `<milliseconds>:<id>`.
- One optional index for `api.allFiles`: [Upgrading from 0.5](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/store.md#upgrading-from-05).
- Tests that count requests: a retry now sends an `/abort` for the ticket it replaces, and a cancel during `/upload`
  no longer cuts that request (it answers, and its tickets are given back).
- Tests that make rows look old to drive `eraseOwner` or the sweep must age `created_at` too: `eraseOwner` counts a
  file created within the grace before the run as begun during it (`M11-R215`).

### Added

- **`api.allFiles()`:** the files of every owner, in any status, a page at a time, for an admin inventory or a support
  tool: `{ owner?, route?, status?, name?, type?, order?, limit?, cursor? }`. It is a method of its own, so an `owner`
  that a bug left `undefined` can never widen `api.files`; an `owner` key that is present but `undefined`, `null` or
  empty is refused. One new index serves it (`cloudrop_files_created_at_idx`); the listing answers the same pages
  without it, only slower, so nothing breaks before you migrate. Guide:
  [List every owner's files](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/store.md#list-every-owners-files) (`M11-L1` to `M11-L9`, `M11-R195`).
- **`api.deleteFile` says what it did:** it answers `{ id, deleted, cleaned }`. `deleted` is true when this call
  deleted the file and false when it already was; `cleaned` is true once the bucket has been checked, after the file's
  upload URLs ran out, and holds nothing of it (so `false` is the usual first answer, and the sweep finishes the job).
  Guide: [What `deleteFile` answers](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/store.md#what-deletefile-answers) (`M11-D1`, `M11-D2`).
- **`onDelete` can refuse:** return a `CloudropError` and the file is kept, the hook's writes through `tx` are undone,
  nothing is logged as an error and the caller gets your error: `api.deleteFile` answers it, `api.eraseOwner` counts
  the file in the new `refused`, and a replacing `/complete` sends it to the client. A thrown error is still a failure.
  Guide: [Refuse a deletion](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/store.md#refuse-a-deletion) (`M11-D3` to `M11-D8`).
- **A refused file says what it is:** a `FILE_TYPE_NOT_ALLOWED` from `contentChecks()` carries
  `error.content = { declared, detected?, reason }` (`"mismatch"`, `"refused"` or `"not-accepted"`) on the server, in
  the client and in the React hooks, so an app can say "this is a JPEG" in its own language. Guide:
  [Plugins](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/plugins.md) (`M11-K1` to `M11-K6`, `M11-R137`).
- **The command reads your own variable names:** `--var CLOUDROP_R2_BUCKET=R2_BUCKET`, repeatable, for `doctor` and
  `setup`; every message then names your variable. Also `--version`. Guide:
  [The cloudrop command](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/command.md) (`M11-C1` to `M11-C6`, `M11-R119`, `M11-R235`).
- **`trustedOrigins` takes an app's own scheme,** such as `capacitor://localhost` or `tauri://localhost`, as the exact
  `Origin` a webview sends; the command's `--origin` reads origins by the same rule (`M11-R41`, `M11-R111`).
- `api.checkBucket` answers `advice` on a bucket that is right but could be better, such as a rule that hides
  `Retry-After` (`M11-R205`). `testClient` takes `account`, so the account guard can be tested (`M11-R3`).
- Types `DeletedFile`, `AllFilesOptions` and `ContentRefusal`.

### Changed

- **Breaking: `trustedOrigins`, `api.checkBucket({ origins })` and `--origin` refuse what is not an exact origin:** a
  pattern, text the URL parser refuses (a port over 65535), a host a browser cannot load, and the schemes `ws`, `wss`
  and `ftp`. A pattern used to pass and then match no request. What to do: list each origin (`M11-R40`, `M11-R111`,
  `M11-R176`, `M11-R230`).
- **Breaking for a store written by hand:** `api.allFiles` needs the new optional `listAll` and answers
  `INVALID_CONFIG` without it. A `stale` cursor of another shape than `<milliseconds>:<id>` now fails `api.sweep` with
  a non-retryable `SERVER_ERROR` instead of stopping the sweep silently (`M11-L4`, `M11-R68`, `M11-R242`).
- **`api.deleteFile` no longer answers a storage error once the row is deleted:** it answers success with
  `cleaned: false`, logs the failure, and the sweep removes the object. **Breaking:** a JavaScript `onDelete` that
  returns a value other than a `CloudropError` now fails the deletion (it was ignored). `deleteFile` answers `NOT_FOUND` for a file
  whose `/complete` is recorded during the call (`M11-D2`, `M11-D3`, `M11-R150`).
- **`retry()` follows one table** and never repeats a request that cannot succeed: after a refusal that ended the
  upload (`FILE_TYPE_NOT_ALLOWED`, a hook's refusal, `UPLOAD_EXPIRED`, `NO_SUCH_UPLOAD`, `ALREADY_EXISTS` and others) it
  asks for a new ticket; after `NOT_UPLOADED` it sends the bytes again. Before asking for a new ticket the client gives
  the old one up (`/abort`), so with a quota the retry is not refused by its own earlier reservation; a resumed upload
  that starts over does the same. Guide: [Retry](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/client.md#retry) (`M11-R80` to `M11-R94`, `M11-R201`).
- **A cancel during `/upload` lets that request answer** (at most 30 seconds, behind the scenes) and gives back each
  ticket it brings, so its reservation does not stay; the job still ends `ABORTED` at once. `close()` waits for that
  cleanup, also when the files were cancelled one by one, so it can take up to 40 seconds when the server does not
  answer (`M11-R261`, `M11-R264`).
- **Limits on configuration and requests:** **breaking:** `completionLeaseMs` and `graceMs` at most 30 days, checked
  at start; metadata nested more
  than 32 levels is `INVALID_METADATA`; a file name with NUL, or with a control character the route's own `key`
  cannot hold, is `INVALID_INPUT` for that file alone (the second failed the whole request before); an owner or file
  id with a broken Unicode character (a lone surrogate) is refused; an `OPTIONS` that is not a preflight for `POST`
  answers 405, not 403; `null` means no options in every `api` call, and `api.put` refuses options that are not an
  object (`M11-R42`, `M11-R46`, `M11-R60`, `M11-R63`, `M11-R64`, `M11-R196`, `M11-R222`, `M11-R245`).
- **`/complete` of a multipart upload the bucket no longer has** ends the upload: with a store its row becomes
  `rejected` and its reserved bytes are released at once, and plugins hear `onAbort` (without a store, at each such
  `/complete`). It used to stay pending until the sweep (`M11-R200`, `M11-R243`).
- **Every `api` call reads a key or a prefix in NFC,** as `/upload` stores them. On S3-compatible services, a key
  another tool wrote in another Unicode form is reached through the storage driver, not `api` (`M11-R44`).
- **The storage drivers trust less:** an answer that is not the storage service's (a web page with status 200, a body
  where none belongs) is an error instead of an empty listing; redirects are never followed; response bodies are read
  up to a bound. `400 RequestTimeout` and `409 OperationAborted` are retried. Error messages name a wrong region, a
  range outside the object and a service that lacks a call (`M11-R20` to `M11-R23`, `M11-R93`, `M11-R173`,
  `M11-R251`).
- **`contentChecks()`** (each change is listed in `M11-R259`):
  - A container that can be audio or video (WebM, MP4, Ogg, Matroska) is judged as the type it was sent as, so
    `deny: ["video/*"]` no longer refuses a voice recording. Sent without a type, it is refused when `deny` names any
    type it can be.
  - `allow` lets a refused kind through under any of its names, at both steps.
  - Newly read as what they are: an Office file from a streaming or ZIP64 writer, a ZIP sent as
    `application/x-zip-compressed`, an MP3 only by two frame headers, a `#!` script behind a byte order mark or blank
    lines, a bare `<!--` and `<?` as browsers read them, a document whose root the first 4 KiB do not reach (XML).
  - No longer refused: text such as `<a,b>` or `<a@b.com>`; a name that ends in a space or a dot is read by its
    extension.
  - Its entry's size ceiling goes from 6 to 7 kB; it measures about 6.5 kB (`M11-R131` to `M11-R136`, `M11-R220`,
    `M11-R221`, `M11-R253` to `M11-R258`).
- **The `cloudrop` command:**
  - The commands it suggests are complete, quoted and runnable (`npx cloudrop … --env-file …`); they name the bucket
    and the S3 endpoint by value. Nothing else is printed by value: never a key, a secret or the account ID, and text
    you typed is repeated only when it cannot be a secret.
  - `--env-file` is read exactly as Node reads it, and may be repeated.
  - `doctor` and `api.checkBucket` judge the CORS rule the service really answers with (the first that matches,
    measured on R2). A blocked upload is a problem; a rule that hides `Retry-After` is advice; `ETag` is no longer
    required, as the client never reads it. So `doctor` exits 0 for a bucket whose rule lacks only `ETag`, where 0.5.0
    exited 1, and the server no longer logs a development warning for it.
  - `setup --apply` places cloudrop's rule before a rule that would answer its uploads while hiding `Retry-After`.
  - `--jurisdiction` twice, or with S3 settings, is a usage error (`M11-R110` to `M11-R120`, `M11-R170` to `M11-R177`,
    `M11-R204`, `M11-R205`, `M11-R232` to `M11-R237`).
- **`cloudrop/testing`:** the test bucket now behaves as R2 was measured to: one object for a key written in two
  Unicode forms (`object(key).key` is the form last written), `401` for an unknown access key, and answers to CORS
  preflights. The memory store orders ids and owners by bytes, as SQL does (`M11-R26`, `M11-R65`, `M11-R172`,
  `M11-R209`).
- **Postgres:** statements that lock several rows lock them in one order; `revokeUploads` ends uploads in several
  steps, so a call that fails may have ended some of them (call it again); a call or a transaction-mode completion
  that Postgres ends as a deadlock or a serialization failure runs once more, hooks included. The sweep's reads are one
  index range per status (a page went from 12 ms to 0.12 ms on 360,000 rows). **SQLite:** the name filter of
  `api.files` folds ASCII letters without `lower()`, so the ICU extension no longer changes its answers (`M11-R61`,
  `M11-R66`, `M11-R69`, `M11-R240`, `M11-R241`).
- **React:** `useUpload` follows a changed factory or route without a remount; `useResumable` never shows another
  route's records (`M11-R4`, `M11-R5`).
- The bundled server entry's size ceiling goes from 32 to 36 kB; it measures about 34.7 kB (`M11-R100`).

### Fixed

- **A cancel could delete a finished file** (servers without a store): a tab closed while `/complete` was in flight,
  the server finished the file, and after the reload the resumed upload was cancelled before the client had asked the
  server. Its `/abort` now always says to keep a finished file (`M11-R260`).
- **A deletion could skip `onDelete`:** `api.deleteFile` called while that file's `/complete` was in flight deleted
  the file without running the hook (`M11-R150`).
- **`eraseOwner` could report `done`** while an upload recorded by a server whose clock ran behind was still in the
  bucket (`M11-R215`).
- **Uploads refused with `QUOTA_EXCEEDED` by their own earlier attempt:** a retry or a resume that needed a new ticket,
  or a cancel during `/upload`, left the old reservation in place (`M11-R89` to `M11-R92`, `M11-R201`, `M11-R261`).
- **`doctor` judged any rule of the bucket,** so it could say CORS was fine while an earlier rule answered uploads in
  cloudrop's place; it now names the rule that answers. Its suggested commands failed when pasted after `--env-file`
  or `--jurisdiction` (`M11-R110`, `M11-R170`).
- **In tests:** `testClient` lost `cookie` and `origin` under happy-dom, and under jsdom 26 every request and every
  storage call failed (`M11-R1`, `M11-R2`, `M11-R250`).
- **Postgres:** two deadlocks among the store's own statements, one when a retried `/upload` of many files met
  `revokeUploads`, one on `replace` routes in transaction mode (`M11-R61`, `M11-R240`); two owners whose ids differ
  only in a broken character were stored as one (`M11-R60`); a missing table permission was reported as a missing
  table (`M11-R62`).
- **Storage:** an `s3()` endpoint that answered a web page looked like an empty bucket, so `deletePrefix` reported a
  verified erasure (`M11-R20`); a copy of an object over 5 GiB whose stored headers held non-ASCII text failed its
  signature (`M11-R25`, `M11-R252`); a wrong-typed checksum or bucket rule threw instead of answering an error
  (`M11-R24`); a custom `fetch` whose answers are not web streams works again (`M11-R251`).
- **`contentChecks()`:** a WebM whose DocType was `constructor` made `/complete` fail for ever (`M11-R130`); a `]>`
  inside a quoted value of a doctype hid the SVG behind it (`M11-R220`); a refusal could not end a row a crashed
  request had left completing (`M11-R138`).
- **The client:** `done` rejected and the file stayed queued where `crypto.getRandomValues` is missing; a hostile list
  argument threw; a `/complete` that never left the page stopped a later cancel from cleaning up; mass cancels could
  pass the browser's 64 KiB limit for requests sent while a page closes (`M11-R82` to `M11-R87`).
- **The server:** a plugin hook returning `null` answered 500; a preflight naming a header with `_` was answered
  without it, so the browser blocked the request; `/complete` could fail after `onComplete` ran when its result could
  not be read twice (`M11-R45` to `M11-R47`).
- **Guides:** the Drizzle setup block now compiles on both supported drizzle-orm lines (`drizzle({ client: pool })`)
  (`M11-R231`); the signed-in recipe kept one client per user on a server that renders pages (`M11-R8`); a hook's
  `request` has its body already read (`M11-R43`); `eraseOwner` needs the sweep to finish for a crashed completion
  (`M11-R153`); on Workers with D1, sweep one bounded round per run (`M11-R70`).

## 0.5.0 - 2026-11-21

In short: when your app deletes a file, its `onDelete` hook now hears who asked and why, so the audit row can say it.

### Added

- **`api.deleteFile(id, { context })` and `api.eraseOwner(owner, { context })`:** `context` reaches the route's
  `onDelete` as it is, such as the person or administrator who asked, their reason and their address. A replaced file's
  `onDelete` gets `request` instead, the `/complete` request of the upload that replaces it. Guide:
  [onDelete](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/store.md#ondelete) (`M10-D12`).
- Type `DeleteFileOptions`.

### Changed

- `DeleteContext` gains `context` and, for a replacement, `request`; a hand-built `DeleteContext` in a test now passes
  `context`.

## 0.4.0 - 2026-11-21

In short: the server can now check what a file really is, not just what the browser says it is
(`cloudrop/plugins`, `contentChecks()`). Your app hears about every deleted file (`onDelete`), can search and sort a
user's files, and can stop a file from landing on the wrong account after someone signs in elsewhere (`account`).

### Added

- **`cloudrop/plugins` with `contentChecks()`.** At `/upload` it refuses web pages, programs, scripts and XML or SVG
  types the route does not name; at `/complete` it reads the first 4 KiB, recognises the real format from its
  signature (images, animated PNG, PDF, ZIP and office files, audio, video, programs, HTML, SVG, XML) and refuses a
  file whose content contradicts its declared type or is one of those refused kinds. A refused file ends `rejected`
  with `FILE_TYPE_NOT_ALLOWED`: its object is deleted, plugins get `onAbort` and a store releases its quota. Options:
  `allow` and `deny`. A CSV starting with `MZ` or text starting with `ID3` is not mistaken for a program or an MP3:
  each needs its whole header. The guide says what it cannot catch, and to serve stored files with
  `X-Content-Type-Options: nosniff`. Guide: [Plugins](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/plugins.md) (`M10-K1` to `M10-K12`).
- **`onDelete({ file, owner, reason, tx? })` route hook**, `reason` `"deleted"`, `"replaced"` or `"erased"`: runs when
  `api.deleteFile`, a `replace: true` completion or `api.eraseOwner` deletes a completed file (the sweep never deletes
  one). With `transaction: true` it runs inside the deletion's transaction, and what it writes through `tx` commits
  once, with the deletion; otherwise it runs before the deletion, at least once. Either way the hook itself can run
  twice for one file, so keep other effects idempotent. A throw keeps the file. Guide:
  [onDelete](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/store.md#ondelete) (`M10-D4` to `M10-D9`).
- **`api.files` filters:** `name` (a substring; ASCII letters match in either case, every other character only
  itself), `type` (exact, or a top-level prefix such as `"image/"`) and `order` (`"newest"`, the default, or
  `"oldest"`), the same on Postgres, SQLite, D1 and the memory store. A cursor works only with the options of the page
  that returned it. No migration (`M10-D1` to `M10-D3`).
- **Client option `account`:** the user this page shows, sent with `/upload` only as `x-cloudrop-account`. On a route
  with a store and `owner`, the server refuses an upload whose session is someone else's with the new code
  `ACCOUNT_CHANGED` (409, not retryable: reload the page), before any reservation or plugin. Pages without it are
  checked as before. Guide:
  [Guard against a changed account](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/client.md#guard-against-a-changed-account) (`M10-A`).
- The React guide's [Errors to show](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/react.md#errors-to-show): nothing for `ABORTED`, no error or Retry for
  `CLIENT_CLOSED`, and a Reload button for `ACCOUNT_CHANGED`.
- Types `DeleteContext` and `DeleteReason`.

### Changed

- **Breaking for a store written by hand:** `CloudropStore.list` receives `name`, `type` and `order`. A 0.3 store still
  compiles but ignores them; `api.files` then refuses its pages with a non-retryable `SERVER_ERROR` whenever they do not
  match the options, instead of answering unfiltered files (`M10-D11`). Implement the three. Every shipped adapter
  does.
- **Breaking for a plugin's own tests:** `BeforeUploadContext` and `AfterVerifyContext` gain a required `accept` (the
  route's accept list), which a hand-built context must now pass.
- `CloudropErrorCode` gains `ACCOUNT_CHANGED`, which breaks an exhaustive `switch` over it.
- A cursor from a 0.3 `api.files` listing filtered by `route` is refused once after the upgrade with `INVALID_INPUT`;
  start that listing again. Cursors of unfiltered listings keep working (`M10-D2`).
- The bundled server entry's size ceiling goes from 30 to 32 kB: the owner file API and `onDelete` brought it to about
  31 kB (`M10-D10`). `contentChecks` lives in its own entry and adds nothing to it.

## 0.3.0 - 2026-11-21

In short: you can now test your upload routes without a bucket (`cloudrop/testing`), and one command checks and sets
up your bucket (`cloudrop doctor`, `cloudrop setup`). Everything was then tested against a real R2 bucket and a real
database, and the problems found there are fixed below. The guides now ship inside the package (`docs/`).

### Added

- **`cloudrop/testing`:** `testBucket()`, `testClient()` and `memoryStore()` let an app test its routes, `authorize`,
  metadata, quotas, `onComplete` and whole uploads in Vitest, Bun or `node:test`, with no bucket, browser or network.
  The test client is the real client, wired to `cloudrop.handler` in-process; the test bucket is the in-process fake
  of R2 that cloudrop's own tests use. Guide: [Testing your app](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/testing-your-app.md) (`M9-T1` to
  `M9-T9`).
- **The `cloudrop` command** (Node 24+ and Bun): `cloudrop doctor --origin <origin>` checks the storage settings,
  `CLOUDROP_SECRET`, the bucket and its CORS and lifecycle rules in plain words (exit 0, 1 or 2).
  `cloudrop setup --origin <origin>` prints the rules and the Wrangler and AWS CLI commands; with `--apply` it adds
  cloudrop's rules through the S3 API and keeps every other rule (`--dry-run`, `--replace`). It never prints a
  setting's value. Guide: [The cloudrop command](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/command.md) (`M9-C1` to `M9-C9`).
- `StorageDriver` gains optional `putBucketCors` and `putBucketLifecycle`. `BucketCorsRule` gains `id` and
  `maxAgeSeconds`, and `BucketLifecycleRule` gains `sourceXml`.
- **The guides ship in the package:** `node_modules/cloudrop/docs/` holds the user guides of this exact version, with
  an index in `docs/README.md`; links to the project's history point at GitHub.

### Changed

- Reading bucket settings refuses a configuration with CDATA, comments or namespace prefixes, with a non-retryable
  `STORAGE_ERROR`, and reads an empty self-closing configuration as no rules.
- **Upload URLs end at least 15 minutes before their token**, so a `PUT` started near the deadline can still be
  completed: `/sign` answers `UPLOAD_EXPIRED` in a token's last 15 minutes, and the client gets a new ticket or starts
  over there (`M9-H3`). Measured on R2: a URL's expiry is checked when the request starts, not when its body ends.
- The `cloudrop` command names the setting to fix when the bucket does not answer, suggests the exact origin for one
  that is not, refuses a pattern such as `https://*.example.com`, notes a misspelt `CLOUDROP_*` name, offers
  `--replace` only after a refused read, and ends a dry run by pointing at `--apply` (`M9-H100` to `M9-H104`,
  `M9-H107`). `setup --apply` was measured on R2: both writes accepted, other rules kept, rule IDs kept.

### Fixed

Found by testing against a real R2 bucket and as a new user before this release (`M9-H`):

- A file whose type has parameters (`text/csv;charset=utf-8`, and every `text/plain` `File` under `bun test`) was
  refused as "not a valid MIME type"; it is stored with its essence type (`M9-H1`).
- A storage `HEAD` refused because the server's clock is more than 15 minutes off says so, instead of pointing at the
  credentials (`M9-H2`); a `401` (R2's answer to an unknown access key) points at the access key ID and secret instead
  of the object key (`M9-H5`).
- A part sent to a multipart upload aborted elsewhere fails as `NO_SUCH_UPLOAD`, not `UPLOAD_REJECTED` (`M9-H4`).
- Two `resume()` calls of one upload in the same page could let the second one win when the first one's file check
  was slower; the first call now always decides (`M9-H7`).
- `api.deletePrefix` refused a folder whose name has accents when R2 listed a key in the other Unicode form, so the
  folder could never be deleted (`M9-H6`).
- With `transaction: true`, a node-postgres connection that dies while `onComplete` runs no longer stops the process;
  the completion answers a retryable error (`M9-H50`). The store guide now asks for `pool.on("error")` and gives a
  workaround for drizzle-orm 0.45.
- Owners, file ids and cursors containing NUL, and cursor times after the year 9999, are refused with `INVALID_INPUT`
  instead of a retryable `SERVER_ERROR` on Postgres; an `owner()` that returns NUL is the route's bug (`M9-H51`).

## 0.2.0 - 2026-11-20

### Added

- **`client.close()`** stops a client: every running and queued upload of every route stops, and `start()`,
  `upload()` and `resume()` answer the new error code `CLIENT_CLOSED` afterwards. Without options it acts like closing
  the tab: a multipart upload keeps its record and its parts, so the same user can resume it. `close({ abort: true })`
  cancels on the server too, for sign-out: `await close({ abort: true })`, then `forget()`, then your auth library's
  sign-out. A file whose `/complete` may have finished is always kept. `createUploadHooks()` returns the same `close()`
  (`M8-L1` to `M8-L4`, `M8-L7`).
- **`headers` client option** for requests to the upload server only (`/upload`, `/sign`, `/complete`, `/abort`),
  never for bucket `PUT`s: an object, or a function (possibly async) called before each request, so a bearer token is
  fresh on each. A function that fails or hangs fails that request unsent with `NETWORK_ERROR` (`M8-L5`, `M8-L6`).
- **`useResumable().discarding`**: the ids being discarded, to disable a second press of Discard (`M8-L8`).
- **`api.files({ owner, route?, limit?, cursor? })`**: an owner's completed files, newest first, a page at a time
  (`M8-A1`).
- **`api.eraseOwner(owner, { graceMs?, signal? })`** removes everything an owner uploaded without needing your key
  layout: it revokes unfinished uploads, deletes completed files and reports `done` once nothing can still land. Run it
  until it reports `done` (`M8-A5`).
- **Route option `replace: true`** (needs a store and `owner`): one file per owner on the route, such as an avatar. The
  previous file is deleted in the same write that records the next one's completion, and of two completions at once
  exactly one file survives. Read the kept file with `api.files({ owner, route, limit: 1 })` (`M8-A6`).
- **`api.sweep({ all: true, signal? })`** runs every page in one call and sums the reports; the store guide has cron
  recipes for Node and Cloudflare Workers (`M8-A7`).
- Exported types `FilesOptions`, `FilesPage`, `EraseOptions`, `EraseReport` and `Completion`.

### Changed

- **Type-level breaks:** `CloudropErrorCode` and `ClientErrorCode` gain `CLIENT_CLOSED`, which breaks an exhaustive
  `switch` over them. New members break a hand-written mock: `CloudropClient.close()`, `UploadHooks.close()`,
  `UseResumable.discarding`, and `FileApi`/`StoreFileApi`'s `files()` and `eraseOwner()`.
- **A store written by hand** must implement the new `CloudropStore.list()`, and `complete()` takes `{ replace }` and
  answers `Completion` with `replaced`. Every shipped adapter does (`M8-A3`).
- `api.deleteFile` deletes the object at once and marks the row cleaned only once a late `PUT` can no longer land
  (about 1 h 15 min after completion); until then the sweep checks the key again. The sweep follows the same rule: it
  marks an ended row cleaned, and counts it in `cleaned`, only once no upload URL of the row can still put an object
  back, and stamps `cleaned_at` with the time its check started (`M8-A4`).
- The React "Signed-in users" recipe, the guides and the Vite example use `close()` instead of each route's `abort`.
  "Send a bearer token" uses `headers`.

### Fixed

- A bearer token no longer needs a custom `fetch`, which moved bucket `PUT`s off `XMLHttpRequest` and its byte-by-byte
  progress.
- A file still waiting for its ticket can no longer ask `/upload` after sign-out.
- The sweep could mark a row cleaned up to 15 minutes before its last upload URL ran out when the row ended soon after
  it left `pending` (an `/abort` or a revoke right after `/upload`), so a slow `PUT` landing then stayed in the bucket
  (`M8-A4`).
- Without a store, `/complete` sends `data: null` when `onComplete` returns a value JSON cannot carry (a function, a
  Symbol); the answer used to have no `data`, which the client refused (`M8-Q34`).

### Migration

- **Database store:** the owner index becomes `(owner, status, created_at)`, which `api.files` and `eraseOwner` read:
  `CREATE INDEX "cloudrop_files_owner_status_created_at_idx" ON "cloudrop_files" (owner, status, created_at); DROP
  INDEX "cloudrop_files_owner_status_idx";` (`CONCURRENTLY` on a large Postgres table). Drizzle and Prisma users
  generate a migration; when drizzle-kit asks whether the new index renames the old one, answer that it is created.
  With `tables.schema` or your own table names, use those names. Without the migration the store works, only slower
  for owners with many files (`M8-A2`).

## 0.1.1 - 2026-11-20

### Fixed

- **R2: a text, JSON, HTML or SVG file of 50 bytes or more failed at `/complete` with `502 STORAGE_ERROR`** ("The
  storage service's response had no content length"), after its bytes had reached the bucket. R2 compresses its answer
  to the `HEAD` request that reads the stored size when the request offers gzip, as Node's and Bun's `fetch` do, and
  then sends no `Content-Length`. The driver now asks for an uncompressed answer on every `HEAD`, which also fixes
  `/abort`, the store's sweep and `api.head` on such files, for `r2()` and for `s3()` pointed at R2. Applications that
  set `accept-encoding: identity` in a `fetch` of their own can drop it.

### Documentation

- **Signed-in users in React:** the React guide shows a client per user, in a context keyed by the user, and a sign-out
  that cancels every route's uploads before `forget()`: `forget()` stops nothing, and a file that gets its ticket
  afterwards saves a new record and, once the session changed, asks `/upload` with the next user's session. The Vite
  example's sign-out now does the same.
- **What "`onComplete` once" means:** at least once without a store; with one, once under a lease, and exactly once only
  for writes through `tx` on Postgres with `transaction: true`. Keep an email or a webhook idempotent.

## 0.1.0 - 2026-11-19

The first release. Version `0.0.0` on npm only reserved the name.

### Added

- **The server** (`cloudrop`): `createCloudrop` with routes declared by `route(policy, callbacks)`. Every route requires
  an `authorize` function, which refuses a request with `unauthorized()` or `forbidden()`; size and type are checked
  before an upload link is signed and again on the stored object. The handler serves four endpoints (`/upload`,
  `/sign`, `/complete`, `/abort`), answers every request, with an error whose `code` and `message` say what to do when
  it refuses one, and after `/upload` trusts only the signed upload token. `/upload` takes an optional idempotency key,
  which the client sends with every request; with a store, a retry ends the pending rows of the attempt whose answer
  was lost, so they hold no quota. `/abort` takes `keep: true`, which the client's `discard()` sends: without a store,
  it aborts an unfinished upload but never deletes an object that already landed, since `onComplete` may have recorded
  it. `cloudrop.api` gives server code the same operations without HTTP.
- **Storage drivers** for Cloudflare R2 (`r2()`) and any S3-compatible service (`s3()`), with SigV4 signing over
  `fetch` and settings read from `CLOUDROP_*` environment variables on the first request, so a build needs no secrets.
  `cloudrop.api.checkBucket` reports a missing CORS or lifecycle rule.
- **Adapters to mount the handler:** `cloudrop/next` for the Next.js App Router and `cloudrop/node` for Node's
  `http`, Express and similar servers. Runtimes with `Request` and `Response` (Bun, Deno, Hono, Cloudflare Workers) use
  the handler directly.
- **The browser client** (`cloudrop/client`): `createCloudropClient`, typed from the server's routes. Small files go in
  one `PUT`, large files in parts sent in parallel; every request is retried with growing waits and honours
  `Retry-After`; expired links are renewed and missing parts are sent again. Progress, speed and time left per file and
  per job, pause, resume, cancel and retry per file or job, connections that adapt to the network, pausing while
  offline, and resuming a large upload after a reload or a closed tab. `discard(upload)` drops one unfinished upload
  without its file: the server aborts it and the browser deletes its record. `forget()` deletes every record and
  aborts nothing, for sign-out.
- **React hooks** (`cloudrop/react`): `createUploadHooks` gives `useUpload` for inputs, drop zones and progress lists
  and `useResumable` for uploads that continue after a reload, with `discard(upload)` and `forget()`, each followed by
  a fresh read of every `useResumable`'s list. `react` 18 or 19 is an optional peer dependency.
- **An optional database store:** one row per upload before anything is signed, `onComplete` once per file (exactly
  once for writes through its transaction on Postgres), a quota per owner that concurrent uploads cannot overshoot
  (refused with `QUOTA_EXCEEDED`), revocation of an owner's uploads, and a sweep that cleans up abandoned uploads.
  `tables.schema` puts the store's tables in a Postgres schema. Postgres time columns are `timestamptz(3)`, the
  millisecond precision of a JavaScript `Date`. cloudrop 0.x ships no migrations: Postgres tables created from the
  repository before this release keep working as they are; recreate them, or apply the change drizzle-kit and Prisma
  propose, to match.
  Adapters: `cloudrop/adapters/sql` (node-postgres, postgres.js, `node:sqlite`, Cloudflare D1),
  `cloudrop/adapters/drizzle` (`drizzle-orm` 0.45 or later, including 1.x from 1.0.0-rc.5) and
  `cloudrop/adapters/prisma` (Prisma 7).
- **Zero runtime dependencies.** Only web-platform APIs, so the server runs on Node.js 24+, Bun, Deno and Cloudflare
  Workers. ESM only, with type declarations for every entry.
- **Examples** in the repository: `examples/next`, a Next.js app that uploads to a local RustFS container, Wrangler's
  local R2 or real R2, with an upload UI on the hooks as its home page, a lab page and an opt-in SQLite store;
  `examples/hono`, a Bun and Hono API with better-auth sign-in and a Drizzle store on Postgres; and
  `examples/vite-react`, a Vite React app on another origin that uploads through it. Both web apps list unfinished
  uploads after a reload, to resume by picking the file again or to discard.
