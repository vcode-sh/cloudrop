# Resume after reload: design

Status: approved by the owner 2026-11-16 (design in conversation; the owner asked for the implementation without further
questions, following the research's recommendations). Executed 2026-11-16 and 2026-11-17 by the resume plan on
`feat/m3-resume`, from `57144e0`; what it decided while building is `M3-U60` to `M3-U87`. Parent spec:
[`2026-11-15-cloudrop-design.md`](2026-11-15-cloudrop-design.md) §6.3, which this design amends (§8). Builds on
`cloudrop/client` as merged at `35cb8a9` (plans A and B,
[`2026-11-16-progress-scheduler-design.md`](2026-11-16-progress-scheduler-design.md)). Research:
`.superpowers/research/research-resume.md` (git-ignored; its findings are restated here where they decide something).
Decisions taken while executing go to `docs/decisions/m3-uploader.md`, continuing the `M3-U` series from `M3-U60`.

## 1. Goal

A user whose page reloaded (or closed) during a multipart upload picks the same file again and the upload continues:
only the parts the bucket does not hold are sent, and a file whose `/complete` already finished is reported done
without sending anything. It works with no setup; an app can turn it off, scope it to a signed-in user and forget it on
sign-out.

Out of scope: copying the file into the origin-private file system (`persist: "opfs"`, spec §6.3: needs Safari 26 for
main-thread writes or a worker, and a second full write of every file); File System Access handles (Chromium only);
resuming single-PUT files; re-issuing an expired token for the same multipart upload (a server and security design of
its own); cross-device resume (1.1).

## 2. Public API

Everything is exported from `cloudrop/client`.

```ts
const client = createCloudropClient<typeof cloudrop>({
  persist: true,        // default; false keeps nothing on disk
  namespace: user.id,   // optional, default "": records of one namespace never mix with another's
});

const { data: unfinished, error } = await client.resumable("files");   // route optional: every route when omitted
// unfinished: readonly ResumableUpload[], newest first
//   { id, route, name, size, type, lastModified, expiresAt }          — never the token, key or metadata

const job = client.resume(unfinished[0], file, { signal });             // UploadJob of one file
const { data, error } = await job.done;                                 // the job's UploadResult, as start() gives

const forgotten = await client.forget();                                // Result<{ forgotten: number }>
```

- `ResumableUpload` is a plain, JSON-safe object; `id` is the upload's id (the ticket's `id`, the object's
  `cloudrop-id`), stable across page loads. `expiresAt` is the ticket's, an ISO string.
- `resume(upload, file, options?)` returns an `UploadJob` like `start()`: snapshot, `subscribe`, `pause`, `resume`,
  `abort`, `retry`, `done`. Its one file's id is the client's next sequence number, as for any job (`M3-U2`). Options:
  `signal` only; the route and metadata come from the record.
- `resumable()` and `forget()` never reject. `resumable()` resolves `ok([])` when persistence is off or the runtime has
  no `indexedDB`; `forget()` resolves `ok({ forgotten: 0 })` there.
- `forget()` deletes every record of the client's namespace (the sign-out call). `forget({ all: true })` deletes every
  record of every namespace of this origin.
- New client error code `UPLOAD_IN_USE` (client-only, beside `ABORTED`): the upload is being sent by another tab of
  this browser.

### 2.1 Errors of `resume()`

`resume()` returns a job whose `done` resolves `{ data: null, error }` without any request when:

