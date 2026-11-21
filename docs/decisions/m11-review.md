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

### M11-R100: the bundled server budget is provisional until the owner sets it

- **Decision:** `scripts/size-limit.config.ts` holds the "cloudrop (bundled)" ceiling at 36 kB while 0.6.0 is built.
  The owner sets the final number before the release, from the size measured once every fix is merged.
- **Why:** the ceiling was 32 kB (`M10-D10`) with 0.68 kB of room. `api.deleteFile`'s answer and `onDelete` refusals,
  the `content` field, `api.allFiles` and the review's fixes (bounded response bodies, refused web-page answers,
  redirects never followed) each add honest code that every server needs; measured 32.47 kB with the storage fixes
  merged. Cutting a fix to fit a budget would trade correctness for a number nothing depends on.
- **If wrong:** the owner sets another ceiling, or asks for the store paths behind their own entry (`M5-T69`).
- **Status:** provisional.
- **Visible in:** `scripts/size-limit.config.ts`.

### M11-R40: `trustedOrigins` and `checkBucket` refuse a pattern, in the command's words

- **Decision:** A value with `*` in `trustedOrigins` (`createCloudrop`, `INVALID_CONFIG`) or in
  `api.checkBucket({ origins })` (`INVALID_INPUT`) is refused with the command's sentence (`M9-H100`): `"https://*.example.org"
  is a pattern, not an origin. Name each origin your pages upload from, such as https://app.example.com.` Every other
  refusal uses the command's two sentences too, prefixed with `trustedOrigins: ` or `checkBucket: `: the one that names
  the origin to use (`Use https://app.example.com: …`) and the one for text with no origin. One module,
  `src/server/origins.ts`, serves the option, the api call and the handler's origin hint.
- **Why:** `new URL("https://*.example.org").origin` equals its input, so the old check accepted the pattern and the
  server then matched it against no request: every upload from the subdomains answered `403 ORIGIN_NOT_ALLOWED`, found
  only in production. The command already refused it. A bucket's CORS rule may hold a pattern, but a page's origin never
  is one, so a `checkBucket` for a pattern would report on an origin no page has.
- **If wrong:** an app that relied on the pattern being accepted now fails at start-up instead of at the first upload;
  the pattern never matched, so no working setup changes. The command keeps its own copy of the sentences
  (`src/cli/args.ts`); a later change can make it import `readOrigins`.
- **Status:** in force.
- **Visible in:** `src/server/origins.ts`, `src/server/config.test.ts`, `src/server/bucket-check.test.ts`,
  `docs/guide/server.md#what-an-origin-is`.

### M11-R41: an app's own scheme is an origin: `scheme://host[:port]`, lowercase

- **Decision:** For a URL whose origin the URL parser gives as `null`, `trustedOrigins` and `checkBucket` accept the
  text itself when it matches `^(?!file:)[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d{1,5})?$`: `capacitor://localhost`,
  `tauri://localhost`, `chrome-extension://<id>`, `moz-extension://<uuid>`, `app://localhost:8100`. The handler compares
  it with the request's `Origin` header as an exact string, as for every origin, and answers with it in
  `Access-Control-Allow-Origin`. `null`, `file://…`, `data:…` and anything with a path, an uppercase letter or
  credentials stay refused, with a message that now says "in lowercase". `http`, `https` and the other special schemes
  keep the parser's rule, so `https://bücher.example` is refused with `Use https://xn--bcher-kva.example`, the form a
  browser sends.
