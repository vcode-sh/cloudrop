# Client

This page is for developers writing the browser side without React, or wanting to know what the hooks run on. It covers
`cloudrop/client`: creating a client, uploading one file or several, following progress, pausing, cancelling and
retrying, how the client shares connections between uploads, what happens when the page goes offline or a request
stalls, what it cleans up, and closing it when the user signs out. Resuming after a reload, and `resumable()`, `resume()`, `discard()` and `forget()`, have
their own page: [Resume after reload](resume.md). Error codes: [Errors](errors.md).

## Create a client

```ts
"use client";
import { createCloudropClient } from "cloudrop/client";
import type { cloudrop } from "../lib/cloudrop"; // a type import: no server code or secret reaches the browser

const client = createCloudropClient<typeof cloudrop>();
```

Import the server with `import type`. A value import would pull the server, its storage driver and its secret settings
into the browser bundle. The type is enough for the client to know your route names, each route's metadata and what
each route's `onComplete` returns.

| Option | What it does | Default |
| --- | --- | --- |
| `basePath` | Where the server's handler is mounted: a path on this page's origin, or an absolute URL such as `"https://api.example.com/api/cloudrop"`. No trailing slash, query or fragment. For a handler on another origin, list the page's origin in the server's `trustedOrigins`, or every call gets `ORIGIN_NOT_ALLOWED`. | `"/api/cloudrop"` |
| `headers` | Headers for the requests to your server (`/upload`, `/sign`, `/complete`, `/abort`), never for bucket `PUT`s: an object, or a function, possibly async, called before each request (see [Send a bearer token](#send-a-bearer-token)). | none |
| `account` | The signed-in user this page shows, as the route's `owner` returns it, sent with `/upload` only: a string, `""` for nobody, or a function, possibly async, called before each `/upload` (see [Guard against a changed account](#guard-against-a-changed-account)). | none |
| `fetch` | Replaces the global `fetch`, for tests and runtimes that bring their own. Passing it also sends bucket `PUT`s through it (see [Transports](#transports-xhr-or-fetch)). | global `fetch` |
| `concurrency` | How many bucket `PUT`s the client sends at once, across all its uploads: `"auto"` or a whole number from 1 to 16 (see [Concurrency and order](#concurrency-and-order)). | `"auto"` |
| `order` | Which `PUT`s go first when they wait for a connection: `"added"` or `"smallest-first"`. | `"added"` |
| `persist` | Keeps unfinished multipart uploads in IndexedDB so they can resume after a reload. `false` keeps nothing on disk. | `true` |
| `namespace` | Keeps one signed-in user's unfinished uploads apart from another's: pass the user's id. At most 256 characters. | `""` |

A wrong option throws `INVALID_CONFIG` when the client is created. Wire types (`UploadRequest`, `FileTicket`,
`ErrorBody` and the rest) and the route inference types (`RouteName`, `RouteMetadata`, `RouteResult`,
`InferableCloudrop`) are imported from `cloudrop/client`, never from `cloudrop`.

In React, [`cloudrop/react`](react.md) creates the client for you and gives you hooks for inputs, drop zones and
progress.

### Send a bearer token

The client sends cookies to your server. An app that keeps its session in a token instead, such as a desktop or mobile
shell around a web view, or a session handed over by QR code, adds it with the `headers` option:

```ts
const client = createCloudropClient<typeof cloudrop>({
  basePath: "https://api.example.com/api/cloudrop",
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }), // your app's token, refreshed when needed
});
```

On the server, `authorize` reads `request.headers.get("authorization")`.

- **Only your server gets them.** The headers go with `/upload`, `/sign`, `/complete` and `/abort`, never with a
  bucket `PUT`: a presigned URL must not carry your token, and bucket `PUT`s keep `XMLHttpRequest` and its byte-by-byte
  progress (see [Transports](#transports-xhr-or-fetch)).
- **A function runs before each request,** so each request carries the token of its moment, and a token that expires
  during a long upload is refreshed for the next `/sign` or `/complete`. An object is sent as it is with every request.
- **When the function throws or rejects,** that request is not sent and fails with `NETWORK_ERROR`, which the client
  retries as any network failure. Its time counts against the request's timeout, and a cancel stops the wait.
- **`content-type` stays the client's.** A `content-type` among the headers is replaced by `application/json`.
- **At sign-out, await [`close()`](#close-the-client)** before the session the function reads ends: each `/abort`
  calls the function too. Return no headers rather than throw when signed out: `/abort` needs only the upload token.
- **At `pagehide`, an async function may be too late.** The `/abort` a closing page sends for a failed file waits for
  it, and a page that is gone sends nothing. The bucket's lifecycle rule and, with a store, the sweep clean up.
- **From a page on another origin,** the `authorization` header makes the browser send a preflight first. The handler
  allows the headers a page on a `trustedOrigins` origin asks for.
- **A request without an `Origin` header,** as a native app sends, needs no `trustedOrigins` entry (see
  [Origins](server.md#origins)).

### Guard against a changed account

A browser sends one session cookie for every tab. When someone signs in as another user in another tab, a file still
queued in this tab, or retried here, would ask `/upload` with the new session and become the other user's file. Tell the
client who this page belongs to, and the server refuses that upload:

```ts
// account: the user this page shows, as the routes' owner returns it
const client = createCloudropClient<typeof cloudrop>({ namespace: userId, account: userId });
```

- **What is compared.** On a route with a [store](store.md) and `owner`, the server compares `account` with what
  `owner` returns for the request's session. When they differ, the whole `/upload` is refused with `ACCOUNT_CHANGED`,
  not retryable, before any plugin, reservation or storage call, and each of its files ends `failed`. Its message asks
  the person to reload the page.
- **Pass what `owner` returns,** usually the user's id, at most 255 characters. `""` means nobody is signed in on this
  page: an upload whose session has an owner is refused too.
- **A function** is called before each `/upload`, retries included; return the user this page shows, not a fresh read
  of the session, which would always agree. `null` or `undefined` sends no account. When the function throws, rejects
  or returns something else, the `/upload` is not sent and fails with `NETWORK_ERROR`, as for `headers`.
- **Only `/upload` carries it,** as the `x-cloudrop-account` header, percent-encoded; never `/sign`, `/complete`,
  `/abort` or a bucket `PUT`. The later calls need no check: each carries the upload token, which names the owner
  `/upload` saw.
- **Ignored without an owner.** On a route without `owner`, when `owner` returns `null`, and when the client sends no
  account (an older page during a deploy), the upload is checked as before. So the guard is safe only when the route's
  `authorize` refuses anonymous sessions: otherwise a page whose account signed out in another tab still uploads, as a
  file with no owner.
- **From a page on another origin,** the preflight that a cross-origin `/upload` already sends asks for this header too,
  and the handler allows it for a page on a `trustedOrigins` origin. A proxy or framework that answers preflights itself
  must allow `x-cloudrop-account`.

## Upload one file

```ts
const controller = new AbortController();
const { data, error } = await client.upload("avatar", file, { signal: controller.signal });

if (error) {
  showError(error.message); // your app's error display
} else {
  console.log(data.file.key, data.data); // data.data is what onComplete returned, null without one
}
```

- `upload(route, file, options?)` sends one `File` and resolves to `{ data, error }`. It never rejects for an expected
  failure.
- `options.metadata` is validated by the route's schema on the server. It is required when the route's schema requires
  it, and TypeScript enforces that.
- `options.signal` cancels the upload: requests stop, the server is told, and the result is `ABORTED`.
- `data.file` is the stored file: `id`, `key`, `name`, `size`, `type` and `url` (the public URL on a public route,
  otherwise `null`).
- No `this`: `const { upload } = createCloudropClient()` works too.

## Upload several files

Pass a list, such as an array or `input.files`, and `upload()` resolves to an `UploadResult` once every file has
settled:

```ts
const files = input.files; // a FileList, or null when the input has none
if (!files || files.length === 0) return;
const { data, error } = await client.upload("files", files);

for (const outcome of data?.files ?? []) {
  if (outcome.status === "done") console.log(outcome.name, outcome.result.file.key);
  else console.log(outcome.name, outcome.status, outcome.error.message); // "failed" or "aborted"
}
```

- `data.files` holds one outcome per file, in the order passed: `status: "done"` with its `result`, or `"failed"` or
  `"aborted"` with its `error`.
- `error` is the error of the first file, in the order passed, that did not end done.
- Unlike other results, `data` stays when some files failed. It is `null` only when nothing started: wrong arguments, or
  `/upload` refused the whole job (such as `TOO_MANY_FILES`).
- An error that belongs to one file carries `error.file`, `{ id, name }`.
- A value typed `File | File[]` fits neither `upload()` signature: pass it to `start()` and await `start(...).done`.

### Reset the file input

A browser fires no `change` event when the user picks the same file again, so clear the input after each pick. Copy the
files out of the input before you clear it.

```ts
input.addEventListener("change", () => {
  const files = Array.from(input.files ?? []);
  input.value = ""; // picking the same file again now fires change
  if (files.length > 0) void client.upload("files", files);
});
```

In React, `getInputProps()` from [`cloudrop/react`](react.md#one-file) does this for you.

## Jobs: progress, pause and retry

`start()` gives you a handle to follow and control the upload while it runs:

```ts
const files = input.files; // a FileList, or null when the input has none
if (!files || files.length === 0) return;
const job = client.start("files", files, { metadata, signal }); // a File, an array or a FileList
const unsubscribe = job.subscribe(() => render(job.getSnapshot()));

const first = job.files[0];
first?.pause(); first?.resume(); first?.abort(); // one file
job.pause(); job.resume(); job.abort();                            // every file of the job

const { data, error } = await job.done;
const again = await job.retry(); // or job.files[0].retry(): the failed files again
```

`input`, `metadata`, `signal` and `render` stand for your page's file input, the route's metadata, an optional
`AbortSignal` and your own rendering code.

- `start()` sends every file through one `/upload`, then runs each file on its own: one file failing or being
  cancelled never stops another.
- `job.files` and `getSnapshot().files` are in the order the files were passed. Each file has an `id` (`"1"`, `"2"`, …)
  that is unique per client.
- `job.done` resolves to the same `UploadResult` as `upload()` with a list, and never rejects.

### Snapshots and React

`getSnapshot()` returns the same object until something changes, so React's `useSyncExternalStore` works directly:

```tsx
import { useSyncExternalStore } from "react";
import type { UploadJob } from "cloudrop/client";

function Progress({ job }: { job: UploadJob<unknown> }) {
  const snapshot = useSyncExternalStore(job.subscribe, job.getSnapshot);
  return <progress value={snapshot.totals.progress} />;
}
```

Each file in `snapshot.files` has:

| Field | Meaning |
| --- | --- |
| `status` | `queued`, `uploading`, `paused`, `completing`, `done`, `failed` or `aborted`. The last three are final. |
| `bytes`, `size` | Bytes sent and the file's size. |
| `progress` | From 0 to 1. |
| `speed` | Bytes per second, averaged over about 3 s. 0 unless uploading. |
| `eta` | Seconds left at the current speed; `null` while nothing moves. |
| `error`, `result` | The file's error, or its `/complete` result. |

`snapshot.totals` adds up `bytes`, `size`, `progress`, `speed` and `eta` over the files that did not fail or abort, so
a failed file never holds the job below 1. It also counts the `done`, `failed` and `aborted` files, and `count` is every
file of the job.

Listeners are called at once on a status change, at most every 100 ms while bytes flow, and every second while a file
uploads.

### Statuses

```text
queued -> uploading -> completing -> done
completing -> uploading                     (/complete reported parts missing)
queued or uploading -> paused -> (resume) -> queued
any status that is not final -> failed or aborted
```

A file is `queued` until its first bucket `PUT` gets a connection, `uploading` while its bytes go to the bucket, and
`completing` once every byte is sent and `/complete` runs. When `/complete` reports parts missing, the file goes back to
`uploading` to send them. A file resumed after `pause()` is `queued` again until it gets a connection. A file resumed
after a reload starts `queued` while its record is checked, then goes to `completing`, since its first request is
`/complete` (see [Resume after reload](resume.md#the-server-is-asked-first)).

### Pause and resume

- `pause()` stops a queued or uploading file's requests and keeps the parts already stored in the bucket. A file that
  is completing (its bytes all sent) ignores it.
- `resume()` sends only the parts not yet stored in the bucket. A single `PUT` starts again from the beginning.
- `job.pause()` and `job.resume()` do that for every file.

### Test pause and progress locally

On `localhost` an upload finishes before you can press Pause. Slow it down:

- In Chrome's DevTools, open the Network panel and pick a throttling profile such as "Slow 4G", or add a custom one.
  It slows the tab's bucket `PUT`s too, so progress, speed and Pause have time to show. The Offline profile fires the
  page's `offline` event, which pauses the uploads (see [Offline](#offline)).
- Use a file over the server's `multipartThreshold` to see parts. In development you can lower the threshold, as
  [`examples/next`](../../examples/next/README.md) does with `multipartThreshold: "8MB"`.
- The example's `/lab` page can delay every bucket `PUT` and inject failures, and shows each request.

### Cancel

`abort()` on a file, `job.abort()`, or the `signal` you passed cancels: requests stop, the file ends `aborted`, and the
server is told to clean up with `/abort`. A file still waiting for its ticket ends `aborted` at once; a ticket that
arrives for it later only gets its `/abort`. A failed file ends `aborted` too, and the server is told to drop what it
kept for `retry()`.

The one exception: a file after a `/complete` that may have succeeded is kept, never deleted.

### Retry

- `job.files[n].retry()` sends a failed file again and resolves with its outcome.
- `job.retry()` does that for every failed file and resolves with an `UploadResult` of the job's current outcomes once
  every file has settled. Its `data` is `null` when its `/upload` for every file was refused, as with `done`.
- A retry reuses the file's ticket when it can, so the parts already stored in the bucket are not sent again and the
  bytes stay counted.
- It asks `/upload` for a new ticket when the old one expired or was given up, or when the failure was one a new attempt
  with the same ticket cannot fix: `UPLOAD_EXPIRED`, `INVALID_TOKEN`, `UPLOAD_REJECTED`, `VERIFICATION_FAILED`,
  `NO_SUCH_UPLOAD`, or a file that never got a ticket. `job.retry()` asks for all of those files in one `/upload`. On a
  new ticket the file starts again under a new key, and its `bytes` drop to 0.
- When a `/complete` may have succeeded, a retry sends `/complete` again first, never a second upload.
- `retry()` of a file that is still running waits for it to settle. Of a done or aborted file, it answers that outcome
  at once.
- `job.done` keeps each file's first outcome, whatever a retry does later. The snapshot shows the current one.

## How files are sent

- Files up to the server's `multipartThreshold` (64 MiB by default) go in one `PUT`. Larger ones go in parts of 8 MiB
  (16 MiB from 256 MiB, larger only when a file would need over 10,000 parts), read with `Blob.slice`, at most four
  parts of one file at a time.
- Every part except the last has exactly the same size. R2 requires equal part sizes in a multipart upload, so the
  server plans one part size per file and the client cuts the file by that plan.
- A request is tried up to 6 times with backoff: a random wait up to 0.5 s, then up to 1 s, 2 s and so on, at most 20 s.
  When the answer carries `Retry-After`, the wait is at least that long (at most 20 s).
- An expired upload URL is renewed once.
- Parts that `/complete` reports missing are sent again, at most twice.
- Calls to your server send cookies (`credentials: "include"`), so `authorize` can read the session. Uploads to the
  bucket send none.

A browser hides every answer header the bucket's CORS rule does not expose. Expose `Retry-After` in the rule, or the
client cannot read it and waits its own backoff alone. See [Bucket setup](bucket-setup.md).

### When /upload refuses one file

`/upload` answers per file. A file it refuses with a retryable error (the storage service failed or was busy while the
server started it) asks `/upload` again for itself alone, with the backoff above and within the attempts the job's
`/upload` left, while the job's other files go on.

- The file stays `queued` while it waits.
- Pausing it stops the wait until it resumes. Cancelling it ends it `aborted` at once, without another request.
- Going offline pauses it while it waits, after a refusal or after a later `/upload` that failed as a whole, whatever
  the job's other files do; going back online asks at once. An `/upload` already sent is not stopped: a ticket it
  brings waits paused.
- A refusal that is not retryable, such as a file over the size limit, fails the file at once.

## Concurrency and order

One client shares its connection slots between all its uploads. Each bucket `PUT` holds one slot, and one file has at
most four parts in flight. Calls to your server take no slot.

- **`concurrency: "auto"`** (the default) starts with 4 slots. After each 2 s in which the bytes sent rose by 10 % or
  more while `PUT`s waited, it adds one, up to 8. A network error, a stall, or a `429` or `503` from the bucket halves
  the slots.
- **A number from 1 to 16** fixes the slots.
- **`order: "added"`** (the default) sends files added earlier first. **`order: "smallest-first"`** sends smaller files
  first, across every job of the client.

## Offline

When the page goes offline, every queued and uploading file pauses (`status: "paused"`) and resumes when the page is
back online.

- A file you paused stays paused. Your `pause()` or `resume()` of a file the network paused makes it yours.
- Files that start while the page is offline pause before any `PUT`.
- The `/upload` that starts a job, or that a `job.retry()` sends for several files, is not held: with no network it
  fails those files with `NETWORK_ERROR` after its attempts, and `retry()` sends it again. A one-file `/upload` (a
  file asking again after a refusal, a `file.retry()` that needs a new ticket) pauses while it waits.

## Stalled requests

In a browser, a bucket `PUT` that makes no progress for 30 s, or whose answer takes that long after the last byte,
counts as a network error and is tried again. Through `fetch`, which reports no progress, a `PUT` gets 30 s plus its
size at 100 KiB/s.

Calls to your server have a deadline for the whole answer: 30 s for `/upload` and `/sign`, 120 s for `/complete`. A
missed deadline is a retryable `NETWORK_ERROR`, tried again within the same attempts. Each `/upload` ask carries a
random `idempotencyKey`, the same on all of its attempts, so a server with a database store releases what an attempt
whose answer never arrived reserved. A `/complete` that timed out counts as one that may have finished, so a cancel or a
failure afterwards keeps the file. `/abort` gets 10 s and is sent once; if it is missed, the bucket's lifecycle rule
cleans up.

## Transports: XHR or fetch

- In a browser, bucket `PUT`s go through `XMLHttpRequest`, which reports bytes while they are sent, so progress moves
  smoothly.
- Passing the `fetch` option sends everything through it, `PUT`s included. A part's bytes then count only once it is
  stored, so progress moves a part at a time. To add a token or other headers to your server's requests, use the
  `headers` option instead: it leaves `PUT`s on `XMLHttpRequest`.
- Outside a browser (Node, Bun, Deno, Workers), `PUT`s use `fetch` the same way.

## What gets cleaned up

- **Cancelling** returns `ABORTED` and tells the server to clean up with `/abort`.
- **A single-`PUT` file of `upload()` that fails after `/upload`** is cleaned up the same way, in the background, so
  `upload()` answers the error at once. `upload()` returns no handle to retry with, so there is nothing to keep.
- **A multipart file of `upload()` that fails** for a reason a later attempt can fix, such as the network, keeps its
  parts and its resume record, so a reload can [resume](resume.md) it and send only the parts the bucket lacks; no
  `/abort` is sent. One the bucket or the server refused, or whose ticket expired, is cleaned up as a single `PUT` is,
  and so is every failed file with persistence off or unavailable.
- **A failed file of `start()`** keeps its ticket and the parts already stored in the bucket, so `retry()` can reuse
  them, until `abort()` of the file or the job (or `options.signal`), `pagehide`, or the ticket's expiry (24 hours).
  `abort()` tells the server with `/abort`. `pagehide` does too, except for a multipart file `upload()` would keep,
  which keeps its parts and its resume record for a reload. The bucket's lifecycle rule removes unfinished parts nobody
  resumes. A failed single-`PUT` object kept until expiry stays in the bucket: call `job.abort()` once you will not
  retry.
- **A file after a `/complete` that may have succeeded** is always kept, never deleted.
- **[`close()`](#close-the-client)** cancels every file, or, without `abort`, keeps each multipart upload's record for
  its user's next client.

## Close the client

`close()` stops a client for good, which an app with signed-in users needs when the user changes:

```ts
await client.close({ abort: true }); // at sign-out: cancel every upload, telling the server
await client.forget(); // then delete the user's unfinished uploads
```

- **Afterwards** `start()`, `upload()` and `resume()` answer `CLIENT_CLOSED` before any request, and a job's or a
  file's `retry()` sends nothing. `resumable()`, `discard()` and `forget()` keep working. Create a new client for the
  next user.
- **Every file of every route stops,** queued, uploading, paused, failed or waiting for its ticket, in any phase. A file
  waiting for its ticket ends `aborted` at once, and its `/upload`, if in flight, is cancelled.
- **`close({ abort: true })`,** at sign-out, cancels each file as `abort()` does: its `/abort` goes with its own
  upload token and `keepalive`, so a reload right after does not stop it, and the records of those uploads go.
- **`close()` without options,** when another user signed in in another tab, stops each file as closing the tab would.
  A multipart upload sends no `/abort` and keeps its record, which the same user [resumes](resume.md) on a new client
  after signing in again, in this page or after a reload. A single `PUT`, which cannot resume, is cancelled, and so is
  every file when persistence is off or unavailable.
- **A file whose `/complete` may have finished** is kept, never deleted, either way.
- **It resolves** once every file it stopped has ended and each `/abort` it sent was answered; it never rejects. A file
  in the middle of `/complete` waits for that answer, at most 2 minutes. Await it before a sign-out ends what a
  `headers` function reads, or that function cannot give the `/abort`s their headers.
- **The first call decides,** and every later call does nothing but resolve with the first.

In React, the factory returns the same `close()`: [Signed-in users](react.md#signed-in-users).

## Errors that only the client produces

Five codes come from the client and never from the server:

- `UPLOAD_REJECTED`: the bucket refused the bytes as signed (a different size, type or checksum).
- `ABORTED`: a cancel.
- `NETWORK_ERROR`: no answer after every attempt. Retryable.
- `UPLOAD_IN_USE`: `resume()` or `discard()` found the upload held in this browser (see
  [Resume after reload](resume.md#two-tabs)).
- `CLIENT_CLOSED`: `start()`, `upload()` or `resume()` after [`close()`](#close-the-client).

Every other code, and what to do about it: [Errors](errors.md).

Why the client behaves as it does: the [M3-S decisions](../decisions/m3-slice.md), the
[M3-U decisions](../decisions/m3-uploader.md), for `close()` and `headers`, the
[M8-L decisions](../decisions/m8-client.md), and for `account`, the [M10-A decisions](../decisions/m10-account.md).
