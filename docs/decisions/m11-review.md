# M11-R: the review of every area before 0.6.0

Findings of the area-by-area review and what was done with each, designed in `docs/superpowers/specs/2026-11-21-0.6.0-design.md`.
Each entry: Decision, Why, If wrong, Status, Visible in.

### M11-R1: `testClient` gives the handler the headers it sent, in Node, happy-dom and jsdom

- **Decision:** `testClient` builds each server request with the environment's `Request` and then defines the
  request's `headers` as the `Headers` the client sent, with `Origin: http://localhost` set last. The handler reads
  `cookie`, `origin` and every other header in Node and in Vitest's `happy-dom` and `jsdom` environments. One set of
  cases (`src/testing/test-client-environments.ts`) runs in all three; `jsdom` is a dev dependency for that.
- **Why:** happy-dom 21's `Request` constructor removes the forbidden request headers, `cookie` and `origin` among
  them, so under `// @vitest-environment happy-dom` the guide's signed-in tests answered `UNAUTHORIZED` and `origin`
  was absent, while the guide names happy-dom as supported. Setting the headers after construction would depend on
  each environment's header guard; an own property does not. jsdom 31 keeps Node's `Request` and needed no change.
- **If wrong:** code in front of the handler that copies the request (`new Request(request)`, `request.clone()`)
  loses the two headers again under happy-dom; the guide says so. An environment whose `Request` has a
  non-configurable own `headers` would throw here; none of the three has.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/testing.ts`, `packages/cloudrop/src/testing/test-client-environments.ts`,
  `packages/cloudrop/src/testing.happy-dom.test.ts`, `packages/cloudrop/src/testing.jsdom.test.ts`,
  `docs/guide/testing-your-app.md`.

### M11-R2: the handler reads a request body without `Blob`

- **Decision:** `readJson` decodes the body's chunks with one streaming `TextDecoder` (`fatal`, `{ stream: true }` per
  chunk, then a last `decode()`), not through `new Blob(chunks).arrayBuffer()`. The 64 KiB cap and its check while the
  stream is read are unchanged. A character whose bytes arrive in two chunks reads whole, and a body that ends inside a
  character is refused `INVALID_INPUT`, as before.
- **Why:** jsdom 26's `Blob` has no `arrayBuffer()` (measured on 26.1.0 under Vitest's jsdom environment; jsdom 31 has
  it), so every request of an app's test answered `SERVER_ERROR`, and the log said "Pass it a Fetch API Request",
  which blames the caller. `TextDecoder` is in every runtime the server supports, so the handler no longer depends on
  the environment's `Blob` at all.
- **If wrong:** a runtime whose `TextDecoder` ignores `stream` would misread a character split between chunks; the
  handler test with a split "é" shows it. The bundled server entry grew 8 bytes gzipped (31,393 to 31,401).
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/server/http.ts`, `packages/cloudrop/src/server/handler.test.ts`.

### M11-R3: `testClient` takes `account`

- **Decision:** `TestClientOptions` gains `account`, typed as the client's own option and passed to it unchanged.
- **Why:** the account guard of 0.4.0 (`M10-A`) compares the client's `account` with the route's `owner`, and
  `testClient` had no way to set it, so an app could not test `ACCOUNT_CHANGED` through its own routes. The guide gains
  the example, which is a test of the repository (`M9-T9`).
