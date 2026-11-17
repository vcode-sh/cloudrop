# cloudrop

Fast, resumable, direct-to-bucket file uploads for Cloudflare R2 and S3-compatible storage.

## Status

Nothing usable is published yet; `cloudrop@0.0.0` on npm only reserves the name.

- M0 (real-R2 spike) and M1 (storage: SigV4 signer, `r2` and `s3` drivers, contract suite): done.
- M2 (the server: `createCloudrop`, routes, upload tokens, the handler, completion checks, `cloudrop.api`, the Next.js
  and Node adapters): done.
- M3 (the upload engine and the browser client): the first slice, both progress plans and the resume plan are done on
  this branch. `cloudrop/client` uploads one file or several per call, as one `PUT` or in parts, with retries, URL
  renewal, a connection pool shared by the client that sizes itself, progress, speed and time left, pause, resume,
  cancel and retry per file, recovery from stalled requests and lost connectivity, and resume after a reload. React
  hooks (`useUpload`) arrive in M4.

Why the code is the way it is, and what the M2 reviews changed: [docs/decisions](docs/decisions/README.md).

## Quickstart

The five-line path from server to upload (the route's `authorize` is shown in full under [Server](#server)):

```ts
// lib/cloudrop.ts: the server
export const cloudrop = createCloudrop({
  storage: r2({ bucket: "media" }),
  routes: { files: route({ accept: "image/*", maxSize: "5MB", authorize }) },
});

// app/api/cloudrop/[...all]/route.ts: the handler
export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);

// the browser: a type import, because a value import would pull the server, its storage driver and its secret
// settings into the browser bundle
import { createCloudropClient } from "cloudrop/client";
import type { cloudrop } from "./lib/cloudrop";
const { upload } = createCloudropClient<typeof cloudrop>();
const { data, error } = await upload("files", file);
```

`upload()` never rejects for an expected failure. Branch on `error.code`; show `error.message`, which says what to do
next:

```ts
if (error) {
  showError(error.message); // e.g. ABORTED after a cancel, UNAUTHORIZED, FILE_TOO_LARGE, NETWORK_ERROR
} else {
  console.log(data.file.key, data.data); // data.data is what the route's onComplete returned, null without one
}
```

A working version of all three files, with a demo sign-in, runs against a local RustFS container without any
credentials: [`examples/next`](examples/next/README.md).

Requirements: Node.js 24+, Bun, Deno or Workers on the server, a browser with `fetch` and `AbortSignal` for the client
(the browser lane tests Chromium only), and TypeScript 5.4 or newer for cloudrop's types (`route()`'s return type uses
`NoInfer`).

## Goals

- Headless core with a small footprint, plus thin React, Vue and Svelte bindings.
- R2-correct multipart uploads (equal part sizes), adaptive concurrency, retries, pause, resume and abort.
- Resume after a page reload.
- One framework-agnostic server handler (`Request` in, `Response` out) that signs uploads, requires authorization
  and verifies size and type on completion.
- Tested against real R2 and several S3-compatible servers.

## Server

```ts
// lib/cloudrop.ts
import { createCloudrop, r2, route, unauthorized } from "cloudrop";

export const cloudrop = createCloudrop({
  storage: r2({ bucket: "media" }), // CLOUDROP_R2_ACCOUNT_ID, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY from the environment
  // secret: CLOUDROP_SECRET from the environment (openssl rand -base64 32)
  routes: {
    avatar: route({
      accept: "image/*",
      maxSize: "5MB",
      authorize: async ({ request }) => {
        const user = await getUser(request); // your session lookup
        return user ? { userId: user.id } : unauthorized();
      },
      prefix: ({ userId }) => `users/${userId}/avatars`,
    }),
  },
});
```

Write `authorize` before `prefix`, `key` and `onComplete`: TypeScript types their context from its result in the order
the options are written. Its result is signed into the upload token, which the browser can read, so return ids, never
secrets.

### Mounting the handler

`cloudrop.handler(request)` takes a `Request` and always resolves to a `Response`. It serves `POST` (and the CORS
preflight, `OPTIONS`) to `/api/cloudrop/upload`, `/sign`, `/complete` and `/abort` (change the prefix with
`basePath`), in any framework that speaks `Request` and `Response`.