| Case | Code | Message (exact wording is the plan's) |
|---|---|---|
| `file` is not a `File`, or `upload` is not an object with a string `id` | `INVALID_INPUT` | what to pass |
| no record with that `id` in this namespace, or it expired | `NOT_FOUND` | the upload can no longer be resumed; start it again |
| `file` does not match the record (§3.3) | `INVALID_INPUT` | pick the same file the upload started with |
| another tab holds the upload (§3.5) | `UPLOAD_IN_USE` | it is being sent in another tab; finish or close it there |

Every other outcome is the job's normal `UploadResult`.

## 3. Behaviour

### 3.1 What is saved

One record per multipart upload, in IndexedDB database `cloudrop`, object store `uploads`, keyed by `id`:

```ts
interface UploadRecord {
  id: string; namespace: string; route: string; metadata: unknown;           // metadata as sent to /upload
  name: string; size: number; type: string; lastModified: number;
  fingerprint: string;                                                       // §3.3
  token: string; key: string; partSize: number; partCount: number; expiresAt: string;
  savedAt: number;                                                           // ms, for newest-first
}
```

Never a presigned URL, an ETag or a part list. A single-PUT ticket is never saved.

### 3.2 When a record is written and deleted

- **Written once**, when a multipart ticket arrives: from `start()`, from `resume()` or `retry()` asking `/upload` for
  a new ticket (which replaces the record under the new `id` and deletes the old one). No write per part.
- **Deleted** when the file ends `done` or `aborted`; when `pagehide` sends the `/abort` of a failed file's ticket
  (`M3-U33`); when a record is found expired (by `resumable()`, `resume()` or the next save); and by `forget()`.
- A failed file keeps its record (it may be retried, and after a reload resumed) until one of the above.
- Store operations of one client are applied in the order they were made (a delete issued after a save never runs
  before it). A store error never fails, pauses or slows an upload; `resumable()` and `forget()` report theirs as
  `{ data: null, error }` with code `STORAGE_ERROR` and a message that names the browser's storage, never its raw text.

### 3.3 Matching the file

`resume(upload, file)` accepts `file` only when `name`, `size`, `lastModified` and `type` equal the record's and its
fingerprint equals the record's. The fingerprint is the hex SHA-256 of the file's first 64 KiB followed by its last
64 KiB (the whole file when it is at most 128 KiB), computed with `crypto.subtle`. Where `crypto.subtle` is missing (a
page served over plain HTTP on a LAN address), the fingerprint is the empty string on both sides and matching rests on
name, size, `lastModified` and type. A match is a heuristic: an edit in the middle of a file with the same edges and
timestamp is not seen (M5's `checksums()` will close it). Hashing two 64 KiB slices costs well under a millisecond.

### 3.4 Resuming: ask the server first

The resumed file starts as `completing` with every part counted as landed, so its first request is `/complete` with
the saved token (owner decision: the server's part list, not a saved one):

- **success** → `done`, the record is deleted. This also settles a `/complete` that finished before the reload.
- **`PARTS_MISSING`** → exactly those parts are sent, then `/complete` again. This first answer uses none of the
  `PARTS_MISSING` repair rounds (`M3-S13`). From this answer the snapshot's `bytes` are the sizes of the parts that
  landed; before it they are 0.
- **`UPLOAD_EXPIRED`, `INVALID_TOKEN` or `NO_SUCH_UPLOAD`** (the server's "aborted or expired" for a multipart upload
  that is gone and not completed) → one new
  `/upload` with the record's route and metadata (the `retry()` new-ticket branch, `M3-U31`), the old record deleted,
  a new one saved, and the whole file sent. Its bytes restart at 0 (`M3-U36`).
- **any other failure** → the file ends `failed` with that error and keeps its record; `retry()` and a later
  `resume()` start again from the probe.

A probe answered with `NETWORK_ERROR` or `SERVER_ERROR` sets `mayBeComplete` as any `/complete` does (`M3-S14`).
`retry()`'s new-ticket list (`M3-U31`) gains `NO_SUCH_UPLOAD` for the same reason.

### 3.5 Two tabs

Every run of a persisted upload (from `start()`, `resume()` or `retry()`) holds a Web Lock named
`cloudrop:upload:<id>` from its first request to its settling, where `navigator.locks` exists. `resume()` asks for the
lock without waiting; when another tab holds it, the job ends with `UPLOAD_IN_USE` and sends nothing. Without
`navigator.locks` two tabs may send the same parts: harmless to the result (the server verifies), but wasted bytes.

### 3.6 `resumable()`

Reads the namespace's records, deletes the expired ones (`expiresAt` within 60 s of now counts as expired, so a listed
upload has time to start), and returns the rest newest first, filtered by route when one is given. It does not call the
server.

### 3.7 Off and unsupported

`persist: false`, or no `indexedDB` in the runtime: nothing is read or written, `resumable()` returns `[]`,
`resume()` ends with `NOT_FOUND`, `forget()` returns 0. The library never calls `navigator.storage.persist()` (Firefox
would prompt); an app that wants persistent storage calls it itself.

## 4. Security

The record holds the upload token: a bearer credential for its upload for 24 hours that can sign PUTs for its key,
complete it, and through `/abort` abort it or delete its finished object (spec §5.5). It is signed, not encrypted, so
its `owner` and `metadata` are readable, and the record repeats `metadata`. Persisting it adds exposure to other users
of the same browser profile within 24 hours, to the time after sign-out, and to disk at rest; it adds nothing a script
injected into the live page does not already have. Limits (owner decision):

- the record is deleted the moment its file ends done or aborted, so a persisted token never outlives its use and
  cannot delete a finished object after a reload;
- expired records are never used and are deleted when seen;
- `namespace` keeps one signed-in user's records apart from another's on the same browser;
- `forget()` is the sign-out call; the README says to call it.

`authorize` runs only in `/upload` (spec §7.1): a resumed upload runs with its original owner. An app whose
`onComplete` must re-check the session can read the request there.

## 5. Architecture

| Module | Purpose |
|---|---|
| `client/records.ts` (new) | The IndexedDB store: open, put, get, getAll by namespace, delete, delete by namespace; one ordered queue; errors swallowed for uploads, returned for `resumable`/`forget` |
| `client/fingerprint.ts` (new) | The edge hash and the file match (§3.3) |
| `client/resume.ts` (new) | `resumable()`, `resume()`, `forget()`: validation, lock, rebuilding the `Upload` from a record, the probe start |
| `client/locks.ts` (new, or inside `resume.ts` if under ~30 lines) | The Web Lock around a persisted run |
| `upload.ts`, `file-run.ts`, `job-run.ts`, `retry-file.ts`, `lifecycle.ts` (changed) | Save on a multipart ticket, delete on done/aborted/pagehide, the probe's free repair round, the bytes after the probe |
| `client.ts`, `types.ts` (changed) | Options, the three methods, `ResumableUpload` |
| `errors.ts` (changed) | `UPLOAD_IN_USE` in `ClientErrorCode` |

A rebuilt ticket has `parts: []`; every part is signed through `/sign` when needed (`client/parts.ts` already signs
lazily). The client still imports only `errors.ts`, `input.ts`, `plan.ts` and `protocol/types.ts` from outside
`client/`.

## 6. Testing

- **Unit lane:** a hand-written fake of the IndexedDB subset the store uses and a fake `navigator.locks`, in
  `src/testing/` (never shipped), over the fake R2 and fake XHR. Rows prove, with independent oracles (the fake bucket's
  stored bytes and the request sequence): a record is written once per multipart ticket and never for a single PUT;
  it holds no URL; deleted on done, on abort, on pagehide of a failed file, on expiry; kept for a failed file; the probe
  completes a finished upload with no PUT; `PARTS_MISSING` sends exactly the missing parts and does not consume a
  repair round; expired/invalid token takes one new `/upload` and replaces the record; mismatched name, size,
  `lastModified`, type and edge bytes are refused; no `crypto.subtle` falls back; `UPLOAD_IN_USE` when the lock is
  held; namespaces never mix; `forget()` and `forget({ all: true })`; store errors never fail an upload and are
  reported by `resumable()`/`forget()`; `persist: false` and no `indexedDB` do nothing; ordered operations (a delete
  right after a save wins).
- **Browser lane (RustFS and R2):** a multipart upload interrupted by a reload, the same file picked again, only the
  missing parts sent and the file done; a reload after a `/complete` that finished (the lab's dropped-answer fault):
  resume sends `/complete` only; a different file picked: refused; a second tab: `UPLOAD_IN_USE`; real IndexedDB and
  real Web Locks.
- `/lab` lists unfinished uploads with a Resume control that asks for the file, and a Forget button.

## 7. Size and docs

- `cloudrop/client` ceiling raised to 10 kB gzip (owner decision 2026-11-16; resume on by default adds an estimated
  0.8–1.1 kB to 8.35 kB). Spec §1's "client plus React" target becomes about 12 kB. Built, it measured 2.1 kB more
  (10.45 kB), and the owner raised the ceiling to 10.5 kB (`M3-U86`).
- Decision entries from `M3-U60`: each choice of §1–§4 and every execution ruling that changes behaviour or a
  contract.
- README: a "Resume after reload" section (the three calls, `persist`, `namespace`, sign-out with `forget()`, what is
  stored and for how long, what is not supported).

## 8. Amendments to spec §6.3

- "Multipart uploads persist to IndexedDB by default" stays; the record is §3.1's, without `parts`, `etag` or
  `checksum`.
- "`uploader.resumable()` lists unfinished uploads. When the user picks the same file again, only missing parts are
  sent" becomes: `resumable()` lists them; the app passes the picked file to `resume(upload, file)`; the client asks
  `/complete` first and sends only what it answers missing.
- "`persist: 'opfs'`" is deferred (§1).
- "The client trusts its own record and does not call `ListParts` on resume" is replaced by §3.4: one `ListParts`
  (Class A, inside `/complete`) per resumed file, in exchange for an exact part list and a settled `/complete`.
- Spec §7 gains §4's paragraph on the persisted token.
