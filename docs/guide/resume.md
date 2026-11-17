# Resume after reload

This page covers how a large upload survives a reload or a closed tab: what you write in your page, how the client
recognises the same file, what it asks the server, what it keeps in the browser and when it deletes it, how two tabs
share an upload, and what is not supported. For uploads in general, see [Client](client.md).

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
  `afterVerify` and `onComplete` run again then, so make them idempotent by `file.id`, as for any retried request.
- **Parts missing:** exactly those are sent, then `/complete` again. The parts that landed count in `bytes` from that
  answer; before it, `bytes` is 0.
- **The upload is gone** (`UPLOAD_EXPIRED`, `INVALID_TOKEN` or `NO_SUCH_UPLOAD`): the file is `queued` again, asks
  `/upload` once for a new ticket with the record's route and metadata, and sends the whole file under a new key, its
  `bytes` from 0, with no failure in between. The old parts wait for the bucket's lifecycle rule. When that `/upload` is
  refused, the file ends `failed` with its error.
- **Any other failure** ends the file `failed` and keeps its record. `retry()` asks `/complete` again, and so does a
  `resume()` after a reload that left the record (see [When a record is deleted](#when-a-record-is-deleted)).

## What is stored

One record per upload, in the IndexedDB database `cloudrop`:

- the upload's id, route and the metadata sent to `/upload`;
- its upload token, key, part size, part count and expiry;
- the file's name, size, type, `lastModified` and fingerprint;
- the namespace.

Never a presigned URL, an ETag or a part list.

The token is a bearer credential for its upload for 24 hours: it signs `PUT`s for its key, completes the upload, and
through `/abort` cancels it or deletes its finished file. It is signed, not encrypted, so what `authorize` returned and
the metadata can be read from it.

## When a record is deleted

- when its file ends done or is cancelled, or `upload()` cleans up a failed file;
- when a new ticket replaces it;
- when `pagehide` gives up a failed file's ticket with `/abort`;
- when it is found expired, by `resumable()`, `resume()` or the next save (a minute early, so a listed upload has time
  to start);
- on `forget()`.

So after a reload, the uploads left to resume are those that were still uploading or paused, and failed files after a
`/complete` that may have succeeded (every failed file, when the page crashed and `pagehide` never fired).

A delete issued in `pagehide` may not commit before the page unloads, so the next page still lists that upload.
Resuming it finds the upload gone when the `/abort` reached the server, and starts over with a new ticket, sending every
byte. When the `/abort` did not reach the server, only the missing parts are sent.

## Two tabs

The page that holds an upload's ticket holds a Web Lock on it (`cloudrop:upload:<id>`) as long as it keeps the ticket:
while the file runs, while a failed file waits for `retry()`, and until the server answered the `/abort` that gives it
up.

- `resume()` of an upload held in another tab, or in this page, ends with `UPLOAD_IN_USE` and sends nothing. Finish or
  cancel it there.
- `resumable()` still lists held uploads.
- A record is saved only once its lock is held. Without the lock, a second holder could complete an upload whose
  `/abort` this page then sends, deleting the stored file.

## Namespace and sign-out

Pass the signed-in user's id as `namespace` (a string of up to 256 characters, `""` by default). A client sees only its
namespace's records. The namespace is fixed when the client is created, so create a new client when the user changes.

Call `forget()` at sign-out:

- It deletes the namespace's records and resolves `{ data: { forgotten }, error }`, counting the records it deleted,
  expired ones included.
- `forget({ all: true })` deletes every record of this origin. Any other argument is `INVALID_INPUT`.
- Uploads that are running keep going; abort their jobs to stop them.

Without `forget()`, a signed-out user's unfinished uploads, tokens included, stay on the browser profile for up to 24
hours, and another user signed in on the same profile and namespace could finish them. They stay the first user's files,
since `authorize` runs only in `/upload`: check the session again in `onComplete` when that matters.

## When persistence is off or unavailable

Resuming needs a **secure context** (HTTPS, or `localhost` in development), where browsers have Web Locks.

With `persist: false`, or where there is no `indexedDB` (Node, Bun, Deno, Workers) or no Web Locks (a page served over
plain HTTP, such as a LAN address), nothing is read or written:

- `resumable()` resolves `[]`;
- `resume()` ends with `NOT_FOUND`;
- `forget()` resolves `{ forgotten: 0 }`.

The same goes where the browser refuses the lock (a document no longer active, an opaque origin): that upload keeps no
record, and still uploads.

The client looks for `indexedDB` and Web Locks once, when it is created: create it after any polyfill for them.

`resumable()` and `forget()` never reject. When the browser's storage fails, they resolve `STORAGE_ERROR`. A storage
failure never fails, pauses or slows an upload.

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