```ts
// Next.js: app/api/cloudrop/[...all]/route.ts
import { toNextHandler } from "cloudrop/next";
export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);

// Node http or http2, or Express mounted at the path, before any body parser
import { toNodeHandler } from "cloudrop/node";
http.createServer(toNodeHandler(cloudrop));
app.use("/api/cloudrop", toNodeHandler(cloudrop));
```

`toNodeHandler` takes the request's origin from `Host` (or HTTP/2's `:authority`) and the scheme from the connection,
never from `X-Forwarded-*` or `:scheme`. It answers `400` when that host is missing, sent twice, malformed (userinfo, a
path, an invalid port) or names another origin in `host` than in `:authority`, rather than guess one such as
`localhost`, since the origin decides the same-origin check. It also answers `400` to a request target that is not a
path, such as the absolute form `POST http://host/api/cloudrop/upload`: browsers send that form only to proxies, and
accepting it would let the target choose the origin. A hand-built request without `rawHeaders` is read from `headers`
alone.

### Origins

The handler accepts requests from its own origin and from `trustedOrigins` (exact origins such as
`"https://app.example.com"`, never `"*"`), and requests without `Origin`, which come from servers and native apps
(unless `Sec-Fetch-Site: cross-site` shows a browser that dropped it).
It sees its own origin in the request URL and trusts no `X-Forwarded-*` header. Behind a proxy that terminates TLS or
rewrites `Host`, your own pages therefore look cross-origin: list the app's public origin in `trustedOrigins`. The
first time the handler refuses a request from an origin, it logs a warning naming the refused origin and the one it
sees (for up to 16 origins).

### Uploads and the token

- `/upload` checks the request, validates the route's metadata schema, runs `authorize`, then checks each file's size
  and type before anything is signed. File names are normalized to NFC before they are counted (1 to 255 Unicode
  code points) and stored.