- **Why:** the old check answered `INVALID_CONFIG` with a message `capacitor://localhost` already satisfied, so a
  Capacitor, Tauri or extension app could not be configured at all. The form is the one the Fetch standard gives the
  header (`serialized-origin = serialized-scheme "://" serialized-host [ ":" serialized-port ]`, lowercase scheme, port
  of 1 to 5 digits, <https://fetch.spec.whatwg.org/#origin-header>). The URL standard alone makes such a URL's origin
  opaque (<https://url.spec.whatwg.org/#origin>, "Otherwise: return a new opaque origin"), which serializes as `null`;
  WebKit and Chromium treat a scheme the app registered as a tuple origin and send it. What each shell sends is taken
  from its documentation, not measured here: Capacitor iOS `capacitor://localhost`
  (<https://ionicframework.com/docs/troubleshooting/cors>), Tauri `tauri://localhost` on macOS and Linux and
  `http://tauri.localhost` on Windows and Android (<https://v2.tauri.app/reference/config/>, `useHttpsScheme`).
  `file:` is excluded because a file page sends `null`, and trusting `null` would trust every sandboxed frame.
- **If wrong:** a shell that sends `null` for its scheme (the standard's reading) is refused as before, with its entry
  accepted but never matched; the guide tells the reader to check the header in the shell's network inspector. The
  `chrome-extension://` and `moz-extension://` values are from memory of those browsers' behaviour, with no page found
  that states the header. A host outside `[a-z0-9.-]` (an IPv6 literal, an underscore) is refused.
- **Status:** in force.
- **Visible in:** `src/server/origins.ts`, `src/server/handler-cors.test.ts`, `src/server/config.test.ts`,
  `docs/guide/server.md#what-an-origin-is`, `docs/guide/deployment.md#a-webview-or-a-browser-extension`.

### M11-R42: metadata nested more than 32 levels is `INVALID_METADATA`, before anything walks it

- **Decision:** `/upload` refuses metadata with a value inside more than 32 nested arrays and objects: `400
  INVALID_METADATA`, "The metadata is nested more than 32 levels deep. Send a flatter value.", no error log, before the
  route's schema and `authorize` run. The depth is counted by a loop, one level per turn. Nothing else needed a change:
  - `JSON.parse` of the body reads any depth in a loop (measured below); the 64 KiB body cap bounds it at 32,768 levels.
  - `isPlainObject` reads one prototype and walks nothing; the readers of `/upload`, `/sign`, `/complete` and `/abort`
    check types with `typeof` and `Array.isArray`. A test sends 30,000 levels in each field: `400`, nothing logged.
  - `JSON.stringify` of `authorize`'s answer, of `onComplete`'s result and of the token payload runs on the
    application's own values. A request reaches them only through `metadata`, now at most 32 deep; a deep value the
    application builds itself is its bug, answered `500` with a log line as before.
  - The token is parsed only after its HMAC verifies and is at most 16,384 characters, so its depth is the server's.
- **Why:** on a route whose schema passes values through (`z.any()`), `"metadata": [[[…]]]` 5,000 deep, a 10 KB body,
  answered `500 SERVER_ERROR` with `RangeError: Maximum call stack size exceeded` in the log, before `authorize`: an
  anonymous caller could fill the error log. A recursive schema (`z.lazy`) overflows the same way inside its own
  validation, which is why the check runs first and on the input. Measured 2026-11-21 at the top of an empty stack:
  Node 24.22.2 parses 2,000,000 levels and `JSON.stringify` throws by 5,000 (1,000 passes); Bun 1.4.4 parses the same
  and throws by 200,000 (30,000 passes). A deeper call stack, such as a framework's middleware, lowers both, so a
  number is safer than catching the `RangeError`, which would also hide a schema's own `RangeError` (an invalid date).
- **If wrong:** an app that sends metadata deeper than 32 levels in under 2 KiB gets `INVALID_METADATA` where it got
  `200`; none is known. Raise `MAX_METADATA_DEPTH` in `src/server/schema.ts`.
- **Status:** in force.
- **Visible in:** `src/server/schema.ts`, `src/server/upload-metadata.test.ts`, `src/server/handler-failures.test.ts`,
  `docs/guide/server.md`, `docs/guide/errors.md`.

### M11-R43: a hook's `request` has its body read, and the guide and JSDoc say what to read instead

- **Decision:** The handler keeps reading the body once and passing the same `Request` on. The guide's new section
  "The request's body is already read" and the JSDoc of `request` in `AuthorizeContext` (which `owner`, `prefix` and
  `key` share), `CompleteContext` (`onComplete`, `afterComplete`), `BeforeUploadContext`, `AfterVerifyContext` and
  `DeleteContext` say that `request.json()` and `request.text()` throw and that headers, `url`, the validated `metadata`
  and `file` are what a hook reads. The context types moved to `src/server/route-context.ts`, because `route.ts` had
  three lines left under its cap.
- **Why:** the guide called `request` "a standard `Request`", and `authorize: async ({ request }) => request.json()`
  answered `500` with `Body is unusable`. Handing hooks a second `Request` with the bytes would let `authorize` read a
  body the server has not validated, beside `metadata`, which it has, and would copy up to 64 KiB per request for it.
- **If wrong:** an app that needs the raw body in a hook cannot have it; it sends the value as `metadata`.
  `docs/guide/store.md` describes `onDelete`'s `request` and was another agent's to edit in this round: it does not
  repeat the sentence yet.
- **Status:** in force.
- **Visible in:** `src/server/route-context.ts`, `src/server/plugins.ts`, `src/server/delete-context.ts`,
  `src/server/upload-authorize.test.ts`, `docs/guide/server.md#the-requests-body-is-already-read`.

### M11-R44: every `api` call reads a key or prefix in NFC

- **Decision:** `api.getUrl`, `head`, `put`, `delete`, `deleteMany`, `copy` (both keys) and `deletePrefix` normalize
  the key or prefix to NFC before the storage sees it, as `/upload` normalizes every key it stores. Nothing is refused
  for its form. `deletePrefix` still deletes each key as the storage listed it (`M9-H6`).
- **Why:** `/upload` stores `users/Zoé/a.txt` in NFC whatever form the route's `prefix` returned, but
  `api.deletePrefix("users/Zoé/")` with the text in NFD listed another byte sequence on a byte-exact store (`s3()`, the
  fake) and answered `{ deleted: 0, verifiedAt }` while the file stayed: an erasure that reports done and is not.
  `api.getUrl` signed a URL to an object that does not exist. The same string must name the same object in the route
  and in `api`; a refusal naming the NFC form would be louder, but would surface in production on the first user whose
  name or file name arrives decomposed (macOS), in a call whose error an app may not check.
- **If wrong:** keys written by other tools. On R2 the two forms are one object, so nothing changes. On a store that
  compares bytes, an object another tool wrote under a key or prefix that is not NFC is out of reach of `cloudrop.api`:
  `api.delete` of it deletes nothing and succeeds, as a delete of any missing key does. The storage driver the app
  passed to `createCloudrop` sends keys as given (`storage.head`, `storage.delete`, `storage.list`), and the guide
  says so. A key whose NFC form is longer than 1,024 bytes is refused by the driver's own check, as before.
- **Status:** in force.
- **Visible in:** `src/server/api.ts`, `src/server/api.test.ts`, `docs/guide/server.md#file-api`.

### M11-R45: a plugin hook that returns `null` refuses nothing

- **Decision:** `beforeUpload` and `afterVerify` may return `null` as well as `undefined`; the hook types say
  `CloudropError | null | undefined`. Any other value still throws the "must return nothing or a CloudropError" error.
- **Why:** a hook written in plain JavaScript, or ending in `return null`, answered `500` on every upload, with a
  message about a second installed copy of cloudrop.
- **If wrong:** none known: `null` could never have meant a refusal.
- **Status:** in force.
- **Visible in:** `src/server/plugins.ts`, `src/server/plugins.test.ts`, `docs/guide/server.md#plugin-hooks`.

### M11-R46: a preflight allows every header name, and an `OPTIONS` that is no preflight is told so

- **Decision:** A trusted origin's preflight is answered with the header list it asked for whenever each name is an RFC
  9110 token (section 5.6.2: letters, digits and `` !#$%&'*+-.^_`|~ ``), separated by commas with optional spaces and
  tabs; any other text is answered with `content-type` alone, as before. An `OPTIONS` from an allowed origin without
  `Access-Control-Request-Method: POST` answers `405 METHOD_NOT_ALLOWED` with `Allow: POST, OPTIONS` and "This OPTIONS
  request is not a CORS preflight for POST. Send the request as POST." It was `403 ORIGIN_NOT_ALLOWED`.
- **Why:** the old pattern knew only letters, digits and `-`, so a preflight asking for `x_api_key` or `x.trace-id` got
  `content-type` back and the browser blocked the real request, with nothing in the server log. And "This site may not
  upload here. Add its origin to trustedOrigins" sent an operator whose origin was already trusted to the wrong
  setting.
- **If wrong:** a client that matched on `403` for a preflight for another method now sees `405`; a browser treats
  both as a failed preflight.
- **Status:** in force.
- **Visible in:** `src/server/http.ts`, `src/server/handler-cors.test.ts`, `docs/guide/errors.md`.

### M11-R47: `/complete` sends the JSON taken from `onComplete`'s result

- **Decision:** Without a store, `/complete` answers with `JSON.parse` of the JSON `runOnComplete` took when
  `onComplete` returned, not with the live value. The store path already did (`resultToStore` and the replayed answer
  both parse the stored text), so both paths now send plain data that encodes the same way every time.
- **Why:** the answer was encoded a second time from the live value. A `toJSON` that throws on its second call gave a
  non-retryable `500` after `onComplete` had run, and one that answers differently sent the client other data than the
  server had measured.
- **If wrong:** none known; the client receives what `JSON.stringify` gave the first time, as the types
  (`CompleteData`) already said.
- **Status:** in force.
- **Visible in:** `src/server/complete.ts`, `src/server/complete.test.ts`.

### M11-R48: the longest `Content-Disposition` is 3,612 bytes, and R2 takes it

- **Decision:** `/upload` neither refuses nor shortens a file name for the size of its `Content-Disposition`. The live
  lane now uploads a 255-emoji name as a single `PUT` and as a multipart upload on every run.
- **Why:** measured on real R2, 2026-11-21: the 3,612-byte header, the longest `/upload` can sign (14 bytes per
  astral code point), is accepted as a signed header of the presigned `PUT` and of `CreateMultipartUpload`, and `HEAD`
  returns it byte for byte (`docs/research/r2-spike-findings.md`, "Sizes, names and types"). The hardening pass before
  0.3.0 had measured it once by hand; nothing held it.
- **If wrong:** another S3-compatible service with a smaller header limit refuses the upload at the bucket, which the
  client reports as the storage's refusal; RustFS and Wrangler's local R2 are not measured with this name.
- **Status:** in force.
- **Visible in:** `src/server/handler.r2.integration.test.ts`, `docs/research/r2-spike-findings.md`.

### M11-R49: the live lane's two skipped cases are a declared gap, and stay skipped

- **Decision:** `bun run test:live` reports "2 skipped": the contract cases "writes CORS rules that read back as
  written…" and "writes a lifecycle rule from its fields…". They stay skipped on live R2, through the lane's declared
  gap `bucketSettingsWrites` (`M9-C4`), whose reason Vitest prints beside each.
- **Why:** both replace the bucket's whole CORS or lifecycle configuration. The live bucket is the owner's, its CORS
  rule `cloudrop-browser-tests` serves the browser lane, and AGENTS.md allows changing it only when the owner asks; the
  lane's Object Read & Write token is also refused the bucket-settings reads the cases check with (spike Q8).
  AGENTS.md's "fails, never skips" is about a lane whose
  service or credentials are missing, which this lane does fail on (`beforeAll`); a capability a backend lacks is the
  one skip the testing rules allow. RustFS runs both cases on every `bun run test:rustfs`.
- **If wrong:** a regression in the writes that only real R2 shows goes unseen until `cloudrop setup --apply` meets it;
  `docs/research/r2-spike-findings.md` ("setup writes on R2, 2026-11-21") measured them once by hand.
- **Status:** in force.
- **Visible in:** `src/storage/s3-driver.r2.integration.test.ts`, `src/testing/storage-contract/bucket-settings.ts`.

### M11-R150: a deletion never ends a file it did not read as completed

- **Decision:** `deleteCompleted`, with a transaction and under a lease, answers a row that was not `completed` when it
  read it from that read, as `end` answers a row it does not change, and never calls `end` for it. `api.deleteFile` of
  an upload whose `/complete` is recorded a moment later answers `NOT_FOUND`, and the file stays completed, with its
  object and its `onDelete` still to run; a row already `deleted` answers `deleted: false` as before. The other
  callers were checked and hold: `eraseOwner` deletes only rows it listed as `completed`, each read again by the same
  code; a replacement whose listing misses a file that completes before the record rolls back with a transaction
  (`replacedAsListed`) and runs the late hook under a lease (`afterReplacing`); and a server without any `onDelete`
  calls `end` alone (`M10-D8`), where there is no hook to miss.
- **Why:** the hook is chosen from the row as read. A `pending` or `completing` row chose none, and `end(completed →
  deleted)` then matched the row a completion had recorded in between: the file was deleted with no `onDelete`, so no
  audit row was written and no pointer cleared. Seen on the memory store in both modes and on Postgres 18 through
  Drizzle on both drivers (`deleteFile` answered `deleted: true`, the row `deleted`, the hook never run). On Postgres
  the window is between the deletion's `SELECT` and its `UPDATE`: an `UPDATE … WHERE status = 'completed'` does not
  wait for a row whose committed version is `pending`, so the test holds the read until the completion has committed.
- **If wrong:** a caller that deletes a file in the moment it completes gets `NOT_FOUND` where 0.5.0 deleted it; it
  calls again, and the hook then runs.
- **Status:** in force. Each test was seen failing on the code before the fix.
- **Visible in:** `src/server/store-delete.ts`, `src/server/store-delete-race.test.ts`,
  `src/adapters/drizzle-handler.db.integration.test.ts`, `src/testing/delete-fixture.ts` (`state.read`).

### M11-R151: the tests of deletion and erasure fail when their branch is removed

- **Decision:** Every branch of `src/server/erase.ts` and `src/server/store-delete.ts` was removed or inverted in turn
  (95 one-line mutations) with the unit lane run on each, and tests were added or sharpened until each mutation a
  caller can see fails one. In `eraseOwner`: the last read of the live statuses (an `/upload` reserved before the run
  and recorded during it), both signal checks inside a run (between two files of a page, and between two pages, with
  no store call after the abort), the signal check before the run (an unfinished upload stays unrevoked), every page
  read, the `graceMs` a caller passes, `rejected` and `expired` rows, a row marked cleaned too early, a row that
  cannot be marked cleaned, the store's error for a failed revocation, listing or last read, and options that are not
  an object. In deletions: a failed read before the hook and after a throw, the log line of a failed deletion, the row
  a late replacement's hook sees, and what a replacement lists (only its own route, nothing without an owner, every
  page, nothing on a route without `onDelete`, and the store's error when the listing fails).
- **Why:** the review removed the last live read and both mid-run signal checks and every test stayed green. The cause
  was the frozen test clock: every file was created at the very millisecond the run started, so the check for an
  upload that started during the run answered for the reads it was meant to back up. The same clock hid two more: the
  live statuses read together (`M8-A5`) and `done` needing no failure. Those tests now move the clock before the run.
- **If wrong:** three mutations change nothing a caller can see and are left without a test: marking a row cleaned
  that is marked already (`store.cleaned` ignores it), and treating a route without `onDelete` as hooked in
  `hookedRoute` and in `afterReplacing` (the missing hook is not called). Each only saves a call.
- **Status:** in force.
- **Visible in:** `src/server/erase.test.ts`, `src/server/store-delete.test.ts`,
  `src/server/store-delete-race.test.ts`, `src/server/store-delete-replace.test.ts`.

### M11-R152: `EraseReport` says what each counter leaves in the bucket

- **Decision:** The guide's table for `api.eraseOwner` and the JSDoc of `EraseReport` say, per counter, what is in the
  bucket after the run. `revoked` and `deleted` files have their objects removed later in the same run, where each
  counts a second time, in `cleaned`, `waiting` or `failed`. `refused` files, and files whose `onDelete` threw
  (`failed`), are still completed with their objects. `waiting` is two kinds: files still live, whose objects are
  still there (a completed file its hook kept, a completion under way, an upload started during the run), and ended
  uploads whose object this run removed but whose URLs, or the grace after them, have not run out. No behaviour
  changed.
- **Why:** both texts said of `waiting` that what the files had stored was removed. That holds only for the ended
  ones: a refused file, a completion under way and an upload begun during the run keep their objects, so an operator
  reading `waiting: 1` after an erasure request could believe the bucket was empty of that owner.
- **If wrong:** none known; the counters themselves are as `M8-A5` and `M11-D4` set them.
- **Status:** in force.
- **Visible in:** `src/server/erase.ts`, `docs/guide/store.md#erase-an-owner`.

### M11-R153: an erasure needs the sweep for a completion its server never finished

- **Decision:** `api.eraseOwner` still never ends a `completing` row. One left by a server that died in `/complete`
  counts in `waiting` on every run, with its object kept, until the sweep ends it as `failed`: past its lease and
  `graceMs` past its token's deadline, 25 hours after its `/upload` with the defaults. The next run then removes the
  object and can report `done`. The guide says so under "It needs the sweep", and `EraseReport.done` names it.
- **Why:** the other choice was to let `eraseOwner` end such a row itself. It would gain no time, since the row may be
  taken over by a `/complete` until its token's deadline either way. It would need the sweep's rule a second time: the
  rule lives in each store's `stale` statement, which reads every owner's rows, so `eraseOwner` could share it only by
  sweeping everyone or by restating it. And it would end a stuck completion without the sweep's `reported` list, the
  one place an app learns that its `onComplete` may have recorded a file that never completed. Every store app is
  already told to run the sweep on a schedule, so the safe change before a release is the sentence, not a second path
  that ends rows.
- **If wrong:** an app that erases owners and runs no sweep sees `waiting: 1, done: false` for ever for such an owner;
  the guide names the cause and the cure. A per-owner `stale` would let `eraseOwner` share the rule later.
- **Status:** in force. `src/server/erase.test.ts` ("waits for the sweep to end a completion its server never
  finished…") holds the times at the millisecond: not ended at 25 hours, ended one millisecond later.
- **Visible in:** `docs/guide/store.md#erase-an-owner`, `src/server/erase.ts`, `src/server/erase.test.ts`.

### M11-R154: a replacement whose `onDelete` threw for a lost race asks its client to retry

- **Decision:** The guide scopes the lost-race sentence: when `onDelete` throws because another deletion took the file
  first, `api.deleteFile` answers as for a file already deleted and `api.eraseOwner` counts the file nowhere
  (`M10-D7`), but a replacing `/complete` answers the retryable `SERVER_ERROR` of any throw, its new file stays
  `pending`, and the client's retry, which finds nothing left to replace, completes. The behaviour is as it was.
- **Why:** the sentence read as if every caller answered "already deleted". A replacement cannot: it has run
  `onComplete` and holds a claim or a transaction, and whether the file it meant to replace is gone decides nothing
  about its own completion, which the retry settles by listing again (`M10-D5`). Reading the row again there would
  add a store call to gain an answer the retry gives anyway.
- **If wrong:** a client sees one more retry of `/complete` in that race than a second read would cost.
- **Status:** in force. `src/server/store-delete-race.test.ts` ("an onDelete that throws after a deletion won fails
  /complete, which a retry finishes"), in both modes.
- **Visible in:** `docs/guide/store.md#a-replacement-whose-files-change-meanwhile`.

### M11-R110: every command the output prints is complete, quoted and runnable as printed

- **Decision:** one module (`src/cli/commands.ts`) builds every printed command.
  - A cloudrop command the output tells the reader to run next repeats the run's `--origin`, `--env-file`, `--var`
    and `--jurisdiction`, each as one word of a POSIX shell (plain text as it is, anything else in single quotes), ends
    its line, and starts with the runner that started the command: `bunx` or `pnpm exec` when
    `npm_config_user_agent` starts with `bun/` or `pnpm/`, `npx` otherwise. The usage line says the same. The dry
    run's last line and the plain `setup`'s last paragraph print the `--apply` command instead of describing it.
  - A Wrangler command starts with the runner too (`npx wrangler …`), as Cloudflare's documentation writes it.
  - A Wrangler or AWS CLI command names the bucket and the S3 endpoint by value, once the storage settings are all
    set and valid, and `<bucket>` and `<endpoint>` until then, with a sentence that says to replace them. Beside the
    commands the output says that each tool signs in on its own, with the variables that do it.
- **Why:** each printed command failed when pasted. After `doctor --origin X --env-file e2e.env` the suggested
  `cloudrop setup --origin X --apply` answered "No storage settings found"; without `--jurisdiction` it targeted the
  default endpoint; a bare `cloudrop` is `command not found` in a project that installed the package; and
  `--origin 'https://a.example$(id)'`, which the URL parser takes as an origin, was printed as shell text. After
  `--env-file`, `"$CLOUDROP_R2_BUCKET"` was empty in the reader's shell. The runner is measured (2026-11-21):
  `npx` and `npm run` set `npm/11…`, `bunx` and `bun run` set `bun/1.4.4 …` and start the bin with Node, `pnpm exec`
  sets `pnpm/12…`, and a direct start sets nothing. The test splits each printed command with a real `sh` and reads
  it back through `parseArgs`.
- **If wrong:** a bucket name and an S3 endpoint are printed, which `M9-C8` kept out of the output; neither grants
  access, and both are printed only after the presets' own checks accepted them (an endpoint with a user name or
  password is refused there). The quoting is POSIX: in PowerShell a word with a single quote, and in `cmd` any quoted
  word, needs requoting, which the guide says. Yarn's runner is not detected and gets `npx`.
- **Status:** in force. Supersedes the `"$NAME"` form of `M9-C8` and `M11-C4`; `M11-C4`'s rule that messages name the
  app's variable stands.
- **Visible in:** `src/cli/commands.ts`, `src/cli/commands.test.ts`, `src/cli/doctor.ts`, `src/cli/setup.ts`,
  `src/cli/instructions.ts`, `src/cli/usage.ts`, `src/cli/run.ts`, `docs/guide/command.md#settings`,
  `docs/guide/bucket-setup.md`.

### M11-R111: one origin rule for the server and the command, and `ws:`, `wss:` and `ftp:` are no page's origin

- **Decision:** the command reads `--origin` with `originProblem` of `src/server/origins.ts`, the function
  `trustedOrigins` and `api.checkBucket` use, and prints its message as it is; the command's own copy of the rule is
  gone. That rule now refuses a URL whose scheme is `ws`, `wss` or `ftp`: "is not a page's origin: a page is loaded over
  http or https, or over an app's own scheme."
- **Why:** the command's copy predated `M11-R41`, so `--origin capacitor://localhost`, `tauri://localhost` and
  `chrome-extension://<id>` exited 2 with "Write it as scheme://host[:port]", which is how they are written, and an app
  the server accepted could not have its bucket checked or set up. The same copy, and the server's rule, took
  `ws://a.example` and `ftp://a.example`: the URL standard lists six special schemes (`ftp`, `file`, `http`, `https`,
  `ws`, `wss`, <https://url.spec.whatwg.org/#special-scheme>) and its origin algorithm returns a tuple origin for all
  but `file` (<https://url.spec.whatwg.org/#origin>), but a document is fetched over `http` and `https` alone, so no
  page sends such an `Origin`. A CORS rule written for one allows nobody.
- **If wrong:** an app whose shell really sends `ws://…` or `ftp://…` as its origin is refused at start-up
  (`INVALID_CONFIG`) and by the command (exit 2); none is known. The command's messages lose "with its own --origin"
  and gain "in lowercase", the server's wording.
- **Status:** in force. Extends `M11-R41`.
- **Visible in:** `src/server/origins.ts`, `src/server/config.test.ts`, `src/cli/args.ts`, `src/cli/run.test.ts`,
  `docs/guide/command.md`, `docs/guide/server.md#what-an-origin-is`.

### M11-R112: `--env-file` is read by Node's own parser, ported step for step

- **Decision:** `parseEnvFile` (`src/cli/env-file.ts`) is a port of `Dotenv::ParseContent` in Node's
  `src/node_dotenv.cc` (the `v24.x` branch, read 2026-11-21), not a line pattern of the command's own. It keeps Node's
  reading where another dotenv reader may differ: a byte order mark stays in the first name, so the variable the file
  means is not set; only a space after `export` is taken off (`export<tab>A=1` sets `export<tab>A`); a carriage return
  is removed and ends no line; a name may hold a space; `A=` followed by spaces alone takes the next line as its value;
  a no-break space is not trimmed. A file that starts with a byte order mark before a variable gets a `note` naming
  the variable Node does not set. The test compares each of these with `util.parseEnv` of the Node that runs it.
- **Why:** the guide said the file is read "the way Node's `--env-file` does", and the review found four files the two
  read differently, each in the direction that hides a problem: `doctor` answered `ok … is set` for a variable an app
  started with `node --env-file` never gets. A differential run of 300,000 random files of the characters that matter
  (quotes, `#`, `=`, `export`, CR, LF, tab, a byte order mark) against `util.parseEnv` on Node 24.22.2 found no
  difference; that run is not in the suite, the table of the named cases is.
- **If wrong:** an app that loads the file with dotenv, Bun or Next.js may get a variable Node does not, and `doctor`
  then reports it as not set; the guide says whose reading it is. A later Node that changes its parser turns the table
  test red on that Node, which is the signal to port the change.
- **Status:** in force. Amends `M9-C8`.
- **Visible in:** `src/cli/env-file.ts`, `src/cli/env-file.test.ts`, `src/cli/variables.ts`,
  `docs/guide/command.md#settings`.

### M11-R113: every `--env-file` is read, a later one winning, and an empty variable in the environment wins too

- **Decision:** `--env-file` may be repeated; every file is read in the order given and a later file's value replaces
  an earlier one's. A variable the environment has wins over every file, even when it is set to nothing: the setting
  then reads as not set, with a `note` that names the variable and the file whose value it hides. The note for a
  variable set in both names the file its value came from.
- **Why:** measured on Node 24.22.2: `node --env-file=a.env --env-file=b.env` sets what both files hold and `b.env`'s
  value where both name a variable; `A= node --env-file=a.env` leaves `A` empty. The command read only the last file,
  silently, and took the file's value over an empty variable, so it reported `ok … is set` for a setting the library
  (`fromEnv`: an empty variable is unset) would not find.
- **If wrong:** none known; a project that passed `--env-file` twice and relied on the first being ignored now gets
  its variables too.
- **Status:** in force.
- **Visible in:** `src/cli/args.ts`, `src/cli/variables.ts`, `src/cli/variables.test.ts`,
  `docs/guide/command.md#settings`.

### M11-R114: `--replace` never stands in for a bucket that refuses the credentials

- **Decision:** `setup --apply` and `--dry-run` report the listing's failure whenever a read of the rules failed,
  with `--replace` as without it, in the same sentence (`Bucket: The storage service refused these credentials…`),
  and write nothing.
- **Why:** with `--replace` a refused read became a planned replace before the listing was looked at. With a wrong
  secret key every request is refused, so `--dry-run --replace` exited 0 with "would replace every rule" and
  `--apply --replace` printed two "the write failed" lines that named no variable (run against a local server,
  2026-11-21). `M9-H102` had ruled that the listing tells wrong credentials from an object token; the `--replace`
  path skipped it.
- **If wrong:** credentials that may write bucket settings but may neither read them nor list objects can no longer
  replace the rules with this command; none is known, and the S3 API writes still work by hand.
- **Status:** in force. Completes `M9-H102`.
- **Visible in:** `src/cli/setup.ts`, `src/cli/setup.test.ts`, `docs/guide/command.md#setup`.

### M11-R115: the command and the origin rule repeat nothing that may be a secret

- **Decision:** an argument the command does not know is repeated only when it is shaped like an option's name
  (`--force`, up to its `=`) or a command's (letters and hyphens, at most 20). `NAME=value` after the command is named
  by `NAME` when that is one of the ten settings ("CLOUDROP_SECRET is given as an argument…"), and any other argument
  by its position ("Argument 4 is not an option…"). An `--env-file` that cannot be read is reported by its error code
  alone, and by its number when there are several; a path is printed only once it was read as a file. `originProblem`
  (the server's `trustedOrigins` and `checkBucket`, and `--origin`) does not repeat a value with an `@` in it: "An
  origin holds no user name or password, so this one is not repeated here. Use https://app.example.com…". The tests'
  leak check now covers values under 8 characters as whole words.
- **Why:** the output goes to terminals, CI logs and, for the server's `INVALID_CONFIG`, application logs.
  `doctor --origin X CLOUDROP_SECRET=<value>` printed the value in `Unknown option "…"`, `--env-file <value>` printed
  it in `Cannot read <value> (ENOENT)`, and `--origin https://KEY:pw@host` and `trustedOrigins` printed the password.
  The old leak check skipped values under 8 characters, so a short password was never looked for.
- **If wrong:** an honest typo that is not shaped like a name (`doctor orig1n …`) is named by its position, which is
  less direct. A word of letters typed as the command (`cloudrop hunter`) is still repeated. On Node a missing
  `--env-file` never reaches the command: Node exits 9 and prints the path itself (`M9-H104`).
- **Status:** in force. Amends `M9-C8` (the path of an unreadable file) and `M9-H100`.
- **Visible in:** `src/cli/args.ts`, `src/cli/variables.ts`, `src/server/origins.ts`, `src/cli/run.test.ts`,
  `src/cli/command-fixture.ts`, `src/server/bucket-check.test.ts`, `docs/guide/command.md#settings`.

### M11-R116: a sentence about the bucket is true for the answer and for the service

- **Decision:** the listing that proves the bucket (`M9-C5`) reads two answers as not a storage service's: a `404`
  that names no missing bucket ("The endpoint answered the listing with HTTP 404, but not as a storage service does…")
  and a redirect (for S3 the storage's own sentence with the endpoint and region variables; for R2 "The endpoint
  redirected the request (HTTP 302), and a signed request is not sent on", since R2 has no region setting), each with
  the endpoint's variable. `api.checkBucket` words its "may not read" and "add a lifecycle rule" messages for R2 only
  when the storage's `rules` are the `r2()` preset's own object, and names no service otherwise. `setup --apply` says
  "R2 can take up to 30 seconds" only on R2.
- **Why:** a listing names no object, yet a bare `404` from a proxy printed "The object does not exist. Check the
  key."; and an S3 run printed "R2 object tokens cannot", "admin read token or in the dashboard", "R2 creates a 7-day
  rule by default" and R2's half minute. The review's third case, a redirect reported as "Could not reach the storage
  service", did not reproduce on this commit: the driver already answers "The storage endpoint redirected the
  request…" (run on Node 24 and Bun 1.4 against a local server), so only its wording for R2 changed.
- **If wrong:** a driver built by hand with `rules: { ...R2_RULES }` gets the neutral words on R2. A storage service
  that answers a listing of a missing bucket with a bare `404` is told "something else may be answering", and the
  finding still names the endpoint to check.
- **Status:** in force. Extends `M9-H101`.
- **Visible in:** `src/cli/bucket-access.ts`, `src/server/bucket-check.ts`, `src/cli/setup.ts`,
  `src/cli/doctor.test.ts`, `src/cli/setup.test.ts`, `docs/guide/command.md#doctor`.

### M11-R117: a variable is read as an own property

- **Decision:** the command reads the environment with `Object.hasOwn` and an env file's variables from a `Map`.
- **Why:** `--var CLOUDROP_SECRET=__proto__` with nothing set printed `ok __proto__ is set.`, and `constructor` and
  `toString` printed "is set in the environment and in undefined": a plain lookup finds what every object inherits.
  All three are names a shell can set, so `--var` accepts them.
- **If wrong:** none known.
- **Status:** in force.
- **Visible in:** `src/cli/variables.ts`, `src/cli/env-file.ts`, `src/cli/variables.test.ts`.

### M11-R118: `--jurisdiction` is for R2 alone, and is given once

- **Decision:** `--jurisdiction` with settings that select S3 is a usage error (exit 2) that names the S3 variables
  found; a second `--jurisdiction` is a usage error too.
- **Why:** with S3 settings the option changed nothing and said nothing, and of two the last won silently. Either
  hides a mistake about which bucket is being checked or written.
- **If wrong:** a script that passes `--jurisdiction` for every environment, S3 ones included, now exits 2 there.
- **Status:** in force.
- **Visible in:** `src/cli/args.ts`, `src/cli/run.ts`, `src/cli/run.test.ts`, `docs/guide/command.md#settings`.

### M11-R119: `cloudrop --version` prints the package's version

- **Decision:** `--version` and `-v`, as the first argument, print the version and exit 0. `src/cli.ts` imports
  `package.json` with `{ type: "json" }`; the build keeps the one string (`var version = "…"`), not the manifest.
- **Why:** `cloudrop --version` answered `Unknown command "--version"`, and a bug report needs the number. A build-time
  constant would have left the source bin, which the tests run under Node and Bun, without one.
- **If wrong:** a bundler that stops tree-shaking a JSON import would put the whole manifest into `dist/cli.js`, about
  3 kB; nothing imports that file.
- **Status:** in force.
- **Visible in:** `src/cli.ts`, `src/cli/args.ts`, `src/cli/run.ts`, `src/cli/run.test.ts`, `docs/guide/command.md`.

### M11-R120: the package check runs the built bin on Node and Bun

- **Decision:** `scripts/check-package.sh` (part of `bun run verify`) checks `dist/cli.js` itself: its first line is
  `#!/usr/bin/env node`, it is executable in the packed tarball, `--version` prints the version of `package.json`,
  `--help` prints the usage and `doctor` without `--origin` exits 2, on Node and, when `bun` is on `PATH`, on Bun.
- **Why:** every test of the command ran the source (`runCommand`, or `src/cli.ts` under each runtime). A build that
  dropped the shebang, lost the version or broke the entry would have been published green. Each message was seen to
  fire by breaking the built file by hand (a wrong version, a wrong exit code).
- **If wrong:** none known; the check adds four starts of a runtime, about half a second, to the package check.
- **Status:** in force.
- **Visible in:** `scripts/check-package.sh`.

### M11-R80: `retry()` follows one table of what each failure leaves of the ticket

- **Decision:** `retryStep(error)` in `src/client/retry-step.ts` is the one place that says what a failure leaves of
  its upload's ticket, and `retry()`, `giveUp` and `discard()` read it. It answers `resend` for `NOT_UPLOADED` and
  `PARTS_MISSING`; `same` for every retryable error and for `INVALID_INPUT`, `ORIGIN_NOT_ALLOWED`,
  `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE`, `BODY_TOO_LARGE`, `NOT_FOUND`, `SERVER_ERROR` and `STORAGE_ERROR`;
  `new` for every other error, a code this client does not know included. It replaces the list `NEEDS_NEW_TICKET`
  (`M3-U31`), whose default was the same ticket. `retry()` decides in this order: no ticket, or one the page gave up
  (`M3-U33`): a new ticket. `new`: a new ticket. A `/complete` in doubt (`M3-U30`): `/complete` alone. A ticket that
  expired, or cannot sign what is still to send (`M9-H3`): a new ticket. Otherwise the same ticket; for `resend`, the
  parts the answer named are sent again first, and every part when it named none.

  | Answer | From | What it leaves: object, multipart upload, row | `retry()` |
  | --- | --- | --- | --- |
  | Any refusal or no answer: `UNAUTHORIZED`, `FORBIDDEN`, `UNKNOWN_ROUTE`, `INVALID_METADATA`, `TOO_MANY_FILES`, `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`, `ACCOUNT_CHANGED`, `QUOTA_EXCEEDED`, `INVALID_INPUT`, `UPLOAD_EXPIRED` (the row was revoked meanwhile), `STORAGE_ERROR`, `RATE_LIMITED`, `SERVER_ERROR`, `NETWORK_ERROR`, the handler's refusals below | `/upload` | Nothing: the file has no ticket. What `/upload` reserved for a refused file it released. An answer lost on the way leaves rows and multipart uploads nobody holds, for the sweep and the lifecycle rule | new: `/upload` is asked again, since its answer depends on the session, the quota and the server's rules of that moment |
  | `INVALID_INPUT`, `ORIGIN_NOT_ALLOWED`, `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE`, `BODY_TOO_LARGE`, `NOT_FOUND` | the handler, before it reads the token, at `/sign` and `/complete`; `INVALID_INPUT` also for a part list `/sign` refuses | Everything as it was | same: the request was turned away, not the upload; it passes once the proxy, `basePath` or `trustedOrigins` is fixed |
  | `SERVER_ERROR`, retryable (a hook threw, the store failed, another request is completing, a setting is missing) or not (the handler caught a throw); an answer that is not cloudrop's | `/sign`, `/complete` | Everything as it was; after `/complete` the file may be complete | same; after `/complete`, `/complete` alone |
  | `STORAGE_ERROR`, retryable or not; `RATE_LIMITED` | `/sign`, `/complete` | Everything as it was. A refusal whose delete failed keeps the object, and the next `/complete` discards it | same |
  | `NETWORK_ERROR` | the client: no answer, or the `headers` function failed | Everything as it was; a `/complete` that left the page may have completed the file (`M11-R82`) | same; `/complete` alone when in doubt |
  | `INVALID_TOKEN` | `/sign`, `/complete` | Everything as it was; the token is not this server's | new |
  | `UPLOAD_EXPIRED` | `/sign` (expired, in its last 15 minutes, or its row is not pending), `/complete` (expired, or its row was ended or is gone) | Stateless: the object or parts stay. Store: the row is ended, or the sweep ends it | new |
  | `UNKNOWN_ROUTE` | `/sign`, `/complete` | Everything as it was; a deploy removed the token's route | new, which `/upload` refuses while the job's route is gone |
  | `NOT_UPLOADED` | `/complete`, single `PUT` | No object under the key; the row stays pending | resend: the `PUT`, then `/complete` |
  | `PARTS_MISSING` | `/complete`, multipart | The upload is open; the row stays pending | resend: the named parts, then `/complete` (after the two repair rounds of `M3-S13`) |
  | `VERIFICATION_FAILED` | `/complete` | The object is deleted, or is another writer's and kept; the row is `rejected` | new |
  | `NO_SUCH_UPLOAD` | `/complete`; the bucket (`404 NoSuchUpload`, `M9-H4`) | The multipart upload is gone and no object of it is stored | new |
  | `ALREADY_EXISTS` | `/complete`, multipart | The multipart upload is aborted; the row is `rejected` | new |
  | `FILE_TYPE_NOT_ALLOWED` | `/complete` (`contentChecks()`, `M10-K4`) | The object is deleted; the row is `rejected` | new |
  | Any other code, not retryable | `/complete`: a plugin's `afterVerify` refusal (the object is deleted, the row `rejected`) or a replacing route's `onDelete` refusal (`M11-D3`: the object and the pending row are kept) | As named | new |
  | `UPLOAD_REJECTED` | the bucket: `403` for the signature or after a renewed link, `501`, any other `4xx` | Nothing of this `PUT`; earlier parts and the pending row stay until the ticket is given up (`M11-R89`) | new |
  | `STORAGE_ERROR`, `RATE_LIMITED`, `NETWORK_ERROR` | the bucket: `5xx`, `408`, `400 RequestTimeout` (`M11-R88`); `429`, `503`; no readable answer | Parts that landed stay | same |
  | `ABORTED`; a done file | a cancel | As the cancel left it | nothing: `retry()` answers the outcome as it is (`M3-U37`) |
  | `INVALID_INPUT`, `CLIENT_CLOSED` | the client, for the arguments of `start()` or a closed client | The job has no files | nothing: `retry()` answers the refusal |
  | `NOT_FOUND`, `UPLOAD_IN_USE`, `INVALID_INPUT`, `STORAGE_ERROR` | `resume()`'s checks | The record is as it was | the checks run again (`M3-U90`) |

  `INVALID_CONFIG` is thrown, and `STORAGE_UNREACHABLE`, `STORAGE_DENIED`, `INVALID_PART` and `CHECKSUM_MISMATCH` never
  leave the server (`storageFailure`); one a hook returns follows its `retryable`.
- **Why:** two dead ends, both reproduced. After `contentChecks()` refused a file at `/complete` the server had deleted
  the object, and `retry()` sent `/complete` with the old ticket for ever: `NOT_UPLOADED` without a store,
  `UPLOAD_EXPIRED` with one, although `M10-K4` said a retry asks for a new ticket. After a proxy answered a single `PUT`
  for the bucket, `/complete` answered `NOT_UPLOADED`, part 1 stayed counted as landed, and every `retry()` sent only
  `/complete`. Both came from the same default: a code missing from a list kept the ticket. The default is now the
  other way round, because a refusal for good that the client cannot place is most often the server ending the upload,
  and then only a new ticket can store the file; the codes that leave the ticket good are few and named. A
  `PARTS_MISSING` whose list a proxy dropped looped the same way and now sends every part.
- **If wrong:** a replacing route whose `onDelete` refuses at `/complete` keeps the object and the pending row, and the
  retry sends the file again under a new key instead of `/complete` alone; the first object and row go with the
  `/abort` of `M11-R89`. A person who retries a file refused for its content sends it again to be refused again: the
  client cannot know whether the server's rules changed, and `/upload`'s own refusals are asked again the same way.
- **Status:** in force. Supersedes the list of `M3-U31`; `M10-K4`'s sentence about `retry()` is true from here on.
- **Visible in:** `src/client/retry-step.ts`, `src/client/retry-file.ts` (`needsTicket`, `requeue`),
  `src/client/file-run.ts` (`giveUp`), `src/client/discard.ts`, `src/client/retry-steps.test.ts` (one row per answer),
  `src/client/retry-dead-ends.test.ts`, `docs/guide/client.md` ("Retry").

### M11-R81: a `/complete` in doubt ends with the server's word

- **Decision:** an answer of `/complete` that says the ticket is over (`new` in `M11-R80`) outranks the doubt of an
  earlier `/complete`: the next `retry()` asks `/upload` for a new ticket. `NOT_UPLOADED` clears the doubt, as
  `PARTS_MISSING` and `NO_SUCH_UPLOAD` do, so that retry sends the file again and a cancel sends `/abort`. The first
  retry after a doubt still sends `/complete` alone, whatever the clock says (`M3-U30`), and a cancel still sends no
  `/abort` for a ticket whose doubt was never cleared.
- **Why:** `M3-U30` accepted that a file in doubt whose ticket expired "can never be confirmed done by `retry()`", so
  every later `retry()` sent a `/complete` that could only answer `UPLOAD_EXPIRED`. The same held for a doubt followed
  by `NOT_UPLOADED`, `VERIFICATION_FAILED` or a content refusal. Once the server has answered, the old ticket can settle
  nothing more, and the message already tells the person to start again; `retry()` now does that. With a store the
  answer proves no completion was recorded: a completed row is replayed, also after expiry.
- **If wrong:** without a store, a `/complete` that finished unheard, followed by an expiry and a retry, stores the
  file twice and runs `onComplete` twice, as the person's own new upload would. `NOT_UPLOADED` after a completion that
  finished unheard means the app deleted the object since; the retry stores it again under the same key.
- **Status:** in force. Amends `M3-U30`'s "If wrong".
- **Visible in:** `src/client/retry-file.ts` (`needsTicket`), `src/client/upload.ts` (`complete`),
  `src/client/retry-dead-ends.test.ts`.

### M11-R82: only a `/complete` that left the page may have finished the file

- **Decision:** the errors of a request the client gave up before sending it (the `headers` or `account` function
  threw, rejected, gave nothing usable or did not answer within the request's time) are marked as unsent
  (`wasSent` in `src/client/failures.ts`), and a `/complete` that failed that way leaves no doubt. Their code stays
  `NETWORK_ERROR`, retryable.
- **Why:** reproduced: with a `headers` function that failed for every `/complete`, `upload()` kept the stored object
  for good and `abort()` after `start()` sent no `/abort`, because any `NETWORK_ERROR` of `/complete` counted as "may
  have finished". Nothing was sent, so nothing can have finished. Every other failure of `send()` is built after
  `fetch` was called and still counts: a browser does not say whether a failed request left. `account` runs for
  `/upload` only, where no decision reads the mark.
- **If wrong:** none known. A custom `fetch` that rejects before sending is still counted as sent, which keeps the file.
- **Status:** in force.
- **Visible in:** `src/client/failures.ts` (`wasSent`, `headersFailed`, `accountFailed`), `src/client/upload.ts`
  (`complete`), `src/client/upload-abort.test.ts`.

### M11-R83: without `crypto.getRandomValues`, the `/upload` key comes from `Math.random`

- **Decision:** `newRequestKey` (`src/client/launch.ts`) fills its 16 bytes with `crypto.getRandomValues` when the
  runtime has it and with `Math.random` otherwise; the key keeps its shape, 32 hex digits.
- **Why:** reproduced: without a global `crypto.getRandomValues`, which React Native's Hermes lacks unless the app adds
  a polyfill (`M8-Q8` names it as a target), the key threw inside `launch`, `job.done` rejected with a `TypeError` and
  the file stayed `queued`, though `done` promises never to reject. The key is an idempotency key, not a secret: the
  server only compares it with the keys of the same owner's pending rows, and supersedes nothing else by it
  (`M5-T105`), so a guessed key gives a caller nothing they could not send themselves. It only has to differ from that
  owner's other asks of the last 24 hours, which sixteen draws from an engine's generator do. The client's other two
  uses were checked: `crypto.randomUUID` is not called, and `crypto.subtle` (`fingerprint.ts`) runs only where records
  are kept, which needs Web Locks and so a secure context; without it `fingerprintOf` rejects, the record is not saved,
  `isSameFile` answers false, and the upload goes on (measured in the unit lane, 2026-11-21).
- **If wrong:** a runtime whose `Math.random` repeats a sequence across sessions of one owner within a day could give
  two asks one key, and with a store the later ask would end the earlier one's pending rows: that upload then fails
  with `UPLOAD_EXPIRED` and `retry()` starts it again.
- **Status:** in force.
- **Visible in:** `src/client/launch.ts`, `src/client/launch.test.ts`.

### M11-R84: a hostile argument is `INVALID_INPUT`, never a throw

- **Decision:** `start()`, `upload()`, `resume()`, `discard()` and `forget()` read what the caller passed through
  `tryRead` (`src/client/arguments.ts`), so a getter or a proxy that throws is answered as `INVALID_INPUT`: "An
  argument threw an error while it was read. Pass plain values: a route name, File objects and options." for
  `start()` and `upload()`, each other call's own message otherwise. A list of files is read entry by entry and refused
  at the first that is no `File`, before anything is copied.
- **Why:** reproduced: `upload("files", { length: Infinity })` and `start("files", { length: 2 ** 32 })` threw
  `RangeError: Invalid array length` out of the call, and `{ length: 2 ** 32 - 1 }` ran `Array.from` out of memory
  (the test worker died with it), because the list was copied before it was checked. A `length` getter that threw
  left `upload()` twice, once from the check and once from telling a list from a file. Public calls return
  `{ data, error }`; a `RangeError` from inside the library says nothing a caller can act on.
- **If wrong:** none known. A list with a hole is refused as before, with the message for a list that holds something
  other than files.
- **Status:** in force.
- **Visible in:** `src/client/arguments.ts`, `src/client/resume.ts`, `src/client/discard.ts`,
  `src/client/arguments.test.ts`.

### M11-R85: a ticket from `/upload` passes the check a saved record passes

- **Decision:** `isPartPlan(size, partSize, partCount)` in `src/client/answers.ts` is the one check of a multipart
  plan, for a ticket `/upload` answers and for a record read back from IndexedDB: parts of 5 MiB to 5 GiB, at most
  10,000 of them, and exactly the count the file's size and the part size give. A ticket outside it makes the whole
  `/upload` answer unreadable (`SERVER_ERROR`, "the upload server sent an answer this client cannot read"), as a wrong
  part count already did (`M3-S7`); a record outside it is deleted, as before. A signed part's number must lie in 1 to
  the part count, as before.
- **Why:** reproduced: a ticket with `partSize: 1` and one part per byte passed, because only the count was compared
  with the file, and the client then listed every part number (16,777,221 for a 16 MiB file) before the first `PUT`.
  A saved record was already capped at 10,000 parts (`records.ts`); the live answer, which also crosses proxies and
  cloudrop versions, was not. The three limits are those of every S3-compatible storage (`R2_RULES`, `S3_RULES`), and
  the server's planner never goes below 8 MiB, so no ticket of a cloudrop server is refused.
- **If wrong:** a custom `StorageDriver` whose rules allow parts under 5 MiB or more than 10,000 parts would have its
  multipart tickets refused by the client; the planner starts at 8 MiB and doubles, so that needs a file over
  10,000 times the driver's largest part.
- **Status:** in force.
- **Visible in:** `src/client/answers.ts`, `src/client/records.ts`, `src/client/endpoints.test.ts`.

### M11-R86: a cancel during `/complete` waits for the answer, and the documentation says so

- **Decision:** the behaviour of `M3-S14` and `M4-F4` stays: a cancel does not cut off a `/complete` in flight. The
  file stays `completing` until that request answers, at most 120 seconds (`COMPLETE_TIMEOUT_MS`, one attempt; no
  further attempt starts after a cancel), and ends `done` with its result when the server completed it and `aborted`
  otherwise; `done` of an aborted file then waits for its `/abort`, at most 10 seconds. The JSDoc of
  `FileHandle.abort`, `UploadJob.abort` and `UploadOptions.signal` and the guide's "Cancel" now say this.
- **Why:** confirmed by test: `abort()` during `/complete` left the file `completing`, and a completion that succeeded
  ended it `done`, while the JSDoc said the file "ends aborted at once" and that the signal's result "is ABORTED". The
  behaviour is right: when the server answered success the object is stored and `onComplete` ran, so reporting
  `ABORTED` would hide a file the app has recorded, and cutting the request off would leave the page not knowing which
  it was. Only the sentences were wrong.
- **If wrong:** an app that treats a cancel as "the file does not exist" must delete a file that ends `done` after a
  cancel; the guide says so.
- **Status:** in force.
- **Visible in:** `src/client/types.ts`, `src/client.ts`, `docs/guide/client.md` ("Cancel"),
  `src/client/cancel-completing.test.ts`.

### M11-R87: `/abort` uses keepalive only within a byte budget

- **Decision:** each client counts the bytes of its request bodies in flight with `keepalive` and sends an `/abort`
  with it only while they stay within 56 KiB (`KEEPALIVE_BUDGET_BYTES`, `src/client/keepalive.ts`); an `/abort` beyond
  that goes as an ordinary request. A body counts from its `fetch` until its answer was read or the request failed.
  `discard()` still sends without keepalive (`M3-U95`).
- **Why:** measured in Chromium 159.0.8154.6 (Playwright's headless shell) on 2026-11-21 with
  `spikes/keepalive/measure.mjs`, two runs with the same numbers. The cap is 65,536 bytes of keepalive bodies in
  flight together, and a request beyond it is refused before it reaches the network (`TypeError: Failed to fetch`, no
  network event): of 230 POSTs of 285 bytes sent in one tick, 1 was refused; of 160 of 420 bytes, 4; of 500 of 420
  bytes, 344; of ten of 12,288 bytes, a token at its largest, 5. One body of 65,536 bytes passed and one of 65,537 was
  refused. The bytes come back once the answers are read, and stay counted while an answer is left unread. The same
  230 and 500 requests all passed without keepalive, and all passed sent as the client now sends them. Before this,
  `close({ abort: true })` and `job.abort()` over that many files left the last tickets unaborted with nothing said:
  an `/abort`'s failure is not reported. 56 KiB leaves 8 KiB of the cap for the page's own beacons.
- **If wrong:** on `pagehide` the `/abort`s beyond the budget are ordinary requests the browser may drop, so those
  uploads wait for the lifecycle rule, the sweep or the ticket's expiry, as all of them beyond the cap did before. Two
  clients of one page count apart and can pass the cap together; a page whose own keepalive requests hold more than
  8 KiB can too. A failed network (`net::ERR_NETWORK_CHANGED` while Docker networks came and went) fails requests the
  same way to the page, which the script reports apart.
- **Status:** in force. Firefox and Safari were not measured; the Fetch standard sets the same 64 KiB.
- **Visible in:** `src/client/keepalive.ts`, `src/client/endpoints.ts` (`send`),
  `src/client/endpoints-keepalive.test.ts`, `spikes/keepalive/measure.mjs`,
  `docs/guide/client.md` ("Close the client").

### M11-R88: the client retries S3's `400 RequestTimeout`

- **Decision:** a bucket answer whose S3 code is `RequestTimeout` is retried within the part's attempts and, when
  they run out, fails the file with the retryable `STORAGE_ERROR` "The storage service failed. Try again in a
  moment.", as a `408` does; `retry()` then keeps the ticket and the parts that landed (`M11-R80`). It was
  `UPLOAD_REJECTED`, not retryable, which made the person start the whole file again.
- **Why:** AWS documents the case as transient: "an HTTP 400 with the error code `RequestTimeout` is classified as
  transient and retried", listed with `InternalError` under the transient errors of every SDK
  (https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html, read 2026-11-21). S3's error list
  (https://docs.aws.amazon.com/AmazonS3/latest/API/ErrorResponses.html) names it as the answer to a socket not read
  from or written to within the timeout period, with status 400; that page did not load its table for this review, so
  the status comes from the SDK guide's sentence. A browser on a stalling link is exactly who gets it, and the same
  bytes sent again pass. R2 was not measured: `docs/research/r2-spike-findings.md` has no stalled body, only uploads
  that took 11 to 13 s and still answered `200`; the client gives a stalled `PUT` up itself after 30 s (`M3-U27`), so
  R2's own answer rarely reaches it. The rule is by S3 code, whatever the status, so it holds for both.
- **If wrong:** a storage service that answers `RequestTimeout` for a request it will never take costs five more
  attempts before the file fails, with a retryable error instead of `UPLOAD_REJECTED`.
- **Status:** in force. The server's driver (`src/storage/storage-error.ts`) is settled apart in this review; the rule
  to share is this one: the S3 code `RequestTimeout`, whatever its status, is a retryable `STORAGE_ERROR`.
- **Visible in:** `src/client/bucket.ts`, `src/client/bucket.test.ts`, `src/client/retry-steps.test.ts`,
  `docs/guide/errors.md`.

### M11-R89: a retry gives the ticket it replaces up before it asks for a new one

- **Decision:** when `retry()` replaces a ticket the file still holds, it first gives that ticket up as `abort()` of
  the failed file would (`drop`): one `/abort`, the record deleted, the lock let go once the server answered. The new
  `/upload` waits for that answer, at most the `/abort`'s 10 seconds, whatever it is; `job.retry()` waits for the
  `/abort` of every file it replaces a ticket for, then sends its one `/upload`. A ticket a `/complete` may have
  finished gets no `/abort`, as `abort()` gives it none (`M3-S14`), and one the page already gave up gets no second.
- **Why:** reproduced while filling the table of `M11-R80`: with a store and a quota of 1,000 bytes, a 600-byte file
  whose `PUT` the bucket refused failed with `UPLOAD_REJECTED`, and every `retry()` was answered `QUOTA_EXCEEDED`,
  because the first ticket's row was still pending and its bytes still counted (`reserved_bytes` counts pending rows
  until the sweep ends them). `M3-U55` sent no `/abort` for a replaced ticket because "little is left to free"; with a
  store the reservation is left, and without one a stored single-`PUT` object and landed parts are. The same `/abort`
  removes the object and the pending row a refusing `onDelete` leaves (`M11-R80`). Waiting for the answer is what makes
  it work: an `/upload` that raced the `/abort` would still be counted against the old row.
- **If wrong:** a retry that needs a new ticket takes one more round trip. When the `/abort` does not arrive although
  the `/upload` then does, the old row stays pending and a file larger than the owner's free quota is refused
  `QUOTA_EXCEEDED` until the sweep ends that row; `api.sweep` is the remedy, as before. A plugin's `onAbort` hears of
  a ticket the server had already ended a second time, as after `abort()` of such a file. A resumed upload that starts
  over (`M3-U74`) still sends no `/abort` for its old ticket: its probe answered that the upload is gone, and the one
  case with a pending row left, parts missing in the ticket's last 15 minutes, ends with the sweep.
- **Status:** in force. Supersedes `M3-U55` for `retry()`.
- **Visible in:** `src/client/retry-file.ts` (`requeue`, `retryFiles`), `src/client/launch.ts` (`after`),
  `src/client/retry-dead-ends.test.ts`, `src/client/retry-file.test.ts`, `docs/guide/client.md` ("Retry").

### M11-R130: a name read from a file is never looked up on a plain object

- **Decision:** the EBML DocType table is a `Map`, as the ISO BMFF brand table already was, so a DocType of
  `constructor`, `toString` or `__proto__` is no type. Every lookup in `src/plugins/**` whose key comes from the file
  is a `Map`, a `Set`, a list or a pattern. `src/plugins/sniff-fuzz.test.ts` runs more than 20,000 inputs (each
  signature's start before random bytes, cut at every length up to 64, and each sample with one byte changed) through
  `sniff` and through `afterVerify`, and both must answer: a type or none, a pass or a refusal.
- **Why:** `DOC_TYPES["constructor"]` answered `Object`'s constructor, which `checkContent` then read as a detection
  and threw a `TypeError`. An `afterVerify` that throws keeps the object and answers a retryable `500`, so a 20-byte
  file made every `/complete` of it fail for ever, with an error logged each time (review finding G4, reproduced).
  `sniff` is not wrapped in a `try`: a caught bug would pass the file as sent, which is the wrong answer to hide.
- **If wrong:** a later table keyed by file content and written as an object literal brings it back; the fuzz inputs
  include DocTypes named like inherited members, and a new format adds its start to `PREFIXES`.
- **Status:** in force.
- **Visible in:** `src/plugins/sniff-containers.ts`, `src/plugins/sniff.test.ts`, `src/plugins/sniff-fuzz.test.ts`.

### M11-R131: a tag is its whole name, and `<!--` is a web page before any byte

- **Decision:** text reads as `text/html` when, after the standard's whitespace bytes (`09 0A 0C 0D 20`), it starts
  with a row of the table in WHATWG MIME Sniffing §7.1 (Living Standard, 19 October 2026, commit `ba4b3c3`): one of
  the sixteen tags in any case before a tag-terminating byte (space or `>`), or `<!--`. Three choices go past the
  table, each on purpose: (1) a tag also ends at the standard's other whitespace bytes and at `/` (`<br/>`,
  `<div` then a line feed), as `M10-K1` ruled; (2) one of the fifteen elements is also found as the unprefixed root
  after comments or a doctype in a document without `<?xml`, as before; (3) `<!--` needs no byte after it. Nothing
  else ends a name, so `<a,b>`, `<a@b.com>`, `<b|c>` and `<br2>` are not tags. Leading whitespace is the standard's
  five bytes only: a vertical tab or a no-break space is content.
- **Why:** the root element's name was read without looking at what ended it, so `<a,b> denotes the inner product`,
  `<a@b.com> wrote:` and `<b|c>` were refused as web pages (review finding G6, reproduced). The finding also says the
  standard matches a bare `<!--`; its current text does not (`3C 21 2D 2D TT`, mask `FF FF FF FF FF`: "followed by a
  tag-terminating byte", the same in the published page, the commit snapshot and `mimesniff.bs`). Browsers do:
  Chromium's `kSniffableTags` (`net/base/mime_sniffer.cc`) matches `<!--` as a prefix, and Firefox's
  `nsUnknownDecoder` does behind `network.mimesniff.non_standard_html_comment`, which is `true` in
  `StaticPrefList.yaml` ("differs from the mimesniff standard but matches Chrome"). `<!--x-->hello<script>` is
  therefore a page in both, and showed no type here (reproduced). Chromium matches every tag as a bare prefix
  (`<address` as `<a`); that is not followed, since it would refuse `<abbr>` and `<price>`, and Firefox and the
  standard agree on the terminator.
- **If wrong:** text that opens with `<!--` and is not HTML or SVG (a Markdown file, an XML file without a
  declaration) is refused as a web page whether or not a space follows; the guide's Limits say so. A page whose first
  tag ends at a byte outside space, tab, line break, `/` and `>` is not detected, as in both browsers' own tables.
- **Status:** in force; `src/plugins/sniff-text.test.ts` has every row of the table, in both cases, before each
  terminator, after the whitespace bytes, and inside a longer name.
- **Visible in:** `src/plugins/sniff-text.ts`, `src/plugins/sniff-text.test.ts`, `docs/guide/plugins.md`.

### M11-R132: the entry walk goes past a streamed ZIP entry

- **Decision:** when a local file header has bit 3 of the general purpose flag set, the next entry is the first local
  file header in the bytes read that follows a data descriptor whose compressed size equals the distance from the
  entry's data: 12 bytes back without the descriptor's signature, 16 with it. The same four bytes anywhere else are
  the entry's data. An Office file is then found by its `word/`, `xl/` or `ppt/` entry as before, whichever of
  `[Content_Types].xml`, `_rels/.rels` or `docProps/` comes first. ZIP64 descriptors (8-byte sizes) are not read: a
  writer uses them for entries of 4 GiB, which do not fit in the 4 KiB read. What a ZIP that names no package answers
  when it was sent as an Office type is `M11-R133`.
- **Why:** the walk stopped at the first entry with bit 3, so such a file read as a plain ZIP (review finding G3,
  reproduced with files built as these writers build them). PKWARE APPNOTE 6.3.10 §4.4.4 defines bit 3 (crc-32 and
  sizes zero in the local header, the values in a data descriptor after the data), §4.3.9 the descriptor and §4.3.9.3
  that its signature `PK 07 08` is optional. Writers that set it for every deflated entry, read from their sources:
  Java's `ZipOutputStream.putNextEntry` (`e.flag = 8` when size, compressed size or crc is not preset) with `writeEXT`;
  Apache Commons Compress `ZipArchiveOutputStream.usesDataDescriptor` (deflated, and the output is not a
  `RandomAccessOutputStream`), which Apache POI's `ZipPackage.saveImpl(OutputStream)` wraps its stream in, writing
  `[Content_Types].xml` first; Node's archiver (`compress-commons`, `useDataDescriptor(true)` for streamed sources).
  The compressed size is what makes a header the next entry: a stored archive inside an entry holds headers too.
- **If wrong:** an entry's data that holds a local file header 12 or 16 bytes after four bytes spelling its own offset
  is read as the next entry (one chance in 2^32 for random data); the worst outcome is a ZIP read as an Office file,
  which any ZIP with a `word/` entry already is. An Office file whose first Office entry starts past the first 4 KiB
  still reads as a ZIP.
- **Status:** in force; `src/plugins/sniff-zip.test.ts` (each first entry, with and without the signature, a header
  inside an entry's data, a descriptor of another size, an Office folder past 4 KiB).
- **Visible in:** `src/plugins/sniff-containers.ts`, `src/testing/file-samples.ts`, `docs/guide/plugins.md`.

### M11-R133: a container is the type it was sent as, when it can be that type

- **Decision:** a detection is marked a container when its first bytes do not say which of its types the file is:
  ISO BMFF with a general brand (`isom`, `iso2` to `iso9`, `mp41`, `mp42`, `avc1`, `dash`, `M4V `, `f4v `: `video/mp4`,
  `audio/mp4`, `audio/x-m4a`, `video/x-m4v`), 3GPP and 3GPP2 (`video/` and `audio/`), WebM and Matroska (`video/` and
  `audio/`), Ogg (`audio/ogg`, `audio/opus`, `video/ogg`, `application/ogg`), and a ZIP whose entries name no package
  (`application/zip`; sent as an Office Open XML, `application/vnd.ms-*`, OpenDocument or `+zip` type, that type).
  For a container, `deny`, `allow` and the default refusals judge each type it can be, among them the type it was
  sent as: it is refused only when all of them are, with `reason: "refused"` and the container's first type as
  `detected`. Sent as one of its types, which `/upload` already judged, it therefore passes. Sent untyped, it passes
  when the route accepts one of the types left; the route's own entries count among the types a ZIP or an Office
  file can be. Sent as a type it cannot be, it is a `mismatch` as before. A ZIP still does not contradict any other
  `application/` or `model/` type (`M10-K1`), but is judged as `application/zip` there. Every other detection is one
  type, judged as before; RIFF needs no rule, since its form type (`WAVE`, `WEBP`) says what the file is. The names
  in messages no longer claim a kind the bytes do not show: "a WebM file", "an MP4 file", "a 3GP file", "a Matroska
  file", "an Ogg file".
- **Why:** `deny` and the refused list were matched against the sniffer's first type, a video type for WebM and for
  the MP4 brands above. On a route with `accept: "audio/*"` and the guide's own `deny: ["video/*"]`, a recording sent
  as `audio/webm` (what `MediaRecorder` makes) was refused "This file is a WebM video", an `audio/x-m4a` with major
  brand `mp42` "an MP4 video", and an Ogg video sent as `video/ogg` under `deny: ["audio/*"]` "an Ogg recording"
  (review finding G2, reproduced). The same held for ZIP: a Word file whose `word/` entry starts past 4 KiB was
  refused by `deny: ["application/zip"]` and, sent untyped, was not accepted by a route that takes Word files (G3).
- **If wrong:** what `deny` cannot promise. `deny: ["video/*"]` refuses a file sent as a video type and a file
  whose bytes show a video-only format; a video in a WebM, MP4, 3GP, Matroska or Ogg file sent as that container's
  audio type passes, and so does one sent untyped to a route that accepts the audio type. `deny: ["application/zip"]`
  does not refuse a plain ZIP sent as, or untyped to a route that takes, an Office, OpenDocument or `+zip` type;
  a ZIP with an empty `word/` entry passed there already. Telling audio from video takes a parser per container
  (track boxes, EBML tracks, Ogg codec headers), which is the scanning work the design leaves for later.
- **Status:** in force; amends `M11-K2`: `detected` is still the sniffer's first type, and a container sent as one of
  its own types is never refused on it.
- **Visible in:** `src/plugins/content-checks.ts`, `src/plugins/bytes.ts`, `src/plugins/sniff-containers.ts`,
  `src/plugins/sniff.ts`, `src/plugins/content-checks-containers.test.ts`, `docs/guide/plugins.md#containers`.

### M11-R134: `allow` lets a kind through by any of its names, at both hooks

- **Decision:** the refused kinds that go by several names are groups: web page (`text/html`,
  `application/xhtml+xml`), Windows or DOS program (five names), Linux program (three), macOS program (two), `#!`
  script (the four shell types and `application/x-perl`, `application/x-ruby`, `application/x-php`), JavaScript
  (WHATWG's sixteen), Windows installer (two), the unknown types (two). The groups of detected kinds are the
  sniffer's own `agrees` lists, so the two cannot drift apart. A type is let through when `allow` matches the type or
  any name of its group. At `/complete`, content is let through when `allow` matches any type that content can be
  here: its group, and the type it was sent as when the content agrees with that type. `deny` still wins, the route's
  `accept` still applies, and content sent as a type it does not agree with is still a `mismatch`. What is refused by
  default does not change: `application/x-perl`, `-ruby` and `-php` are names a script is allowed by, not types
  refused at `/upload`.
- **Why:** `allow` was matched against one type at a time, the declared one at `/upload` and the sniffer's at
  `/complete`, so it had to name both (review finding G5, each reproduced). With `allow: ["text/x-shellscript"]`, a
  script sent as `application/x-sh` or `text/x-sh` was refused at `/upload`, though the guide said it passes; with
  `allow: ["application/x-msdownload"]` a program passed `/upload` and was refused at `/complete` as
  `application/vnd.microsoft.portable-executable`; `allow: ["application/xhtml+xml"]` refused real XHTML as
  `text/html`; `allow: ["application/rss+xml"]` refused a feed as `application/xml` on a route that did not name it.
  An operator knows the type their users' browsers send, not the sniffer's name for it.
- **If wrong:** allowing one name allows its whole group: `allow: ["application/xhtml+xml"]` also lets `text/html`
  through a route that accepts it, and `allow: ["application/x-perl"]` every `#!` script. Each group is one risk
  (a page that runs script, a program for one system), so there is nothing to tell apart; an app that must can leave
  the other names out of the route's `accept`, or `deny` them.
- **Status:** in force; `src/plugins/content-checks-allow.test.ts` allows each kind by each of its names and sends it
  as every one, at `/upload` for the eight groups and at `/complete` for the six kinds the bytes show.
- **Visible in:** `src/plugins/content-checks.ts`, `src/plugins/sniff.ts`, `src/plugins/sniff-text.ts`,
  `docs/guide/plugins.md#options`.
