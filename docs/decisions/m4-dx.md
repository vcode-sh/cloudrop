# M4a decisions: audit fixes, developer experience and React hooks

Design: [`2026-11-17-m4-dx-and-react-design.md`](../superpowers/specs/2026-11-17-m4-dx-and-react-design.md). Each
entry: decision, why, what it costs if wrong, status, source, where it is visible. `M4-F<n>` numbers follow the design's
§3 to §5; `M4-B<n>` follow §6. Execution rulings continue each series from the next free number.

## Fixes and developer experience (`M4-F`)

### Client (design §3, `M4-F1` to `M4-F9`)

<!-- Task A appends its entries above this line. -->

### Server and storage (design §4, `M4-F10` to `M4-F14`)

### M4-F10: keys and other identifiers from storage XML keep their edge whitespace

- **Decision:** `xmlText` decodes an element's text exactly as sent; a new `xmlValue` (and `xmlValues`, which replaces
  `xmlTexts`) trims, for numbers, dates, booleans, codes and the CORS lists. Keys, upload IDs, ETags, continuation
  tokens and the lifecycle rule's ID and prefix are read with `xmlText`.
- **Why:** audit F10. `keyProblem` accepts `"users/42/a "` and `"users/42/b\u00a0"`, and a route's `key()` can produce
  them, but `list()` returned them trimmed: `delete()` then removed a key that never existed, and `deletePrefix` failed
  forever with "Some keys were still listed after they were deleted". Whitespace inside a typed value carries no meaning
  in the S3 schema, so trimming stays there.
- **If wrong:** a backend that pads a key or an upload ID with whitespace would hand it back padded; none of the four
  backends does (contract case "lists and deletes keys with edge whitespace exactly as stored").
- **Status:** in force.
- **Source:** design §4, audit F10.
- **Visible in:** `storage/xml.ts`, `storage/s3/objects.ts`, `storage/s3/multipart.ts`, `storage/s3/bucket-settings.ts`,
  `storage/s3/objects.test.ts`, `server/api.test.ts` (`api.deletePrefix`), `testing/storage-contract/list.ts`.

### M4-F11: `/upload` aborts the multipart upload when signing its first parts throws

- **Decision:** `startFile` aborts the multipart upload it just created when signing the first part URLs or the token
  throws, then rethrows, so `startFileSafely` rejects that file with `SERVER_ERROR` as before. A `presignPart` that
  returns an error already aborted it.
- **Why:** audit F11. `StorageDriver` is public; a custom driver whose `presignPart` throws left an open upload that held
  its parts until the bucket's lifecycle rule removed it.
- **If wrong:** an `abortMultipart` that throws too replaces the first error in the log line `startFileSafely` writes;
  the file is rejected either way.
- **Status:** in force.
- **Source:** design §4, audit F11.
- **Visible in:** `server/upload.ts` (`startFile`), `server/upload-storage.test.ts`.

### M4-F12: no retry before `NO_SUCH_UPLOAD`; overlapping completions measured on live R2

- **Decision:** `completedBefore` keeps answering `NO_SUCH_UPLOAD` on the first HEAD that finds no object of this
  upload; no delayed second HEAD. Nothing in the code changed.
- **Why:** audit F12 feared that a `/complete` retried while the first `CompleteMultipartUpload` still ran could see
  `NoSuchUpload` before HEAD showed the object. 23 trials on live R2 (4 to 200 parts, the second Complete 0 to 600 ms
  after the first, ListParts and HEAD polled every ~35 ms) never showed it: every HEAD started after any `NoSuchUpload`
  answer saw the object. ListParts during a completion answers `500 InternalError` (a retryable `STORAGE_ERROR`), and
  a second Complete that starts early succeeds too, so both calls run `onComplete` (`M3-U84`).
- **If wrong:** a completion much longer than the 0.6 s measured could still open the window; then a cancel after
  `NO_SUCH_UPLOAD` deletes a recorded file (`M3-U83`, "If wrong"). The fix is the one the design names: retry the HEAD
  once after a short delay.
- **Status:** in force.
- **Source:** design §4, audit F12; `docs/research/r2-spike-findings.md`, "Overlapping completions, 2026-11-17".
- **Visible in:** `server/complete.ts` (`completedBefore`), unchanged.

### M4-F13: four simplifications of the server, two of them narrowed

- **Decision:** `verifyObject` does its own HEAD and `handleComplete` picks it or `completeParts` in one expression;
  `presignParts` returns `allOk(signed)`; `readJson` joins the body through `new Blob(chunks).arrayBuffer()`; one
  `abortContexts(request, files, reason)` in `plugins.ts` builds the `onAbort` contexts for `runBeforeUpload`, `/upload`
  and `tokenAbortContexts` (which replaces `abortContext` for `/abort` and `/complete`). Two parts of the design's list
  were narrowed: `allOk` stays in `storage/s3/responses.ts` instead of moving to `errors.ts`, and `node.ts` keeps its
  copy loop.
- **Why:** design §4 accepted the simplifications. In `errors.ts`, `allOk` lands in the chunk `cloudrop/next` and
  `cloudrop/node` import, measured +0.11 kB gzip on both summed budgets (1.12 of 1.1 kB, 3.21 of 3.2 kB) for code
  neither runs. `NodeRequest` yields `Uint8Array<ArrayBufferLike>`, which `BlobPart` accepts only through an `as`, and
  narrowing the public `NodeRequest` type is not worth a loop of six lines.
- **If wrong:** none in behaviour: every existing test passes unchanged. `server/presign.ts` importing from
  `storage/s3/` is the cost of the first narrowing.
- **Status:** in force.
- **Source:** design §4, audit F13 (S1 to S4).
- **Visible in:** `server/complete.ts`, `server/presign.ts`, `server/http.ts` (`readJson`), `server/plugins.ts`
  (`abortContexts`), `server/token-request.ts` (`tokenAbortContexts`), `server/upload.ts`, `server/abort.ts`.

<!-- Task B appends its entries above this line. -->

### API, configuration and documentation (design §5, `M4-F15` to `M4-F21`)

<!-- Tasks C and E append their entries above this line. -->

## Bindings (`M4-B`)

<!-- Task D appends its entries above this line. -->