- **If wrong:** nothing to migrate; the option is new and optional.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/testing.ts`, `packages/cloudrop/src/testing.guide.test.ts`,
  `docs/guide/testing-your-app.md`.

### M11-R4: `useUpload` follows the factory of its latest render

- **Decision:** a mounted `useUpload` whose hooks come from another factory, as from a context whose value changed
  without a remount, uploads through that factory's client and renders, pauses, aborts, retries and clears that
  factory's list. The factory is read from the committed render, with the route and the options. Uploads started
  through the previous factory stay on its client and in its list: the hook neither cancels nor shows them, and a
  component that renders with the previous factory again shows them again.
- **Why:** the hook's controller kept the first factory for the life of the component while the rendered list already
  came from the new one, so a file picked after the change went through the previous client (the previous user's
  `namespace` and `account` in the Signed-in recipe) and never appeared. `useResumable` already followed the change.
  Cancelling the previous factory's uploads here would contradict `M4-B4`: the client owns its uploads, and the app
  stops them with that factory's `close()`, as `useCloseOtherUsers` does.
- **If wrong:** an app that relied on a mounted component staying on its first factory keys the component by the
  factory, which remounts it.
- **Status:** in force. Run under React Strict Mode and, once, on React 18.3.1.
- **Visible in:** `packages/cloudrop/src/react/use-upload.ts`, `packages/cloudrop/src/react/rerender.test.ts`,
  `docs/guide/react.md`.

### M11-R5: `useResumable` shows only the list read for its route and factory

- **Decision:** `uploads` is the list read for the render's `route` and factory. After either changes it is `[]`
  until the new read answers. A `refresh()` kept from a render of another route or factory still answers its caller
  and changes nothing the hook shows.
- **Why:** the hook kept the previous route's records on screen until the new read answered, so a page could offer
  "Resume" for a record of a route the component no longer shows. An empty list is what the hook shows before any
  first read.
- **If wrong:** a list flickers empty on a route change; an app that wants the old rows meanwhile keeps them itself.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/react/use-resumable.ts`, `packages/cloudrop/src/react/rerender.test.ts`,
  `packages/cloudrop/src/react/types.ts`.

### M11-R6: a job refused before it starts is not kept by the hooks

- **Decision:** `useUpload` adds a job to its route's list and to the factory's tracker only when the job has a file.
  A job the client refuses before it starts (`CLIENT_CLOSED`, `INVALID_INPUT`) has none; `upload()` and
  `resume(upload, file)` still resolve with its refusal.
- **Why:** each refused call stayed in the list for good, so `retry()`, `pause()` and `abort()` walked jobs with
  nothing to act on, and each one made every `useResumable` of the factory read IndexedDB again.
- **If wrong:** nothing rendered changes: a refused job never had a file in `files`.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/react/use-upload.ts`, `packages/cloudrop/src/react/use-upload.test.ts`.

### M11-R7: `createUploadHooks(null)` is `createUploadHooks()`

- **Decision:** null options count as none, as `createCloudropClient` and `testBucket` read theirs.
- **Why:** from plain JavaScript, `createUploadHooks(null)` threw a `TypeError` from the first `upload()`, read or
  `close()`, where the hooks promise an `INVALID_CONFIG` result for a wrong option and nothing thrown.
- **If wrong:** nothing to migrate; the types never allowed null.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/react.ts`, `packages/cloudrop/src/react.test.ts`.

### M11-R8: the Signed-in recipe caches a user's client in a browser only

- **Decision:** `uploadsFor(userId)` of the Signed-in recipe (`docs/guide/react.md`, `docs/guide/hono.md`, and
  `examples/vite-react/src/lib/upload.ts`, which the guides mirror) returns an uncached client and hooks when
  `typeof window === "undefined"`, and keeps its per-user map only in a browser.
- **Why:** the map is emptied only by `useCloseOtherUsers`, an effect, and no effect runs on a server. An app that
  server-renders the module with the user's id (Next.js, TanStack Start) kept one client per user for as long as the
  server ran. A client that starts no upload attaches no listener and holds no timer (`client/lifecycle.ts` adds its
  listeners only while a file runs), so the uncached one is collected with the render.
- **If wrong:** a server render creates one client per call instead of one per user; it sends nothing. The Vite
  example renders in the browser only, so the guard never runs there; it is kept so the example and the guides are
  the same code.
- **Status:** in force.
- **Visible in:** `docs/guide/react.md#signed-in-users`, `docs/guide/hono.md`, `examples/vite-react/src/lib/upload.ts`.

### M11-R9: an example and a recipe render what uploads only once the session is known

- **Decision:** `examples/vite-react` renders its drop zone once `session.isPending` is false, signed in or out, and
  the roots shown in the React and Hono guides do the same.
- **Why:** while the session loads the user id is `""`, so the hooks are those of the client with `account: ""`. A
  signed-in user's drop in that window was refused `ACCOUNT_CHANGED` (`M10-A`), and its row vanished when the user's
  id remounted the tree. `examples/next` has no accounts and a module-level factory, so it has no such window.
