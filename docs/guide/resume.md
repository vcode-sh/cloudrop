# Resume after reload

This page is for developers whose users upload large files. It covers how a large upload survives a reload or a closed
tab: what you write in your page, how the client recognises the same file, what it asks the server, what it keeps in the
browser and when it deletes it, how two tabs share an upload, how to discard one upload without its file, and what is
not supported. For uploads in general, see [Client](client.md).

## What resumes

A file sent in parts (over the server's `multipartThreshold`, 64 MiB by default) survives a reload or a closed tab. The
client keeps a record of its upload in the browser's IndexedDB. When the user picks the same file again, only the parts
the bucket does not hold are sent.

It is on by default and needs nothing on the server. Files sent in one `PUT` are not kept: a reload loses them, and the
page starts them again.

## Resume in your page

```ts
const client = createCloudropClient<typeof cloudrop>({
  namespace: user.id, // the signed-in user's id: one user's unfinished uploads never mix with another's
  // persist: false,  // keeps nothing on disk, and nothing can be resumed after a reload
});

// After the reload: what can be continued, newest first, for one route (every route without an argument). Uploads this
// client holds itself, running, failed and kept for retry(), or being resumed, are left out.
const { data: unfinished } = await client.resumable("files"); // null when the browser's storage failed
const upload = unfinished?.[0]; // { id, route, name, size, type, lastModified, expiresAt }: enough to ask for the file

// The user picks the file again, through a file input or a drop.
if (upload) {
  const job = client.resume(upload, picked, { signal });
  const { data, error } = await job.done; // an UploadResult of one file, as start(...).done gives
}

// The user does not want it any more: no file needed.
if (upload) await client.discard(upload); // { data: { aborted: true }, error: null }

// At sign-out:
await client.forget();
```

`user`, `picked` and `signal` stand for your app's signed-in user, the `File` the user picked again, and an optional
`AbortSignal`.

### The user picks the file again

A page cannot get a `File` back after a reload: a browser hands a page a file only when the user picks or drops it, and
cloudrop does not copy files (see [Not supported](#not-supported)). `resumable()` gives you the name and size to ask
for.

`start()` and `upload()` never match a file against a record: the same file passed to them is uploaded again under a new
key. Only `resume()` continues an upload.

### What counts as the same file

The same name, size, `lastModified` and type, and the same SHA-256 of its first and last 64 KiB (of the whole file, up
to 128 KiB). It is a heuristic: a file changed only in the middle, with the same timestamp, passes.

## What resume() does

`resume(upload, file, options?)` returns an `UploadJob` of one file with everything a job of `start()` has:
`subscribe`, `getSnapshot`, `pause`, `resume`, `abort`, `retry` and `done`. The route and the metadata come from the
record; `signal` is the only option.

### Checks before any request

The file is `queued` while the record, the file and the lock are checked. When a check fails, `done` resolves
`{ data: null, error }` before any request, with:

| Code | Why |
| --- | --- |
| `INVALID_INPUT` | Wrong arguments, or a different file than the one the upload started with. |
| `NOT_FOUND` | No unexpired record of that upload in the client's namespace: it finished, was cancelled or expired, or persistence is off. |
| `STORAGE_ERROR` | The browser's storage cannot be read. |
| `UPLOAD_IN_USE` | The upload is held in this page or another tab (see [Two tabs](#two-tabs)). |

A cancel meanwhile resolves `ABORTED` the same way. `retry()` of a refused job runs the checks again: it resolves the
same refusal while they fail, sending nothing, and resumes once they pass, such as after `UPLOAD_IN_USE` once the other
tab let go, or after `STORAGE_ERROR` once the storage reads again.

### The server is asked first

Once the checks pass, the file is `completing`, and its first request is `/complete` with the saved token. That lists
the bucket's parts: one `ListParts` per resumed file. On R2, `ListParts` is a **Class A operation**, the more expensive
of R2's two billed operation classes.

- **All parts there, or a `/complete` that finished before the reload:** the file ends done without a `PUT`. The route's
  `afterVerify` and `onComplete` run again then, so make them idempotent by `file.id`, as for any retried request. With
  a [database store](store.md) a finished `/complete` is answered from its row instead, and neither runs again.
- **Parts missing:** exactly those are sent, then `/complete` again. The parts already stored in the bucket count in `bytes` from that
  answer; before it, `bytes` is 0.
- **The upload is gone** (`UPLOAD_EXPIRED`, `INVALID_TOKEN` or `NO_SUCH_UPLOAD`, or parts missing in the ticket's
  last 15 minutes, when the server signs no more URLs for it): the file is `queued` again and gives the old ticket up
  with `/abort`, as a [retry that replaces a ticket](client.md#retry) does. It waits for the answer (at most 10
  seconds), so with a [database store](store.md) the bytes the old ticket reserved no longer count against the owner's
  quota. Then it asks `/upload` once for a new ticket with the record's route and metadata, and sends the whole file
  under a new key, its `bytes` from 0, with no failure in between. A ticket whose `/complete` may have succeeded gets no
  `/abort`. When that `/upload` is refused, the file ends `failed` with its error.
- **Any other failure** ends the file `failed` and keeps its record. `retry()` then does what
  [any retry does](client.md#retry): it asks `/complete` again when the failure left the ticket good, such as a network
  or server failure, and asks `/upload` for a new ticket when the server ended the upload, such as a file refused for
  its content. A `resume()` after a reload that left the record asks `/complete` again (see
  [When a record is deleted](#when-a-record-is-deleted)).

## What is stored

One record per upload, in the IndexedDB database `cloudrop`:

- the upload's id, route and the metadata sent to `/upload`;
- its upload token, key, part size, part count and expiry;
- the file's name, size, type, `lastModified` and fingerprint;
- the namespace.

Never a presigned URL, an ETag or a part list.

The token is a bearer credential for its upload for 24 hours: it signs `PUT`s for its key (until 15 minutes before it
expires), completes the upload, and
through `/abort` cancels it or deletes its finished file (not with a [database store](store.md), which keeps a finished
file). It is signed, not encrypted, so what `authorize` returned and
the metadata can be read from it.

## When a record is deleted

- when its file ends done or is cancelled, also `abort()` of a failed file of `start()` that still holds its ticket;
- when a new ticket replaces it (except the record of a ticket `pagehide` already gave up, which another tab may hold);
- when its file fails for a reason the same ticket can never fix (the bucket or the server refused it, or the ticket
  expired), with the `/abort` that gives the ticket up;
- when it is found expired, by `resumable()`, `resume()` or the next save (a minute early, so a listed upload has time
  to start);
- on `discard()` of its upload, once the server answered its `/abort` (see [Discard one upload](#discard-one-upload));
- on `forget()`.

Any other failed file keeps its record, such as one the network failed: a failure of `upload()` and `pagehide` give its
ticket up without `/abort`, so a reload lists it and `resume()` sends only the parts the bucket lacks. So after a
reload, the uploads left to resume are those that were still uploading, paused or failed for a reason a resume can
fix. A file given up this way is not cancelled by a later `abort()` from the same page, which sends nothing: another
tab may have resumed it.

A delete issued just before the page unloads (a cancel, then the tab closes) may not commit, so the next page still
lists that upload. Resuming it finds the upload gone when the `/abort` reached the server, and starts over with a new
ticket, sending every byte; when the `/abort` did not reach the server, only the missing parts are sent.

## Two tabs

The page that holds an upload's ticket holds a Web Lock on it (`cloudrop:upload:<id>`) as long as it keeps the ticket:
while the file runs, while a failed file waits for `retry()`, and until it gives the ticket up: once the server answered
its `/abort`, or at once when no `/abort` is sent.

- `resume()` of an upload held in another tab, or in this page, ends with `UPLOAD_IN_USE` and sends nothing. Finish or
  cancel it there.
- `resumable()` leaves out the uploads this client holds: from the ticket's arrival until the page gives it up, and from
  a `resume()` call until its checks refuse it or its upload ends. A failed file of `start()` is continued with its own
  `retry()`, so it is not listed; one of `upload()`, which has no handle to retry with, is listed once it fails. An
  upload another tab holds is still listed, since that tab may let it go; `resume()` of it is `UPLOAD_IN_USE` until
  then.
- A record is saved only once its lock is held. Without the lock, a second holder could complete an upload whose
  `/abort` this page then sends, deleting the stored file (without a [database store](store.md)).

## Namespace and sign-out

Pass the signed-in user's id as `namespace` (a string of up to 256 characters, `""` by default). A client sees only its
namespace's records. The namespace is fixed when the client is created, so create a new client when the user changes.

At sign-out, close the client, then call `forget()`:

```ts
await client.close({ abort: true }); // cancels every upload of every route, telling the server
await client.forget(); // deletes the namespace's records
```

- `forget()` deletes the namespace's records and resolves `{ data: { forgotten }, error }`, counting the records it
  deleted, expired ones included.
- `forget({ all: true })` deletes every record of this origin. Any other argument is `INVALID_INPUT`.
- `forget()` stops nothing: uploads that are running keep going. Close the client first, as above: a file that gets
  its ticket after `forget()` saves a new record, and a file still waiting for its ticket asks `/upload` with whatever
  session the browser holds by then. What [`close()`](client.md#close-the-client) does in each phase is in the client
  guide; in React: [Signed-in users](react.md#signed-in-users).
- When the user changed without signing out here, such as a sign-in in another tab, call `close()` without options on
  the last user's client and leave the records: its multipart uploads stop without an `/abort`, as when a tab closes,
  and that user resumes them on their next sign-in.

Without `forget()`, a signed-out user's unfinished uploads, tokens included, stay on the browser profile for up to 24
hours, and another user signed in on the same profile and namespace could finish them. They stay the first user's files,
since `authorize` runs only in `/upload`: check the session again in `onComplete` when that matters.

## Discard one upload

`discard(upload)` drops one upload from `resumable()` without its file, for a list with a Discard button per row:

```ts
const { data, error } = await client.discard(upload);
if (error) showMessage(error.message); // the upload is still listed: try again later
```

It takes the upload's Web Lock, as a resume would, sends `/abort` with the token the record keeps and `keep: true`,
deletes the record and, once the delete has run, lets the lock go. `/abort` aborts the multipart upload, so its parts
leave the bucket at once; with a [database store](store.md) it also ends the upload's row and frees the bytes it
reserved against the quota. Without a store, `keep` tells the server never to delete an object that landed: a listed
upload may be one whose `/complete` finished while the page heard nothing (a reload during the last step, or an answer
lost), and its file stays. With a store the row decides and `keep` changes nothing: a completed row keeps its file,
and a pending one proves `onComplete` has not committed, so a landed object is deleted with the row and nothing is
left outside the quota. The server takes an expired token for `/abort`, so any listed upload can be aborted. A server
older than this release ignores `keep` and, without a store and while the token is valid, deletes such a finished file:
update the server with the client.

| What happens | Result | The record |
| --- | --- | --- |
| The server aborted the upload | `{ data: { aborted: true }, error: null }` | deleted |
| The upload had already finished (its `/complete` went through unheard): the file is kept, nothing is aborted. Without a store, a landed object of a `/complete` that never ran is kept too; with a store, it is deleted with its pending row | `{ data: { aborted: true }, error: null }` | deleted |
| The server refused the token for good (`INVALID_TOKEN`, `UPLOAD_EXPIRED`, `NO_SUCH_UPLOAD` and the other codes a new ticket would be needed for), for example after the server's secret changed | `{ data: { aborted: false }, error: null }` | deleted |
| The record expired and the browser already deleted it, with its token (a minute before `expiresAt`) | `{ data: { aborted: false }, error: null }`, no request | already gone |
| `/abort` did not get through (no connection, a server error, a timeout) | that error, such as a retryable `NETWORK_ERROR` | kept, for another try |
| Another tab, or this page, holds the upload | `UPLOAD_IN_USE`, no request | kept |
| No record of that id in this namespace, and not expired: it finished, or was cancelled or discarded | `NOT_FOUND`, no request | none |
| Anything but an upload with a string `id` | `INVALID_INPUT` | unchanged |

With `aborted: false`, the bucket's abort-incomplete-multipart rule removes the parts, and a store's sweep ends the row.
A tab closed while its `/abort` is on the way keeps the record, so the upload is listed again; discarding it again is
harmless.
`forget()` deletes every record of the namespace at once but sends no `/abort`: use it at sign-out, and `discard()` when
the user drops an upload. With a database store, the uploads it forgets keep the bytes they reserved until their
tokens expire and the sweep ends their rows: call `cloudrop.api.revokeUploads({ owner })` in your sign-out handler to
free them at once.

## When persistence is off or unavailable

Resuming needs a **secure context** (HTTPS, or `localhost` in development), where browsers have Web Locks.

With `persist: false`, or where there is no `indexedDB` (Node, Bun, Deno, Workers) or no Web Locks (a page served over
plain HTTP, such as a LAN address), nothing is read or written:

- `resumable()` resolves `[]`;
- `resume()` ends with `NOT_FOUND`;
- `discard()` resolves `NOT_FOUND` (or `{ aborted: false }` for an upload within a minute of `expiresAt`), sending
  nothing;
- `forget()` resolves `{ forgotten: 0 }`.

The same goes where the browser refuses the lock (a document no longer active, an opaque origin): that upload keeps no
record, and still uploads.

The client looks for `indexedDB` and Web Locks once, when it is created: create it after any polyfill for them.

`resumable()`, `discard()` and `forget()` never reject. When the browser's storage fails, they resolve `STORAGE_ERROR`.
A storage failure never fails, pauses or slows an upload.

Records live in the origin's best-effort storage, which a browser may evict under pressure. cloudrop never calls
`navigator.storage.persist()`, since Firefox would prompt the user for it; call it yourself if you want persistent
storage.

## Not supported

- **Resuming without picking the file again.** A copy into the origin-private file system is deferred to a later opt-in:
  it needs Safari 26 or a worker, and writes every file a second time.
- **Files sent in one `PUT`.**
- **Resuming on another device or browser.**
- **Continuing an upload after its 24-hour token expired.** Its record is deleted, the old parts wait for the bucket's
  lifecycle rule, and the file is started again.

Why it works this way: the resume decisions `M3-U60` to `M3-U91` in [m3-uploader.md](../decisions/m3-uploader.md).