- `authorize` runs only in `/upload`. The token it signs is the authority for that file for 24 hours: a session revoked
  mid-upload can still finish the upload, so re-check the session in `onComplete` when that matters (`request` carries
  the caller's cookies and headers).
- `/abort` is cleanup, not revocation. Until the token expires, whoever holds it can get a new single-PUT URL,
  upload and complete, and can delete its own completed file through `/abort`. Upload URLs live 15 minutes.
- `/abort` still cleans up, and runs `onAbort`, after a deploy removed or renamed the token's route; `/sign` and
  `/complete` refuse such a token.
- A custom `key` must be unique: a rejected or aborted upload's object is deleted by key after a HEAD, not
  conditionally.
- Hooks can run more than once: a retried or replayed request repeats `afterVerify` and `onComplete` (on `/complete`)
  and `onAbort` (on `/abort`). Make their side effects idempotent by the stable `file.id`.

### File API

`cloudrop.api` works on the same storage and returns `{ data, error }`: `getUrl`, `head`, `put`, `delete`,
`deleteMany`, `copy`, `deletePrefix` (a folder prefix ending in `/`, emptied and listed again to prove it) and
`checkBucket`. `checkBucket({ origins })` reports CORS for browser uploads, the abort-incomplete lifecycle rule and
private routes on a public bucket. An R2 object token may not read bucket settings, so those checks come back
`unknown`, as do settings the storage cannot report at all (Wrangler's local R2 answers `501 NotImplemented`); with
an admin read token, R2's answers have not been measured yet. In development
(`NODE_ENV=development`) the first request runs it once and logs each problem.

## Client

```ts
"use client";
import { createCloudropClient } from "cloudrop/client";
import type { cloudrop } from "../lib/cloudrop"; // a type import: no server code or secret reaches the browser

// options: basePath (default "/api/cloudrop"), fetch, concurrency (bucket PUTs at once: "auto", the default, or 1 to
// 16), order ("added", the default, or "smallest-first"), persist and namespace (see Resume after reload)
const client = createCloudropClient<typeof cloudrop>();

const controller = new AbortController();
const { data, error } = await client.upload("avatar", file, { signal: controller.signal });
```

- `upload(route, file, options?)` sends one `File`. The route name, the metadata (`options.metadata`, required when
  the route's schema requires it) and the result type (`data.data`, what `onComplete` returned) are inferred from
  `typeof cloudrop`. `const { upload } = createCloudropClient()` works too. Passed a list (an array or `input.files`),
  `upload()` resolves to the job's result described below.
- Files up to the server's `multipartThreshold` (64 MiB by default) go in one `PUT`, larger ones in parts of 8 MiB
  (16 MiB from 256 MiB, larger only when a file would need over 10,000 parts), at most four of a file at a time, read
  with `Blob.slice`. A request is tried up to 6 times with backoff, honouring `Retry-After`; an expired upload URL is
  renewed once; parts that `/complete` reports missing are sent again, at most twice.
- A file that `/upload` refuses with a retryable error (the storage service failed or was busy while the server
  started it) asks `/upload` again for itself alone, with the backoff above and within the attempts the job's
  `/upload` left, while the job's other files go on. It stays `queued` while it waits; pausing it or going offline
  stops the wait until it resumes, and cancelling it ends it `aborted` at once without another request. A refusal that
  is not retryable, such as a file over the size limit, fails the file at once.
- In a browser, a bucket `PUT` that makes no progress for 30 s, or whose answer takes that long after the last byte,
  counts as a network error and is tried again. Through `fetch`, which reports no progress, a `PUT` gets 30 s plus its
  size at 100 KiB/s.
- Cancelling through `options.signal` returns `ABORTED` and tells the server to clean up with `/abort`. A file of
  `upload()` that fails after `/upload` is cleaned up the same way, in the background, so `upload()` answers the error
  at once (a file of `start()` is kept for `retry()` instead: see below). The one exception is a file after a
  `/complete` that may have succeeded: it is kept, never deleted.
- Four error codes come from the client and never from the server: `UPLOAD_REJECTED` (the bucket refused the bytes as
  signed: a different size, type or checksum), `ABORTED` (a cancel), `NETWORK_ERROR` (no answer after every attempt;
  retryable) and `UPLOAD_IN_USE` (`resume()` found the upload held in this browser: see
  [Resume after reload](#resume-after-reload)).
- Endpoint requests send cookies (`credentials: "include"`), so `authorize` can read the session; uploads to the bucket
  send none.
- Wire types (`UploadRequest`, `FileTicket`, `ErrorBody` and the rest) and the route inference types (`RouteName`,
  `RouteMetadata`, `RouteResult`, `InferableCloudrop`) are imported from `cloudrop/client`, never from `cloudrop`.

The bucket needs a CORS rule for your page's origin; [`examples/next`](examples/next/README.md#what-any-bucket-needs)
lists what any bucket needs. Add `Retry-After` to the rule's `ExposeHeaders` beside `ETag`. A browser hides every
answer header the rule does not expose: with `Retry-After` exposed, a retry after a `429` or `503` waits at least as
long as the bucket asks (at most 20 s); without it, the client cannot read the header and waits its own backoff alone
(a random wait up to 0.5 s, then 1 s, 2 s…). R2 answers concurrent writes to one key with `429` and `Retry-After: 5`,
which a page cannot read when the rule omits it (measured 2026-11-16,
[findings](docs/research/r2-spike-findings.md#bad-checksum-gone-upload-and-throttling-from-a-browser-2026-11-16)).
Why the client behaves as it does: [M3-S decisions](docs/decisions/m3-slice.md) and
[M3-U decisions](docs/decisions/m3-uploader.md).

Troubleshooting: when every upload ends in `NETWORK_ERROR` "The file could not reach the storage service, or the storage
service refused it" although the connection works, check the bucket's CORS rule first. A rule that misses the page's
origin, or one of the headers cloudrop signs (or a checksum header you add), blocks every `PUT`, and the browser shows
it as a network failure only after the retry budget; the browser console names what was blocked, and
`cloudrop.api.checkBucket({ origins })` checks the rule when the credentials may read it.

### Several files, progress and pause

```ts
const job = client.start("files", input.files, { metadata, signal }); // a File, an array or input.files
const unsubscribe = job.subscribe(() => render(job.getSnapshot())); // or React's useSyncExternalStore
job.files[0].pause(); job.files[0].resume(); job.files[0].abort();   // one file
job.pause(); job.resume(); job.abort();                              // every file of the job
const { data, error } = await job.done;
const again = await job.retry(); // or job.files[0].retry(): the failed files again
```

- `start()` sends every file through one `/upload`, then runs each file on its own: one file failing or being
  cancelled never stops another. `job.files` and `getSnapshot().files` are in the order the files were passed; each
  file has an `id` (`"1"`, `"2"`, …) that is unique per client.
- `getSnapshot()` returns the same object until something changes, so `useSyncExternalStore(job.subscribe,
  job.getSnapshot)` works. Each file has `status` (`queued`, `uploading`, `paused`, `completing`, `done`, `failed` or
  `aborted`), `bytes`, `size`, `progress` (0 to 1), `speed` (bytes per second, averaged over about 3 s), `eta`
  (seconds, null while nothing moves), `error` and `result`. `totals` adds up the files that did not fail or abort and
  counts the done, failed and aborted ones. Listeners are called at once on a status change, at most every 100 ms
  while bytes flow, and every second while a file uploads.
- `pause()` stops a queued or uploading file's requests and keeps the parts that landed; `resume()` sends only the
  rest, and a single `PUT` starts again. A file that is completing (its bytes all sent) ignores `pause()`. `abort()`
  is the cancel described above.
- `job.done`, and `upload()` with a list, resolve to an `UploadResult`: `data.files` holds an outcome per file
  (`status: "done"` with its `result`, or `"failed"` or `"aborted"` with its `error`), and `error` is the error of the
  first file, in the order passed, that did not end done. Unlike other results, `data` stays when some files failed;
  it is null only when nothing started: wrong arguments, or `/upload` refused the whole job (such as
  `TOO_MANY_FILES`). An error that belongs to one file carries `error.file` (`{ id, name }`). A value typed
  `File | File[]` fits neither `upload()` signature: pass it to `start()` and await `start(...).done`.
- One client shares its connection slots between all its uploads; each bucket `PUT` holds one, and one file has at
  most four parts in flight. Calls to your server take no slot. With `concurrency: "auto"`, the default, the client
  starts with 4 slots and adds one, up to 8, after each 2 s in which the bytes sent rose by 10 % or more while `PUT`s
  waited; a network error, a stall or a `429` or `503` from the bucket halves the slots. A number from 1 to 16 fixes
  them. Files added earlier go first; with `order: "smallest-first"` smaller files go first, across every job of the
  client.
- When the page goes offline, every queued and uploading file pauses (`status: "paused"`) and resumes when it is back
  online; a file the caller paused stays paused, and a caller's `pause()` or `resume()` of a file the network paused
  makes it the caller's. Files that start while the page is offline pause before any `PUT`. The `/upload` that
  starts a job is not held: with no network it fails every file with `NETWORK_ERROR` after its attempts, and `retry()`
  sends it again.
- `job.files[n].retry()` sends a failed file again and resolves with its outcome; `job.retry()` does that for every
  failed file and resolves with an `UploadResult` of the job's current outcomes once every file has settled (`data` null
  when its `/upload` for every file was refused, as with `done`). A retry reuses the file's ticket when it can, so the
  parts that landed are not sent again and the bytes stay counted. It asks `/upload` for a new ticket when the old one
  expired or was given up, or the failure was one a new attempt with it cannot fix (`UPLOAD_EXPIRED`, `INVALID_TOKEN`,
  `UPLOAD_REJECTED`, `VERIFICATION_FAILED`, `NO_SUCH_UPLOAD`, or a file that never got a ticket); `job.retry()` asks for
  all of those files in one `/upload`. On a new ticket the file starts again under a new key, and its `bytes` drop to 0.
  When a `/complete` may have succeeded, a retry sends `/complete` again first, never a second upload. `retry()` of a
  file that is still running waits for it to settle; of a done or aborted file, it answers that outcome at once.
  `job.done` keeps each file's first outcome whatever a retry does later; the snapshot shows the current one.
- A failed file of `start()` keeps its ticket and the parts that landed, so `retry()` can reuse them, until `abort()`
  of the file or the job (or `options.signal`), `pagehide`, or the ticket's expiry (24 hours); `abort()` and
  `pagehide` tell the server with `/abort`, and after expiry the bucket's lifecycle rule removes unfinished parts. A
  failed single `PUT` object kept until expiry stays in the bucket: call `job.abort()` once you will not retry.
  `upload()` returns no handle to retry with, so its failed files are cleaned up at once, as above.
- In a browser, bucket `PUT`s go through `XMLHttpRequest`, which reports bytes while they are sent. Passing `fetch`
  sends everything through it, `PUT`s included: a part's bytes then count only once it is stored, so progress moves a
  part at a time. Outside a browser (Node, Bun, Deno, Workers) `PUT`s use `fetch` the same way.

### Resume after reload

A file sent in parts (over the `multipartThreshold`, 64 MiB by default) survives a reload or a closed tab: the client
keeps a record of its upload in the browser's IndexedDB, and when the user picks the same file again, only the parts the
bucket does not hold are sent. It is on by default and needs nothing on the server. Files sent in one `PUT` are not
kept: a reload loses them, and the page starts them again.

```ts
const client = createCloudropClient<typeof cloudrop>({
  namespace: user.id, // the signed-in user's id: one user's unfinished uploads never mix with another's
  // persist: false,  // keeps nothing on disk, and nothing can be resumed after a reload
});

// After the reload: what can be continued, newest first, for one route (every route without an argument).
const { data: unfinished } = await client.resumable("files"); // null when the browser's storage failed
const upload = unfinished?.[0]; // { id, route, name, size, type, lastModified, expiresAt }: enough to ask for the file

// The user picks the file again, through a file input or a drop.
if (upload) {
  const job = client.resume(upload, picked, { signal });
  const { data, error } = await job.done; // an UploadResult of one file, as start(...).done gives
}

// At sign-out:
await client.forget();
```

- **The user picks the file again.** A page cannot get a `File` back after a reload: a browser hands a page a file
  only when the user picks or drops it, and cloudrop does not copy files (see the end of this section). `resumable()`
  gives the name and size to ask for. `start()` and `upload()` never match a file against a record: the same file
  passed to them is uploaded again under a new key.
- **The same file** means equal name, size, `lastModified` and type, and an equal SHA-256 of its first and last 64 KiB
  (of the whole file up to 128 KiB). It is a heuristic: a file changed only in the middle, with the same timestamp,
  passes.
- **`resume(upload, file, options?)`** returns an `UploadJob` of one file with everything a job of `start()` has:
  `subscribe`, `getSnapshot`, `pause`, `resume`, `abort`, `retry` and `done`. The route and the metadata come from the
  record; `signal` is the only option. Its one file is `queued` while the record, the file and the lock are checked.
  When a check fails, its `done` resolves `{ data: null, error }` before any request, with `INVALID_INPUT` for wrong
  arguments or a different file, `NOT_FOUND` when there is no unexpired record of that upload in the client's
  namespace (it finished, was cancelled or expired, or persistence is off), `STORAGE_ERROR` when the browser's storage
  cannot be read, or `UPLOAD_IN_USE` (below); a cancel meanwhile resolves `ABORTED` the same way. `retry()` of a
  refused job runs the checks again: it resolves the same refusal while they fail, sending nothing, and resumes once
  they pass, as after `UPLOAD_IN_USE` once the other tab let go, or `STORAGE_ERROR` once the storage reads again.
- **The server is asked first.** Once the checks pass, the file is `completing`, and its first request is `/complete`
  with the saved token, which lists the bucket's parts: one `ListParts`, a Class A operation, per resumed file.
  - All there, or a `/complete` that finished before the reload: the file ends done without a `PUT`. The route's
    `afterVerify` and `onComplete` run again then, so make them idempotent by `file.id`, as for any retried request.
  - Parts missing: exactly those are sent, then `/complete` again. The parts that landed count in `bytes` from that
    answer; before it, `bytes` is 0.
  - The upload is gone (`UPLOAD_EXPIRED`, `INVALID_TOKEN` or `NO_SUCH_UPLOAD`): the file is `queued` again, asks
    `/upload` once for a new ticket with the record's route and metadata and sends the whole file under a new key, its
    `bytes` from 0, with no failure in between. The old parts wait for the bucket's lifecycle rule. When that `/upload`
    is refused, the file ends `failed` with its error.
  - Any other failure ends the file `failed` and keeps its record; `retry()` asks `/complete` again, and so does a
    `resume()` after a reload that left the record (see when a record is deleted, below).
- **What is stored**, one record per upload, in the IndexedDB database `cloudrop`: the upload's id, route and the
  metadata sent to `/upload`; its upload token, key, part size, part count and expiry; the file's name, size, type,
  `lastModified` and fingerprint; and the namespace. Never a presigned URL, an ETag or a part list. The token is a
  bearer credential for its upload for 24 hours: it signs `PUT`s for its key, completes the upload, and through
  `/abort` cancels it or deletes its finished file. It is signed, not encrypted, so what `authorize` returned and the
  metadata can be read from it.
- **When a record is deleted:** when its file ends done or is cancelled, or `upload()` cleans up a failed file; when a
  new ticket replaces it; when `pagehide` gives up a failed file's ticket with `/abort`; when it is found expired, by
  `resumable()`, `resume()` or the next save (a minute early, so a listed upload has time to start); and on `forget()`.
  So after a reload, the uploads left to resume are those that were still uploading or paused, and failed files after a
  `/complete` that may have succeeded (every failed file, when the page crashed and `pagehide` never fired). A delete
  issued in `pagehide` may not commit before the page unloads: the next page then still lists that upload. Resuming it
  finds the upload gone when the `/abort` reached the server, and starts over with a new ticket, sending every byte;
  when the `/abort` did not, only the missing parts are sent.
- **Two tabs.** The page that holds an upload's ticket holds a Web Lock on it (`cloudrop:upload:<id>`) as long as it
  keeps the ticket: while the file runs, while a failed file waits for `retry()`, and until the server answered the
  `/abort` that gives it up. `resume()` of an upload held in another tab, or in this page, ends with `UPLOAD_IN_USE` and
  sends nothing: finish or cancel it there. `resumable()` still lists held uploads. A record is saved only once its
  lock is held: without the lock, a second holder could complete an upload whose `/abort` this page then sends,
  deleting the stored file.
- **Namespace and sign-out.** Pass the signed-in user's id as `namespace` (a string of up to 256 characters, `""` by
  default): a client sees only its namespace's records, and the namespace is fixed when the client is created, so create
  a new client when the user changes. Call `forget()` at sign-out: it deletes the namespace's records and resolves
  `{ data: { forgotten }, error }`, counting the records it deleted, expired ones included; `forget({ all: true })`
  deletes every record of this origin, and any other argument is `INVALID_INPUT`. Uploads that are running keep going;
  abort their jobs to stop them. Without `forget()`, a signed-out user's unfinished uploads, tokens included, stay on
  the browser profile for up to 24 hours, and another user signed in on the same profile and namespace could finish
  them. They stay the first user's files, since `authorize` runs only in `/upload`: re-check the session in `onComplete`
  when that matters.
- **Off, or no storage.** Resuming needs a secure context (HTTPS, or `localhost` in development), where browsers have
  Web Locks. With `persist: false`, or where there is no `indexedDB` (Node, Bun, Deno, Workers) or no Web Locks (a page
  served over plain HTTP, such as a LAN address), nothing is read or written: `resumable()` resolves `[]`, `resume()`
  ends with `NOT_FOUND` and `forget()` with `{ forgotten: 0 }`. The same goes where the browser refuses the lock (a
  document no longer active, an opaque origin): that upload keeps no record, and still uploads. The client looks for
  `indexedDB` and Web Locks once, when it is created: create it after any polyfill for them. `resumable()` and `forget()` never reject; when the browser's storage fails they resolve
  `STORAGE_ERROR`. A storage failure never fails, pauses or slows an upload. Records live in the origin's best-effort
  storage, which a browser may evict under pressure; cloudrop never calls `navigator.storage.persist()`, since Firefox
  would prompt the user for it, so call it yourself if you want persistent storage.
- **Not supported:** resuming without picking the file again (a copy into the origin-private file system is deferred
  to a later opt-in: it needs Safari 26 or a worker, and writes every file a second time); files sent in one `PUT`;
  resuming on another device or browser; continuing an upload after its 24-hour token expired (its record is deleted,
  the old parts wait for the bucket's lifecycle rule, and the file is started again).

### Not done yet

- The upload protocol is tested on the in-process fake, on real R2, and from Chromium through the example on RustFS
  and on real R2. Wrangler runs only the storage contract and, in the example, single uploads: its local R2 does not
  implement ListParts, so a multipart upload cannot complete there.
- The client has no React hooks yet.
- How the server's parallel storage calls fit Cloudflare Workers' subrequest limits is unmeasured.

## Development

```bash
bun install
bun run verify        # check, typecheck, test, build and package checks
bun run test:rustfs   # storage contract on RustFS in Docker
bun run test:wrangler # storage contract on Wrangler's local R2
bun run test:live     # storage contract and upload protocol on real R2 (credentials: CLOUDROP_R2_ENV_FILE)
bun run test:browser  # the example in Chromium's headless shell, uploading to RustFS in Docker
bun run test:browser:live # the same on real R2 (credentials as test:live; CORS must allow localhost:5173)
```

Background research: [`docs/research`](docs/research). Measured backend behaviour:
[`docs/research/test-backends.md`](docs/research/test-backends.md).

Not affiliated with Cloudflare.

## License

[MIT](LICENSE)