- **If wrong:** the drop zone appears a moment later, after the session request.
- **Status:** in force.
- **Visible in:** `examples/vite-react/src/app.tsx`, `docs/guide/react.md#signed-in-users`, `docs/guide/hono.md`.

### M11-R10: the Hono guide's client passes `account`

- **Decision:** step 7 of `docs/guide/hono.md` creates the client with `account: userId` beside `namespace`, with a
  bullet that says what it guards.
- **Why:** the example and the React guide pass it; the Hono guide's copy did not, so an app built from that page had
  no guard against a sign-in in another tab.
- **If wrong:** nothing: the option is ignored on a route without a store and `owner`.
- **Status:** in force.
- **Visible in:** `docs/guide/hono.md`.

### M11-R11: the Hono guide says `api.files` lists a user's files

- **Decision:** the schema step of `docs/guide/hono.md` no longer says cloudrop's file API has no listing call. It
  names `uploads.api.files({ owner })` and keeps the app's own Drizzle queries for joins.
- **Why:** the sentence predates `api.files` and contradicted step 6 of the same page.
- **If wrong:** nothing.
- **Status:** in force.
- **Visible in:** `docs/guide/hono.md`.

### M11-R12: the Vite example's row dismisses a failed file

- **Decision:** a failed row of `examples/vite-react` has Dismiss beside Retry (or Reload, for `ACCOUNT_CHANGED`): the
  file's `abort()`, which ends it `aborted`, after which Clear finished removes it. It is the same button as Cancel
  on a running row, with the other label.
- **Why:** `clear()` keeps an upload with a failed file for `retry()`, and the row offered only Retry, so a file
  refused for good, such as one over the quota, stayed listed until a reload. The Next example's row already cancels
  a failed file.
- **If wrong:** nothing kept: `abort()` on a failed file gives its ticket up, as the Next example's Cancel does.
- **Status:** in force.
- **Visible in:** `examples/vite-react/src/components/upload-row.tsx`, `examples/vite-react/src/app.browser.test.ts`.

### M11-R13: the Next example's unfinished-uploads panel uses the hook's `discarding`

- **Decision:** `examples/next/components/upload/unfinished-uploads.tsx` reads `discarding` from `useResumable` and
  keeps no state of its own for it; the React guide's block for the panel shows that component's code, its
  `discardEach` included.
- **Why:** the hook has had `discarding` since 0.2.0 (`M8-L8`), the guide showed it, and the example it names still
  kept its own set, so the page the guide walks through was not the code the guide showed.
- **If wrong:** the hook holds an id until the list is read again, which is when the example's own set let go of it.
- **Status:** in force.
- **Visible in:** `examples/next/components/upload/unfinished-uploads.tsx`, `docs/guide/react.md#build-your-upload-ui`.

### M11-R24: a value of the wrong type from JavaScript answers INVALID_INPUT, in the checksum and in bucket rules

- **Decision:** `checksumProblem` checks that `checksumCrc32c` is a string before it tests its pattern, and
  `putBucketCors` and `putBucketLifecycle` check each rule's shape before writing XML: a CORS rule is an object whose
  four lists are lists of text; a lifecycle rule is an object with `sourceXml` as text, or with `prefix` as text and
  `abortIncompleteMultipartUploadDays` as a whole number from 1. Anything else answers `INVALID_INPUT` naming the shape.
  What a valid rule may contain beyond that is still left to the service.
- **Why:** a pattern tests a list or an object as its text, so `checksumCrc32c: ["4waSgw=="]` passed the check on
  `put`, `presignPut` and `presignPart` and the signer then threw `TypeError: value.trim is not a function`;
  `putBucketCors([null])`, `putBucketCors([{}])` and `putBucketLifecycle([null])` threw `TypeError` too. A public call
  answers a Result and never throws. A lifecycle rule without a prefix was written with the prefix `undefined`, as
  text, which a service accepts as a rule for keys that start with those nine letters. Every other validator in
  `validate.ts` already checked the type; a table test now passes each one numbers, lists, objects, `null` and booleans.
