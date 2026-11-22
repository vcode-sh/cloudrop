# Changelog

Every notable change to the `cloudrop` package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0, a minor version may change the API.

## Unreleased

**Upgrading to 1.0.**

- Node.js 26 or newer. Before: `"engines": { "node": ">=24" }`. After: `"engines": { "node": ">=26" }`, and CI tests
  Node 26 only. On Node 24 npm warns at install (`EBADENGINE`). Why: the owner's floor for 1.0, and Node 26 is the
  active LTS from October 2026 (`M12-P2`).
- TypeScript 7.0 or newer for cloudrop's types. Before: the README said 5.4 or newer. After: 7.0 or newer. Why: the
  owner's floor for 1.0; the workspace and every lane already compile with TypeScript 7 (`M12-P3`).
- A database store you wrote yourself is wrapped with `defineStore` from the new entry `cloudrop/store`. Before:
  `createCloudrop({ store: myStore, ... })`. After: `import { defineStore } from "cloudrop/store"` and
  `createCloudrop({ store: defineStore(myStore), ... })`. Without it the server logs `INVALID_CONFIG` at start, every
  request answers a retryable 500 and every `api` call answers that `INVALID_CONFIG`. The adapters' stores (`sqlStore`, `drizzleStore`, `prismaStore`) and
  `memoryStore` need nothing, and neither does a store copied from one with spread (`M12-S1`, `M12-S2`).
- A wrapper around an adapter's store that copies it any other way than spread, such as
  `Object.fromEntries(Object.entries(store).map(...))` or a class that copies the methods, loses the store code and
  answers as above. Before: `createCloudrop({ store: logged(sqlStore(executor)), ... })`. After: copy with spread
  (`{ ...store, get: logged(store.get) }`), or wrap the result: `store: defineStore(logged(sqlStore(executor)))`
  (`M12-S1`, `M12-S2`).
- `api` has the store's calls only when `store` is passed. Before: a server without a store typed `api.files`,
  `api.file`, `api.allFiles`, `api.usage`, `api.revokeUploads`, `api.deleteFile`, `api.eraseOwner`, `api.reconcile`
  and `api.sweep`, which answered `INVALID_CONFIG`. After: they are type errors there, and a store that may be
  undefined (`store: flag ? s : undefined`, or a spread `...(store && { store })`) counts as none. An app with an
  opt-in store writes one view of `api` with the store's calls next to its server and calls them through it:
  `export const storeApi = store ? (cloudrop.api as StoreFileApi<RouteName<typeof cloudrop>>) : null;` (both types
  from `cloudrop`), then `if (storeApi) await storeApi.usage(userId)` where it wrote `cloudrop.api.usage(userId)`.
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
- The row status type is `FileRecordStatus`. Before: `import type { FileStatus } from "cloudrop"` (or
  `"cloudrop/store"`). After: `import type { FileRecordStatus } from "cloudrop"`. `FileStatus` from `cloudrop/client`,
  a file's state in an upload job, keeps its name (`M12-A1`).
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
- `authorize` may not return a field named `request`, `metadata`, `file`, `data`, `tx`, `route` or `signal`: it is a
  type error. Before: `authorize: () => ({ userId, route: "admin" })` compiled, and cloudrop's own `request`,
  `metadata` and `file` replaced fields of those names. After: wrap the value, such as
  `authorize: () => ({ userId, scope: { route: "admin" } })`. The runtime is unchanged (`M12-A8`).
- The client's `namespace` defaults to `account` when `account` is a string. Before:
  `createCloudropClient({ namespace: userId, account: userId })`, and `{ account: userId }` alone kept records under
  `""`. After: `createCloudropClient({ account: userId })` keeps them under `userId`. A function `account` keeps `""`,
  and an explicit `namespace` wins. A page that passed `account` alone stops listing the unfinished uploads it saved
  under `""` before the upgrade; pass `namespace: ""` for a day to keep them resumable (`M12-A4`).

### Added

- `cloudrop/store`: `defineStore` and the store types, for a database store you write yourself (`M12-S2`).
- A type per record status, from `cloudrop` and `cloudrop/store`: `PendingRecord`, `CompletingRecord`,
  `CompletedRecord`, `DeletedRecord`, `AbortedRecord`, `ExpiredRecord`, `RejectedRecord`, `FailedRecord`, and
  `RecordOf<S>` to pick one. `api.allFiles({ status: "failed" })` answers `FailedRecord`s (`M12-T1`, `M12-T4`).

### Changed

- The refusal of a `plugins` option that is not a list suggests `[contentChecks()]`, not the removed `limits()`
  (`M12-A11`).
- A server without a store no longer carries the store's code: it travels with the store object. The bundled server
  is 28.25 kB instead of 34.71 kB (gzip), and a server with a SQL store 33.61 kB instead of 33.13 kB (`M12-S1`).
- The size ceilings of every entry are raised for 1.0, so they guard against accidents and never block work (`M12-P1`).
  Bundle size is not covered by semver; the release notes give the sizes measured.

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
