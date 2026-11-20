# M7: patch releases after 0.1.0

Rulings made for releases after 0.1.0, from what applications built on the published package reported. The first
report came from an application that integrated 0.1.0 and ran it in production (2026-11-20); it led to 0.1.1.

### M7-P1: `HEAD` asks for an uncompressed answer, unsigned

- **Decision:** The S3 driver's transport (`src/storage/s3/transport.ts`) adds `accept-encoding: identity` to every
  `HEAD` request after signing it. Every other request is sent as before.
- **Why:** R2 compresses the answer to a `HEAD` of an object with a compressible type (`text/plain`, `application/json`,
  `text/html`, `image/svg+xml` and others) of 50 bytes or more when the request offers gzip, which Node's and Bun's
  `fetch` do by default, and then sends no `content-length`
  ([HEAD and compression](../research/r2-spike-findings.md#head-and-compression-2026-11-20)). `head()` reads the stored
  size from that header, so on 0.1.0 such a file failed `/complete` with `502 STORAGE_ERROR`, and `/abort`, the sweep
  and `api.head` failed on it the same way. The fix belongs in the shared transport, not in `r2()`: `s3()` pointed at an
  R2 endpoint gets the same answers. The header is left out of the signature, so a runtime that rewrites
  `accept-encoding` (unmeasured for Workers) cannot turn the fix into `SignatureDoesNotMatch`.
- **If wrong:** a service that refuses `identity` would answer `HEAD` with `406`; S3 and every S3-compatible service
  tested (R2, RustFS, Wrangler's local R2) accept it.
- **Status:** in force. The contract case "reports the stored size of an object R2 would compress" runs on every
  backend, and the fake R2 compresses as R2 does, so the unit lane fails without the header.
- **Visible in:** `src/storage/s3/transport.ts`, `src/testing/fake-r2/objects.ts`,
  `src/testing/storage-contract/objects.ts`, `docs/guide/troubleshooting.md`.

### M7-P2: one client per signed-in user in the React guide; cancel before `forget()`

- **Decision:** The React guide gets a [Signed-in users](../guide/react.md#signed-in-users) recipe: a client per user
  with the user's id as `namespace`, hooks in a context keyed by the user, a `useStopUploads` hook that calls `abort()`
  of each route, a `StopUploadsOnUserChange` component that runs it when the keyed provider unmounts, and a sign-out
  that cancels, then calls `forget()`, then signs out. `examples/vite-react` does the same, and its browser pass proves
  that Sign out during an upload ends the upload's row as `aborted`. The READMEs say what `onComplete` "once" means:
  at least once without a store; with one, once under a lease, and exactly once only for writes through `tx` on
  Postgres with `transaction: true`.
- **Why:** the report found the per-user recipe only in the Hono guide, and an app that followed it still had to find
  that `forget()` stops nothing. `forget()` deletes the records it finds, but a file still waiting for its ticket asks
  `/upload` afterwards, saves a new record, and once the session cookie changed asks with the next user's session. The
  example's sign-out had that gap, and left the running upload's row pending until a sweep. The README's "once per file"
  led the reporter to expect no second email or webhook.
- **If wrong:** the recipe names each route by hand; an app that adds a route and forgets it there leaves that route's
  uploads running at sign-out. `M7-P3` removes that step.
- **Status:** amended by `M8-L7` for 0.2.0: `useStopUploads` and `StopUploadsOnUserChange` gave way to the factory's
  `close()`; the per-user client, the keyed context and `forget()` at sign-out stay.
- **Visible in:** `docs/guide/react.md`, `docs/guide/resume.md`, `docs/guide/hono.md`, `packages/cloudrop/README.md`,
  `README.md`, `examples/vite-react/src/lib/upload.ts`, `examples/vite-react/src/components/auth-panel.tsx`.

### M7-P3: a client-wide stop for 0.2.0, separate from `forget()`

- **Decision:** 0.2.0 adds one call that stops a client: it refuses new uploads and resumes, cancels every running job
  of every route, and keeps the resume records, since deleting them is the application's decision, which `forget()`
  stays. The React factory exposes the same stop, so `useStopUploads` needs no route list. Its regression covers a user
  change while `/complete` runs, when the server may already be finishing the file: the file must be kept, not
  deleted, and nothing may ask `/upload` afterwards.
- **Why:** the report's integration had to find and stop each route's jobs on its own (`M7-P2`). It is new public API,
  so it waits for a minor version.
- **If wrong:** none known; the name and the exact behaviour of a job mid-`/complete` are settled in its design.
- **Status:** in force through `M8-L1` to `M8-L4` (`close()`), `M8-L7` (React) and `M8-L8` (`useResumable`'s
  `discarding`, from the gap check).
- **Visible in:** `docs/decisions/m8-client.md`, `docs/superpowers/plans/README.md`.

### M7-P4: request options for the upload server only, for 0.2.0

- **Decision:** 0.2.0 adds a client option that applies to requests to the upload server only (`/upload`, `/sign`,
  `/complete`, `/abort`), never to bucket `PUT`s, such as headers or a `fetch` of their own. Bucket `PUT`s then keep
  `XMLHttpRequest` and its byte-by-byte progress.
- **Why:** today a bearer token needs a `fetch` option that tells the server's URLs from presigned ones by hand
  ([Send a bearer token](../guide/client.md#send-a-bearer-token)), and passing `fetch` moves bucket `PUT`s off
  `XMLHttpRequest` (`M3-U6`), so progress moves a part at a time.
- **If wrong:** none known; the option's shape is settled in its design.
- **Status:** in force through `M8-L5` and `M8-L6` (the `headers` option).
- **Visible in:** `docs/decisions/m8-client.md`, `docs/superpowers/plans/README.md`.