- **If wrong:** a caller who passed a `String` object as a checksum, or a lifecycle rule with neither `sourceXml` nor
  days, gets `INVALID_INPUT` where the first worked by accident and the second was refused by the service.
- **Status:** in force.
- **Visible in:** `src/storage/validate.ts`, `src/storage/s3/bucket-writes.ts`, `src/storage/validate.test.ts`,
  `src/storage/s3-driver.test.ts`, `src/storage/s3/bucket-settings.test.ts`.

### M11-R23: a storage error names the range, the redirect or region, and a lost conditional write

- **Decision:** `storageError` gains three messages and one retry. `416` reads "The byte range starts at or past the
  object's end. Ask for a range inside its size." Any `3xx`, and the code `AuthorizationHeaderMalformed`, read "The
  storage endpoint redirected the request, or the bucket is in another region. Check the endpoint and region settings."
  `ConditionalRequestConflict` reads "Another request changed this key at the same moment. Write the object again, or
  start a new multipart upload." and is not retryable. `RequestTimeout` is retryable whatever its status. All four keep
  the code `STORAGE_ERROR`.
- **Why:** each fell through to "rejected the request (HTTP n). Check the key, size and headers you passed, then
  retry.", which names nothing the person can change. `416 InvalidRange` is what R2 answers to any range of an
  empty object (`docs/research/r2-spike-findings.md`, "The first 4 KiB of small objects"); a contract case now asks
  for such a range and for one that starts at the object's end, and R2, RustFS, Wrangler's local R2 and the fake all
  answered `416` to both on 2026-11-21. AWS answers a request sent to another region's endpoint with `301 PermanentRedirect` and one signed for
  another region with `400 AuthorizationHeaderMalformed`: the codes `cli/bucket-access.ts` already reads for the
  command, from AWS's error list, unmeasured here. One message serves both because a bare `301` (AWS to `HEAD`, or any
  proxy from http to https) cannot be told from a region redirect. On `409`, AWS's "Conditional write behavior" says:
  "When using conditional writes with `PutObject`, uploads may be retried after receiving a `409 Conflict` error. When
  using `CompleteMultipartUpload`, the entire multipart upload must be re-initiated"
  (<https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>, read 2026-11-21): `retryable` means
  the same request may succeed later, which holds for neither as a rule, so the message says what to send instead. On
  `RequestTimeout`, AWS's SDK reference says "an HTTP 400 with the error code `RequestTimeout` is classified as
  transient and retried" (<https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html>, read
  2026-11-21); until now only a `408` was retried, and AWS sends this code with `400`.
- **If wrong:** a storage service that sends `3xx` for another reason gets a message about the endpoint, which is
  still the setting to look at. AWS's error-code list page (`API/ErrorResponses.html`) could not be read by the tool
  used for this review, so `PermanentRedirect` and `AuthorizationHeaderMalformed` rest on the command's earlier reading
  of it.
- **Status:** in force.
- **Visible in:** `src/storage/storage-error.ts`, `src/storage/storage-error.test.ts`,
  `src/testing/storage-contract/objects.ts`, `docs/guide/errors.md`.

### M11-R20: a 200 that is not S3's answer is an error, never an empty result

- **Decision:** `list` requires a `<ListBucketResult` element and `listParts` a `<ListPartsResult` element, and answer
  the incomplete-response error otherwise ("The storage service's response had no object listing. Retry the request.",
  "… no part listing …"). A call S3 answers without a body (`put`, `delete`, `abortMultipart`, `putBucketCors`,
  `putBucketLifecycle`) refuses a 2xx that carries one: "The storage endpoint sent more data than an S3 answer holds.
  Check the endpoint setting." An ETag header that is weak (`W/"…"`) counts as missing, on `head` and on `put`.
