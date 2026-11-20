# Changelog

Every notable change to the `cloudrop` package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0, a minor version may change the API.

## Unreleased

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
