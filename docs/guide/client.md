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
| `namespace` | Keeps one signed-in user's unfinished uploads apart from another's: pass the user's id. At most 256 characters. | `account` when it is a string, otherwise `""` |

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
const client = createCloudropClient<typeof cloudrop>({ account: userId }); // also the namespace
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

### Sending a file again after it failed

`upload()` and `start()` never look for an earlier attempt: the same file passed again is a new upload under a new
key. That matters for a file sent in parts whose `upload()` failed for a reason a later attempt can fix, such as the
network: its parts and its resume record are [kept](#what-gets-cleaned-up), and with a [database store](store.md)
its row still holds the file's bytes of the owner's quota. A second `upload()` of that file can then be refused with
`QUOTA_EXCEEDED` until the sweep ends the first one's row. Settle the earlier attempt first:

```ts
const { data: unfinished } = await client.resumable("files");
const earlier = unfinished?.find(
  (kept) => kept.name === file.name && kept.size === file.size && kept.lastModified === file.lastModified,
);

if (earlier) {
  // Continue it: only the parts the bucket lacks are sent.
  const { data, error } = await client.resume(earlier, file).done;
  // Or drop it, which frees its parts and its bytes of the quota, and upload the file as new:
  // await client.discard(earlier);
}
```

[Resume after reload](resume.md) describes both calls. With `start()`, call `retry()` on the failed file instead: it
reuses the ticket, or gives it up before it asks for a new one ([Retry](#retry)).

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
- A file [`contentChecks()`](plugins.md#what-a-refusal-carries) refused carries `error.content`,
  `{ declared, detected?, reason }`: what the check found, for wording the refusal yourself.
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

`abort()` on a file, `job.abort()`, or the `signal` you passed cancels: the file's bucket `PUT`s and `/sign` calls stop,
the file ends `aborted` at once, and the server is told to clean up with `/abort`. `done` settles once the server has
answered that `/abort`, at most 10 seconds later. A failed file ends `aborted` too, and the server is told to drop what
it kept for `retry()`.

A file still waiting for its ticket ends `aborted` at once, and `done` does not wait for it. An `/upload` already on
its way is not cut off, whichever of `abort()`, `job.abort()`, the signal or [`close()`](#close-the-client) cancelled
its files: your server may have reserved their bytes by then, and only the tickets it answers can give them back. The
client waits for that answer behind the cancelled files, at most 30 seconds and without another attempt, and sends
`/abort` for each ticket it brings; a ticket that arrives for one cancelled file of a job that goes on gets its
`/abort` the same way. An `/upload` that had not left the page yet is not sent. When no answer arrives (the tab
closed, the connection dropped), a [database store](store.md) keeps what that `/upload` reserved until its
[sweep](store.md#the-sweep) ends the rows.

A file that is `completing` is the exception: every byte is in the bucket and `/complete` is running on your server,
so the cancel does not cut that request off. The file stays `completing` until the answer arrives, at most 2 minutes
(the time one `/complete` is given), and then ends with it:

- **`done`,** with its result, when the server completed the file: it is stored and `onComplete` ran, so `upload()`
  answers the file and not `ABORTED`. Delete it on your server if the user no longer wants it.
- **`aborted`** for any other answer. No further attempt is made.

A file after a `/complete` that may have succeeded (no answer, or a `SERVER_ERROR`) is kept, never deleted: no `/abort`
is sent for it. Once a later `/complete` has answered that the ticket is over (`UPLOAD_EXPIRED`, for example), a
cancel does send `/abort`, with `keep: true`: it frees what the ticket still holds and never deletes a file that
landed. The `/abort` of a [resumed](resume.md#the-server-is-asked-first) upload carries `keep: true` too, until the
server has answered which parts the bucket lacks: the page before the reload may have completed the file.

### Retry

- `job.files[n].retry()` sends a failed file again and resolves with its outcome.
- `job.retry()` does that for every failed file and resolves with an `UploadResult` of the job's current outcomes once
  every file has settled. Its `data` is `null` when its `/upload` for every file was refused, as with `done`.
- A retry reuses the file's ticket when it can, so the parts already stored in the bucket are not sent again and the
  bytes stay counted. What the file failed with, and where, decides:

  | The file failed with | Answered by | `retry()` |
  | --- | --- | --- |
  | Any error, or no answer | `/upload`: the file has no ticket yet | Asks `/upload` again. Its answer depends on the session, the quota and the server's rules of that moment, so a refusal for good is repeated until what it names has changed. |
  | `NETWORK_ERROR`; `RATE_LIMITED`; `STORAGE_ERROR` and `SERVER_ERROR`, retryable or not | `/sign`, `/complete`, or the bucket (`429`, `503`, `408`, another `5xx` except `501`, S3's `RequestTimeout` and `OperationAborted`, no readable answer) | Same ticket: sends the parts not yet stored, then `/complete`. After a `/complete` that may have succeeded, `/complete` alone. |
  | `INVALID_INPUT`, `ORIGIN_NOT_ALLOWED`, `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE`, `BODY_TOO_LARGE`, `NOT_FOUND` | The handler at `/sign` or `/complete`, before it read the token | Same ticket: the request was turned away, not the upload. It passes once the proxy, `basePath` or `trustedOrigins` is fixed. |
  | `BUCKET_BLOCKED` | The browser, for a `PUT` whose six attempts all failed before it reported a byte sent, around a renewal `/sign` answered | Same ticket: sends the parts not yet stored, then `/complete`. It passes once the bucket's CORS rule lets the page through, or the network or credentials that looked like a block are fixed. |
  | `NOT_UPLOADED` | `/complete`, for a file sent in one `PUT` | Same ticket: sends the file again, then `/complete`. |
  | `PARTS_MISSING` | `/complete`, for a file sent in parts | Same ticket: sends the listed parts again (every part when the answer lists none), then `/complete`. |
  | `INVALID_TOKEN`, `UPLOAD_EXPIRED`, `UNKNOWN_ROUTE`, `NO_SUCH_UPLOAD` | `/sign` or `/complete`; `NO_SUCH_UPLOAD` also by the bucket (`404 NoSuchUpload`) | New ticket: this one is over. After `UNKNOWN_ROUTE`, `/upload` refuses the same way while the route is missing. |
  | `VERIFICATION_FAILED`, `ALREADY_EXISTS`, `FILE_TYPE_NOT_ALLOWED`, or any other refusal for good, a code this client does not know included | `/complete` | New ticket: the server ended the upload and removed what was stored. |
  | `UPLOAD_REJECTED` | The bucket: a `403` for the signature or after a renewed link, `501`, any other `4xx` | New ticket. |
  | `ABORTED`, or a file that is done | A cancel | Nothing: answers the outcome as it is. |
  | `INVALID_INPUT`, `CLIENT_CLOSED` | The client, for the arguments of `start()` or a closed client | Nothing: answers the refusal. |
  | `NOT_FOUND`, `UPLOAD_IN_USE`, `INVALID_INPUT`, `BROWSER_STORAGE_ERROR` | The checks of [`resume()`](resume.md#checks-before-any-request) | Runs the checks again. |

  [Errors](errors.md) says for each code what to do besides.

- A ticket is also replaced when it expired, when it can no longer sign the parts still to send, and when the page gave
  it up (`pagehide`). `job.retry()` asks for every file that needs a ticket in one `/upload`. On a new ticket the file
  starts again under a new key, and its `bytes` drop to 0. A file refused for what it is, such as its type, is refused
  again unless the server's rules changed: ask the person for another file instead.
- Before it asks for a new ticket, a retry gives the old one up with `/abort`, as `abort()` of the failed file would,
  and waits for the answer (at most 10 seconds): the parts or the object stored under it are removed, and with a
  [database store](store.md) the bytes it reserved no longer count against the owner's quota when the new `/upload`
  is checked. A ticket whose `/complete` may have succeeded is replaced only once the server has answered that it is
  over, and its `/abort` then carries `keep: true`: a file that did land is never deleted by it. Without a
  [database store](store.md) that file stays in the bucket beside the new one; with a store the upload's row says
  whether it was completed. A multipart ticket the page gave up at
  `pagehide` and kept for a [resume](resume.md) is discarded the same way, as `discard()` of its upload would, unless
  another tab resumes it meanwhile.
- When a `/complete` may have succeeded, a retry sends `/complete` again first, never a second upload, whatever the
  page's clock says about the ticket. Once the server has answered that the ticket is over, the next retry asks for a
  new one.
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
  When the answer carries `Retry-After`, the wait is at least that long; an HTTP date counts from the answer's own
  `Date` header when the client can read it. A bucket `PUT` waits at most 20 s. When your server (or a proxy in front
  of it) asks for more than 20 s at `/upload`, `/sign` or `/complete`, the client does not wait: the file fails with
  the retryable error, such as `RATE_LIMITED`, and `retry()` asks again when your app chooses. `error.retryAfter` gives
  the wait in whole seconds (at most 86,400) whenever the answer carried `Retry-After`: your server's, a proxy's, or the
  bucket's on a `PUT`. It is `undefined` when no wait is known, so pick your own delay then. Only the default message
  of `rateLimited(seconds)` names the wait ("Try again in 600 seconds."), so build your own text from `retryAfter`:

  ```ts
  const { error } = await job.done;
  if (error?.retryable && error.retryAfter !== undefined) {
    showNotice(`Too many uploads right now. Try again in ${error.retryAfter} s.`); // your app's notice
    setTimeout(() => void job.retry(), error.retryAfter * 1000);
  }
  ```
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
whose answer never arrived reserved. When every attempt ended without a ticket, the first `retry()` of one of that
ask's files sends the key once more, for the same reason. A `/complete` that timed out counts as one that may have
finished, so a cancel or a failure afterwards keeps the file. `/abort` gets 10 s and is sent once; if it is missed,
the bucket's lifecycle rule cleans up.

## Transports: XHR or fetch

- In a browser, bucket `PUT`s go through `XMLHttpRequest`, which reports bytes while they are sent, so progress moves
  smoothly.
- Passing the `fetch` option sends everything through it, `PUT`s included. A part's bytes then count only once it is
  stored, so progress moves a part at a time. To add a token or other headers to your server's requests, use the
  `headers` option instead: it leaves `PUT`s on `XMLHttpRequest`.
- Outside a browser (Node, Bun, Deno, Workers), `PUT`s use `fetch` the same way.

## What gets cleaned up

- **Cancelling** returns `ABORTED` and tells the server to clean up with `/abort`, unless a `/complete` in flight
  completes the file first (see [Cancel](#cancel)).
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
  waiting for its ticket ends `aborted` at once; its `/upload`, if in flight, is left to answer, and the ticket it
  brings is aborted, with or without `abort` (see [Cancel](#cancel)).
- **`close({ abort: true })`,** at sign-out, cancels each file as `abort()` does: its `/abort` goes with its own
  upload token and `keepalive`, so a reload right after does not stop it, and the records of those uploads go. A
  browser lets a page have 64 KiB of `keepalive` request bodies in flight and refuses the rest unsent, so the client
  sends about the first 56 KiB of `/abort`s that way (some 130 to 200 files) and the others as ordinary requests,
  which a reload can stop: await `close()` before you navigate.
- **`close()` without options,** when another user signed in in another tab, stops each file as closing the tab would.
  A multipart upload sends no `/abort` and keeps its record, which the same user [resumes](resume.md) on a new client
  after signing in again, in this page or after a reload. A single `PUT`, which cannot resume, is cancelled, and so is
  every file when persistence is off or unavailable.
- **A file whose `/complete` may have finished** is kept, never deleted, either way.
- **It resolves** once every file it stopped has ended and each `/abort` it sent was answered; it never rejects. A file
  in the middle of `/complete` waits for that answer, at most 2 minutes, and an `/upload` in flight for its own, at
  most 30 seconds. Await it before a sign-out ends what a `headers` function reads, or that function cannot give the
  `/abort`s their headers.
- **The first call decides,** and every later call does nothing but resolve with the first.

An app need not wait for `close()` to move on. What it started runs to its end whether or not anything awaits it: a
ticket that an `/upload` in flight brings back later still gets its `/abort`, sent with that upload's own token, so the
server accepts it whoever is signed in by then; a `/complete` in flight still finishes for the user who started it. An
app can drop the promise, call `forget()` and create the next client at once: a late ticket saves no record. The cost:
if the app's `headers` function fails once the user signed out, a late `/abort` is not sent and that upload waits for
the lifecycle rule or the sweep.

In React, the factory returns the same `close()`: [Signed-in users](react.md#signed-in-users).

## Errors that only the client produces

Seven codes come from the client and never from the server:

- `UPLOAD_REJECTED`: the bucket refused the bytes as signed (a different size, type or checksum).
- `ABORTED`: a cancel.
- `NETWORK_ERROR`: no answer after every attempt. Retryable.
- `BUCKET_BLOCKED`: only in a browser (never in React Native), after every attempt failed before the browser reported a
  byte sent, while your server answers: usually the bucket's CORS rule, or a firewall or extension; in Firefox also a
  dropped connection or a bad signature. Retryable; `retry()` once the cause is fixed (see
  [Troubleshooting](troubleshooting.md#uploads-fail-with-bucket_blocked)).
- `UPLOAD_IN_USE`: `resume()` or `discard()` found the upload held in this browser (see
  [Resume after reload](resume.md#two-tabs)).
- `CLIENT_CLOSED`: `start()`, `upload()` or `resume()` after [`close()`](#close-the-client).
- `BROWSER_STORAGE_ERROR`: the browser's own storage for unfinished uploads (IndexedDB) failed, or it refused
  `discard()` a Web Lock. Uploads go on; only resuming after a reload may not. Never the bucket's `STORAGE_ERROR`.

Every other code, and what to do about it: [Errors](errors.md).

Why the client behaves as it does: the [M3-S decisions](../decisions/m3-slice.md), the
[M3-U decisions](../decisions/m3-uploader.md), for `close()` and `headers`, the
[M8-L decisions](../decisions/m8-client.md), and for `account`, the [M10-A decisions](../decisions/m10-account.md).