- **Why:** an `s3()` endpoint that answers every request with 200 and a page (a console's port, a single-page app's
  host, a captive portal) read as an empty bucket: `api.deletePrefix("users/42/")` answered `{ deleted: 0, verifiedAt }`,
  a verified erasure, while the files stayed stored. `getBucketCors` and `getBucketLifecycle` already refused such a
  body. Audited against a real server that answers `200 text/html` with a length, a date and a weak ETag to every
  method (`src/storage/s3/web-page.test.ts`), each call on its own:

  | Call | Before | Now |
  | --- | --- | --- |
  | `list`, `listParts` | an empty, final listing | fixed: the root element is required |
  | `head` | an object of the page's size | fixed for a weak ETag; see "If wrong" |
  | `put` | stored, with the page's ETag | fixed: a body where S3 sends none, and the weak ETag |
  | `delete`, `abortMultipart`, `deleteMany` | deleted | fixed: a body where S3 sends none |
  | `putBucketCors`, `putBucketLifecycle` | written | fixed: a body where S3 sends none |
  | `createMultipart`, `completeMultipart`, `copy` | safe: no upload ID, no ETag in the body | unchanged |
  | `getRange` | safe: a 200 is "ignored the byte range" | unchanged, and now bounded (`M11-R22`) |
  | `getBucketCors`, `getBucketLifecycle` | safe: no configuration element | unchanged |
  | `presignPut`, `presignPart`, `presignGet` | no request is sent | unchanged |

  There is no batch delete: `deleteMany` sends one `DELETE` per key.
- **If wrong:** a host that answers `HEAD` and a ranged `GET` as a static file server does (a strong ETag, a date, a
  length, `206`) still reads as an object: nothing in such an answer differs from S3's, since an object may itself be
  a page. The upload protocol is not fooled, because `/complete` compares the object's `x-amz-meta-cloudrop-id`. An
  S3-compatible service that answers a `PUT` or a `DELETE` with a body would now fail every write; R2, RustFS and
  Wrangler's local R2 send none (the three backend lanes pass).
- **Status:** in force.
- **Visible in:** `src/storage/s3/objects.ts`, `src/storage/s3/multipart.ts`, `src/storage/s3/responses.ts`,
  `src/storage/s3/transport.ts`, `src/storage/s3/web-page.test.ts`, `docs/guide/troubleshooting.md`.

### M11-R21: the driver never follows a redirect

- **Decision:** every request is sent with `redirect: "manual"`, and a `3xx` is the error of `M11-R23`. A custom
  `fetch` that follows a redirect all the same is caught by `response.redirected` and reported the same way, with the
  status 302 standing for the first answer's, which is gone by then.
