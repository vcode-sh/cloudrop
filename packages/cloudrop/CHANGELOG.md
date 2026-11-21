# Changelog

Every notable change to the `cloudrop` package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0, a minor version may change the API.

## Unreleased

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
