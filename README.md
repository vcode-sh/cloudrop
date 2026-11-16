# cloudrop

Fast, resumable, direct-to-bucket file uploads for Cloudflare R2 and S3-compatible storage.

## Status

Nothing usable is published yet; `cloudrop@0.0.0` on npm only reserves the name.

- M0 (real-R2 spike) and M1 (storage: SigV4 signer, `r2` and `s3` drivers, contract suite): done.
- M2 (the server: `createCloudrop`, routes, upload tokens, the handler, completion checks, `cloudrop.api`, the Next.js
  and Node adapters): done.
- M3 (the upload engine and the browser client): the first slice and the first progress plan are done on this branch.
  `cloudrop/client` uploads one file or several per call, as one `PUT` or in parts, with retries, URL renewal, a
  connection pool shared by the client, progress, speed and time left, and pause, resume and cancel per file. Automatic
  concurrency, stall and offline handling and `retry()` come in the next plan, resume after a reload later. React hooks
  (`useUpload`) arrive in M4.

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

// options: basePath (default "/api/cloudrop"), fetch, concurrency (bucket PUTs at once, 1 to 16, default 4)
const client = createCloudropClient<typeof cloudrop>();

const controller = new AbortController();
const { data, error } = await client.upload("avatar", file, { signal: controller.signal });
```

- `upload(route, file, options?)` sends one `File`. The route name, the metadata (`options.metadata`, required when
  the route's schema requires it) and the result type (`data.data`, what `onComplete` returned) are inferred from
  `typeof cloudrop`. `const { upload } = createCloudropClient()` works too. Passed a list (an array or `input.files`),
  `upload()` resolves to the job's result described below.
- Files up to the server's `multipartThreshold` (64 MiB by default) go in one `PUT`, larger ones in parts, four at a
  time, read with `Blob.slice`. A request is tried up to 6 times with backoff, honouring `Retry-After`; an expired
  upload URL is renewed once; parts that `/complete` reports missing are sent again, at most twice.
- Cancelling through `options.signal` returns `ABORTED` and tells the server to clean up with `/abort`. A file that
  fails after `/upload` is cleaned up the same way, in the background, so `upload()` answers the error at once. The
  one exception is a file after a `/complete` that may have succeeded: it is kept, never deleted.
- Endpoint requests send cookies (`credentials: "include"`), so `authorize` can read the session; uploads to the bucket
  send none.
- Wire types (`UploadRequest`, `FileTicket`, `ErrorBody` and the rest) and the route inference types (`RouteName`,
  `RouteMetadata`, `RouteResult`, `InferableCloudrop`) are imported from `cloudrop/client`, never from `cloudrop`.

The bucket needs a CORS rule for your page's origin; [`examples/next`](examples/next/README.md#what-any-bucket-needs)
lists what any bucket needs. Why the client behaves as it does: [M3-S decisions](docs/decisions/m3-slice.md) and
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
  `TOO_MANY_FILES`). An error that belongs to one file carries `error.file` (`{ id, name }`).
- One client shares `concurrency` slots between all its uploads; each bucket `PUT` holds one, files added earlier go
  first, and one file has at most four parts in flight. Calls to your server take no slot.
- In a browser, bucket `PUT`s go through `XMLHttpRequest`, which reports bytes while they are sent. Passing `fetch`
  sends everything through it, `PUT`s included: a part's bytes then count only once it is stored, so progress moves a
  part at a time. Outside a browser (Node, Bun, Deno, Workers) `PUT`s use `fetch` the same way.

### Not done yet

- The upload protocol is tested on the in-process fake, on real R2, and from Chromium through the example on RustFS
  and on real R2. Wrangler runs only the storage contract and, in the example, single uploads: its local R2 does not
  implement ListParts, so a multipart upload cannot complete there.
- The client has no automatic concurrency, smallest-first order, offline handling, `retry()` of a failed file or
  resume after a reload yet, and no React hooks.
- No stall detection yet: a request that never answers keeps `upload()` pending until the caller cancels it through
  `options.signal`.
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