- **Why:** a request is signed for one host: its `Host` header is part of the signature, so the host a redirect names
  can only refuse it, and fetch drops `Authorization` on a cross-origin redirect anyway. What arrived there was an
  unsigned request, answered with a page (a captive portal's 200) that read as a result, or with a 403 that pointed at
  the access key. A `307` or `308` also sends the body again, so a file's bytes went to a host nobody configured.
- **If wrong:** AWS answers `307 TemporaryRedirect` for a bucket created minutes ago in another region, which an SDK
  follows; cloudrop reports it and the request works once the endpoint names the bucket's region. A runtime whose
  fetch answers a manual redirect with an opaque status 0 (a browser) reports the generic refusal with "HTTP 0".
- **Status:** in force.
- **Visible in:** `src/storage/s3/transport.ts`, `src/storage/storage-error.ts`, `src/storage/s3/web-page.test.ts`.

### M11-R22: answers are read up to a bound, and the tag reader is linear

- **Decision:** `send` reads a body through its stream and cancels it at a bound: 4 KiB of an error body (S3 names its
  code first), `end - start + 1` bytes of a ranged GET, 8 MiB of an XML answer, none for a call S3 answers without a
  body. Past the bound a successful answer fails with the error of `M11-R20`; an error body is cut and still read for
  its code. `xmlBlocks` matches an opening tag only up to the next `<` and finds its end with a plain search that
  stops once no closing tag is left; the self-closing check of `getBucketCors` and `getBucketLifecycle` matches the
  same way.
- **Why:** the JSDoc said bodies were bounded by the caller and nothing bounded them: a 4 KiB content sniff read
  whatever a server sent with a `206`, and every answer was read whole. The tag pattern was quadratic on unclosed tags:
  `xmlValue("<Code>".repeat(n), "Code")` took 7 s for 480 KB, and 1.2 MB took 21 s to 123 s in the new tests before
  the fix. The XML bound is derived from the largest page cloudrop asks for: 1,000 entries (`MAX_LIST_PAGE`, for
  objects and for parts), each a key of 1,024 bytes with every byte escaped to six characters (`&quot;`) and under
  1 KiB of other fields, come to 7.2 MB; a CORS or lifecycle configuration is far smaller.
- **If wrong:** a listing over 8 MiB fails where it was read; it cannot be S3's answer to `max-keys=1000`. A ranged
  answer that sends more than the range is refused rather than cut, since which bytes it sent is then unknown.
- **Status:** in force.
- **Visible in:** `src/storage/s3/transport.ts`, `src/storage/xml.ts`, `src/storage/s3/bucket-settings.ts`,
  `src/storage/s3/transport.test.ts`, `src/storage/xml.test.ts`.

### M11-R25: a header value read back from the storage is signed as the bytes it is

- **Decision:** the signer hashes a canonical request that holds a character from U+0080 to U+00FF as one byte per
  character, not as UTF-8. Every other canonical request is ASCII and is hashed as before. Callers' own header values
  stay limited to printable ASCII.
- **Why:** a copy of a source over `maxSinglePutSize` starts a multipart upload with the type, disposition and
  metadata that `HEAD` returned. `Headers.get()` returns a stored value as a byte string, one character per byte, and
  fetch sends it back as those bytes; the signer hashed the characters' UTF-8 instead, so the storage verified other
  bytes than were signed. Measured on R2, 2026-11-21 (`docs/research/r2-spike-findings.md`, "Non-ASCII bytes in stored
  headers"): R2 stores UTF-8 bytes another tool wrote in `content-type` and `content-disposition` and returns them
  raw, returns such metadata as an RFC 2047 word in ASCII, and answered the copy in parts `403 SignatureDoesNotMatch`,
  which cloudrop reported as `STORAGE_DENIED` "Check the access key, its permissions and the bucket name". A single
  copy was never affected: it sends no stored header. After the fix the same copy answers 200 and the copy's
  disposition holds the same bytes.
- **If wrong:** a header value with a character above U+00FF cannot come from `Headers.get()` and fetch refuses to send
  one, so its signature does not matter. The unit test's expected signature was computed with `node:crypto` over the
  bytes, not with this signer.
- **Status:** in force.
- **Visible in:** `src/storage/sigv4.ts`, `src/storage/sigv4.test.ts`, `src/storage/s3/copy.test.ts`,
  `docs/research/r2-spike-findings.md`.

### M11-R26: the fake R2 keeps one object for a key's NFC and NFD forms, and answers 401 to an unknown access key

- **Decision:** the fake stores an object under the NFC form of its key together with the key as last written. Either
  form reads, overwrites and deletes it, a create-only `PUT` in the other form answers `412`, and a listing matches its
  prefix in either form and returns the form last written. `FakeR2.keys()` returns those forms and `FakeR2.object(key)`
  takes either. A header-signed request whose access key ID is not the bucket's answers `401 Unauthorized`, bare to
  `HEAD`, before any other check.
- **Why:** both were measured on R2 on 2026-11-21 (`docs/research/r2-spike-findings.md`, "Keys", "One key in two
  Unicode forms, through deletePrefix" and "An unknown access key"; `M9-H5`, `M9-H6`), and the fake kept two objects
  and answered `403 SignatureDoesNotMatch`. The driver's handling of both was covered by stubbed answers only; it now
  runs against the fake (`src/storage/s3/objects.test.ts`), and so does anything built on `testBucket`.
- **If wrong:** multipart uploads and presigned URLs were not measured for either behaviour, so an upload still belongs
  to its key exactly as written until it completes, and a presigned URL of an unknown key still fails its signature.
  A test that relied on the fake keeping both forms of one key as two objects now sees one.
- **Status:** in force.
- **Visible in:** `src/testing/fake-r2.ts`, `src/testing/fake-r2/bucket.ts`, `src/testing/fake-r2/objects.ts`,
  `src/testing/fake-r2/signature.ts`, `src/testing/fake-r2.test.ts`, `src/testing/fake-r2/signature.test.ts`.
