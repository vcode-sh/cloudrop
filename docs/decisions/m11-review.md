# M11-R: the review of every area before 0.6.0

Findings of the area-by-area review and what was done with each, designed in
`docs/superpowers/specs/2026-11-21-0.6.0-design.md`.
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
- **Status:** in force; `M11-R250` replaces the `Blob` the chunks were joined with, and `M11-R251` reads a body
  that is not a web stream whole.
- **Visible in:** `src/storage/s3/transport.ts`, `src/storage/xml.ts`, `src/storage/s3/bucket-settings.ts`,
  `src/storage/s3/transport.test.ts`, `src/storage/xml.test.ts`.

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
- **Status:** amended by `M11-R252`: the bytes are read as UTF-8 before white space is trimmed and collapsed, and the
  canonical request is hashed as UTF-8 again.
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
- **Status:** in force. `testBucket.object(key)` answers the form last written since `M11-R209`.
- **Visible in:** `src/testing/fake-r2.ts`, `src/testing/fake-r2/bucket.ts`, `src/testing/fake-r2/objects.ts`,
  `src/testing/fake-r2/signature.ts`, `src/testing/fake-r2.test.ts`, `src/testing/fake-r2/signature.test.ts`.

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
- **Status:** in force. Amended by `M11-R230`: the text must also be a URL the parser reads, so a port over 65535 or
  with leading zeros is refused, and `http`, `https`, `ws`, `wss` and `ftp` text never reaches the pattern.
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

### M11-R60: an owner or a file id with a lone surrogate is refused

- **Decision:** `isOwnerOrId` and `readOwner` also require `String.prototype.isWellFormed()`. A route whose `owner()`
  returns such a string fails the `/upload` as the route's bug (500, logged: "owner must return null or a string of 1
  to 255 characters without NUL (U+0000) or a lone surrogate."); `api.usage`, `revokeUploads`, `eraseOwner`,
  `reconcile`, `files`, `allFiles`, `file`, `deleteFile` and a cursor whose id has one answer `INVALID_INPUT` before
  any store call. The other text that reaches the database was checked and needs nothing new in the store's files:
  route names (`[A-Za-z0-9_-]`), idempotency keys (the same letters), types (a checked MIME type) and claims (a UUID)
  are ASCII; ids are the server's own; keys are refused unless well-formed and free of control characters
  (`keyProblem`); metadata and `result` are stored as the text of `JSON.stringify`, which writes a lone surrogate and
  NUL as `\ud800` and `\u0000` escapes (read back equal on Postgres); file names are refused unless well-formed.
- **Why:** node-postgres, postgres.js and node:sqlite encode a lone surrogate as U+FFFD. Measured on Postgres 18.6
  and node:sqlite: after a reserve for `"u\ud800"` and one for `"u\ud801"`, `usage` of the first counted both files
  and `owners` listed one owner, `"u\ufffd"`, so the two shared a quota, and `usage`, `revokeUploads` and
  `eraseOwner` for one acted on the other's files. `M9-H51` refuses NUL for the same kind of reason.
  `isWellFormed` is in Node 20 and every Workers runtime, below the package's floor of Node 24, and `/upload` and the
  name filter already call it.
- **If wrong:** an app whose user ids hold a lone surrogate (a string cut in the middle of a pair) gets a logged 500
  on `/upload` where before it got rows under another owner. One gap stays outside the store's files: a file name
  with NUL passes `/upload`'s check (`src/server/upload-request.ts`, `readDescriptor`) and on Postgres fails the
  reserve of the whole request with a retryable `SERVER_ERROR` ("unsupported Unicode escape sequence"); SQLite stores
  it. Nothing is merged or corrupted, but the answer blames the server for the client's name.
- **Status:** in force.
- **Visible in:** `src/server/owner-files.ts`, `src/server/store-upload.ts`, `src/server/store-api.test.ts`,
  `src/server/store-upload.test.ts`, `docs/guide/store.md`.

### M11-R61: the Postgres store locks several rows in byte order of id, and a call ended as a deadlock runs once more

- **Decision:** on Postgres, `reserve`'s superseding update and `revoke` take their rows through
  `id IN (SELECT id … ORDER BY id COLLATE "C" FOR UPDATE)`, so each locks its pending rows in byte order of id before
  it changes any. A store method that Postgres ends with `40P01` (deadlock) or `40001` (serialization failure) is run
  once more by `sqlStore` (`isConflict`); a second failure is thrown, and the server answers it as every store
  failure, a retryable `SERVER_ERROR`. Calls inside the store's `transaction` are not run again. The audit of every
  statement that writes:
  - `reserve` with a key: the superseded rows in id order, then the usage row (`FOR UPDATE`), then the new rows.
    Without a key: the usage row, then new rows, which nobody else can hold.
  - `revoke`: the owner's pending rows in id order, then the usage row.
  - `complete` with `replace`: the advisory lock of the owner and route, the new row, the owner's other completed rows
    on the route, the usage row. The replaced rows are completed, so `reserve` and `revoke` never want them; the only
    other statement that locks several of them is another replacing completion of that owner and route, which waits
    for the advisory lock before it locks a row. `end` and `deleteFile` lock one of them and then the usage row.
  - `claim`, `attach`, `release`, `cleaned`: one file row. `complete` without `replace` and `end` (the sweep's and
    `eraseOwner`'s only writes, one row at a time): one file row, then the usage row.
  - `reconcile`: the usage row only; it reads the file rows without locking them.
  - SQLite and D1 run one writer at a time and take no row locks.
- **Why:** the two statements locked the same rows in different orders: `revoke` along
  `(owner, status, created_at)`, the superseding update out of a hash join over the pending rows
  (`Hash Right Semi Join` in its plan). Measured on Postgres 18.6 with 80 rows: 150 of 300 races ended one side with
  `40P01` after the 1 s `deadlock_timeout`; when `revokeUploads` was the one ended, a sign-out that ignored the error
  left the uploads live. After the change, 0 of 300 races of two superseding reserves and a revoke, in 2 s. Every
  method is one atomic unit, so a call Postgres ended has written nothing and running it again is the whole call
  again, as `M5-T74` does for `23505`. Without the rerun, an app whose own transaction locks these tables in another
  order turns a deadlock into a failed sign-out; measured with such a transaction on node-postgres, postgres.js,
  Drizzle and Prisma (whose error keeps the code): each `revoke` failed with `40P01` before, and answers after.
- **If wrong:** the rerun costs one more statement after a failure that took a second to detect. `40001` cannot come
  from Postgres at READ COMMITTED, which the store requires (`M5-T78`); it is rerun for databases that speak
  Postgres's protocol and report conflicts that way. Should the replaced rows ever be locked in bulk by another
  statement, `replace` needs the same ordered subquery.
- **Status:** in force for the superseding reserve and for the rerun. Changed by `M11-R240`: `revoke` no longer
  locks its rows in id order, it takes the rows nobody holds; the audit above is replaced by that entry's, because
  "`reserve` and `revoke` never want them" was untrue of a row either had waited for. Changed by `M11-R241`: a
  transaction the store runs is run again too.
- **Visible in:** `src/store/sql/postgres.ts`, `src/store/sql/store.ts`, `src/store/sql/executor.ts`,
  `src/store/sql/lock-order.db.integration.test.ts`, `src/store/sql/store.test.ts`, `docs/guide/store.md`.

### M11-R62: the schema check blames the schema only when the database says so

- **Decision:** `checkSchema` reads a failed read's error (`isMissingFromSchema`, `isPermissionDenied`, through the
  same chain of `code`, `originalCode`, `cause` and Prisma's `meta` as the other checks). Postgres `42P01` and
  `42703`, and SQLite's and D1's "no such table" and "no such column", answer the same `INVALID_CONFIG` as before,
  naming the table and its first missing column. Postgres `42501` answers `INVALID_CONFIG` "The database role may not
  read the table "cloudrop_files" (permission denied). Grant it what the store needs: GRANT SELECT, INSERT, UPDATE ON
  "cloudrop_files" TO <role>; GRANT SELECT, INSERT, UPDATE, DELETE ON "cloudrop_usage" TO <role>; and, for tables
  outside the public schema, GRANT USAGE ON SCHEMA <schema> TO <role>;", with the driver's error as `cause`. Any other
  failure is thrown as the driver reported it; the `SELECT 1` that asked whether the database answers at all is gone.
- **Why:** the check took any failure of its probes for a missing table, so a role with no rights on the tables was
  told "The table "cloudrop_files" does not exist. Create the store's tables…" with the cause `permission denied`,
  and so was a read cancelled by a statement timeout while `SELECT 1` still answered. The grants in the message are
  the least the store needs, proven by a role with exactly those running every method on Postgres 18.6: it never
  deletes a file's row, and deletes a usage row only in `reconcile`. The message holds the table names the app
  configured and no role, host or connection string; the driver's `permission denied for table …` stays in `cause`,
  which goes to the logger.
- **If wrong:** a driver that reports a missing table in another form than these makes the first call throw the
  driver's error instead of `INVALID_CONFIG`; the contract runs "tables that were never created" and "a files table
  missing a column" on node-postgres, postgres.js, Drizzle, Prisma (Postgres and better-sqlite3), node:sqlite and D1.
  The check only reads, so a role that may read but not write passes it and fails its first write with the driver's
  `permission denied`.
- **Status:** in force.
- **Visible in:** `src/store/sql/tables.ts`, `src/store/sql/executor.ts`, `src/store/sql/store.test.ts`,
  `src/store/sql/tables.db.integration.test.ts`, `src/testing/store-contract/transaction.ts`, `docs/guide/store.md`.

### M11-R63: `completionLeaseMs` and `graceMs` are at most 30 days

- **Decision:** `createCloudrop` refuses a `completionLeaseMs` over 2,592,000,000 (30 days) with `INVALID_CONFIG`
  ("completionLeaseMs must be a whole number of milliseconds from 1000 to 2592000000 (30 days), such as 300000."), and
  `api.sweep` and `api.eraseOwner` refuse a `graceMs` over the same with `INVALID_INPUT` ("graceMs must be from 900000
  (15 minutes, the life of an upload URL) to 2592000000 (30 days)."; one message for both calls since `M11-R68`,
  where each had its own sentence about the least). The other numbers an app gives were checked and need
  no change: a `quota` answer must be null or a safe integer from 0 (anything else, `NaN`, `Infinity`, a negative or
  a fraction included, refuses the upload and is logged), and the largest safe integer fits Postgres's `bigint`;
  `limit` of `files`, `allFiles` and `sweep` is a whole number from 1 to 1000; a cursor's time is at most the year
  9999 (`isStoreCursor`); `all` is a boolean and `signal` an `AbortSignal`.
- **Why:** both had only a lower bound, and the claim and the sweep subtract them from the current time. With
  `Number.MAX_SAFE_INTEGER` the result is no date at all and `toISOString` throws `RangeError: Invalid time value`;
  with `1e14` it is a year before 1, which Postgres refuses as a time. Either way every `/complete` or every sweep
  failed, long after the option was set. 30 days is far beyond any completion or upload (a token lives 24 hours, a
  URL 15 minutes) and keeps every computed time inside what Postgres and JavaScript hold. A day, the token's life,
  was tried for the lease first and is too short: a lease longer than the deadline plus the grace is how an app keeps
  the sweep from ending a slow completion, which `sweep.test.ts` covers with 26 hours.
- **If wrong:** an app that set either above 30 days now fails at construction or at the call, naming the bound,
  where before it ran with a value that only postponed cleanup.
- **Status:** in force. `docs/guide/errors.md` gives `graceMs` both bounds since `M11-R233`.
- **Visible in:** `src/server/store-config.ts`, `src/server/leftovers.ts`, `src/server/sweep.ts`,
  `src/server/erase.ts`, `src/server/store-config.test.ts`, `src/server/sweep.test.ts`, `src/server/erase.test.ts`,
  `docs/guide/store.md`.

### M11-R64: a null cursor is no cursor

- **Decision:** `api.sweep`, `api.files` and `api.allFiles` read `cursor: null` as a missing cursor, and their option
  types say `cursor?: string | null`. The store guide's admin listing passes `query.get("cursor")` as it is.
- **Why:** each answers `cursor: null` for "no more", and a loop that starts with `let cursor = null` and passes back
  what the last page answered was refused with `INVALID_INPUT` on its first call; so was a sweep given the cursor of
  a finished one. The types made every caller write `cursor ?? undefined`.
- **If wrong:** nothing kept: a null cursor could not page anything before.
- **Status:** in force.
- **Visible in:** `src/server/sweep.ts`, `src/server/owner-files.ts`, `src/server/all-files.ts`,
  `src/server/sweep.test.ts`, `src/server/all-files.test.ts`, `docs/guide/store.md`.

### M11-R65: the memory store orders ids and owners by their bytes

- **Decision:** `memoryStore` compares ids and owners by code point (`byBytes`), which is their order in UTF-8 bytes,
  in `owners`, `list`, `listAll` and `stale`: the sort, the cursor comparison and the tie on a shared time. The store
  contract has a case for each with U+E000 beside U+1F600, and `CloudropStore.owners` says "in byte order of owner".
- **Why:** it sorted with JavaScript's `<`, which compares UTF-16 units and puts a character past U+FFFF (surrogates
  from D800) before U+E000 to U+FFFF, while Postgres (`COLLATE "C"`), SQLite and D1 compare bytes and put it after.
  An app's test on the memory store paged such owners in another order than its database. The three cases failed on
  the memory store and passed on every SQL backend before the change.
- **If wrong:** nothing a test could rely on: ids are the server's own (ASCII), and the order of owners shows only in
  the order `api.reconcile()` repairs them.
- **Status:** in force.
- **Visible in:** `src/testing/memory-store-reads.ts`, `src/testing/store-contract/usage.ts`,
  `src/testing/store-contract/list.ts`, `src/testing/store-contract/stale.ts`, `src/server/store.ts`.

### M11-R66: a page of sweep work is one index range per status

- **Decision:** the SQL store's `stale` reads each status on its own, `status = '…' AND <time> < before`, ordered by
  the time and the id with `LIMIT limit + 1`, and takes the page from those ranges with `UNION ALL` and the same
  order and limit: `pending` and `completing` (with its lease check) for `"expire"`, the five ended statuses with
  `cleaned_at IS NULL` for `"cleanup"`. The cleanup ranges order by `cleaned_at, ended_at, id`: `cleaned_at` is null
  in every row of the range, so the rows and their order are the same, and it is how Postgres sees that the
  `(status, cleaned_at, ended_at)` index already has them in order. One statement text serves Postgres, SQLite and D1.
  The rows a page answers, their order and the cursor are unchanged.
- **Why:** asked as one condition over the statuses (`status = 'pending' OR (status = 'completing' AND …)`,
  `status IN (…)`), no single index holds the rows in the page's order, so every page read every waiting row and
  sorted them. Measured with `EXPLAIN (ANALYZE, BUFFERS)` on Postgres 18.6, 360,000 rows of which 120,000 pending
  (30,000 past their deadline), 30,000 completing (28,750 past deadline and lease) and 24,000 ended and not cleaned,
  a page of 101 rows:

  | Page | Before | After |
  | --- | --- | --- |
  | expire, first | 6,996 buffers, 12.1 ms: `BitmapOr` over two indexes, 58,750 rows, top-N sort | 244 buffers, 0.12 ms: two `Index Scan`s of `status_expires_at_idx` under `Incremental Sort` (presorted `expires_at`), 105 and 101 rows read |
  | expire, after a cursor | 6,977 buffers, 12.4 ms | 140 buffers, 0.11 ms |
  | cleanup, first | 6,885 buffers, 8.7 ms: bitmap scan of 24,000 rows, top-N sort | 435 buffers, 0.46 ms: five `Index Scan`s of `status_cleaned_at_ended_at_idx` under `Incremental Sort` |
  | cleanup, after a cursor | 6,860 buffers, 8.4 ms | 439 buffers, 0.47 ms |

  The same ids in the same order before and after, on all four pages. Without `cleaned_at` in the cleanup ranges'
  order Postgres chose a bitmap scan and a sort per status (24,063 buffers, worse than before). SQLite (node:sqlite,
  the same rows, with and without `ANALYZE`): expire 10.9 ms (`MULTI-INDEX OR`, `USE TEMP B-TREE FOR ORDER BY`) to
  0.20 ms, cleanup 3.9 ms to 0.41 ms, each range a `SEARCH` of its index with `USE TEMP B-TREE FOR LAST TERM OF ORDER
  BY`. A sweep of a backlog cost a full read per page, so its cost grew with the square of the backlog.
- **If wrong:** a status with few stale rows among many past their deadline (completing rows whose claims are live) is
  walked along `expires_at` until a page is found or the range ends, as before the change at worst. A page costs up
  to five small ranges where one statement ran; on D1 that is one query all the same, with at most 21 parameters.
  Five ranges are also the most D1 takes: it refuses a sixth `SELECT` in one `UNION ALL` ("too many terms in compound
  SELECT", measured on Wrangler's local D1 and listed among D1's limits), so a sixth ended status would need a second
  statement.
- **Status:** in force.
- **Visible in:** `src/store/sql/reads.ts`, `src/store/sql/stale.db.integration.test.ts`,
  `src/testing/store-contract/stale.ts`.

### M11-R67: the store contract covers a failed usage write in a superseding reserve and in `end` from pending, and a newest-first page boundary inside one instant

- **Decision:** the atomicity cases gain "reserve that supersedes an attempt" and "end from pending to aborted": the
  usage write fails once, and neither table may have changed (the superseded row still pending). The list cases gain
  three rows of one `created_at` read newest first two at a time, so the cursor sits inside the tie.
- **Why:** both writes move a row and its owner's bytes in one unit and had no case that failed the second half; a
  store that ended the lost attempt's rows before the usage write and outside its unit would have passed. The paging
  cases used distinct times, so a store whose cursor kept only the time passed them and skipped rows that share one.
  All three pass on the memory store and on every SQL backend as they are.
- **If wrong:** nothing: cases only.
- **Status:** in force.
- **Visible in:** `src/testing/store-contract/atomicity.ts`, `src/testing/store-contract/list.ts`.

### M11-R68: the sweep refuses a `stale` cursor it cannot continue from

- **Decision:** when a store's `stale` answers a cursor that is neither null nor `<milliseconds>:<id>`
  (`isStoreCursor`), the sweep handles none of that page's rows, logs "cloudrop: The store's stale answered a cursor
  that is not <milliseconds>:<id> of its page's last row, or null after the last page." and answers that message as
  a `SERVER_ERROR` that is not retryable, with `all` and without. To pay for it under the bundled entry's 32 kB
  ceiling, four things in the same files became one each: `sweepAll` counts every page into one report instead of
  summing each page's, `api.files`, `api.allFiles` and `api.sweep` read `limit` through one `readLimit`, `owner()`'s
  answer is checked by `isOwnerOrId` itself, and `graceMs` has one message. `sweep.ts` was at its 250 lines, so the
  reading of its options moved to `sweep-options.ts`.
- **Why:** `CloudropStore.stale` documents that format, and the sweep refuses any other cursor a caller passes. A
  store written by hand that numbered its pages got no word of it: with `all`, the sweep read its own cursor back,
  found it was not one, and stopped after the first page with `cursor: null` and no error, so each run handled one
  page of a backlog; without `all`, the caller was handed `expire:page-2` and told on the next call that it was no
  cursor of an earlier sweep. `api.files` already refuses a page a store answered wrongly (`M10-D11`).
- **If wrong:** a store whose cursors were another shape and whose backlog never passed one page worked before and
  fails now, loudly, once a second page exists. The bundled entry is 31,988 bytes, 47 more than before this review's
  store fixes (31,940) and 12 under the ceiling.
- **Status:** in force. `M11-R242` makes it hold when the cursor comes from a later page of the call.
- **Visible in:** `src/server/sweep.ts`, `src/server/sweep-options.ts`, `src/server/owner-files.ts`,
  `src/server/store-upload.ts`, `src/server/leftovers.ts`, `src/server/sweep-all.test.ts`.

### M11-R69: the name filter folds ASCII letters without `lower()` on SQLite

- **Decision:** on SQLite and D1 the SQL store's name filter is `instr(<name>, ?) > 0`, where `<name>` is `name`
  wrapped in one `replace(…, 'R', 'r')` for each distinct ASCII letter of the search, and plain `name` when the
  search has none. Postgres keeps `translate`. Only `a` to `z` reach the statement's text.
- **Why:** the filter was `instr(lower(name), ?)`, and SQLite's ICU extension replaces `lower` with one that folds
  every letter. Reproduced with the real extension (SQLite's `ext/icu/icu.c`, built against ICU 78 and loaded into
  node:sqlite 3.53.4 with `loadExtension`): `lower('ÄB')` is `'äb'` instead of `'Äb'`, and a search for `ä` answered
  `Ärger.TXT` beside `ärger.txt`. Postgres and the memory store answer only the second, and `api.files` checks each
  page against its filter with ASCII folding (`M10-D11`), so on such a database it refused a page the store meant,
  with `SERVER_ERROR`. `M10-D1` had recorded this as a known difference; it is none now. A letter the search does
  not have cannot match one in the name, so folding only the search's letters gives the same answer as folding all
  26. Measured on node:sqlite, 200,000 names of one owner and a search that matches none, the same with and without
  the extension: `lower` 19 ms (34 ms under ICU); now 14 ms for a search without letters, 20 ms for one letter, 60 ms
  for `report x` (six); folding all 26 letters always took 209 ms, which is why it folds only those it needs. The
  plans are unchanged: the name was never searched through an index (`list-all.db.integration.test.ts`).
- **If wrong:** a search of many distinct letters over an owner with very many files costs up to about 1 µs a file
  on SQLite where `lower` cost 0.1. The committed test replaces `lower` with a function that folds every letter, as
  the extension does, since CI has no ICU extension to load.
- **Status:** in force.
- **Visible in:** `src/store/sql/reads.ts`, `src/adapters/sql.db.integration.test.ts`.

### M11-R70: on Workers with D1, the guide sweeps one bounded round per run

- **Decision:** the store guide's Workers cron recipe calls `api.sweep({ limit: 400 })` instead of
  `sweep({ all: true })`, names `limit: 15` for the Free plan, and has a section, "Cloudflare Workers with D1: how
  much fits in one run", with the limits, what each call costs, and what to do with a backlog (more runs: each starts
  with the oldest work) and with `eraseOwner` (run it again). No code changed.
- **Why:** Cloudflare's limits, read 2026-11-21 (the pages were last changed 2026-11-20 and 2026-11-19):
  [D1](https://developers.cloudflare.com/d1/platform/limits/) allows 1,000 queries per Worker invocation on Workers
  Paid and 50 on Free, counts a `db.batch()` as one query, and fails the rest of the invocation with "Too many API
  requests by single Worker invocation"; [Workers](https://developers.cloudflare.com/workers/platform/limits/) allow
  10,000 subrequests per invocation on Paid (up to 10 million with `limits.subrequests`) and 50 on Free, and a cron
  run 15 minutes. Counted on node:sqlite through an executor that counts each `query` and each `batch`, as D1 does:
  an `/upload` is 1 query for all its files plus 1 query and 1 bucket request per multipart file (11 and 10 for ten
  multipart files, 1 and 0 for ten small ones); a `/complete` 3 queries and 1 request, 1 query when replayed; a
  sweep 2 queries to find its work, then 2 queries and 1 to 3 requests per upload it expires (44 queries and 31
  requests for 21 uploads, ten of them multipart) and 1 query and 1 to 3 requests per ended upload it cleans (7 and
  5 for five); a new isolate's first call 2 more for the check of the tables. So `all: true` over more than about
  490 expired uploads passes the Paid limit in one run, and 23 pass the Free one. `limit: 400` is at most
  2 × 400 + 2 + 2 = 804 queries and 1,200 requests; `limit: 15` at most 34 queries and 45 requests. The requests of
  an upload fit: a reserve is two statements per file but one batch, so the largest `/upload` (`maxFiles` 100, all
  multipart) is 101 queries.
- **If wrong:** the limits are Cloudflare's to change; the section gives the date and the pages. The Free plan's
  10 ms of CPU per cron run was not measured against the signing of 45 requests, and the guide says so.
- **Status:** in force.
- **Visible in:** `docs/guide/store.md#cloudflare-workers-with-d1-how-much-fits-in-one-run`.

### M11-R71: Prisma's schema has no collation for an index column, as `M11-L5` assumed

- **Decision:** `M11-L5` stands as written, with its source added: the `(created_at)` index is kept, and the
  `(created_at, id COLLATE "C")` form stays something an app adds in its own migration.
- **Why:** `M11-L5` chose partly on the belief that a Prisma model cannot declare that index. Checked against Prisma
  ORM 7's documentation, [Indexes](https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes), read
  2026-11-21: an indexed column takes `length` (MySQL), `sort` and `ops` (an operator class, for GIN, GiST, SP-GiST
  and BRIN indexes), and the index takes `map`, `type`, `clustered` and `where`; the page does not mention collation,
  and says indexes over a function "are not yet supported". `ops: raw("text_pattern_ops")` is no way around it: that
  operator class orders with its own operators, which `ORDER BY id COLLATE "C"` does not use. The belief was right.
- **If wrong:** should Prisma add a collation argument, the choice still stands on size (3.4 MB against 17.1 MB) and
  on one definition for every adapter.
- **Status:** in force.
- **Visible in:** `docs/decisions/m11-listing.md` (`M11-L5`).

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
- **Status:** in force. Supersedes the list of `M3-U31`; `M10-K4`'s sentence about `retry()` is true from here on. Its
  table is amended by `M11-R92` (first row: a retry frees the rows a lost answer left) and by `M11-R200`
  (`NO_SUCH_UPLOAD`: with a store the row is `rejected`).
- **Visible in:** `src/client/retry-step.ts`, `src/client/retry-file.ts` (`needsTicket`, `requeue`),
  `src/client/file-run.ts` (`giveUp`), `src/client/discard.ts`, `src/client/retry-steps.test.ts` (one row per answer
  at `/complete`; at `/sign` and for the bucket's `PUT`, one row per step and per code only that request can meet),
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
- **Status:** in force. Amends `M3-U30`'s "If wrong". Amended by `M11-R201`: the answer that says the ticket is over
  also ends the doubt for a cancel, which then sends `/abort` with `keep`.
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
- **Status:** in force. Supersedes `M3-U55` for `retry()`. The last sentence of its "If wrong" is superseded by
  `M11-R90`: a resumed upload that starts over sends its `/abort` too. Amended by `M11-R201`: a ticket a `/complete`
  may have finished gets its `/abort`, with `keep`, once the server has answered that it is over.
- **Visible in:** `src/client/retry-file.ts` (`requeue`, `retryFiles`), `src/client/launch.ts` (`after`),
  `src/client/retry-dead-ends.test.ts`, `src/client/retry-file.test.ts`, `docs/guide/client.md` ("Retry").

### M11-R90: a resumed upload that starts over gives its old ticket up first

- **Decision:** a resumed upload that starts over (`startOver` in `src/client/job-run.ts`, `M3-U74`) gives the old
  ticket up as a `retry()` that replaces one does (`M11-R89`): one `/abort`, the record deleted, the lock let go once
  the server answered. The new `/upload` waits for that answer, at most the `/abort`'s 10 seconds, whatever it is. A
  ticket a `/complete` may have finished gets no `/abort`. Every place where the client asks `/upload` again was then
  checked on a server with a store and a quota:

  | The client asks `/upload` again | What frees the reservation of the ticket before |
  | --- | --- |
  | `retry()` replaces a ticket the file holds | The client: `/abort` first (`M11-R89`) |
  | A resumed upload starts over | The client: `/abort` first (this entry) |
  | `retry()` after `pagehide` gave the ticket up for a resume (`M4-F1`) | The client: the kept upload is discarded under its lock first (`M11-R91`) |
  | An automatic retry of one ask, after a lost answer or a failure of the whole request | The server: every attempt of an ask sends one idempotency key, and `reserve` first ends the owner's pending rows of that key and route (`M5-T100`, `M5-T101`). Rows without an owner hold no quota (`M5-T105`) |
  | `retry()` after an ask whose every attempt ended without a ticket | The server, since the client sends that ask's key once more (`M11-R92`) |
  | A file asks again alone after `/upload` refused it with a retryable error (`M3-U92`) | The server: it gave the file no ticket and released what it had reserved for it within that request (`releaseUnstarted` in `src/server/store-upload.ts`); a file over its quota reserved nothing |
  | A ticket arrives for a file cancelled meanwhile | The client: its `/abort` at once (`M4-F2`); no new `/upload` follows |
  | `discard()` | No `/upload` follows. Its `/abort` ends the pending row and frees the reservation, with `keep` or not (`M3-U94`) |
  | `forget()` | No `/upload` follows and no `/abort` is sent: the rows stay pending until their tokens expire and the sweep ends them, or the app's sign-out calls `api.revokeUploads({ owner })`. The resume guide says so |
  | `upload()` of a file whose earlier `upload()` failed and kept its record (`M4-F1`) | Nothing: a new job knows nothing of the earlier one. `resumable()` lists it, and `resume()` or `discard()` settles it |
- **Why:** reproduced on a server with a store and a quota of the file's size plus 1,000 bytes, two ways. A resumed
  four-part upload in its ticket's last 15 minutes, parts 3 and 4 missing: the probe is answered `PARTS_MISSING`, the
  ticket can sign nothing (`M9-H3`), and the new `/upload` was answered `QUOTA_EXCEEDED`. And a resumed upload whose
  multipart upload the bucket had aborted: `/complete` answers `NO_SUCH_UPLOAD` and leaves the row pending
  (`completeParts` answers a failure, not a refusal), and the new `/upload` was answered `QUOTA_EXCEEDED` too. Both
  left the row `pending`, and every later `resume()` or `retry()` got the same answer until the sweep. `M11-R89` named
  the first case and left it to the sweep; the second it took for an upload with nothing left to free. The `/abort` is
  also what removes the parts of a ticket that only stopped signing, which no other request of this page would.
- **If wrong:** a start over takes one more round trip, and for a token the server no longer knows (`INVALID_TOKEN`)
  that `/abort` is refused and frees nothing, as nothing was held. After a probe whose first `/complete` got no answer
  and whose second was answered `UPLOAD_EXPIRED`, the doubt stays and no `/abort` is sent: with a store that row stays
  pending until the sweep, and the new `/upload` of an owner without room for the file twice is `QUOTA_EXCEEDED` until
  then. A plugin's `onAbort` hears of the old upload.
- **Status:** in force. Supersedes `M3-U55` for the start over, and the last sentence of `M11-R89`'s "If wrong".
  Amended by `M11-R200` (the server ends the row `/complete` answers `NO_SUCH_UPLOAD` for, so that row is `rejected`
  before the `/abort` arrives) and by `M11-R201` (the doubt followed by `UPLOAD_EXPIRED` in "If wrong" now gets its
  `/abort`, with `keep`).
- **Visible in:** `src/client/job-run.ts` (`startOver`), `src/client/replaced-ticket.test.ts`,
  `src/client/resume.test.ts`, `src/client/resume-job.test.ts`, `docs/guide/resume.md` ("The server is asked first").

### M11-R91: a retry discards the upload `pagehide` kept for a resume

- **Decision:** when `retry()` replaces a multipart ticket the page gave up without `/abort` (`pagehide` on a failed
  file of a client that keeps records, `M4-F1`), it first discards that upload as `discard()` of its listing would
  (`M3-U93`, `M3-U94`): under the upload's Web Lock, `/abort` with the record's token and `keep`, then the record
  deleted and the lock let go. The new `/upload` waits for it. Nothing is sent when another tab holds the lock, or
  when the record is gone (finished, discarded or expired); a ticket whose `/abort` was already sent gets no second.
- **Why:** reproduced with a store and a quota of the file's size plus 1,000 bytes: a four-part file failed with
  `NETWORK_ERROR`, the page hid and came back from the back-forward cache, and every `retry()` was answered
  `QUOTA_EXCEEDED`, because the kept upload's row was still pending. The retry also left that upload listed by
  `resumable()` beside the file it had just stored under a new key. `M4-F1` kept the record because "another tab may
  resume and complete the upload, and an `/abort` with a live token would then delete the finished object": the lock
  rules the first out, the record's absence shows a finished upload, and `keep` makes the `/abort` unable to delete an
  object that landed. So the hazard `M4-F1` named does not apply to an `/abort` sent this way.
- **If wrong:** while another tab resumes the kept upload, this page's retry still asks for a new ticket and sends the
  file a second time, as before; an owner without room for both is refused `QUOTA_EXCEEDED` until the other tab ends.
  A retry of such a file reads the browser's records once more. `abort()` of a file given up at `pagehide` still sends
  nothing (`M4-F1`): it asks no `/upload`.
- **Status:** in force. Amends `M4-F1`: "a later `retry()`'s new ticket leaves its record in place" no longer holds.
- **Visible in:** `src/client/retry-file.ts` (`giveUpReplaced`), `src/client/replaced-ticket.test.ts`,
  `src/client/persist.test.ts`, `docs/guide/client.md` ("Retry"), `docs/guide/resume.md` ("When a record is deleted").

### M11-R92: the first retry after an `/upload` that gave no ticket sends that ask's key again

- **Decision:** an `/upload` ask that ends with an error for the whole request leaves its idempotency key with its
  files (`Entry.lostAsk`, one object shared by the ask's files). The next ask that includes one of them, a `retry()`
  of one file or of the job, sends that key instead of a new one and takes it: no later ask sends it, unless that ask
  ends without a ticket too. An ask that was answered, with tickets or with refusals per file, leaves no key.
- **Why:** reproduced with a store and a quota of 1,000 bytes: the server reserved a 600-byte file on each of the six
  attempts of an `/upload` whose answers never reached the page, each attempt ending the rows of the one before
  (`M5-T100`); the file failed with `NETWORK_ERROR`, and every `retry()` was answered `QUOTA_EXCEEDED`, because it
  asked with a new key and the last attempt's row was still pending. The page holds no ticket for that row, so it has
  no `/abort` to send: the key is the only handle. `M5-T101` stated this cost and named the danger of the plain fix:
  "one-file retries of one ask sharing its key would end each other's live rows". Taking the key rules that out. Until
  an ask is answered nobody holds a ticket made under its key, so ending its pending rows ends nothing live; and once
  one retry has taken the key, the ask's other files find it gone and ask with a new one, so no second request can end
  the rows the first retry was given. A refusal the server answered for the whole request (`UNAUTHORIZED`,
  `RATE_LIMITED`) reserved nothing, and its key ends nothing.
- **If wrong:** a `job.retry()` over files of two asks that both gave no ticket sends one key, and the other ask's
  rows wait for the sweep, as all of them did before. A first attempt the server is still working on when the retry
  arrives writes its rows after the retry's, as `M5-T101` says of automatic retries. A custom store that ignores
  `requestKey` keeps the old cost.
- **Status:** in force. Amends `M5-T101` ("an ask whose every attempt lost its answer") and `M5-T102` ("the next
  `launch()` makes a new one"), and the first row of `M11-R80`'s table: a retry frees the rows a lost answer left.
  `docs/guide/store.md` ("Known costs") says so since `M11-R203`.
- **Visible in:** `src/client/launch.ts`, `src/client/entry.ts`, `src/client/launch.test.ts`,
  `src/client/retry-dead-ends.test.ts`, `docs/guide/client.md` ("Stalled requests").

### M11-R93: the client reads a bucket answer as the storage layer does, and a test holds the two together

- **Decision:** `classifyAnswer` (`src/client/bucket.ts`) retries a bucket answer whose S3 code is `OperationAborted`,
  whatever its status, as it retries `RequestTimeout` (`M11-R88`): within the part's attempts, then the retryable
  `STORAGE_ERROR` "The storage service failed. Try again in a moment.", which keeps the ticket (`M11-R80`). It was
  `UPLOAD_REJECTED`. `src/client/bucket-agreement.test.ts` feeds 38 answers to the client (through `putObject`) and to
  `storageError` and fails on any difference that is not in its list. What is compared is what the answer says to do:
  retry, and with which code (`RATE_LIMITED` also slows the client's pool down), or stop. A stop names its code only
  for `NO_SUCH_UPLOAD`, which `retry()` and `resume()` read from both sides (`M9-H4`); every other refusal of the
  bucket is the client's `UPLOAD_REJECTED`, whatever the driver calls it (`STORAGE_DENIED`, `INVALID_PART`,
  `CHECKSUM_MISMATCH`, `NOT_FOUND`), since those codes never leave the server. Two differences are meant:

  | Answer | Storage layer | Client | Why a browser's `PUT` differs |
  | --- | --- | --- | --- |
  | `403` with `ExpiredRequest`, `AccessDenied`, `RequestTimeTooSkewed`, `NotEntitled` or no code | stop (`STORAGE_DENIED`) | renew the URL once, then stop | The server signs a request as it sends it, so its `403` is its credentials or its clock. The page holds a URL signed minutes ago, which may only have expired; R2 says `ExpiredRequest` and RustFS `AccessDenied` for the same expiry, so the code cannot narrow it (decision S10). `403 SignatureDoesNotMatch` stops on both sides |
  | `412 PreconditionFailed` | stop (`ALREADY_EXISTS`) | stored | The page's `PUT` is create-only under a key of its own, so a `412` is its own earlier attempt, which stored the object and whose answer was lost (spec §5.4). `/complete` then checks whose object it is |

  The other 32 answers agree, `409 ConditionalRequestConflict` (stop, `M11-R23`) and `409 ObjectLockedByBucketPolicy`
  (stop) among them.
- **Why:** the two tables were written apart, and `OperationAborted` was in one only. AWS's conditional-writes page
  says of the `409` a conditional `PutObject` can get: "uploads may be retried after receiving a `409 Conflict` error"
  (<https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>, read 2026-11-21); the storage
  layer has retried `OperationAborted` since its second commit (`d0007ae`, 2026-11-15), which no decision records.
  AWS's error list (<https://docs.aws.amazon.com/AmazonS3/latest/API/ErrorResponses.html>) did not load its table for
  this review either, so the code's own wording is not quoted here. R2's error list
  (<https://developers.cloudflare.com/r2/api/error-codes/>, read 2026-11-21) has no `OperationAborted`,
  `RequestTimeout` or `ConditionalRequestConflict`; its `409`s are `BucketNotEmpty`, `BucketConflict` and
  `ObjectLockedByBucketPolicy`, and `docs/research/r2-spike-findings.md` measured no `409` to a `PUT`. So on R2 the
  rule is unmeasured and most likely never met; it is there for S3 and for what speaks its dialect. The client keeps
  `ConditionalRequestConflict` a stop although a `PutObject` may be sent again: under a key of the upload's own, the
  delete that causes it is this upload's `/abort`, and sending the bytes again would store a file the person
  cancelled.
- **If wrong:** a storage service that answers `OperationAborted` for a `PUT` it will never take costs five more
  attempts before the file fails, with a retryable error instead of `UPLOAD_REJECTED`. An answer in neither list is
  not compared: a new rule on one side needs its row in the test.
- **Status:** in force.
- **Visible in:** `src/client/bucket.ts`, `src/client/bucket-agreement.test.ts`, `docs/guide/errors.md`.

### M11-R94: the guides say what `retry()` does after each code

- **Decision:** every row of the errors guide's endpoint and client tables says in "What to do" what `retry()` does
  after that code, as the table of `M11-R80` has it, with `M11-R81` and `M11-R88` to `M11-R93`: the same ticket, the
  bytes again on the same ticket, a new ticket after the old one was given up, `/upload` asked again for a file that
  had no ticket yet, the checks of `resume()` again, or nothing. The client guide's "Retry" holds the table in short
  form, one row per group of codes with the request that answered them; the errors guide points to it.
- **Why:** the rows were written before `M11-R80`. `NOT_UPLOADED` said "the client does this in order", which is true
  of a first run and says nothing of the retry that now sends the file again; `ALREADY_EXISTS`, `UNKNOWN_ROUTE`,
  `FILE_TYPE_NOT_ALLOWED` and `QUOTA_EXCEEDED` said "start a new upload" without saying that `retry()` is that; the
  handler's six refusals, `SERVER_ERROR` and `STORAGE_ERROR` did not say that a retry keeps the ticket, which is what
  a person fixing a proxy needs to know. The client guide's table had four rows by kind of error and left out where
  the answer came from, which decides for `INVALID_INPUT`, `NOT_FOUND` and `STORAGE_ERROR`: each has a row from the
  server, the bucket, the client's own arguments and `resume()`'s checks, with a different retry.
- **If wrong:** the rows are prose and no test reads them: a change to `retryStep` needs its row in both guides.
  `src/client/retry-steps.test.ts` and `src/client/retry-dead-ends.test.ts` hold the behaviour itself.
- **Status:** in force.
- **Visible in:** `docs/guide/errors.md` ("Upload endpoint errors", "Client errors"), `docs/guide/client.md`
  ("Retry").

### M11-R100: the bundled server budget is 36 kB

- **Decision:** `scripts/size-limit.config.ts` holds the "cloudrop (bundled)" ceiling at 36 kB. It was provisional
  while 0.6.0 was built; the owner set it on 2026-11-21, from 34.71 kB measured once every fix was merged.
- **Why:** the ceiling was 32 kB (`M10-D10`) with 0.68 kB of room. `api.deleteFile`'s answer and `onDelete` refusals,
  the `content` field, `api.allFiles` and the review's fixes (bounded response bodies, refused web-page answers,
  redirects never followed) each add honest code that every server needs; measured 32.47 kB with the storage fixes
  merged. Cutting a fix to fit a budget would trade correctness for a number nothing depends on.
- **If wrong:** the owner sets another ceiling, or asks for the store paths behind their own entry (`M5-T69`).
- **Status:** superseded by `M12-P1`; set by the owner for 0.6.0 (2026-11-21).
- **Visible in:** `scripts/size-limit.config.ts`.

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
- **Status:** in force. Extends `M11-R41`. Amended by `M11-R230`: `ws`, `wss` and `ftp` text the URL parser refuses
  (`ws://256.1.1.1`) is refused the same way.
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
- **Status:** in force. Amends `M9-C8` (the path of an unreadable file) and `M9-H100`. Amended by `M11-R234`: the word typed as
  the command is never repeated, a refused `--origin` only when it is written as an origin, and a `--var` setting only
  as a setting's name.
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
- **Status:** in force. Extends `M9-H101`. A bucket that does not exist has the command's own sentence, with its
  variable and the jurisdiction, since `M11-R237`.
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
  inside an entry's data, a descriptor of another size, an Office folder past 4 KiB). Amended by `M11-R212`: ZIP64
  descriptors are read, since writers use them for small entries too.
- **Visible in:** `src/plugins/sniff-containers.ts`, `src/testing/file-samples.ts`, `docs/guide/plugins.md`.

### M11-R133: a container is the type it was sent as, when it can be that type

- **Decision:** a detection is marked a container when its first bytes do not say which of its types the file is:
  ISO BMFF with a general brand (`isom`, `iso2` to `iso9`, `mp41`, `mp42`, `avc1`, `dash`, `M4V `, `f4v `: `video/mp4`,
  `audio/mp4`, `audio/x-m4a`, `video/x-m4v`), 3GPP and 3GPP2 (`video/` and `audio/`), WebM and Matroska (`video/` and
  `audio/`), Ogg (`audio/ogg`, `audio/opus`, `video/ogg`, `application/ogg`), and a ZIP whose entries name no package
  (`application/zip`; sent as an Office Open XML, `application/vnd.ms-*`, OpenDocument or `+zip` type, that type).
  For a container, `deny`, `allow` and the default refusals judge each type it can be, among them the type it was
  sent as: it is refused only when all of them are, with `reason: "refused"` and the container's first type as
  `detected`. Sent as one of its types, which `/upload` already judged, it therefore passes. Sent untyped, nobody said
  which type it is: it is refused when any type it can be is refused, and otherwise passes when the route accepts one
  of them; the route's own entries count among the types a ZIP or an Office file can be. Sent as a type it cannot be, it is a `mismatch` as before. A ZIP still does not contradict any other
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
  audio type passes. `deny: ["application/zip"]` does not refuse a plain ZIP sent as an Office, OpenDocument or
  `+zip` type; a ZIP with an empty `word/` entry passed there already. Telling audio from video takes a parser per container
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

### M11-R135: an ID3 tag agrees with every type of the formats it fronts

- **Decision:** a file that starts with an ID3v2 header is a container (`M11-R133`) of these types: `audio/mpeg`
  and its aliases `audio/mp3`, `audio/x-mp3`, `audio/x-mpeg`, `audio/x-mpg`, `audio/mpeg3`; `audio/mp2`,
  `audio/x-mp2`; `audio/flac`, `audio/x-flac`; `audio/aac`, `audio/x-aac`, `audio/aacp` and `audio/vnd.dlna.adts`.
  Its `detected` stays `audio/mpeg`, and a message calls it "a recording with an ID3 tag". An MPEG audio frame
  without a tag agrees with `audio/mpeg` and the same five aliases.
- **Why:** the tag agreed with `audio/aac` alone for AAC, so an ID3-tagged `.aac` from Chrome on Windows was a
  `mismatch` (reproduced). Chromium's `net/base/mime_util.cc` has no entry for the extension in its own tables
  (`audio/aac` is only in its list of supported audio types), so the platform's type is sent, and Windows registers
  `.aac` as `audio/vnd.dlna.adts`, a type IANA lists (Microsoft, 2005); uploads from Chrome on Windows are reported
  with it (mastodon/mastodon#11342, Borewit/music-metadata#654). Firefox's own table
  (`nsExternalHelperAppService.cpp`) sends `audio/aac`, `audio/mpeg` and `audio/flac`; shared-mime-info adds the
  aliases `audio/x-aac`, `audio/x-flac`, `audio/x-mp3`, `audio/x-mpeg`, `audio/x-mpg` and `audio/x-mp2`, and Chromium
  lists `audio/mpeg3`. As a container, a tagged FLAC sent as `audio/flac` is no longer refused by
  `deny: ["audio/mpeg"]`.
- **If wrong:** an ID3-tagged file sent as an audio type not listed (`audio/x-hx-aac-adts`, a vendor type) is still a
  `mismatch`, and the message names the type to add here. A tag does not front WAV or AIFF, which carry it in a chunk.
- **Status:** in force; `src/plugins/content-checks-containers.test.ts`.
- **Visible in:** `src/plugins/sniff.ts`, `docs/guide/plugins.md`.

### M11-R136: what shows no signature is named, and four things that passed are now detected

- **Decision:**
  - **MP3 without a tag** is read by the whole of WHATWG MIME Sniffing §6.2.3: a Layer III frame header (`FF`, the
    sync bits, layer bits `01`, a bit rate index under 15, a sample rate index under 3) and a second one where the
    first frame ends. The frame's length is bit rate times 144 (72 for MPEG-2 and 2.5) over the sample rate, plus the
    padding bit. One header alone is no longer MP3; Layer I and II and the free bit rate are not detected.
  - **A script** is found by its `#!` line also behind a UTF-8 or UTF-16 byte order mark and behind the whitespace
    bytes text is read after (blank lines, spaces).
  - **An OLE compound file** (`D0 CF 11 E0 A1 B1 1A E1`) is detected as `application/x-ole-storage`, "an old Office
    document or a Windows installer": a container (`M11-R133`) that can be `application/x-msi` or
    `application/x-ms-installer`, and contradicts no `application/` type. Sent as an `application/` type it passes as
    that type; sent untyped it is refused, since one of the types it can be is; sent as another top-level type it is
    a `mismatch`. `allow` of an installer type takes it untyped.
  - **Sent untyped, a container is refused when any type it can be is refused** (not only when all are, as for a
    typed one): nobody said which it is. This also makes `deny: ["video/*"]` refuse an untyped WebM.
  - **An HTML application** is a web page: `application/hta` is a name of that kind (`M11-R134`), and
    `<hta:application` as the root element reads as `text/html`.
  - **HTML or XML sent as `application/vnd.ms-excel` or `application/msword`** is still refused as a web page or
    XML, but no longer contradicts those types, so `allow: ["application/vnd.ms-excel"]` lets it through.
  - The guide's Limits name what still passes undetected: `.bat`, `.cmd`, `.ps1`, `.vbs`, `.js`, `.url`, `.lnk`, a DOS
    `.com`, an HTA that starts with no listed tag, and an installer sent as an old Office type.
- **Why:** review finding G9 probed each of these. The comment on the MP3 rule said the standard "reads none from
  fewer" than four bytes and stopped there, so `FF FF 00 00`, a Layer I header with the free bit rate, read as MP3
  and contradicted whatever the file was sent as (reproduced). The standard's steps go on to parse the frame and
  match a second header; its prose has slips (`and` for `or` in the sync test, `s - length`, the two rate tables'
  names and the scale test the other way round from the code), so the arithmetic follows Firefox's `toolkit/components/mediasniffer/mp3sniff.c`, which the steps
  were written from. `execve` does not run a file whose `#!` is not at byte 0, but POSIX.1-2024 (Shell Command
  Language §2.9.1.4) has the shell run it as a shell script on `ENOEXEC`, and `sh file` does the same. An untyped
  `.msi` passed every route that takes `application/octet-stream`; MS-CFB §2.2 gives the signature, which old Word and
  Excel files share, so only the untyped case and the installer types can be refused. Web applications export HTML
  tables as `.xls`, and there was no way to take them: allowing `text/html` left a `mismatch`.
- **If wrong:** an untyped compound file that is a document (a `.doc` from a system with no type for it) is refused
  and must be sent typed. A real MP3 shorter than one frame and a header, in free format, or whose first frame is
  followed by junk shows no type and passes as sent; a browser does not sniff it either. Other compound-file formats
  sent under a non-`application/` type are a `mismatch`. `.lnk` has a signature (the 20 bytes shared-mime-info matches for
  `application/x-ms-shortcut`: the ShellLinkHeader's size and class id) and is not detected. The reason first
  written here, "to keep the entry inside its 6 kB", no longer holds; `M11-R256` gives the reason that does.
- **Status:** in force, except the third bullet's refusal of an untyped compound file, which `M11-R254` takes back
  (the maintainer's decision); `src/plugins/sniff.test.ts`, `src/plugins/sniff-text.test.ts`,
  `src/plugins/content-checks-legacy.test.ts`, `src/plugins/content-checks-containers.test.ts`.
- **Visible in:** `src/plugins/sniff.ts`, `src/plugins/sniff-text.ts`, `src/plugins/content-checks.ts`,
  `docs/guide/plugins.md#limits`, `docs/decisions/m10-content.md` (two sentences corrected).

### M11-R137: `content` is checked before it is sent, and dropped whole when it is not a refusal's

- **Decision:** `errorBody` sends `content` only when `declared` is a string, `detected` is a string or absent, both
  are at most 255 characters (RFC 6838 §4.2: 127 each for the type and the subtype), and `reason` is `"mismatch"`,
  `"refused"` or `"not-accepted"`. Any other value sends no `content` at all; the code, message and `retryable` are
  sent as before. `CloudropError`'s constructor is left as it is: it still keeps what it was given, for the server's
  own log.
- **Why:** `M11-K3` copied the three fields without looking at them, so a JavaScript plugin that built
  `content: { declared: { key, name }, … }` put a key and a file name on the wire, and one with a reason of its own
  sent it (review finding G7, reproduced with seven shapes). The client drops such a `content` (`M11-K4`), but the
  bytes had left the server, which is the rule `M11-K3` exists for. Dropping the whole field, not the bad value,
  keeps `content` a thing that is either complete or absent, as the client reads it.
- **If wrong:** a plugin's own fourth reason is no longer sent; no client could read it (`M11-K4`). The two types are
  not checked as MIME types: text of that length names no key that `/upload` can sign, but a plugin can still put
  other short text there, as it can in `message`.
- **Status:** in force; amends `M11-K3`'s "a plugin that sets a value outside the three reasons sends it".
- **Visible in:** `src/server/http.ts`, `src/server/handler-failures.test.ts`.

### M11-R138: a refusal claims the row, so it also ends one a stopped request left `completing`

- **Decision:** with a store, a refusal at `/complete` (an `afterVerify` refusal, a failed verification) first calls
  `claim` with a claim of its own, as a completion does, and then ends the row it holds with
  `end("completing", "rejected")`; only then is the object deleted and `onAbort` run. `claim` takes a `pending` row
  and a `completing` one whose claim is older than `completionLeaseMs`, and answers `busy` for a live claim, the
  stored answer for a completed row and `UPLOAD_EXPIRED` for an ended or missing one, each answered as before.
- **Why:** the refusal ended the row with `end("pending", "rejected")`, which changes nothing on a `completing` row.
  A request that claimed the row and then stopped (a crash, a deploy) left it `completing`; once its lease ran out,
  `/complete` verified the file again, was refused again, could not end the row and answered "Another request is
  completing this upload" with `Retry-After: 2`, on every retry until the sweep ended the row as `failed`, keeping
  the refused object (review finding G8, reproduced in lease and transaction mode). The claim rules already say who
  may take such a row (`M5-T19`: a claim is live through exactly the lease, and one millisecond later the row can be
  taken; `M5-T27`: a live claim is busy), so the refusal uses them instead of a rule of its own: a completion that is
  really in flight holds a live claim and is not touched.
- **If wrong:** a refusal now costs two store calls, not one. A request that stops between its claim and its `end`
  leaves the row `completing`, and the next `/complete` after the lease refuses and ends it. An `onComplete` that
  runs longer than the lease can lose its row to a refusal, as it could already lose it to a second completion
  (`M5-T27`); `completionLeaseMs` is the setting for both. `FileCalls.end` takes `"completing"` as well as
  `"pending"`; the store's own `end` always did.
- **Status:** in force; `src/server/store-complete-refuse.test.ts` (busy at the lease's last millisecond, rejected
  one later, in both modes), and `store-complete.test.ts` still holds a refusal off a completion in flight.
- **Visible in:** `src/server/store-complete.ts`, `src/server/store-calls.ts`.

### M11-R139: a refused preflight leaves the same log line as a refused POST

- **Decision:** an `OPTIONS` request from an origin that is neither the server's own nor in `trustedOrigins` calls
  the origin hint before it is answered `403`, as a refused `POST` does. The hint is unchanged: one warning per exact
  origin, for at most 16 origins per handler, and never for a value that is not an exact origin. A preflight and the
  `POST` of one origin share that one warning.
- **Why:** a page on another origin posts `application/json`, which is not a CORS-safelisted type, so its browser
  sends a preflight first and, refused, never sends the `POST`. The hint was called for the `POST` alone, so a
  cross-origin page missing from `trustedOrigins` failed with a CORS error in its console and not one line in the
  server's log (review finding, reproduced).
- **If wrong:** none known; the limit of 16 origins keeps a flood of preflights out of the log as it does for posts.
- **Status:** in force.
- **Visible in:** `src/server/handler.ts`, `src/server/handler-origin-hint.test.ts`.

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
- **Status:** in force. Each test was seen failing on the code before the fix. The guides name that `NOT_FOUND`:
  `docs/guide/store.md` since `M11-R214`, `docs/guide/errors.md` since `M11-R233`.
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

### M11-R170: `checkBucket` and `doctor` judge the CORS rule the service answers with

- **Decision:** for each origin, `api.checkBucket` and `cloudrop doctor` find the rule that answers each request a
  page sends when it uploads, as the service finds it: the first rule, in stored order, that matches the whole
  request (`src/server/bucket-cors.ts`, shared by both). A rule matches on the origin, exactly as written or by a
  pattern with one `*`; on the method; and, for a preflight, on every header it lists, by name without case or by
  pattern. The requests are the preflight of a single `PUT` with `content-disposition`, `if-none-match`,
  `x-amz-meta-cloudrop-id` and `content-type`, the same without `content-type` (a browser does not list it for a type
  a form can send, such as `text/plain`), the preflight of a part's `PUT`, which lists no header, and the `PUT` itself,
  matched on origin and method. A browser never lists `content-length`, and the server signs no checksum header into
  either `PUT`, so none is matched. The check is `ok` when every preflight is answered and the rule that answers the
  `PUT` exposes `ETag`. When that rule does not, the problem names it, by its ID or its place (`rule 1 (no ID)`), says
  what it does not expose, and names the later rule that would have. A rule that answers the `PUT` without
  `Retry-After` is named in an `ok` message, as advice. An exposed `*` counts as every header.
- **Why:** both accepted the bucket when **any** rule allowed the upload (`rules.some(allowsUploads)`). Measured on R2
  on 2026-11-21 (`docs/research/r2-spike-findings.md`, "Which CORS rule answers when several match"): the service
  answers with the first rule that matches the whole request and with that rule alone, as S3 documents. Reproduced: a
  bucket holding `origin *, GET PUT, headers *, nothing exposed` before `cloudrop-uploads` printed `ok CORS: Browsers
  on https://app.example.com can upload and read ETag.`, while the first rule answers every `PUT` and exposes nothing.
  The old sentence "do not let … upload" was also printed for a rule that only lacked `ETag`, which blocks no upload.
  R2's documentation gives the origin rule ("Origin values without a wildcard must match the request's `Origin`
  header exactly", one `*` that "can span periods"); the old check lowercased the rule's origin first.
- **If wrong:** that the `PUT` itself is matched on origin and method alone is S3's documented rule, and R2's `GET`
  in the measurement agrees with it; a `PUT` whose headers an earlier rule does not allow was not measured on R2. If
  R2 passed such a rule over, the check would name a rule that does not answer. An `ok` message is now longer for a
  bucket whose answering rule exposes `ETag` and not `Retry-After`; code that compares the whole message sees the
  difference, the status is unchanged. R2's answer for an exposed `*` is unmeasured: the Fetch standard reads it as
  every header for a request without credentials, which cloudrop's `PUT`s are.
- **Status:** in force. Amends `M9-C2` (what the CORS check accepts). Amended by `M11-R205`: the check no longer
  looks at `ETag`; a rule that answers the `PUT` is judged on `Retry-After` alone, as advice.
- **Visible in:** `src/server/bucket-cors.ts`, `src/server/bucket-cors.test.ts`, `src/server/bucket-check.ts`,
  `src/server/bucket-check.test.ts`, `src/cli/setup-order.test.ts`, `docs/guide/bucket-setup.md`
  ("When the bucket has other CORS rules", "What checkBucket can tell you"), `docs/guide/command.md#doctor`,
  `docs/guide/troubleshooting.md`.

### M11-R171: `setup` puts cloudrop's CORS rule before a rule that would answer in its place

- **Decision:** `setup --apply` and `--dry-run` place `cloudrop-uploads` so that the service answers with it. A new
  rule goes last and an existing one stays where it stands, unless an earlier rule allows `PUT` from one of the run's
  origins without exposing `ETag` and `Retry-After`: then cloudrop's rule goes just before the first such rule, in the
  same write that adds or grows it. Every other rule is written back as read and in its order. The finding says so:
  `added rule "cloudrop-uploads" for <origin> before rule "legacy" and kept 1 other rule ("legacy"). The storage
  service answers a request with the first rule that matches it, and rule "legacy" matches uploads from <origin>
  without exposing ETag and Retry-After.`; an existing rule is `moved`. A rule without an ID is named by its place.
  A rule for another origin, or one that answers uploads in full, stays in front. When the bucket's other rules
  already answer every request cloudrop's rule exists for (each `PUT` preflight, the `PUT` with both headers exposed,
  `GET` and `HEAD`), nothing is added and the finding names the rule that does it. A second run changes nothing.
  `--replace` writes cloudrop's rule alone, so no order arises. The by-hand instructions say where the rule goes.
- **Why:** `setup --apply` appended its rule after the bucket's others, and after the first-match measurement of
  `M11-R170` an appended rule behind `origin *, PUT` never answers: `doctor` then reported a problem that `setup`
  could not fix. Placing it before the first rule that answers in its place, not at the top, leaves every rule that
  answers something else in front of it untouched. The test sends a browser's preflight and `PUT` to the fake R2
  (`M11-R172`) after each run and reads the exposed headers of the answer.
- **If wrong:** from the run's origins, cloudrop's rule now answers `GET` and `HEAD` too in place of the rule it went
  before, so a page that read a header only that rule exposed, or sent a header only that rule allowed, loses it; the
  guide says so, and the remedy is to add them to `cloudrop-uploads`, which `setup` never trims. A service that drops
  rule IDs gets a second copy if the first is later shadowed, since `setup` cannot tell which rule to move. An origin
  left out of a later run is not looked at: only the origins passed decide the place.
- **Status:** in force. Amends `M9-C6` (cloudrop's rule may move; no other rule does). Amended by `M11-R205`:
  the rule cloudrop's goes before is one that does not expose `Retry-After`; `ETag` no longer counts. The by-hand
  instruction says the same since `M11-R232`.
- **Visible in:** `src/cli/rules.ts` (`place`, `serving`, `mergeCors`), `src/cli/setup.ts`, `src/cli/instructions.ts`,
  `src/cli/setup-order.test.ts`, `docs/guide/command.md#setup`, `docs/guide/bucket-setup.md`.

### M11-R172: the fake R2 answers preflights and CORS headers as measured

- **Decision:** `createFakeR2` with `bucketConfig.cors` answers an `OPTIONS` request from its stored rules: `204` with
  the answering rule's methods and max age, the headers asked for and the origin (`*` for a rule that allows every
  origin), or `403` without a CORS header when no rule matches. A request that passes its signature check and names
  an `Origin` gets `access-control-allow-origin` and the rule's exposed headers; one refused for its signature gets
  none. The answering rule is the first that matches. The code (`src/testing/fake-r2/cors.ts`) shares nothing with
  `src/server/bucket-cors.ts`.
- **Why:** the fake answered `OPTIONS` with a signature error and never sent a CORS header, so no test could show what
  a browser gets from a configuration `setup` wrote. Each answer is a measured one: the four stored orders of
  `docs/research/r2-spike-findings.md` ("Which CORS rule answers when several match") are the fake's test, with the
  `204` and `403` shapes of the browser sections and the refused URL without CORS headers (U2, R1). Two
  implementations, so a browser-like request against the fake checks the command against the measurement.
- **If wrong:** a test that sends an `Origin` to the fake of `cloudrop/testing` now gets CORS headers when its
  `bucketConfig.cors` has a matching rule. The body of R2's `403` to a preflight no rule matches was read only on a
  bucket without rules; `vary: Origin` is not modelled.
- **Status:** in force.
- **Visible in:** `src/testing/fake-r2/cors.ts`, `src/testing/fake-r2/cors.test.ts`, `src/testing/fake-r2.ts`,
  `src/cli/command-fixture.ts` (`upload`).

### M11-R173: the message for a `501` names no service

- **Decision:** a `501` from the storage service reads "The storage service does not support this request. Use a
  storage service that implements it."
- **Why:** it read "Use R2 or another backend that implements it." `cloudrop setup --apply` prints the message when a
  settings read answers `501`, so a run against an S3-compatible service that lacks `GetBucketCors` was told to use R2,
  and a run against Wrangler's local R2 was told to use the service it was already using.
- **If wrong:** code that compares the whole message sees the new words; the code (`STORAGE_ERROR`), `retryable` and
  the status are unchanged.
- **Status:** in force. Extends `M11-R116`.
- **Visible in:** `src/storage/storage-error.ts`, `src/storage/storage-error.test.ts`, `src/cli/setup.test.ts`.

### M11-R174: `-h` and `--help` are help only where an option's name can stand

- **Decision:** `--help` or `-h` prints the usage and exits 0 as the first argument or wherever an option's name can
  stand. As the value of an option that takes one (`--env-file -h`, `--origin --help`, `--var -h`) it is that value,
  and is checked as one.
- **Why:** the command looked for the two words anywhere in its arguments, so `doctor --origin X --env-file -h`
  printed the usage and exited 0 without checking anything: a script that names its file so, or passes a value from
  elsewhere, got success for a run that never happened.
- **If wrong:** `cloudrop doctor --origin --help`, typed to ask for help, now answers that `"--help"` is not an origin
  (exit 2) and prints the usage after it, as every usage error does.
- **Status:** in force. Since `M11-R234` that answer names the value by its number and does not repeat it; since
  `M11-R235` `--version` and `-v` follow the same rule.
- **Visible in:** `src/cli/args.ts`, `src/cli/run.test.ts`, `docs/guide/command.md`.

### M11-R175: the lifecycle rule has one name in the guide and the command, and is known by what it does

- **Decision:** the by-hand lifecycle rule of `docs/guide/bucket-setup.md` is named `cloudrop-abort-incomplete`, the
  name `cloudrop setup` prints and writes. `checkBucket`, `doctor` and `setup` go on recognising the rule by what it
  does (enabled, whole bucket, aborts incomplete multipart uploads), whatever its name.
- **Why:** the guide named it `abort-incomplete-uploads`, so a reader who followed the guide and then compared with
  the command's output saw two rules where there is one. A test now holds the other half: a rule that carries
  cloudrop's name but is disabled, or limited to a prefix, is reported as a problem.
- **If wrong:** a bucket set up from the old guide keeps a rule named `abort-incomplete-uploads`; it passes every
  check, and `setup --apply` leaves it alone and adds none (`M9-C7`).
- **Status:** in force. `examples/next/scripts/setup-rustfs.ts` and `examples/hono/scripts/setup-rustfs.ts` write
  the same name since `M11-R206`.
- **Visible in:** `docs/guide/bucket-setup.md`, `src/server/bucket-check.test.ts`.

### M11-R176: an origin's host is one a browser loads a page from

- **Decision:** `originProblem` (the server's `trustedOrigins` and `api.checkBucket`, and the command's `--origin`)
  refuses an `http` or `https` origin whose host, as the URL parser writes it, is neither an address nor a name of
  letters, digits, `-` and `_` in parts joined by single dots, with or without a last dot: "… is not an origin: no
  browser loads a page from this host. A host is an address, or a name of letters, digits, "-" and "_" in parts joined
  by single dots. Name the origin of the page that uploads, such as https://app.example.com." The host is checked
  before a correction is offered, so no refused host is named as the origin to use.
- **Why:** `https://a.example$(id)` passed as an origin. The URL standard forbids only a few characters in a host
  (space, `#`, `/`, `:`, `<`, `>`, `?`, `@`, `[`, `\`, `]`, `^`, `|`, and `%` and controls in a domain:
  <https://url.spec.whatwg.org/#forbidden-host-code-point>), so its parser keeps `$ ( ) & ' " { } ! ; = + , ~` and
  the backtick, and gives such a URL an origin. Measured on 2026-11-21 with Chromium 159 (Playwright's headless shell,
  a page served on `http://<host>.localhost:<port>` that fetches another origin, the `Origin` header read on the
  server): every host with one of those characters, and one with an empty part (`a..b`), ends in
  `net::ERR_INVALID_URL` before any request; `a_b`, `_a`, `-a`, `a.-b`, `xn--bcher-kva`, `localhost.` and `127.0.0.1`
  load, and the page sends exactly that host in `Origin`. A CORS rule or a trusted origin written for a host no page
  has allows nobody, and the text reached logs, a CORS rule and printed commands.
- **If wrong:** Firefox and WebKit were not measured (their Playwright builds were not installed); a browser that
  loads a page from such a host would have its origin refused at start-up (`INVALID_CONFIG`) and by the command
  (exit 2). An origin with an app's own scheme was already held to letters, digits, `.` and `-` (`M11-R41`).
- **Status:** in force. Extends `M11-R111`. The table in `docs/guide/server.md` ("What an origin is") has its row
  since `M11-R207`.
- **Visible in:** `src/server/origins.ts`, `src/server/origins.test.ts`, `src/cli/run.test.ts`,
  `src/cli/commands.test.ts`, `docs/guide/command.md`.

### M11-R177: the command never prints a secret, and says which two values it does print

- **Decision:** the promise is "the command never prints a secret", written the same way wherever it stands: the
  guide, the usage, the file comments of `src/cli/**` and the status of `M9-C8`. It never prints the access key ID,
  the secret access key or the upload token secret, and it never prints the R2 account ID or the S3 region either. It
  prints two setting values, the bucket's name and the S3 endpoint, and only as words of a Wrangler or AWS CLI command
  it suggests (`wrangler r2 bucket … <bucket>`, `aws s3api … --bucket <bucket> … --endpoint-url <endpoint>`). A
  Wrangler command names no account, so an R2 run prints no account ID: Wrangler takes the account from its own
  sign-in. `src/cli/printed-values.test.ts` runs eighteen output paths for R2 and for S3, each setting with a value
  of its own, and holds for each which values the output contains and that none stands outside those words.
- **Why:** `M11-R110` made the printed commands runnable by naming the bucket and the endpoint, which reversed
  `M9-C8`'s "no value ever printed"; the guide still said "The command never prints a setting's value, only the name
  of its variable", and `M9-C8`'s status still cited a live check from before the change. The fixture's check let
  anything pass that followed `wrangler r2 bucket` or `aws s3api` on a line, so a secret printed after a command
  would not have been seen; the new test looks at the exact words.
- **If wrong:** a bucket name or an S3 endpoint that a team treats as confidential reaches the terminal and a CI log
  with `doctor` and `setup`; the guide says so. What follows `=` in `--var` is still printed when it is shaped like a
  variable's name (`M11-C3`), so a value typed there by mistake can be printed: the guide says that too.
- **Status:** in force. Completes `M11-R110`; supersedes the "no value ever printed" of `M9-C8`. The fixture itself
  checks every printed command word for word since `M11-R208`. What the command repeats of a person's own arguments is
  narrower since `M11-R234`.
- **Visible in:** `src/cli/printed-values.test.ts`, `src/cli/usage.ts`, `src/cli/commands.ts`, `src/cli/settings.ts`,
  `src/cli/variables.ts`, `src/cli/command-fixture.ts`, `docs/guide/command.md#settings`,
  `docs/decisions/m9-cli.md` (`M9-C8`), `docs/decisions/m11-command.md` (`M11-C3`).

### M11-R190: one owner's listing in one status leads its order with the owner, so Postgres never walks `created_at` for it

- **Decision:** On Postgres, a listing that names an owner and exactly one status (`api.files`, the `replace`
  listing, `api.allFiles({ owner, status })`) is written `owner = ANY (ARRAY[$1]) AND status IN ($2) … ORDER BY owner,
  created_at, id COLLATE "C"`, each in the page's direction, instead of `owner = $1 … ORDER BY created_at, id`.
  Several statuses or none keep `M11-L6`'s order. SQLite's statement is unchanged.
- **Why:** `M11-L5` said `api.files` kept its plan beside the new `(created_at)` index. It does not. For one owner in
  one status both indexes give the order, and Postgres prices the owner's range (random heap pages) and a walk of
  `created_at` from the newest row (sequential heap pages) about the same once the owner holds some 2% of the rows,
  so the plan changed from one ANALYZE to the next; for an owner whose files are old the walk passes every newer
  file first and grows with the table. `M11-L5`'s best of five after one ANALYZE never met it. Only the order can
  tell the indexes apart: `(owner, created_at)` is an order the owner index has and `(created_at)` has not. Written
  `owner = $1` the planner drops the owner from the order as a known constant, which is how the walk became
  eligible; compared as a one-element array it is no constant to the planner and is still an index condition with
  the estimate of an equality. Every row has the same owner, so the rows and their order are 0.5.0's.
  `status = ANY (ARRAY[$2]) … ORDER BY status, created_at`, the other candidate, was rejected: before Postgres 17 an
  array condition on a second index column is checked row by row, and a recent owner of 15,000 files read 3,098
  buffers on 16.16 against 46. `M11-L6`'s expression for one status too was rejected: it sorts every file of the
  owner for each page.

  Measured 2026-11-21, 310,000 files, a page of 100, 20 rounds of `ANALYZE` then `EXPLAIN (ANALYZE, BUFFERS)`, on
  Postgres 18.6, 17.11 and 16.16 (the same plans and buffers within 1 on each; 18.6 also under
  `plan_cache_mode = force_generic_plan`). Milliseconds (buffers); "walk" is `created_at_idx`, every round:

  | Listing | 0.5.0 | 0.6.0 schema, before | 0.6.0 schema, after |
  | --- | --- | --- | --- |
  | `api.files`, the owner of the oldest 10,000 | 0.07–0.10 (6) | walk, 17.3–19.4 (5,873) | 0.07–0.11 (6) |
  | … oldest first | 0.05–0.08 (6) | walk, 0.04–0.06 (5) | 0.05–0.07 (6) |
  | … after a cursor | 0.05–0.09 (6) | walk, 0.04–0.06 (5) | 0.06–0.07 (6) |
  | … on a route, as `replace` reads it | 0.05–0.09 (8) | walk, 17.0–18.5 (5,876) | 0.07–0.10 (8) |
  | … on a route 1% of the files have | 0.44–0.60 (169) | 0.34–0.41 (169) | 0.37–0.59 (169) |
  | … by name | 0.85–0.93 (22) | walk, 18.1–19.0 (5,887) | 0.87–1.12 (22) |
  | … by type | 0.08–0.15 (22) | walk, 17.5–19.5 (5,887) | 0.11–0.12 (22) |
  | … by a type's family (`M11-R192`) | 2.80–3.00 (228) | 2.75–2.89 (228) | 0.06–0.08 (7) |
  | a recent owner of 15,000 | 0.08–0.09 (46) | walk, 0.17–0.21 (52) | 0.06–0.08 (46) |
  | … after a cursor | 0.08–0.13 (48) | walk, 0.19–0.30 (54) | 0.07–0.12 (48) |
  | … oldest first, the last page | 0.03–0.06 (21) | walk, 0.08–0.14 (23) | 0.03–0.06 (21) |
  | `eraseOwner` (every status) | 2.66–2.95 (228) | 2.81–3.10 (228) | 2.71–2.87 (228) |
  | several statuses, after a cursor (`M11-R191`) | 1.36–2.04 (120) | range of `created_at_idx`, 1.74–1.89 (98) | 1.42–1.77 (120) |
  | `api.allFiles({ owner })` | 2.55–2.84 (228) | 2.80–2.93 (228) | 2.61–2.92 (228) |
  | `api.allFiles()` | 31.8–33.4 (5,250) | 0.04–0.05 (6) | 0.04–0.07 (6) |

  On the reviewer's shape (306,000 files, all completed, the oldest 6,000 of one owner) 0.5.0's statement walked
  `created_at_idx` in 20 of 20 rounds here, 16.8 to 25.6 ms and 5,605 buffers; the reviewer saw it in about half.
  SQLite 3.53 reads every one of these listings by `owner_status_created_at_idx`, without statistics and after
  `ANALYZE` (it plans by the averages in `sqlite_stat1`, never by one owner's share), exactly as on a 0.5 schema.
  No other statement of the store names `created_at`, and none is planned on the index in any round: `reserve` with
  its supersede, `attach`, `claim`, `release`, `complete` with `replace`, `get`, `end`, `cleaned`, `revoke`,
  `reconcile`, `usage`, `owners` and the four sweep pages.
- **If wrong:** where Postgres expects fewer rows than a page it reads the owner's matching rows and sorts them, as
  in 0.5.0, and that sort now compares the owner, equal in every row, before the time: measured on 10,500 sorted
  rows, 6.3 ms became 10.5 ms with the same 5,107 buffers. The two listings where 0.5.0 sorted many rows no longer
  sort (`M11-R191`, `M11-R192`); what is left is an owner whose files are nearly all on a route or in a status that
  few other files have. A Postgres that folds a one-element array into an equality brings the walk back:
  `owner-plans.db.integration.test.ts` fails on it.
- **Status:** in force. `src/store/sql/owner-plans.db.integration.test.ts` reads the plan and the buffers of 18
  owner listings, 3 listings of every owner and the store's 17 other calls after each of 20 `ANALYZE` runs on
  310,000 rows (before the fix: 10 of the 18 on `created_at_idx`, `api.files` at 6,092 buffers), and SQLite's plans
  with and without statistics. `src/store/sql/list-as-0-5.db.integration.test.ts` compares every page of nine
  listings with 0.5.0's statement on both dialects.
- **Visible in:** `src/store/sql/reads.ts` (`inOwnerOrder`, `listedBy`), the two tests, `docs/decisions/m11-listing.md`
  (`M11-L5`, `M11-L6`), `docs/guide/store.md#known-costs`.

### M11-R191: in one owner's listing the cursor's time reaches Postgres as a subquery

- **Decision:** On Postgres, when a listing names an owner, its cursor is compared as `(created_at, id COLLATE "C") <
  ((SELECT $n::timestamptz), $m)`. Every owner's listing and SQLite keep the plain value.
- **Why:** with the value in the statement the planner counts the rows before the cursor, assumes they are spread
  over the owners evenly, and for an owner whose files are old expects almost none: 0.5.0 then read every file of
  the owner before the cursor and sorted them, and beside the new index the planner read the cursor's range of
  `created_at_idx` instead, every other owner's rows in it included (`M11-L6`'s several statuses too, whose order no
  index has). A subquery is one value the planner cannot read, so it assumes a third of the rows, as for the first
  page, and the range of `created_at` is never the cheaper plan; the owner index still starts at the cursor (`Index
  Cond: … created_at <= (InitPlan 1).col1`). Measured on the owner of the oldest 6,000 files, the page after its 2,880th: 0.87
  ms and 69 buffers in 0.5.0, 2.2 to 4.3 ms on `created_at_idx` with `M11-R190` alone, 0.10 ms and 16 buffers with
  this.
- **If wrong:** a page after a cursor is planned like a first page, so a filter few of the owner's files pass costs
  what it costs there.
- **Status:** in force; the cursor rows of `owner-plans.db.integration.test.ts` (fault probe: with the plain value
  three of them read `created_at_idx`).
- **Visible in:** `src/store/sql/reads.ts` (`cursorTime`).

### M11-R192: on Postgres a type's family is matched with `^@`

- **Decision:** `type: "image/"` is `type ^@ $n` on Postgres (starts with), no longer `substr(type, 1, 6) = $n`.
  SQLite, which has no such operator, keeps `substr`. The rows are the same: both compare the first characters
  exactly.
- **Why:** Postgres prices an equality on an expression as one row in 200, so it expected an owner's images to be
  fewer than a page, read every file of the owner and sorted them: 2.8 ms and 228 buffers for an owner of 10,000,
  5.6 ms and 5,102 buffers for one of 15,000, in 0.5.0 as well. That sort is the one `M11-R190` makes slower. `^@`
  has an estimator that reads the column's statistics (10,367 expected of 10,500), so the page is read in index
  order: 0.06 ms and 7 buffers, 0.08 ms and 90. The operator has had that estimator since Postgres 11.
- **If wrong:** none known; a family no file has reads the owner's files once, as before.
- **Status:** in force; the two family rows of `owner-plans.db.integration.test.ts` (fault probe: 228 and 5,162
  buffers with `substr`), and the family row of `list-as-0-5.db.integration.test.ts` for the rows.
- **Visible in:** `src/store/sql/reads.ts` (`typeMatches`).

### M11-R193: the guide says how to check and repair an index a concurrent build left invalid

- **Decision:** "Upgrading from 0.5" keeps its advice to build the index with `CREATE INDEX CONCURRENTLY IF NOT
  EXISTS` on a large table, and adds what the advice left out: the statement runs alone, never inside a transaction
  or beside other statements; the check `SELECT indisvalid FROM pg_index WHERE indexrelid = '"…_idx"'::regclass`; and
  the repair, `DROP INDEX CONCURRENTLY` and the build again. "Upgrading from 0.1" points there.
- **Why:** reproduced on Postgres 18.6 with 306,000 rows: under `SET statement_timeout = '5ms'` the build ends with
  `canceling statement due to statement timeout` and leaves the index with `indisvalid = f`; the same statement
  again, and the migration's `CREATE INDEX IF NOT EXISTS`, both answer `relation … already exists, skipping` and
  leave it invalid; the planner then sorts the table for `api.allFiles` (a parallel sort of 306,000 rows) as if
  there were no index. After the drop and a second build it is valid and read. Inside `BEGIN`, and as the second
  statement of one query string, Postgres refuses `CONCURRENTLY` with `cannot run inside a transaction block`.
- **If wrong:** none; the statements are Postgres's own, per its `CREATE INDEX` page ("Building Indexes
  Concurrently").
- **Status:** in force.
- **Visible in:** `docs/guide/store.md#upgrading-from-05`, `docs/guide/store.md#upgrading-from-01`.

### M11-R194: the guide shows Drizzle's upgrade statement for the SQLite tables too

- **Decision:** The Drizzle bullet of "Upgrading from 0.5" shows both statements `drizzle-kit generate` writes: the
  double-quoted one for `cloudropPgTables()` and, for `cloudropSqliteTables()`, ``CREATE INDEX
  `cloudrop_files_created_at_idx` ON `cloudrop_files` (`created_at`);``.
- **Why:** the bullet named both table sets and showed only the Postgres statement, which `M11-L8` had read from the
  Hono example's migration. Generated with drizzle-kit 1.0.0-rc.5 from `cloudropSqliteTables()`, the SQLite
  migration quotes with backticks; a reader comparing their migration with the guide would see a difference that is
  none.
- **If wrong:** none; SQLite accepts either quoting, and the index is the same.
- **Status:** in force.
- **Visible in:** `docs/guide/store.md#upgrading-from-05`.

### M11-R195: `api.allFiles` refuses an `owner` key whose value is `undefined`

- **Decision:** `api.allFiles({ owner: undefined })`, with any other options, answers `INVALID_INPUT`: "owner is
  undefined. Pass the owner's id to list that owner's files, or leave the owner key out to list every owner's
  files." Only a call whose options have no `owner` key (or no options) lists every owner. Every other option keeps
  its meaning when `undefined`: left out. The type stays `owner?: string`. The guide's support-tool example checks
  the id before the call.
- **Why:** `M11-L1` made `api.allFiles` a method of its own so that an id lost by a bug never lists everyone's
  files, and then read `{ owner: undefined }` as "every owner": the guide's own example,
  `api.allFiles({ owner: userId })`, listed every owner's files in every status when `userId` was `undefined`. A
  present key is an attempt to name an owner; treating its missing value as the widest listing is the unsafe
  reading, and the two cannot be told apart later (the page looks like any other). TypeScript callers lose nothing
  they could do before: an optional filter is spread in, `{ ...(owner ? { owner } : {}) }`, and under
  `exactOptionalPropertyTypes` the compiler already refuses `owner: undefined`.
- **If wrong:** an app that passed an optional owner straight through gets `INVALID_INPUT` where it got every
  owner's files; the message names both ways out. `api.allFiles` is new in 0.6.0, so no released caller changes.
- **Status:** in force; `src/server/all-files.test.ts` (an id read from an empty session object).
- **Visible in:** `src/server/all-files.ts`, `docs/guide/store.md#list-every-owners-files`,
  `docs/decisions/m11-listing.md` (`M11-L1`).

### M11-R196: `/upload` refuses a file name with NUL or a lone surrogate for that file alone; every other text is settled

- **Decision:** A file whose name has a NUL character (U+0000) is rejected in its own ticket with `INVALID_INPUT`:
  "This file's name has a NUL character (U+0000), which cannot be stored. Rename the file, then add it again." A
  name with a lone surrogate is rejected the same way ("is not valid Unicode (it has a lone surrogate)"); until now
  it refused the whole request with the message for a missing name. The other files of the request go on, with or
  without a store. Nothing else about the request's texts changes, and each is now pinned by a test:

  | Text | NUL | lone surrogate | other C0 controls, DEL, C1 |
  | --- | --- | --- | --- |
  | file name | refused, that file | refused, that file | kept as sent |
  | file type | refused, that file (`FILE_TYPE_NOT_ALLOWED`) | refused, that file | refused, that file |
  | metadata keys and values | kept | kept | kept |
  | `idempotencyKey` | request refused | request refused | request refused |

- **Why:** reproduced on Postgres 18.6 through the real handler: `"a\u0000b.txt"` passed `/upload`'s checks, the
  reserve of the whole request failed (a `text` column cannot hold U+0000), and all three files of the request were
  answered `SERVER_ERROR`, `retryable: true`, on every retry; SQLite stored the name. No file system can give a file
  such a name, so refusing it costs no real upload. A lone surrogate cannot be percent-encoded for the header and a
  database stores it as U+FFFD; real files on Windows can carry one, and one such file among ten should not fail
  the other nine. Other control characters stay allowed because they worked in 0.5.0 and are safe where they go:
  macOS names a folder's icon file `Icon\r`; `contentDisposition` writes `_` for every byte outside printable
  ASCII and for `"` and `\` in `filename`, and percent-encodes the name in `filename*`, so
  `a\r\nX-Injected: 1".txt` is signed as `filename="a__X-Injected: 1_.txt"; filename*=UTF-8''a%0D%0AX-Injected%3A%201%22.txt`;
  both databases store them; only `[a-z0-9]{1,16}` of a name's extension reaches the key; cloudrop logs no file
  name. The type is matched against the RFC 6838 pattern after its parameters are dropped, so nothing but
  `[a-z0-9!#$&^_.+-]` and one `/` is stored or signed. The metadata reaches the token and the store as
  `JSON.stringify` wrote it, with U+0000 to U+001F and lone surrogates as `\uXXXX` escapes, which is ASCII a `text`
  column holds (a `jsonb` column would refuse `\u0000`; the store's is `text`). The key is 16 to 128 of
  `[A-Za-z0-9_-]`.
- **If wrong:** an app that wants no control characters in names refuses them in `beforeUpload`, where it sees
  every name. Not settled here: a route whose own `key` function puts the file's name into the key still fails the
  whole request with a non-retryable `SERVER_ERROR` for a name with a control character (`Icon\r` among other
  files), as in 0.5.0, because `normalizeKey` refuses the key and the handler reads that as the route's bug.
- **Status:** in force; the case left open under "If wrong" is settled by `M11-R222`.
  `src/server/upload-texts.test.ts` runs each row of the table through the handler on the fake
  R2 with the memory store; `src/server/upload-texts.db.integration.test.ts` sends a NUL name, `Icon\r` and metadata
  with NUL in one request to Postgres (before the fix: three retryable `SERVER_ERROR`s). The lone-surrogate row of
  `src/server/upload-requests.test.ts` moved there, with its new answer.
- **Visible in:** `src/server/upload-request.ts` (`nameProblem`), the two tests, `docs/guide/server.md`.

### M11-R200: `/complete` ends an upload whose multipart upload the bucket no longer has

- **Decision:** when the bucket answers `NoSuchUpload` to `/complete`'s ListParts or CompleteMultipartUpload and HEAD
  shows no object of this upload under the key (none, or another writer's), the answer is still
  `410 NO_SUCH_UPLOAD`, and it now ends the upload as every other refusal at `/complete` does (`uploadGone` in
  `src/server/complete-verify.ts`): the plugins' `onAbort` runs with `reason: "rejected"`, and with a store the
  request claims the row as a completion would and ends it `rejected` (`M11-R138`), which gives its reserved bytes
  back. Nothing is removed from the bucket: the parts went with the multipart upload, and an object under the key is
  another writer's. When HEAD shows this upload's own object the upload is verified as before, so a `/complete` that
  follows one which finished the upload in the bucket completes the row or is answered from it; a row another request
  holds a live claim on is answered busy and left alone.
- **Why:** reproduced with a store and a quota of 8 bytes: a 5-byte multipart upload was aborted in the bucket, as the
  lifecycle rule does, `/complete` answered `NO_SUCH_UPLOAD`, the row stayed `pending` with its 5 bytes reserved, and
  the owner's next `/upload` was `QUOTA_EXCEEDED` until the sweep. The token names the only multipart upload that row
  can complete, so nothing could finish it. Its release rested on the client sending `/abort` afterwards (`M11-R89`,
  `M11-R90`), which a closed tab never does. A row a stopped request had left `completing` was answered busy after
  its lease for the same reason as in `M11-R138`, and ends now. `rejected`, not `aborted`: nobody cancelled this upload
  through cloudrop; the server judged it at `/complete`, which is what `rejected` and `onAbort`'s `"rejected"` already
  mean (`docs/guide/server.md`, "Plugins"). The stateless path was checked: the server holds nothing for the upload
  (the token is its only record), and what a plugin reserved in `beforeUpload` is released by this `onAbort`, which no
  request ran before unless the client sent `/abort`.
- **If wrong:** the window `M4-F12` looked for and did not find in 23 trials on R2: a `/complete` that gets
  `NoSuchUpload` while HEAD does not yet show the object another `/complete` is writing. With a store, the second
  request then ends the row, the first finds it ended and answers `UPLOAD_EXPIRED`, the sweep's cleanup pass deletes
  the stored object, and the client's retry sends the file again; before, the first completed and the client's retry
  stored the file a second time. Without a store, `onAbort` runs for a file the first request then completes. The
  `/abort` a client sends after `NO_SUCH_UPLOAD` finds the row ended, and `onAbort` hears of the upload a second time,
  with `"aborted"`, as `M11-R89` says of any ticket the server had already ended.
- **Status:** in force. Amends the `NO_SUCH_UPLOAD` row of `M11-R80`'s table (with a store the row is `rejected`) and
  the "leaves the row pending" of `M11-R90`'s "Why".
- **Visible in:** `src/server/complete-verify.ts`, `src/server/store-complete-gone.test.ts`,
  `src/server/complete-multipart.test.ts`, `src/client/replaced-ticket.test.ts`, `docs/guide/errors.md`,
  `docs/guide/server.md` ("Plugins").

### M11-R201: the server's word that a ticket is over ends the doubt of an earlier `/complete`, and that ticket's `/abort` carries `keep`

- **Decision:** when `/complete` answers that the ticket is over (`new` in `M11-R80`: `UPLOAD_EXPIRED`,
  `INVALID_TOKEN`, `UNKNOWN_ROUTE`, a refusal for good) for an upload an earlier `/complete` may have finished, the
  client stops treating the upload as possibly complete and remembers the doubt as `keepStored`
  (`src/client/upload.ts`). The ticket is then given up like any other: by a resumed upload that starts over
  (`M11-R90`), by a retry that replaces it (`M11-R89`), by `abort()` of the failed file, by `pagehide`, and when
  `upload()` fails. Its one `/abort` carries `keep: true` (`drop` in `src/client/file-run.ts`) and is sent with
  keepalive as any cancel's; only `discard()` sends without it (`awaited`, `M3-U95`). While no such answer has
  arrived, a ticket in doubt still gets no `/abort` (`M3-S14`, `M3-H16`).
- **Why:** reproduced three ways on a server with a store and a quota that fits the file once. The first `/complete`
  got no answer, the ticket's deadline passed, and the second was answered `UPLOAD_EXPIRED`; then (1) a resumed upload
  started over, (2) `retry()` asked for a new ticket, each answered `QUOTA_EXCEEDED` with the old row still `pending`,
  and (3) `abort()` of the failed file sent nothing and left the row `pending`. `M11-R90` recorded (1) and left it to
  the sweep. The `/abort` is safe: the server takes an expired token for it. With a store the row decides, `keep` or
  not: a `pending` row proves no completion was recorded, and a completed row is answered from the store, never with
  `UPLOAD_EXPIRED`, and loses nothing to an `/abort`. Without a store `keep` makes the server abort the multipart
  upload and keep an object that landed (`M3-U94`), since nothing there tells a landed object from a recorded one.
  The client could have dropped the doubt alone and sent a plain `/abort`, which an expired token also makes harmless;
  `keep` is there because two servers whose clocks differ can disagree about the expiry, and a plain `/abort` taken
  by the one that still finds the token live would delete a file the unheard `/complete` recorded.
- **If wrong:** without a store, a file whose unheard `/complete` did finish stays in the bucket beside the one the
  new ticket stores, and `onComplete` ran for both, as `M11-R81` already accepts. After `INVALID_TOKEN` the `/abort`
  is refused and frees nothing. A first `/complete` the server is still working on when the `/abort` arrives: with a
  store the row decides (ended before the claim, that completion is answered `UPLOAD_EXPIRED` and the sweep removes
  its object); without one the `/abort` may abort the multipart upload under it, and the file is stored once, by the
  new ticket. `upload()` no longer keeps the record of such a ticket for a resume: only a new ticket can store it.
- **Status:** in force. Amends `M11-R89` and `M11-R90` ("a ticket a `/complete` may have finished gets no `/abort`"),
  `M11-R81` (a cancel after the server's word) and `M3-U94` ("only `discard()` sends `keep`"). Amended by `M11-R260`:
  a resumed upload's `/abort` carries `keep` from the start, until the server proves the upload unfinished.
- **Visible in:** `src/client/upload.ts` (`complete`, `keepStored`), `src/client/file-run.ts` (`drop`),
  `src/client/job-run.ts`, `src/client/endpoints.ts`, `src/client/replaced-ticket.test.ts`,
  `src/client/retry-dead-ends.test.ts`, `docs/guide/client.md` ("Cancel", "Retry"), `docs/guide/resume.md` ("The
  server is asked first").

### M11-R202: a second `upload()` or `start()` of a file whose first attempt kept its upload is the app's to settle

- **Decision:** `upload()` and `start()` go on knowing nothing of an earlier attempt: the same file passed again is a
  new upload under a new key (resume spec §3.3, `M11-R90`'s table). An app that sends a file a second time settles
  the first attempt itself: it finds it with `resumable(route)` by name, size and `lastModified`, and calls
  `resume()`, which sends only the parts the bucket lacks, or `discard()`, which frees its parts and its bytes of the
  quota. The client guide says so under "Upload one file" ("Sending a file again after it failed"), with the calls,
  and the resume guide where it says that only `resume()` continues an upload. No code changed.
- **Why:** reproduced with a store and a quota that fits the file once: a four-part `upload()` failed with
  `NETWORK_ERROR` and kept its record (`M4-F1`); a second `upload()` of the same file was `QUOTA_EXCEEDED`, the first
  row still `pending`; after `discard()` of the listed upload it passed, and `resume()` of it sent the one missing
  part. The client cannot do this for the app without a cost the owner ruled out. The reservation has to be freed
  before `/upload` is asked, and the file's fingerprint (SHA-256 of its edges, `fingerprint.ts`) is computed only
  after a multipart ticket has arrived and its lock was taken (`persist.ts`); a plain `upload()` hashes nothing
  before `/upload`, and does not know yet whether the file will go in parts. Matching on name, size and
  `lastModified` alone would discard another file's upload that shares them, and a client that discarded on its own
  would throw away parts the user may want resumed, while one that resumed on its own would send the file with the
  record's route and metadata instead of the call's. Each of the two is a choice the page's user or its code makes.
- **If wrong:** an app that sends a failed file again without looking in `resumable()` is refused `QUOTA_EXCEEDED`
  for an owner without room for the file twice, until the sweep ends the first row (its token's 24 hours and the
  grace, or sooner with `api.revokeUploads`). Without a quota the first attempt's parts stay until the bucket's
  lifecycle rule removes them. `start()` has `retry()`, which needs none of this.
- **Status:** in force.
- **Visible in:** `docs/guide/client.md` ("Sending a file again after it failed"), `docs/guide/resume.md` ("The user
  picks the file again"), `src/client/replaced-ticket.test.ts`.

### M11-R203: the store guide's known costs say what a retry does after a lost ask

- **Decision:** the sentence of `docs/guide/store.md` ("Known costs") about an `/upload` ask whose every attempt lost
  its answer now reads: its last attempt's rows hold their bytes until the first `retry()` of one of its files, which
  sends that ask's key once more, so the server ends those rows before it reserves again; a page that never retries
  leaves them to the sweep.
- **Why:** the sentence said `retry()` and `resume()` "ask again with a new key", which `M11-R92` changed for
  `retry()`. `resume()` never applied: an ask that gave no ticket left no record to resume.
- **If wrong:** nothing: one sentence, and `src/client/launch.test.ts` and `src/client/retry-dead-ends.test.ts` hold
  the behaviour.
- **Status:** in force. Completes `M11-R92`.
- **Visible in:** `docs/guide/store.md` ("Known costs").

### M11-R204: `setup` says that it merged several rules with cloudrop's ID, in a sentence

- **Decision:** when the bucket holds more than one rule with the ID `cloudrop-uploads`, `setup --apply` and
  `--dry-run` say `merged the 2 rules named "cloudrop-uploads" into one, which allows everything they allowed`
  (`would merge … they allow`), beside whatever else the run does: `added origins … to it`, `moved it before rule
  "legacy"`, `kept 1 other rule ("legacy")`. The merge is its own value (`Merged.merged`, the number of rules), no
  longer text put where "what the rule gains" goes. A `--replace` run reads `replaced every rule with
  "cloudrop-uploads" for <origin>, as --replace asks: the current rules could not be read.`
- **Why:** the merge was written into `added`, which `setup` prints as "added <what> to rule …", so the line read
  `added its copies folded into one to rule "cloudrop-uploads"`; and when the rule also gained an origin or moved,
  `added` held that instead and the merge was not mentioned at all, although the write removed rules from the bucket.
  Every other sentence `src/cli/rules.ts` and `src/cli/setup.ts` can print was then read in each combination (add,
  update with and without a gain, a move, kept rules, nothing to change, an edited lifecycle rule, an unreadable
  setting for R2 and S3, a failed write, `--replace`, a dry run). One more was changed: the `--replace` line ended a
  lifecycle rule's description with two parentheses in a row, `(aborts …, whole bucket) (--replace: …)`. A rule that
  gains several kinds of thing lists them with semicolons (`added origins a, b; exposed headers Retry-After to rule
  …`), which is kept: each kind is itself a list with commas.
- **If wrong:** a script that reads the old `--replace` line sees new words; the status column and the exit code are
  unchanged.
- **Status:** in force.
- **Visible in:** `src/cli/rules.ts` (`mergeCors`), `src/cli/setup.ts` (`changes`, `describeChange`),
  `src/cli/setup-order.test.ts`, `src/cli/setup.test.ts`, `docs/guide/command.md#setup`.

### M11-R205: uploads need the preflights, `Retry-After` is advice, and `ETag` is not judged

- **Decision:** `api.checkBucket`, `cloudrop doctor` and `cloudrop setup` judge a bucket's CORS rules by what a page
  that uploads with cloudrop needs, in three grades.
  - **Required:** a rule answers every preflight of cloudrop's `PUT`s for the origin (`M11-R170`). Without it the
    check is a `problem`: "The bucket's CORS rules do not let <origin> upload: a browser there blocks every upload.
    Add a rule that allows PUT from there with the headers …, and expose Retry-After in it."
  - **Advice:** the rule that answers the `PUT` exposes `Retry-After`. Without it the check stays `ok`, its message
    names the rule and what to do, and the report carries the same words alone in a new optional field,
    `BucketCheck.advice`; `doctor` prints the `setup --apply` command after such a finding, as after a problem. With
    it the message is "Browsers on <origin> can upload and read Retry-After."
  - **Not judged:** `ETag`. A rule without it is `ok` with nothing said, and `setup` places and keeps its rule by
    `Retry-After` alone (`hidesRetryAfter` replaces `hidden` and `READ_HEADERS` in `src/server/bucket-cors.ts`).
  `setup` still writes `exposeHeaders: ["ETag", "Retry-After"]`, and the guide says why.
- **Why:** established from the client's code: of the bucket's answer to a `PUT` it reads the status, the body of an
  error and one header, `retry-after` (`src/client/bucket.ts` for `fetch`, `src/client/transport.ts` for XHR); no
  file under `src/client/**` reads `ETag`, and the server lists the parts and their ETags itself at `/complete`. Yet
  the check reported a `PROBLEM` for a rule that did not expose `ETag`, and the guide gave as the reason for exposing
  it that "only `checkBucket` needs it": the check required what nothing used, and said "a page cannot read them" of
  a header no page of cloudrop's reads. The rule keeps `ETag` for two reasons that are true: the rule 0.5.0 wrote has
  it, so an unchanged rule means a bucket set up then is found complete and is not rewritten; and other code on the
  page that sends a `PUT` to the bucket and reads the answer (an app's own `fetch`, an uploader that completes
  multipart uploads from the browser) needs it. `advice` is a field because `doctor` must know that an `ok` finding
  has something `setup --apply` would change without reading the sentence.
- **If wrong:** a bucket whose answering rule exposes neither header went from `problem` to `ok` with advice, so a
  script that waited for `problem` to notice a shadowed rule no longer does; `doctor`'s exit code for it is 0. In
  development the server logs problems only, so it no longer warns about such a rule. `BucketCheck.advice` is a new
  optional field of a public type. A later feature that reads `ETag` in the page would need the grade back.
- **Status:** in force. Amends `M9-C2`, `M11-R170` ("exposes `ETag`") and `M11-R171` ("without exposing `ETag` and
  `Retry-After`").
- **Visible in:** `src/server/bucket-cors.ts`, `src/server/bucket-check.ts`, `src/cli/rules.ts`, `src/cli/doctor.ts`,
  `src/server/bucket-check.test.ts`, `src/server/bucket-cors.test.ts`, `src/cli/setup-order.test.ts`,
  `docs/guide/bucket-setup.md` ("What any bucket needs", "Why the rule exposes ETag", "What checkBucket can tell
  you"), `docs/guide/command.md`, `docs/guide/troubleshooting.md`, `docs/guide/server.md` ("checkBucket"),
  `examples/next/README.md`.

### M11-R206: the examples' RustFS setup writes the lifecycle rule under the command's name

- **Decision:** `examples/next/scripts/setup-rustfs.ts` and `examples/hono/scripts/setup-rustfs.ts` name the lifecycle
  rule they write `cloudrop-abort-incomplete`, as `cloudrop setup` and the guide do (`M11-R175`). Each script
  replaces the bucket's lifecycle configuration when it runs, so the next `bun run setup:rustfs` leaves one rule under
  the new name.
- **Why:** the two scripts were the last place that wrote `abort-incomplete-uploads`, so a reader who ran an example
  and then `cloudrop doctor` or `setup --dry-run` against it met a second name for the one rule.
- **If wrong:** nothing depends on the name: the checks know the rule by what it does (`M11-R175`). A local RustFS
  bucket set up before keeps the old name until the script runs again.
- **Status:** in force. Completes `M11-R175`.
- **Visible in:** `examples/next/scripts/setup-rustfs.ts`, `examples/hono/scripts/setup-rustfs.ts`.

### M11-R207: the server guide's origin table has a row for each thing the rule refuses and accepts

- **Decision:** "What an origin is" in `docs/guide/server.md` says that `trustedOrigins`, `api.checkBucket` and the
  command's `--origin` share one rule, and its table gains three rows: a host no browser loads a page from
  (punctuation such as `$ ( ) &`, or an empty part), refused; a URL with a user name or password, refused without
  the value repeated; and plain origins that are accepted, an underscore and an address among them. The rows for a
  pattern, for `ws`, `wss` and `ftp`, and for an app's own scheme now carry the reason the message gives.
- **Why:** `M11-R176` (the host), `M11-R115` (the `@`) and `M11-R111` (one rule for all three callers) changed
  `src/server/origins.ts` and left the guide's table as it was. Each row was written from what `originProblem`
  answers for that value, run on 2026-11-21.
- **If wrong:** nothing: the table is prose, and `src/server/origins.test.ts` holds the rule.
- **Status:** in force. Completes `M11-R176`.
- **Visible in:** `docs/guide/server.md` ("What an origin is").

### M11-R208: the command's test fixture reads every printed Wrangler and AWS CLI command word for word

- **Decision:** every run of the command in a test (`run` in `src/cli/command-fixture.ts`) reads back each Wrangler
  and AWS CLI command in its output (`src/cli/printed-commands.ts`) and fails the test unless the command is plain
  POSIX shell words (plain text, single quotes and `\'`, as `commands.ts` quotes; no `$`, backtick, redirect, `;`,
  double quote or open quote) and, word for word, one of eight calls: `wrangler r2 bucket cors list|set <bucket>
  [--file cors.json]`, `lifecycle list <bucket>`, `lifecycle add <bucket> cloudrop-abort-incomplete
  --abort-multipart-days 1`, and `aws s3api get-bucket-cors`, `put-bucket-cors … --cors-configuration
  file://cors-s3.json`, `get-bucket-lifecycle-configuration` and `put-bucket-lifecycle-configuration …
  --lifecycle-configuration file://lifecycle.json`, each with `--bucket` and `--endpoint-url`. The bucket and the
  endpoint must be the run's own values or the placeholders, and a Wrangler command carries `--jurisdiction` exactly
  when the run named one. A checked command is then taken out, and the rest of the output is searched for every
  setting's value as before.
- **Why:** the fixture cut everything after `wrangler r2 bucket` or `aws s3api` off each line before it looked for
  setting values, so a wrong flag, a wrong file name, another bucket or a secret printed after a command passed every
  test; only `printed-values.test.ts` looked at the words, for the bucket and the endpoint. The calls are written in
  the checker apart from `instructions.ts` and `doctor.ts`, from the tools themselves: `wrangler r2 bucket … --help`
  of Wrangler 4.166 (`--file`, `--abort-multipart-days`, `-J/--jurisdiction`, the positional rule name), and the four
  `s3api` calls with their arguments accepted by aws-cli 2.39.3 against an endpoint that refuses the connection, which
  rejects an unknown option before it connects (both run 2026-11-21). Fault probes: `--path` for `--file` in
  `instructions.ts` failed 12 tests of the command, and `--endpoint` for `--endpoint-url` in `commands.ts` failed 11;
  both passed before.
- **If wrong:** a new command the output suggests needs its call in the checker, or every test that prints it fails:
  that is the point. A Wrangler command printed without its runner is not read as a command; its bucket name is then
  found by the search for setting values. The checker knows a bucket's and an endpoint's variable by its name ending
  in `BUCKET` or `ENDPOINT`, which holds for cloudrop's names and for the names the tests rename them to.
- **Status:** in force. Completes `M11-R177`.
- **Visible in:** `src/cli/printed-commands.ts`, `src/cli/printed-commands.test.ts`, `src/cli/command-fixture.ts`.

### M11-R209: `testBucket.object(key)` answers the key as it was last written

- **Decision:** the `key` of the object `testBucket().object(key)` answers is the stored form, the one `keys()` and a
  listing answer, whichever Unicode form the test asked by. `TestObject.key`, `TestBucket.object`, `TestBucket.keys`
  and the testing guide's table say so.
- **Why:** since `M11-R26` the fake keeps one object for a key's NFC and NFD forms and lists the form last written, as
  R2 does, and `object()` takes either form; but it answered the key it had been asked by. Reproduced: an object
  written under `cafe` + U+0301 and asked for by its NFC form answered the NFC key, while `keys()` answered the NFD
  one, so a test comparing the two saw two keys for one object.
- **If wrong:** a test that asked by one form and compared `object(key).key` with what it asked sees the stored form
  now. For keys in one form, every key cloudrop itself makes, nothing changes.
- **Status:** in force. Completes `M11-R26`.
- **Visible in:** `src/testing.ts`, `src/testing.test.ts`, `docs/guide/testing-your-app.md`.

### M11-R210: two tests that proved less than they said now prove it

- **Decision:** `api.deletePrefix`'s case for a key listed in another Unicode form of its prefix (`M9-H6`) runs on
  the fake R2: a key written in NFD, deleted by its NFC prefix, with a neighbouring key left in the bucket. The
  boundary cases of `r2()` and `s3()` bucket names (`a1b`, 63 characters, a dot for S3) assert the path of a URL the
  driver signs, `/<bucket>/a.txt`, where they asserted only that nothing was thrown.
- **Why:** the `deletePrefix` case stubbed `list` and `deleteMany`, so it proved what the code does with a listing the
  test invented; since `M11-R26` the fake answers as R2 was measured to, and the test now fails when the comparison
  of key and prefix stops folding the forms (fault probe: `key.startsWith(prefix)` without `normalize`, red). A
  `not.toThrow()` passes for a preset that accepts a name and then addresses another bucket.
- **If wrong:** nothing: tests only.
- **Status:** in force.
- **Visible in:** `src/server/api.test.ts`, `src/storage/presets-settings.test.ts`.

### M11-R211: the doctype pattern reads a doctype that never ends once

- **Decision:** the doctype part of `PROLOG_ITEM` (`src/plugins/sniff-text.ts`) is
  `<!doctype[^[>]*(?:\[[\s\S]*?\]\s*)?>`: the blanks before `>` belong to the name part, and only an internal
  subset is followed by blanks of its own. It matches what the old pattern matched.
- **Why:** the old pattern, `<!doctype[^[>]*(?:\[[\s\S]*?\])?\s*>`, had two neighbouring parts that both match a
  blank, so for `<!doctype` followed by blanks and no `>` it tried every split of the run. Measured on Node 24,
  2026-11-21: 6.8 ms for the 4,096 bytes the plugin reads, 91 ms for 16,000 characters and 1,435 ms for 64,000, four
  times the time for twice the length; after the change 0.08 ms, 0.25 ms and 1 ms. A `/complete` of such a file held
  the server's thread for 7 ms, which is 140 files a second for one core. The other patterns of the file were
  measured the same way and are linear: a comment, a processing instruction, a tag name and a prefixed name that never
  end, and a doctype whose subset's `]` is never followed by `>`. Both patterns gave the same answer for 400,000
  random strings of `[ ] > < ! "`, blanks and a letter after `<!doctype`.
- **If wrong:** the test bounds one read of 64,000 characters at 250 ms, between the 1 ms of a linear read and the
  1.4 s of a quadratic one; a machine 200 times slower than this one would fail it for a linear pattern.
- **Status:** in force for the bound and its test. Amended by `M11-R220`: the doctype is no longer one pattern but
  is read part by part.
- **Visible in:** `src/plugins/sniff-text.ts`, `src/plugins/sniff-text.test.ts`.

### M11-R212: the ZIP walk reads data descriptors with 8-byte sizes

- **Decision:** `afterStreamed` (`src/plugins/sniff-containers.ts`) takes a local file header for the next entry when
  a data descriptor ends before it in either form of PKWARE APPNOTE 6.3.10 §4.3.9: two sizes of 4 bytes, or two of 8
  in ZIP64 format (§4.3.9.2), each with or without the signature. For the 8-byte form the lower half of the
  compressed size must be the distance from the entry's data and the upper half zero, which is every entry that fits
  in the bytes read. The form is not chosen by the header's ZIP64 extra field, as §4.3.9.2 would have it: both are
  tried.
- **Why:** `M11-R132` left these out because "a writer uses them for entries of 4 GiB". The APPNOTE says ZIP64 format
  "MAY be used regardless of the size of a file", and two writers do, read from their sources on 2026-11-21. Apache
  POI's `SXSSFWorkbook`, the streaming writer for large workbooks, has `zip64Mode = Zip64Mode.Always` ("Always became
  the default in POI 5.0.0") and then writes through its own `Zip64Impl`: `writeLFH` puts version 4.5, flag bit 3,
  zero sizes and no extra field, and `writeDAT` the signature, the crc-32 and two 8-byte sizes. Apache Commons
  Compress's `ZipArchiveOutputStream` with `Zip64Mode.Always` writes `FF FF FF FF` for both sizes in the header, a
  ZIP64 extra field, and 8-byte sizes in `writeDataDescriptor` when the entry has that field. Reproduced with entries
  built as each writes them: the walk stopped at the first entry, so every such `.xlsx` read as a plain ZIP. POI's
  header has no extra field, so the header cannot say which form follows; trying both is what reads its files.
- **If wrong:** two more byte patterns can make an entry's data look like the end of the entry: the worst outcome is
  still a ZIP read as an Office file, as in `M11-R132`. A ZIP64 entry from a writer that can seek back, with
  `FF FF FF FF` in the header, no bit 3 and its real sizes in the ZIP64 extra field (Commons Compress with
  `Zip64Mode.Always` on a file), still ends the walk, and such a file reads as a plain ZIP: reading that field did not
  fit in the entry's 6 kB (5.96 kB with this change, 5.89 kB before).
- **Status:** in force. Amends `M11-R132` ("ZIP64 descriptors (8-byte sizes) are not read"). Amended by `M11-R221`:
  the ZIP64 extra field of an entry from a writer that can seek back is read.
- **Visible in:** `src/plugins/sniff-containers.ts`, `src/plugins/sniff-zip.test.ts`, `src/testing/file-samples.ts`,
  `docs/guide/plugins.md`.

### M11-R213: an earlier decision that a review entry changed says so in its own status line

- **Decision:** every entry that a `M11-R` entry amends, supersedes or reverses now names that entry in its own
  status line, with what changed: `M11-K2` (`M11-R133`), `M11-K3` (`M11-R137`), `M11-C4` (`M11-R110`), `M9-C2`
  (`M11-R170`, `M11-R205`), `M9-C6` (`M11-R171`, `M11-R205`), `M9-C8` (`M11-R112`, `M11-R115`), `M9-H100`
  (`M11-R115`), `M3-U30` (`M11-R81`), `M3-U31` (`M11-R80`), `M3-U55` (`M11-R90`), `M3-U94` (`M11-R201`), `M4-F1`
  (`M11-R91`), `M5-T101` and `M5-T102` (`M11-R92`), `M11-R80` (`M11-R92`, `M11-R200`), `M11-R89` (`M11-R90`,
  `M11-R201`).
- **Why:** a reader who opens `M11-K2` reads that `detected` decides a refusal, and nothing there said that
  `M11-R133` changed it for containers; the pointer stood only in the later entry. `M3-U55` still said it was "in
  force for a resumed upload that starts over", which `M11-R90` ended. Found by reading the status line of each of
  the 105 `M11-R` entries for "amends", "supersedes", "reverses", "replaces" and "corrects", and looking in each
  entry they name for the id of the entry that names it: 18 pairs had none, and all have one now.
- **If wrong:** an entry changed by a later one whose status line uses other words than those five is not found by
  that reading; `M11-R136` ("two sentences corrected" in `m10-content.md`) edited its target's text instead, which
  needs no pointer.
- **Status:** in force.
- **Visible in:** `docs/decisions/m11-content.md`, `m11-command.md`, `m9-cli.md`, `m9-hardening.md`, `m3-uploader.md`,
  `m4-dx.md`, `m5-store.md`, `m11-review.md`.

### M11-R214: the store guide's `deleteFile` row names the `NOT_FOUND` of a file that completes during the call

- **Decision:** the row for `deleteFile` in `docs/guide/store.md` ("File operations") says that `NOT_FOUND` is also
  the answer for a file whose completion is recorded while the call runs, that the file then stays completed with its
  object, and that a second call deletes it.
- **Why:** `M11-R150` changed that answer and left the row saying `NOT_FOUND` "for a file that never completed", which
  such a file is not by the time the caller reads the answer.
- **If wrong:** nothing: one row, and `src/server/store-delete-race.test.ts` holds the behaviour.
- **Status:** in force. Completes `M11-R150`.
- **Visible in:** `docs/guide/store.md` ("File operations").

### M11-R215: `eraseOwner` counts a file created within the grace before the run as begun during it

- **Decision:** the last read of `api.eraseOwner` keeps the run from `done` when the owner's newest file was created
  at or after the run's start less `graceMs` (`created < startedAt - graceMs` is the only case that goes on to the
  last read of the live statuses). Nothing else changed.
- **Why:** each server stamps a row with its own clock, and the run compared `created_at` with its own start to tell
  whether an upload had begun while it went on. Reproduced with two clocks: an upload taken and cancelled, during
  the run and after the run had read the aborted files, by a server whose clock lagged by one second or by two
  minutes got a `created_at` before the run's start, was never live when the run read the live statuses, and the run
  answered `done: true` with the cancelled upload's object still in the bucket. With equal clocks, and with the
  other clock ahead, the same run answered `done: false`. The margin is the grace because that is the difference the
  store's times already allow between servers: the sweep and every "settled" check compare one server's clock with
  times another wrote, and rest on the grace being "minutes, far above normal skew" (`docs/guide/store.md`, "Clock
  skew"). It costs no run its `done`: a file the passes saw that was created within the grace is waiting in that run
  anyway, since an ended file's key is checked for the last time no sooner than 15 minutes plus the grace after it
  was created (`settledAt`), and a live one waits by itself; so the margin decides only for a file the passes did
  not see.
- **If wrong:** two servers whose clocks differ by more than `graceMs` (at least 15 minutes, 1 hour by default) can
  still hide such an upload from the run; a server that far from the storage service's clock cannot sign a request
  it accepts, so it can start no multipart upload, and its single-`PUT` URLs expire as they are made. A run that
  lasts longer than 15 minutes can check such a young file's key for the last time and still count the file as
  waiting; the next run reports `done`. The "Clock skew" paragraph of `docs/guide/store.md` still names only a clock that runs ahead; it was outside this
  change.
- **Status:** in force. The guide's "Clock skew" paragraph names the lagging clock since `M11-R223`.
- **Visible in:** `src/server/erase.ts` (`lastReads`), `src/server/erase-clocks.test.ts`.

### M11-R220: a doctype ends where an XML parser ends it, and one still open after 4 KiB is XML

- **Decision:** `rootElement` (`src/plugins/sniff-text.ts`) reads a doctype by the grammar of XML 1.0 §2.8
  (`doctypedecl`, `intSubset`): part by part, where a part is a quoted literal in either quote (§2.3), a comment
  (§2.5), a processing instruction (§2.6) or one character, and the doctype ends at the first `>` that is in none of
  them and not inside the brackets of its internal subset. Three rulings go with it.
  1. **Both parsers are asked when there is no `<?xml`.** An HTML parser ends a doctype at its first `>`, inside
     quotes and brackets too (HTML Standard §13.2.5, the DOCTYPE states). Such a document is read both ways and the
     root either reading finds decides: `svg` is an SVG, one of the fifteen elements or `html` a web page. A
     document that opens with `<?xml` is read as XML only, as `M11-R131` already has it for the fifteen elements.
  2. **A doctype still open where the text ends is `application/xml`,** with or without `<?xml`, unless the HTML
     reading found a root or the text opens with `<!DOCTYPE html`. A comment that fills the read is a web page
     (`M10-K12`, `M11-R131`) because browsers sniff `<!--` as HTML; they sniff no other doctype as anything, and the
     only parser that reads on to a root is an XML one, so the file is what it can still be: an XML document. It is
     refused unless sent as an XML type the route names, where an SVG sent as `image/svg+xml` passes as before.
  3. **The ceiling of `cloudrop/plugins` goes from 6 to 7 kB, provisional until the owner confirms it.** The entry
     measured 5.96 kB before and 6.16 kB with this change.
- **Why:** the doctype was one pattern, `<!doctype[^[>]*(?:\[[\s\S]*?\]\s*)?>`, which ended an internal subset at
  the first `]` before `>` and a doctype without one at the first `>`, wherever they stood. Reproduced:
  `<!DOCTYPE x [<!ENTITY a "]>">]><svg onload=…>` showed no type, and `application/xml` behind `<?xml ?>`; the same
  with single quotes, with `]>` in a comment or a processing instruction of the subset, and with `>` in a system
  identifier (`<!DOCTYPE x SYSTEM "a>b"><svg>`). Sent as `text/plain` such a file was kept. A doctype whose subset
  ran past the 4 KiB read showed no type either. A pattern cannot be told "a part that opens and never closes ends
  the read" without backtracking into another reading of the parts before it, so the parts are matched one at a
  time, each once: the worst 4,096 characters measured (blanks, `] ` pairs, `<!-` runs) take 0.08 ms in
  `doctypeEnd` and 0.4 ms through `sniffText`, 64,000 take 2.3 ms, and Adobe Illustrator's doctype with two
  entities 1.2 µs (Node 24, 2026-11-21). Reading only as XML would have lost
  what the old pattern found by accident: `<!DOCTYPE x "><script>alert(1)</script>"><y>` is a web page to an HTML
  parser and has root `y` to an XML one. The entry's 40 bytes of room cannot hold a second reading of a grammar;
  nothing else in the entry was shortened to make room.
- **If wrong:** a document without `<?xml` whose entity value holds `>` followed by one of the fifteen tags or
  `<svg` (`<!ENTITY a "<i><b>x</b></i>">`) is refused as the web page or SVG an HTML parser makes of it. A file
  that is nothing but the start of a doctype (`<!DOCTYPE x`) now reads as XML where it showed no type. A declared
  XML document that is not well-formed and hides a tag behind a quoted `>` (`<?xml ?><!DOCTYPE x "><svg>"><y>`) reads
  as XML, not SVG: an XML parser refuses it, and a route that names an XML type takes documents with scripts
  anyway. `deny: ["image/svg+xml"]` does not see an SVG whose doctype outlasts the read on a route that names another
  XML type; the guide's Limits say so.
- **Status:** the 7 kB ceiling, which the owner confirmed for 0.6.0 (2026-11-21), superseded by `M12-P1`; the doctype
  ruling stays in force. Amends `M11-R211` (the doctype
  pattern). `M11-R258` extends ruling 2 to a root hidden behind what follows the doctype, and ruling 1 to a
  processing instruction. `src/plugins/sniff-text.test.ts` has each bypass with each quote, a comment and a processing instruction,
  each kind of doctype that outlasts the read, and both parsers' readings; `src/plugins/sniff-fuzz.test.ts` builds
  2,000 doctypes from the grammar's productions and finds the root after each.
- **Visible in:** `src/plugins/sniff-text.ts`, `src/plugins/sniff-text.test.ts`, `src/plugins/sniff-fuzz.test.ts`,
  `src/plugins/content-checks.test.ts`, `scripts/size-limit.config.ts`, `docs/guide/plugins.md`.

### M11-R221: the ZIP walk reads an entry's size from its ZIP64 extra field

- **Decision:** when a local file header gives `FF FF FF FF` as its compressed size, `zipEntries`
  (`src/plugins/sniff-containers.ts`) walks the header's extra fields and takes the size from the ZIP64 extended
  information extra field, header ID `0001`: 8 bytes, behind the 8 of the uncompressed size (PKWARE APPNOTE 6.3.10
  §4.5.3, which says the field in a local header "MUST include BOTH original and compressed file size fields"). Both
  halves count, so an entry of 4 GiB or more ends the walk as before; so does `FF FF FF FF` with no such field. An
  entry with bit 3 is still followed by its data descriptor (`M11-R132`, `M11-R212`).
- **Why:** `M11-R212` left this case open for want of room in the entry's 6 kB, and `M11-R220` raised that ceiling.
  Reproduced with the bytes Python 3.14's `zipfile` writes for `ZipFile.open(name, "w", force_zip64=True)` on a file
  (measured 2026-11-21: version 4.5, no bit 3, both sizes `FF FF FF FF`, an extra field `01 00 10 00` with the two
  sizes) and that `M11-R212` reads from Apache Commons Compress's source for `Zip64Mode.Always` on a file: the walk
  stopped at the first entry, so a Word file written that way read as a plain ZIP: sent as its Office type it passed
  only by `M11-R133`'s rule for a ZIP that names no package, and `detected` never named it as the Word file it is.
- **If wrong:** a field shorter than its 16 bytes, or lengths that lead the walk of the fields astray, give a size
  the file did not mean; the next entry is then looked for in the wrong place, and the worst outcome is still a ZIP
  read as an Office file or the other way round, as in `M11-R132`. `cloudrop/plugins` measures 6.27 kB with this
  change, 6.16 kB before, under the ceiling `M11-R220` set provisionally.
- **Status:** in force. Amends `M11-R212` ("A ZIP64 entry from a writer that can seek back ... still ends the walk").
- **Visible in:** `src/plugins/sniff-containers.ts`, `src/plugins/sniff-zip.test.ts`, `src/plugins/sniff-fuzz.test.ts`,
  `src/testing/file-samples.ts`, `scripts/size-limit.config.ts`, `docs/guide/plugins.md`.

### M11-R222: a name the key cannot hold refuses that file, when the route put the name in the key

- **Decision:** `/upload` judges the key a route's `prefix` or `key` function built a second time, with the name's
  share of the trouble replaced (`keyForFile`, `src/server/key.ts`): each control character of the key that the
  file's name has too, and, when the name has a `.`, a `..` or an empty part between slashes, each such part of the
  key. When the key is then usable, the name alone made it unusable, and that file is rejected in its own ticket
  with `INVALID_INPUT`: "This file's name has a control character (U+000D), which this upload cannot store. Rename
  the file, then add it again.", or "has a "." or ".." part, or an empty part beside a "/"". The message gives the
  first control character's code point and never the name. The request's other files go on, with or without a
  store, and no row is reserved for the refused file. A key that is still unusable is the route's bug as before: a
  `TypeError`, `SERVER_ERROR` (HTTP 500), and the log names what is wrong without the name's share. What a name may
  put into a key, by character:

  | In the name | In a key built from it |
  | --- | --- |
  | CR, LF, TAB, DEL, U+0085 and every other control character (Unicode `Cc`) | that file refused |
  | the names `.` and `..`, a leading, trailing or doubled `/` | that file refused |
  | a `/` between two parts | kept: a folder |
  | `\`, a no-break space, U+2028, a leading or trailing space or dot | kept as sent |
  | NUL, a lone surrogate | refused before the key is built (`M11-R196`) |

- **Why:** reproduced through the real handler on the fake R2, stateless and with the memory store: on a route with
  ``key: ({ userId, file }) => `users/${userId}/${file.name}` ``, a request of `first.txt` and `Icon\r` was answered
  `SERVER_ERROR`, HTTP 500, not retryable, for both files (0.5.0 did the same, by `M11-R196`). `Icon\r` is the name macOS gives a
  folder's icon file, so dropping a folder on such a route failed every file in it. `normalizeKey` is right to refuse
  the key and never rewrites one (two names would share a key); what was wrong is whose mistake it was read as. The
  route's part of a key is the same for every name, so a route that is itself wrong still fails for plain names and
  is found; the name's part is tested by what the name itself has, which also covers a name the route changed on the
  way (`file.name.toLowerCase()`, a `prefix` built from it). The default key takes only `[a-z0-9]{1,16}` of the
  name's extension, so every name in the table gets a ticket there, and the stored `Content-Disposition` carries
  each name as `M11-R196` says: `filename` with `_` for what is not printable ASCII, `filename*` percent-encoded
  (`a%C2%A0b.txt`, `%20a.txt%20`, `a%2Fb.txt`).
- **If wrong:** a route whose own part of the key has an empty or dot part, or a control character, answers a name
  that has the same with `INVALID_INPUT`, not a 500; every plain name still gets the 500 that shows the bug. Two things a name can still do
  to a key stay the route's bug: a key over 1024 bytes (a name of 255 four-byte characters is 1020 bytes; ext4 and
  APFS cap a real name at 255 bytes and NTFS at 255 UTF-16 units, 765 bytes) and a lone surrogate a route makes by cutting a name inside a character
  (`file.name.slice(0, 50)`). A `prefix` that starts with `/` because the name does is refused as the route's, by
  the check that runs before the key is built. A route that wants `/` or `\` out of its keys replaces them itself.
- **Status:** in force. Settles the case `M11-R196` left open. `src/server/upload-name-keys.test.ts` runs each row
  of the table through the handler, stateless and with the memory store.
- **Visible in:** `src/server/key.ts` (`keyForFile`), `src/server/upload-request.ts` (`prepareFile`),
  `src/server/upload-name-keys.test.ts`, `docs/guide/server.md`.

### M11-R223: the store guide names the lagging clock and the `/complete` of an upload the bucket no longer has

- **Decision:** two passages of `docs/guide/store.md` say what the code does. "Clock skew" (Known costs) now says
  how `eraseOwner` tells an upload that began during a run (the time in its row, written by the server that took
  the upload), what a clock that runs ahead does (delays `done`), what a lagging one does (its upload looks older
  than the run), what a run does about it (the owner's newest file created up to `graceMs` before the run started
  counts in `waiting`, `M11-R215`), and where that stops (clocks more than `graceMs` apart). "What changes for the
  client" has a bullet for a `/complete` whose multipart upload the bucket no longer has (`M11-R200`): the answer
  `NO_SUCH_UPLOAD`, the row `rejected`, its bytes released, `onAbort` with `"rejected"`, `UPLOAD_EXPIRED` for a later
  `/complete`, and the two rows that are not ended (one whose finished object the bucket holds, one another request
  is completing). No code changed.
- **Why:** `M11-R215` left the paragraph naming only a clock that runs ahead ("it was outside this change"), and the
  list of what `/complete` answers with a store had every refusal but the one `M11-R200` added. Each sentence was
  read against `lastReads` (`src/server/erase.ts`), `uploadGone` (`src/server/complete-verify.ts`) and the three
  cases of `src/server/store-complete-gone.test.ts`. The bullet says the upload was aborted "behind the server": an
  `/abort`, the sweep and `revokeUploads` end the row first, and a `/complete` of an ended row answers
  `UPLOAD_EXPIRED` without asking the bucket.
- **If wrong:** none; the text follows the code and its tests.
- **Status:** in force.
- **Visible in:** `docs/guide/store.md` ("Known costs", "What changes for the client").

### M11-R230: text the URL parser refuses is no origin, under any scheme

- **Decision:** `originProblem` (the server's `trustedOrigins` and `api.checkBucket`, and the command's `--origin`)
  accepts nothing the URL parser refuses. An `http` or `https` origin is valid only as the parser's own origin of the
  text, as in 0.5.0, less the hosts and patterns `M9-H100` and `M11-R176` refuse. `ws`, `wss`, `ftp` and `file` are
  never origins. Only a URL the parser reads and gives the origin `null` may be an app's own scheme (`M11-R41`), and
  then only as the text the parser writes for it, so its port is at most 65535 and has no leading zeros
  (`app://localhost:08100` is refused with `Use app://localhost:8100`). Text written as `scheme://host[:port]` that
  the parser refuses is answered "is not an origin: its host or port is not valid. Check the host's spelling and that
  the port is at most 65535."; `ws`, `wss` and `ftp` text keeps "is not a page's origin", and any other text keeps the
  message it had.
- **Why:** since `M11-R41` a string the parser refused fell through to the pattern for an app's own scheme, which
  excluded only `file:`. So `https://app.example.com:99999`, `http://localhost:80800`, `https://1.2.3.4.5`,
  `ws://256.1.1.1` and `ftp://999999999999` were origins; 0.5.0 refused all five. A port typo in `trustedOrigins`
  started the server silently with an entry no request matches, and `--origin` wrote a CORS rule that allows nobody.
  The parser's refusal is the evidence: a browser builds a page's origin with the same parser, so it can send none of
  these. Checked by a property test against 0.5.0's rule (`URL.canParse(o) && new URL(o).origin === o`) over
  generated `http` and `https` text: of 400,000 samples 31,756 were accepted by 0.5.0 and 368,244 refused, the new
  rule agrees on every one and accepts each as the same text, and the rule before this entry accepted 13,977 of the
  refused ones. The generator leaves out `*`, the punctuation `M11-R176` names and empty labels, which 0.5.0 took and
  those two entries refuse on purpose.
- **If wrong:** a webview that sends an origin with a port over 65535 or with leading zeros is refused at start-up
  and by the command; the URL standard allows neither. The new sentence names the port's limit for a host typo too
  (`https://1.2.3.4.5`), which reads past the fault.
- **Status:** in force. Amends `M11-R41` (the pattern alone no longer decides) and `M11-R111`.
- **Visible in:** `src/server/origins.ts`, `src/server/origins.test.ts`, `src/server/origins-fuzz.test.ts`,
  `docs/guide/server.md#what-an-origin-is`.

### M11-R231: the store guide gives Drizzle its driver as `{ client }`

- **Decision:** the Drizzle setup block of `docs/guide/store.md` reads
  `const pool = new Pool({ … }); const db = drizzle({ client: pool });`, and a paragraph under it says which form each
  line of drizzle-orm takes: `{ client }` on both for node-postgres, postgres.js, better-sqlite3 and libsql; the driver
  alone (`drizzle(pool)`) on 0.45 only; and for D1 the binding alone (`drizzle(env.DB)`) on both.
- **Why:** the block was `drizzle(new Pool({ connectionString }))`. On drizzle-orm 1.0.0-rc.5, the line the next
  bullet recommends, that is `TS2345` (a `Pool` is not a `string` or a configuration), and run from JavaScript Drizzle
  builds a pool of its own: `drizzle(pool).$client === pool` is `false` and its options hold no connection string, so
  `drizzleStore` would use a database the app never named. Measured on 2026-11-21 by type-checking both forms for the
  five drivers against the workspace's 1.0.0-rc.5 and against 0.45.4 in a copy with its own install (the method of
  `scripts/check-drizzle-versions.sh`): `{ client }` passes eight of eight for the four drivers above, the driver
  alone passes on 0.45.4 and fails on rc.5 for all four, and D1 takes only the binding on both. Every `ts` block of the
  guide, 25 of them, was then written out as a module with only the names the prose around it supplies and
  type-checked against the workspace's types (23 with Node's types, the two Worker blocks with
  `@cloudflare/workers-types`, the Prisma block against the client `test:db` generates); the six blocks that use
  Drizzle were checked against 0.45.4 as well. The setup block was the only one that failed. Five deliberate faults
  in a copy of the blocks were all reported, so the check reads them.
- **If wrong:** a later 1.x release candidate may change the forms again; the check is not a gate, so nothing would
  say so. The same call stands in the adapter's own text, which this entry did not change: the usage example of
  `src/adapters/drizzle.ts`, two comments, and the message that refuses a single `Client`
  (`src/adapters/drizzle/postgres.ts`).
- **Status:** in force.
- **Visible in:** `docs/guide/store.md` ("Drizzle: `cloudrop/adapters/drizzle`").

### M11-R232: where cloudrop's CORS rule goes is said once, in the same words, in both guides and in the command's output

- **Decision:** `docs/guide/bucket-setup.md`, `docs/guide/command.md` and the instructions `cloudrop setup` prints all
  give the rule the code follows (`place` in `src/cli/rules.ts`): cloudrop's rule goes before any rule that allows
  `PUT` from your origins without exposing `Retry-After`; a rule for another origin, or one that answers uploads in
  full, can stay in front. `bucket-setup.md` describes `setup --apply` with `command.md`'s sentence (a new
  `cloudrop-uploads` goes last, an existing one stays, unless an earlier rule allows `PUT` from one of your origins
  without exposing `Retry-After`) and links to it. The printed instruction reads "Put cloudrop's rule before any rule
  you keep that allows PUT from <origins> without exposing Retry-After, such as an old rule for every origin ("*")."
- **Why:** `bucket-setup.md` said "Put cloudrop's rule before any rule that also allows `PUT` from your origins.
  `cloudrop setup --apply` does that", which it does not since `M11-R171`: a new rule goes last, behind a rule that
  answers uploads in full, and `M11-R205` made `Retry-After` the one header that decides. A reader who compared the
  guide with a `--dry-run` saw the command leave its rule behind another and could not tell which was wrong. The
  by-hand advice asked for more than the command does, and following it moves `GET` and `HEAD` from those origins to
  cloudrop's rule for no gain.
- **If wrong:** a person who writes the file by hand now has to read a rule's exposed headers to place cloudrop's;
  putting it first is still always right, and the guide's paragraph above the sentence says why.
- **Status:** in force. Amends the wording of `M11-R171`'s by-hand instruction.
- **Visible in:** `docs/guide/bucket-setup.md` ("What any bucket needs", "When the bucket has other CORS rules"),
  `docs/guide/command.md#setup`, `src/cli/instructions.ts`, `src/cli/setup-order.test.ts`.

### M11-R233: the errors guide names `allFiles`, both bounds of `graceMs` and the `NOT_FOUND` of a file that completes during the call

- **Decision:** `docs/guide/errors.md` was read against `src/errors.ts`, `src/server/http.ts` and the argument checks
  of the store calls, and four rows changed. "Database store file API errors" lists `allFiles` among the calls and
  says it also answers `INVALID_CONFIG` for a store written by hand without `listAll`. Its `NOT_FOUND` row has the
  file whose completion is recorded while `deleteFile` runs, and what to do (call again), as `docs/guide/store.md`
  has since `M11-R214`. Its `INVALID_INPUT` row gives `graceMs` both bounds (15 minutes to 30 days, `M11-R63`) and
  names the checks it left out: NUL and a lone surrogate in an id or owner, the options of `files` and `allFiles`
  (the `owner` key that is `undefined` among them, `M11-R195`), the sweep's `cursor` and `signal`. The endpoint
  table's `INVALID_INPUT` row says which case refuses one file and lets the rest of the `/upload` go on (`M11-R196`,
  `M11-R222`) and names `/abort`'s `keep` (`M11-R201`).
- **Why:** each is a thing 0.6.0 added or changed that the page did not say, and the page is where a developer reads
  a code from a log. Every status in the endpoint table was compared with `STATUS` in `src/server/http.ts`, and every
  code the source constructs with the page: all agree, and what the handler sends a client (`code`, `message`,
  `retryable`, `parts`, `content`) is stated as `errorBody` does it.
- **If wrong:** none; the text follows the code.
- **Status:** in force.
- **Visible in:** `docs/guide/errors.md` ("Upload endpoint errors", "Database store file API errors").

### M11-R234: the command repeats a refused `--origin`, a `--var` setting and the command word only when they cannot be a secret

- **Decision:** three more places printed back what was typed, and each now follows `M11-R115`'s rule that text is
  repeated only when its shape says what it is.
  - **`--origin`:** a refused value is repeated only when it is written as an origin, `scheme://host[:port]` with at
    most a last `/`. Any other is named by its number: "--origin number 2 is not an origin. Use
    https://app.example.com: an origin is the scheme, host and port, with no path. Its value is not repeated here, in
    case it holds a secret: only text written as scheme://host[:port] is." A value with an `@` keeps `M11-R115`'s
    sentence. `originProblem` takes the name to use in the value's place as a second argument; the server's
    `trustedOrigins` and `api.checkBucket` pass none and repeat as before.
  - **`--var`:** what stands before `=` is repeated only as a setting's name: one that starts with `CLOUDROP_`, or
    one within two edits of a setting. Any other name-shaped word is "what stands before "="".
  - **The command:** the first argument is never repeated. `Unknown command "check"` is gone; every word that is no
    command answers "The first argument is not a command. Use doctor or setup."
  The guide lists the five rules and the one case the command cannot tell apart: the place of a variable's name in
  `--var`, on either side of `=`.
- **Why:** the guide said "The command never prints a secret" and named one exception, and the output goes to
  terminals and CI logs. A URL with a path or a query is what a presigned URL and a webhook URL with a token are, and
  `--origin <such a URL>` printed it whole; the correction it is answered with holds scheme, host and port alone, so
  nothing is lost by leaving the value out. A name-shaped word before `=` in `--var` is what an AWS access key ID is
  (`AKIA` and sixteen letters and digits). A word of at most 20 letters is what MinIO's default key ID is
  (`minioadmin`), and an AWS key ID has no digit about once in thirty, so `M11-R115`'s "a word of letters typed as
  the command is still repeated" printed key IDs the guide promises never to print. Repeating the command word told
  the person nothing they could not see on their own command line.
- **If wrong:** an honest typo loses its echo: `--origin localhost:3530` and `--origin null` are named by number, and
  `cloudrop docter` is not repeated. The server's messages still repeat a `trustedOrigins` entry without an `@`,
  whatever its shape: it is written in code, not typed at a prompt, and its tests and guide table were left as they
  are.
- **Status:** in force. Amends `M11-R115` (the command word, and which origins are repeated) and `M11-C3`.
- **Visible in:** `src/cli/args.ts`, `src/cli/vars.ts`, `src/server/origins.ts`, `src/cli/run.test.ts`,
  `src/cli/vars.test.ts`, `docs/guide/command.md#settings`.

### M11-R235: `--version` and `-v` work wherever `--help` does

- **Decision:** `--version` or `-v` prints the package's version and exits 0 as the first argument or wherever an
  option's name can stand, after a command and its options too (`cloudrop doctor --version`). As the value of an
  option that takes one it is that value (`--env-file -v` reads a file named `-v`). With help asked for as well, the
  usage is printed.
- **Why:** the version was read only as the first argument, so `cloudrop doctor --version` answered
  `Unknown option "--version". The options are listed below.` above a usage that lists `-v, --version` among the
  options, with exit code 2. The usage was right about what a person expects; the code now does it, by the rule
  `M11-R174` gave help.
- **If wrong:** a script that passed `-v` after a command and relied on exit code 2 now gets 0; none is known.
- **Status:** in force. Extends `M11-R174`.
- **Visible in:** `src/cli/args.ts`, `src/cli/run.test.ts`, `docs/guide/command.md`.

### M11-R236: `setup` and the bucket check judge a lifecycle rule by one predicate

- **Decision:** `abortsEverywhere` lives in `src/server/bucket-check.ts`, and `mergeLifecycle` (`src/cli/rules.ts`)
  imports it; the command's own copy is gone. A rule counts when it is enabled, aborts incomplete multipart uploads
  and has no prefix. `src/cli/setup.test.ts` has the case the command lacked: beside a rule that aborts uploads only
  under `tmp/`, `setup --apply` adds `cloudrop-abort-incomplete`.
- **Why:** the two copies said the same thing, and only the check's was tested. With `rule.prefix === ""` taken out
  of the command's copy all 870 tests of `src/cli` and of the check passed: `setup` would have left a bucket whose
  only abort rule covers one prefix as it was and reported "already aborts incomplete multipart uploads", while
  `doctor` reported the problem `setup` then could not fix. The new test fails on that fault, and with the one
  predicate the check's own test fails on it too.
- **If wrong:** none; behaviour is unchanged.
- **Status:** in force.
- **Visible in:** `src/server/bucket-check.ts`, `src/cli/rules.ts`, `src/cli/setup.test.ts`.

### M11-R237: a bucket that does not exist is reported by its variable, and on R2 with the jurisdiction

- **Decision:** when the listing answers `404 NoSuchBucket`, `doctor` and `setup --apply` print the command's own
  sentence in place of the storage's "Check the bucket name in your configuration":
  - R2: "The bucket does not exist. Check CLOUDROP_R2_BUCKET, the bucket's name. A bucket in a jurisdiction also
    needs --jurisdiction."
  - R2 with `--jurisdiction eu`: "The bucket does not exist in the eu jurisdiction. Check CLOUDROP_R2_BUCKET, the
    bucket's name, and that the bucket is in that jurisdiction."
  - S3: "The bucket does not exist. Check CLOUDROP_S3_BUCKET, the bucket's name, and that CLOUDROP_S3_ENDPOINT is the
    service the bucket is on."
  Each name is the app's own under `--var`. The library's message for the same answer is unchanged.
- **Why:** confirmed from the tests that pinned it: the line named no variable, where every other line of the bucket
  check does (`M9-H101`), and under `--var` "your configuration" pointed nowhere. It also said nothing of the
  jurisdiction, while the refusal beside it does ("A bucket in a jurisdiction also needs --jurisdiction") and
  `src/cli/bucket-access.ts` says R2 answers a bucket of another jurisdiction "as missing or refused": the person
  whose bucket is in the EU jurisdiction and who left the option out was told to check a name that was right.
- **If wrong:** what R2 answers for a bucket of another jurisdiction was not measured here, on the owner's
  instruction not to ask a real bucket; the sentences advise a check and assert nothing about that answer. If R2
  answers such a bucket otherwise (a refusal), that path already carries the same hint.
- **Status:** in force. Extends `M9-H101` and `M11-R116`.
- **Visible in:** `src/cli/bucket-access.ts`, `src/cli/doctor.test.ts`, `src/cli/variables.test.ts`.

### M11-R238: records that 0.6.0 left behind say what is true today

- **Decision:** eight records were corrected, none of them a rule.
  - `docs/decisions/m11-command.md`: `M11-C2`, `M11-C4` and `M11-C5` name the files that hold the code today
    (`src/cli/usage.ts`, `cloudropCommand` in `src/cli/commands.ts`, `readVariables` in `src/cli/variables.ts`), and
    their status lines say what `M11-R110` changed: no printed command reads `"$NAME"`, and a suggested command
    repeats `--env-file` and `--jurisdiction` too.
  - `docs/superpowers/plans/README.md`: the listing across owners and the bucket-setup command are no longer
    candidates (`api.allFiles`, `cloudrop setup`), and the bundled server's size is the one measured today.
  - `docs/decisions/README.md`: the M3 plans are history; no plan is active.
  - `scripts/size-limit.config.ts`: each comment carries the size measured on 2026-11-21 with `bun run
    package:check`: cloudrop 46.79 kB, next 0.83 kB, node 2.35 kB, sql 13.11 kB, drizzle 14.85 kB, prisma 12.59 kB,
    testing 14.17 kB, plugins 6.27 kB, the bundled server 34.51 kB, the client 13.48 kB, react 2.26 kB.
  - `AGENTS.md`: the web-platform rule names its second exception, the command's bin, which uses Node's `process` and
    reads `--env-file` through `process.getBuiltinModule("node:fs")` (`M9-C9`).
  - `docs/guide/plugins.md`: its last line links `M11-K` and the review entries that changed what is detected.
  - Status lines: every one of the 157 `M11` entries was read. Five lacked a pointer to the entry that changed or
    completed them and have it now: `M11-D1` (`M11-R150`), `M11-R26` (`M11-R209`), `M11-R63` (`M11-R233`),
    `M11-R150` (`M11-R214`, `M11-R233`), and those this round changed (`M11-R41`, `M11-R111`, `M11-R115`, `M11-R116`,
    `M11-R171`, `M11-R174`, `M11-R177`, `M11-C2`, `M11-C3`).
- **Why:** each sent a reader to a file, a size or a plan that is no longer there. `M11-R213` did this pass once; the
  entries after it, and the files it did not cover, had drifted again.
- **If wrong:** the sizes were measured on this branch before the other fixes of the final review merged; the
  release's own measurement may differ by a few hundredths of a kB.
- **Status:** in force. Continues `M11-R213`.
- **Visible in:** the files named above.

### M11-R240: a revoke on Postgres never waits for a file row while it holds another

- **Decision:** `revoke` on Postgres is one statement for the owner's pending rows that no other transaction holds
  (`FOR UPDATE SKIP LOCKED`, with its usage change), then one statement of its own for each pending row that was
  held: the store's `end` from `pending` to `aborted`, which waits for the row's holder and ends the row only if it
  is still pending. The count answered is the sum. `revoke` is therefore several atomic units, each ending rows with
  their bytes; a call that fails part-way has ended some uploads, and a second call ends the rest. What
  `revokeUploads` promises is unchanged: every upload of the owner that was pending when the call began is ended,
  unless a completion that held it committed; a completion in a transaction is waited for, and its upload is ended if
  it rolls back. The superseding reserve keeps `M11-R61`'s ordered, waiting lock. The audit, each statement with the
  locks it takes in order (Postgres):
  - `reserve` without a key: the usage row (`FOR UPDATE`), then its new rows, which nobody else can hold.
  - `reserve` with a key: the attempt's pending rows in byte order of id, waiting for each, then the usage row, then
    its new rows.
  - `attach`, `release`, `cleaned`, and `claim` under a lease: one file row. `claim` in a transaction: one file row,
    held until that transaction ends, through `onComplete`.
  - `complete` without `replace`, and `end` (the sweep's, `deleteFile`'s and `eraseOwner`'s only writes, one row at a
    time): one file row, then the usage row.
  - `complete` with `replace`: the advisory lock of the owner and route, its own row (held since the claim in a
    transaction), the owner's other completed rows on the route, the usage row.
  - `revoke`: the owner's pending rows nobody holds, without waiting, then the usage row; then, one statement each,
    one file row and the usage row.
  - `reconcile`: the usage row only (made to exist, locked, recounted); it reads file rows without locking them.

  The usage row is every statement's last lock, so its holder waits for nothing. Only two statements wait for a file
  row while they hold one: a superseding reserve (a), and a replacing completion (b), which waits only for completed
  rows. Two of (a) take the same rows in the same order. Two of (b) for one owner and route take turns on the advisory
  lock, and a row one of them holds as its own is not completed for the other. Every other holder of a row that (a) or
  (b) waits for is a one-row statement or a revoke, which wait for nothing but the usage row. That leaves (a) against
  (b): (a) holds a row (b) wants only if a file of the ask being retried completed while the retry ran, and (a) then
  waits for another file of that ask whose completion is in flight. That needs a client that holds the tickets of an
  `/upload` and asks it again with the same `idempotencyKey`; cloudrop's client repeats an ask only when the answer
  never arrived (`src/client/launch.ts`), so it has no ticket for those rows. Postgres ends one of the three after
  its `deadlock_timeout`, and the store runs it again (`M11-R61`, `M11-R241`).
  SQLite and D1 cannot deadlock: they run one writer at a time, each of the store's batches is one write transaction
  that takes the database's single write lock when it begins and holds no other lock, and there are no row locks.
- **Why:** Postgres keeps the lock of a row a statement waited for and then passed over because the row no longer
  matched, until the statement's transaction ends (its `SELECT` documentation, "The Locking Clause": such rows "will
  be locked, although they will not be returned"). With `transaction: true` on a `replace` route, a revoke that saw
  uploads X and Y pending waited for X's completion, passed over X once it committed as completed, kept X's lock and
  waited for Y; Y's completion held Y and wanted X as a row to replace. Measured on Postgres 18.6 with the test of
  this entry, on the code before it: 38 `40P01` in 600 races of two replacing completions and a revoke, 39 s; with
  the interleaving forced, the second completion failed with `40P01` every time. After: 0 in 3,000 races, 1.5 s for
  1,000. 0.5.0 had the deadlock too: its revoke was a plain `UPDATE … WHERE owner = … AND status = 'pending'`, which
  keeps a passed-over row's lock in the same way; the forced interleaving against that statement ended the second
  completion with `40P01` as well (the random race did not show it, 0 in 600, because that `UPDATE` usually ends
  both rows before either completion claims one). Skipping held rows for good was rejected: a pending row held for
  an instant by `/upload`'s `attach`, or by a completion that then rolls back, would stay live after a sign-out. So
  was `SKIP LOCKED` in the superseding reserve: a retry that met the lost attempt's `attach` would leave that file's
  bytes reserved, and could be refused over the quota, where 0.5.0 waited a millisecond and freed them; the one cycle
  left there needs a client cloudrop does not ship and costs that client's own requests a second.
- **If wrong:** a revoke of an owner with many uploads being completed at once runs one statement for each of them,
  where it ran one in all. A custom store's `revoke` may stay one unit: the contract allows several, it does not ask
  for them. `claim` answers `busy` for a row a revoke ended while the claim waited for it (`outcomes.ts`,
  `claimOutcome` reads the statement's snapshot); the client's next `/complete` then answers `UPLOAD_EXPIRED`. That
  was so before this entry and is left as it is.
- **Status:** in force. Replaces the audit of `M11-R61`.
- **Visible in:** `src/store/sql/postgres-revoke.ts`, `src/store/sql/postgres.ts`, `src/store/sql/store.ts`,
  `src/server/store.ts` (`revoke`), `src/store/sql/lock-order.db.integration.test.ts`, `docs/guide/store.md`
  ("Postgres notes").

### M11-R241: a completion in a transaction that Postgres ends as a conflict runs once more

- **Decision:** `sqlStore`'s `transaction` runs its callback again, once, when the transaction ended with `40P01` or
  `40001` (`onceMoreAfterConflict`, the same rule as every other call of the store). For a `/complete` with
  `transaction: true` that is the claim, `onComplete`, `onDelete` for the files a `replace` route is about to delete,
  and the record, all again in a new transaction; a second conflict answers the retryable `SERVER_ERROR` and the
  error log of any store failure. A conflict that ends one of the app's own statements inside `onComplete` is that
  hook's throw, as before: logged as `onComplete`'s failure, rolled back, and retried by the client.
- **Why:** the transaction rolled back whole, with the hooks' writes through `tx`, so the only effects of the first
  run that remain are the ones the guide already asks to be safe to repeat ("Make hooks idempotent"), and the
  client's retry of that `/complete` would run the same hooks again anyway. Before this entry 8 of 400 races
  answered `/complete` with a `SERVER_ERROR` and an error log for a deadlock the store itself had caused; `M11-R240`
  removes that cause, and this entry covers what is left (an app's own transaction over these tables, a database
  that reports serialization conflicts at commit). Measured through node-postgres, postgres.js, Drizzle and Prisma:
  each rejected the transaction with an error `isConflict` reads, and each answers the completion on its second run.
- **If wrong:** a hook with an effect that is not safe to repeat repeats it one request earlier than the client's
  retry would have. The rerun costs a second claim after a wait of at least `deadlock_timeout`.
- **Status:** in force. Changes `M11-R61` ("Calls inside the store's `transaction` are not run again").
- **Visible in:** `src/store/sql/store.ts`, `src/store/sql/executor.ts`, `src/server/store-complete.ts`,
  `src/store/sql/lock-order.db.integration.test.ts`, `docs/guide/store.md` ("What it guarantees", "Postgres notes").

### M11-R242: the sweep refuses a `stale` cursor it cannot continue from on every page, not only the first

- **Decision:** a `stale` cursor of another shape answers `M11-R68`'s non-retryable `SERVER_ERROR` wherever in a call
  it arrives: from the cleanup pass after the expire pass handled rows in the same call, and with `all` from any page
  after the first. `listingFailed` answers the error itself when it is not retryable; a listing the store failed
  (retryable) after rows were handled is still answered as what was done, counted in `failed`, with no cursor. The
  rows handled before the cursor stay handled; the report of them is not returned with the error.
- **Why:** `M11-R68` says "with `all` and without", and its test met the cursor only on a call's first listing. One
  upload to expire and two revoked ones, `api.sweep({ limit: 2 })` on a store that numbers its pages: the answer was
  `{ expired: 1, cleaned: 0, failed: 1, cursor: null }` with `error: null`, and the same with `all` and `limit: 1`
  from its second page. A caller that reads `cursor: null` as "done" ran one page of the cleanup backlog per sweep
  and was told only by the log, which is what `M11-R68` set out to end.
- **If wrong:** a caller that sums reports loses the counts of the pages before the refused one; the rows themselves
  are done and the next sweep does not meet them again.
- **Status:** in force.
- **Visible in:** `src/server/sweep.ts` (`listingFailed`), `src/server/sweep-all.test.ts`.

### M11-R243: without a store, every `/complete` of a vanished multipart upload tells the plugins again

- **Decision:** the stateless `/complete` of a multipart upload the bucket no longer has keeps `M11-R200`'s answer
  and effect on every request: `410 NO_SUCH_UPLOAD` and the plugins' `onAbort` with `reason: "rejected"`, also when
  an `/abort` or an earlier `/complete` already ran `onAbort` for that file. No code changed. `ServerHooks.onAbort`'s
  documentation and the server guide's "Make hooks idempotent" now name this repeat.
- **Why:** an `/abort` followed by two `/complete` calls heard `["aborted", "rejected", "rejected"]`. A stateless
  server has only the token and the bucket, and neither says whether a request already ended this upload for the
  plugins: the bucket answers `NoSuchUpload` the same after the lifecycle rule, after `/abort` and after an earlier
  `/complete`. Answering without the hook would take back what `M11-R200` gave, the release of a plugin's
  reservation when a page that never sends `/abort` finds its upload gone, for every such upload and not only the
  repeats. The repeat asks nothing new of a plugin: `onAbort` could already run twice for one file (a retried
  `/abort`), and after `NO_SUCH_UPLOAD` the client asks for a new ticket (`M11-R80`) and sends the old one's
  `/abort` (`M11-R89`), so the usual course is already `"rejected"` then `"aborted"`. A plugin that releases by
  `file.id` is unaffected; one that subtracts on every call was wrong before this entry. With a store none of this
  happens: the row is ended once and later requests are answered from it.
- **If wrong:** a plugin that counts `onAbort` calls counts a vanished upload once for each request that names it,
  for the 24 hours its token is valid.
- **Status:** in force.
- **Visible in:** `src/server/plugins.ts` (`onAbort`), `src/server/complete-multipart.test.ts`,
  `docs/guide/server.md` ("Make hooks idempotent").

### M11-R244: two paths the fix rounds left without an assertion have one again

- **Decision:** two tests assert what they stopped asserting. `src/server/api.test.ts`, the `deletePrefix` case for
  a prefix in another Unicode form, reads the keys handed to the storage's `deleteMany` and expects the key in the
  bytes the bucket listed it in (`M9-H6`: "deletes the key as listed"). `src/server/complete-multipart.test.ts`
  holds "the client aborted, then a late `/complete` arrives" in its own case, which was there but asserted only
  the answer: it now sends `/abort` and two `/complete` calls and expects `410 NO_SUCH_UPLOAD` twice and the plugins
  told `["aborted", "rejected", "rejected"]` (`M11-R243`). No test was added.
- **Why:** since `M11-R210` the `deletePrefix` case runs on the fake, which holds both Unicode forms of a key as one
  object, so a `deletePrefix` that deleted the key in the prefix's form passed it; with the delete normalized to NFC
  as a probe, the new expectation fails and the old ones do not. `M11-R200` changed the set-up of the "another
  writer's object" case from `/abort` to an abort in the bucket; the `/abort` path was still run by the case above
  it, which did not look at the hooks.
- **If wrong:** none; test code only.
- **Status:** in force.
- **Visible in:** `src/server/api.test.ts`, `src/server/complete-multipart.test.ts`.

### M11-R245: every api call reads its options argument by one rule

- **Decision:** `optionsOf` (`src/input.ts`) reads the options argument of every `api.*` call that can do without
  one: null and undefined are no options, a plain object is the options, and anything else is `INVALID_INPUT` with
  that call's own message. Two calls change. `api.allFiles(null)` lists as `api.allFiles()` does; it was refused.
  `api.put(key, body, options)` refuses options that are not a plain object with "put options must be an object,
  such as { type: "text/plain" }."; it stored the object and ignored them. `api.files` and `api.revokeUploads` need
  their options (`owner`), so null and undefined are refused there with the same message as any other value.
- **Why:** probed on the memory store before the change, each call with null, undefined, `[]`, `"x"` and `5`:

  | Call | null | undefined | `[]`, `"x"`, `5` |
  | --- | --- | --- | --- |
  | `allFiles` | `INVALID_INPUT` | answers | `INVALID_INPUT` |
  | `sweep`, `eraseOwner`, `reconcile`, `deleteFile`, `getUrl`, `checkBucket` | answers as without options | answers | `INVALID_INPUT`, the call's own message |
  | `put` | stores | stores | stores, the options ignored |
  | `files`, `revokeUploads` (options required) | `INVALID_INPUT` | `INVALID_INPUT` | `INVALID_INPUT` |

  A value that comes out of JSON or a database as null reached six calls as "no options" and one as an error, and
  `api.put(key, body, "image/png")` from plain JavaScript stored the object without its type and said nothing, the
  mistake `getUrl` already refuses for `getUrl(key, 3600)`. One function holds the rule, so a new call cannot read it
  another way.
- **If wrong:** a caller that passed `api.put` options of another shape and relied on them being ignored gets
  `INVALID_INPUT` and nothing stored. 0.5.0 ignored them too; its types never allowed the call.
- **Status:** in force.
- **Visible in:** `src/input.ts`, `src/server/api.ts`, `src/server/all-files.ts`, `src/server/store-api.ts`,
  `src/server/erase.ts`, `src/server/sweep-options.ts`, `src/server/api-options.test.ts`.

### M11-R250: the driver joins an answer's chunks by hand, and no library source asks a `Blob` for its bytes on the server

- **Decision:** `readBody` (`src/storage/s3/transport.ts`) copies the chunks it read into one `Uint8Array` of the
  bytes it keeps, not through `new Blob(chunks).slice(0, limit).arrayBuffer()`. The bound, the cancel and what is
  returned are unchanged. Every other use in `packages/cloudrop/src` of `Blob`, `File`, a body's `arrayBuffer()` and
  the newer built-ins was read against Vitest's jsdom 26.1.0 and happy-dom 21 environments and the floors of
  `M8-Q5` and `M8-Q8`, and probed where it runs there:
  - `body instanceof Blob` in `send`, `bodyProblem` and `put` (the driver's own argument check): a `Blob` and a
    `File` of either environment pass it and are stored with their bytes through `testBucket()` (measured).
  - `request.arrayBuffer()` in the fake R2 and `answer.arrayBuffer()` in `cloudrop/node` are a `Request`'s and a
    `Response`'s, which both environments have.
  - `toSorted`, `isWellFormed`, `ArrayBuffer.prototype.detached`, `replaceAll`, `at`, `AbortSignal.timeout` and
    `crypto.randomUUID` are in server files only, all in Node 24, and none is replaced by a test environment.
  - `fingerprintOf` (`src/client/fingerprint.ts`) calls `arrayBuffer()` on the `File`: in jsdom 26 it rejects, so an
    upload there is not saved for `resume()`. It is reached only where the page has IndexedDB, which jsdom has not;
    left as it is and reported, since Chrome 76, Safari 14 and Firefox 69 have the method and the floor is above them.
- **Why:** `M11-R22` and `M11-R2` contradicted each other: jsdom 26's `Blob` has no `arrayBuffer()`, the reason
  `M11-R2` took `Blob` out of the handler's body reader, and `M11-R22` put one into the driver's. Measured in a copy
  of the package with jsdom 26.1.0: `put`, `head`, `getRange`, `list`, `copy`, `delete` and `createMultipart` of
  `testBucket().storage` each answered `STORAGE_UNREACHABLE` (cause: `slice(...).arrayBuffer is not a function`), and
  `src/testing.jsdom.test.ts` failed at `/complete`; with the join by hand each succeeds and the file passes.
- **If wrong:** none known; the join is the copy `Blob` made. A stream whose chunks are not `Uint8Array`s was
  never supported.
- **Status:** in force; amends `M11-R22`.
- **Visible in:** `src/storage/s3/transport.ts`, `src/storage/s3/transport.test.ts` (a `Blob` without
  `arrayBuffer()`, as `handler.test.ts` has for `M11-R2`).

### M11-R251: an answer whose body is not a web stream is read whole, then judged against the bound

- **Decision:** `readBody` reads through the body's reader only where the body has one. A body without `getReader`
  (node-fetch and cross-fetch answer with a Node stream) is read with `arrayBuffer()`, cut to the bound, and
  refused afterwards exactly as a web stream past the bound is: a successful answer over it fails with the error of
  `M11-R20`, and an error body is cut to its first 4 KiB. A body nobody reads (the answer to an ignored `Range`) is
  cancelled when it is a web stream and destroyed when it is a Node stream.
- **Why:** the `fetch` option takes any function with fetch's shape, and 0.5.0 read every answer through `text()`
  and `arrayBuffer()`, which node-fetch has. `M11-R22` called `response.body?.getReader()`, which throws on a Node
  stream, so every call answered `STORAGE_UNREACHABLE`. Measured with node-fetch 2.7.0 against a local server:
  `head`, `put`, `getRange`, `list` and `delete` failed with "getReader is not a function", and the same script on
  the 0.5.0 sources succeeded; after the fix they succeed again. The answer to an ignored `Range` failed in 0.5.0
  too (`response.body?.cancel is not a function`) and now says what happened.
- **If wrong:** with such a `fetch` the bound is checked after the read, so a server that sends gigabytes is read
  whole, as in 0.5.0; only a web stream can be stopped early. A body with neither a reader nor `arrayBuffer()` still
  answers `STORAGE_UNREACHABLE`.
- **Status:** in force; amends `M11-R22`.
- **Visible in:** `src/storage/s3/transport.ts`, `src/storage/s3/transport.test.ts` (four rows with a Node stream as
  the body).

### M11-R252: a stored header value is canonicalised as the text its bytes spell

- **Decision:** `canonicalValue` (`src/storage/sigv4.ts`) reads a header value that holds a character from U+0080 to
  U+00FF as bytes of UTF-8 (what is not UTF-8 becomes U+FFFD), then trims it and makes each run of white space one
  space, and the canonical request is hashed as UTF-8. An ASCII value is canonicalised as before, and the request
  still carries the stored bytes unchanged. The white space is JavaScript's `\s`, as before, now matched against
  characters and not against bytes.
- **Why:** `M11-R25` hashed the right bytes but trimmed and collapsed the byte string first, where the byte `A0` is
  the character U+00A0, which `trim()` and `\s` count as white space. So `voilà` (`C3 A0`) was signed with a space
  for its second byte, and a value ending in `你` (`E4 BD A0`) one byte short: R2 answered `403
  SignatureDoesNotMatch` to the raw `PUT`, and a copy in parts of such an object failed as refused credentials. AWS
  states the rule for values as "trim any leading or trailing spaces" and "convert sequential spaces to a single
  space" (IAM User Guide, "Create a signed AWS API request", "Create a canonical request":
  https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html). That rule read for
  bytes (only `20`) is not what R2 does either, and the measured behaviour wins: R2 reads the bytes as UTF-8 and
  then collapses exactly the characters `\s` matches. A tab, a no-break space (`C2 A0`), U+3000, U+2028 and U+FEFF
  are signed as one space and trimmed at the end; U+0085 and U+200B are not; a byte that is not UTF-8 is signed, and
  stored, as U+FFFD (`docs/research/r2-spike-findings.md`, "How R2 canonicalises a header value", 22 forms signed
  with `node:crypto`). RustFS 1.0.5 passed the same signatures for the rows it could be asked.
- **If wrong:** AWS S3 itself was not measured. If it collapses only the byte `20`, a stored value with a Unicode
  space (a no-break or ideographic space in a file name) is signed wrong there and its copy in parts fails with
  `STORAGE_DENIED`, as it did everywhere before; every value without such a character is signed the same under both
  readings. A value with a character above U+00FF cannot come from `Headers.get()` (`M11-R25`).
- **Status:** in force; amends `M11-R25`.
- **Visible in:** `src/storage/sigv4.ts`, `src/storage/sigv4.test.ts` (four signatures computed with `node:crypto`),
  `src/storage/s3/copy.r2.integration.test.ts` (live R2: a copy in parts of an object whose disposition holds `C3
  A0`, `C2 A0` and ends in `E4 BD A0`), `scripts/test-live-r2.ts`, `docs/research/r2-spike-findings.md`.

### M11-R253: a package in a ZIP agrees with every type a browser gives a `.zip`

- **Decision:** the kinds read from a ZIP's entries (Word, Excel and PowerPoint by their folder, OpenDocument and
  EPUB by their `mimetype` entry) agree with `application/zip`, `application/x-zip-compressed` and
  `application/x-zip`. A ZIP that names no package is unchanged: it never contradicted an `application/` type, and
  is still judged as `application/zip`, so `deny: ["application/zip"]` refuses it under any of the three names.
- **Why:** they agreed with `application/zip` alone. Windows registers `.zip` as `application/x-zip-compressed`, and
  both browsers ask the system before their own table: in Chromium's `net/base/mime_util.cc` `zip` is in
  `kSecondaryMappings`, read after the platform ("b) Underlying platform. c) kSecondaryMappings"), and in Firefox's
  `uriloader/exthandler/nsExternalHelperAppService.cpp` it is in `extraMimeEntries`, read after the OS ("1.
  defaultMimeEntries array 2. OS-provided information 3. our extras array"). shared-mime-info
  (`freedesktop.org.xml.in`) lists `application/x-zip-compressed` and `application/x-zip` as aliases of
  `application/zip`. Reproduced: a ZIP whose first entry is `ppt/lecture1.txt`, sent as
  `application/x-zip-compressed` to `accept: "*/*"`, was refused "This file is a PowerPoint presentation, but it
  was sent as application/x-zip-compressed", and so was an EPUB; 0.5.0 answered the same. A folder named `word/`,
  `xl/` or `ppt/` says which application a package is for, not that the archive is one.
- **If wrong:** with `deny: ["application/zip"]` alone, an archive whose entries name a package and which Windows
  sent as `application/x-zip-compressed` now passes where it was a `mismatch`: `deny` matches neither the declared
  type nor the package's. The guide already says a recognised package is its own type and that anyone can put a
  `word/` entry into a ZIP; a server that must refuse archives denies both ZIP names, which refuses them at
  `/upload`.
- **Status:** in force.
- **Visible in:** `src/plugins/sniff-containers.ts` (`ARCHIVE`), `src/plugins/content-checks-containers.test.ts`,
  `docs/guide/plugins.md` (rule 4).

### M11-R254: an untyped OLE compound file passes as what it was sent as

- **Decision (the maintainer's):** an OLE compound file sent as `application/octet-stream` passes on every route
  that takes that type, as in 0.5.0, whatever else the route accepts. It is no longer a container of the installer
  types: its one type is `application/x-ole-storage`, it contradicts no `application/` type, and sent as another
  top-level type (an image, text, audio, video) it is still a `mismatch`. A file sent as `application/x-msi` or
  `application/x-ms-installer` is still refused by its declared type unless `allow` names an installer type.
  `deny: ["application/x-ole-storage"]` refuses every compound file, typed or not. A message calls it "an old Office
  document, an Outlook message or a Windows installer".
- **Why:** `M11-R136` refused every untyped compound file because it may be an installer. The signature (MS-CFB
  §2.2) is also that of an Outlook `.msg`, an old CAD drawing and a `Thumbs.db`, which browsers send untyped on a
  system without the application, and 0.5.0 took them on a route with `accept: "*/*"`: 0.6.0 refused them as "an old
  Office document or a Windows installer". The bytes cannot tell an installer from a mail message, and refusing all
  of them breaks apps that take business documents. The "content's own type must be in `accept`" rule is skipped
  for it too: `application/x-ole-storage` is the sniffer's name, not a type a route would list, and 0.5.0 asked for
  none.
- **If wrong:** an installer sent untyped, or as an Office type, is not caught; the guide's Limits say so and name
  the two ways to keep it out (`application/octet-stream` out of `accept`, or `deny` of
  `application/x-ole-storage`). `allow: ["application/x-msi"]` is no longer needed for an untyped compound file.
- **Status:** in force; amends `M11-R136`.
- **Visible in:** `src/plugins/sniff.ts` (`OLE`), `src/plugins/content-checks.ts`,
  `src/plugins/content-checks-legacy.test.ts`, `docs/guide/plugins.md` (rule 5, Containers, Limits).

### M11-R255: untyped, a script is judged by the script types alone; the untyped table against 0.5.0

- **Decision:** `text/*` moves from the `#!` script's `agrees` (the types the content can be) to its `loose` (the
  types it does not contradict). Sent as a text type, an allowed script passes as before (`M11-R134`). Sent
  untyped, the route's text entries no longer stand for types the script could be: it is refused unless `allow`
  names a script type, and then accepted only where the route's `accept` takes a script type, by name or by a
  wildcard, as in 0.5.0. The route's entries still count for content whose bytes cannot say which type it is: a container
  (`M11-R133`), an Office file (its folder names the application, not the type) and XML (its root names no `+xml`
  type).
- **Why:** reproduced: with `accept: ["text/html", "application/octet-stream"]` and `allow: ["text/html"]`, an
  untyped `#!/bin/sh` file passed, and so did one on `accept: ["text/plain", …]` with `allow: ["text/plain"]` or
  `allow: ["text/x-shellscript"]`; 0.5.0 refused all three. `M11-R133` words the rule for "a ZIP or an Office file",
  but the code counted the route's entries for every kind whose `agrees` held a wildcard, and the script's held
  `text/*`. Allowing web pages is not allowing scripts, and "the content's own type must be in `accept`" means the
  type the bytes show: a script is not HTML because the route takes HTML.
- **The table.** `contentChecks()` of 0.5.0 and of this commit were run on the same 19,375 cells: 31 files sent
  untyped, 25 `accept` shapes, 25 `allow`/`deny` shapes. Every cell that changed, with its entry:

  | Untyped file | `accept` and lists | 0.5.0 | 0.6.0 | Entry |
  |---|---|---|---|---|
  | A `#!` line behind a byte order mark or blank lines | every shape; with `allow` of a script type, every route that names no script type | passes (no type shown) | refused | `M11-R136` |
  | WebM, Matroska, MP4, 3GP | `deny: ["audio/*"]`, on a route that takes one of its types | passes | refused | `M11-R136` |
  | Ogg | `deny: ["video/*"]`, the same | passes | refused | `M11-R136` |
  | OLE compound file | `deny: ["application/x-ole-storage"]` | passes (no type shown) | refused | `M11-R254` |
  | Windows program | `allow: ["application/x-msdownload"]`, `accept` of `*/*` or `application/*` | refused | passes | `M11-R134` |
  | ZIP that names no package (an empty one too) | `accept` names an Office, `application/vnd.ms-*` or `+zip` type; no `deny` of ZIP or of that type | refused | passes | `M11-R133` |
  | Word, PowerPoint, OpenDocument, EPUB | `accept` names `application/x-zip-compressed` | refused | passes | `M11-R253` |
  | XML with a root other than `svg` | `accept` names a `+xml` type and `allow` names an XML type | refused | passes | `M11-R134`, this entry |

  Nothing else changed: an untyped OLE file passes on every other shape again (`M11-R254`), and a `#!` script at
  the start of the file answers as in 0.5.0 on all 625 shapes. `M11-R259` adds the files 0.6.0 reads as another
  type.
- **If wrong:** an app that relied on `allow: ["text/plain"]` or `allow: ["text/html"]` to take untyped scripts
  (possible in no release) names a script type in both lists. The XML row stays looser than 0.5.0: with an XML type
  allowed and a `+xml` type in `accept`, an untyped XML document passes whatever its root is, as the same file sent
  as that type always did.
- **Status:** in force; narrows `M11-R133`'s "the route's own entries count" to content that can be the entry's
  type.
- **Visible in:** `src/plugins/sniff-text.ts` (`SCRIPT`), `src/plugins/content-checks-allow.test.ts`,
  `docs/guide/plugins.md` (rule 5).

### M11-R256: the test bucket's `cors` option, the reason `.lnk` is not detected, and the two tightenings in the guide's rules

- **Decision:** documentation only, three corrections.
  1. `TestBucketOptions.cors` (`src/testing.ts`) and `docs/guide/testing-your-app.md` say what the option does
     since `M11-R172`: `checkBucket` reads it, and `bucket.fetch` answers a preflight `204` with the answering
     rule's headers or `403` without them, and adds `access-control-allow-origin` and the exposed headers to a
     signed request whose `Origin` a rule allows. The guide's "Bucket CORS" difference says what a test can assert
     and that the client's own `PUT`s still carry no `Origin`.
  2. A Windows shortcut (`.lnk`) stays undetected, for a reason that is true: its signature is known (MS-SHLLINK
     §2.1, ShellLinkHeader: `HeaderSize` `4C 00 00 00`, then `LinkCLSID` `00021401-0000-0000-C000-000000000046`,
     20 bytes in all) and would fit (the entry measures about 6.3 kB under a provisional 7 kB ceiling), but
     refusing it is a fifth kind of file that 0.5.0 took, added after the review that weighed the other four, and
     the maintainer has just taken one of those back (`M11-R254`). It waits for the maintainer's word, with the
     next format added. The guide's Limits already name `.lnk` among what passes.
  3. `docs/guide/plugins.md` states the two tightenings of 0.6.0 in its numbered rules: rule 3, a `#!` line behind
     a byte order mark or blank lines is a script; rule 5, an untyped container is refused when `deny` names any
     type it can be (`M11-R136`).
- **Why:** the JSDoc and the guide said the option was "for tests of `api.checkBucket`", and the guide that "the test
  bucket answers every request": measured on `testBucket({ cors })`, a preflight from an allowed origin answers
  `204` with `access-control-allow-origin`, `-methods`, `-headers` and `-max-age`, one from another origin or with
  a header no rule allows `403` with none, and a signed `GET` with an allowed `Origin` carries
  `access-control-allow-origin` and `access-control-expose-headers`; without the option every preflight is `403`.
  `M11-R136` gave the 6 kB ceiling as the reason for `.lnk`, and `M11-R220` raised it. The two tightenings were in
  the Containers section and the recognition table only, where a reader of the rules does not meet them.
- **If wrong:** none; no behaviour changes.
- **Status:** in force; corrects one sentence of `M11-R136`.
- **Visible in:** `src/testing.ts`, `docs/guide/testing-your-app.md`, `docs/guide/plugins.md`.

### M11-R257: three media aliases, and three rows for checks no test held

- **Decision:**
  - An MP4 file agrees with `audio/x-m4b` (under a general brand and under `M4A `, `M4B ` and `M4P `) and, under a
    general brand, with `video/x-f4v`. An Ogg file agrees with every type that ends in `+ogg`.
  - Three rows are added, each seen red under the mutation it guards: a lifecycle rule that aborts after zero days
    is refused before anything is sent (`days >= 1` in `lifecycleProblem`); `<!DOCTYPE x><a,b><script>` shows no
    type (the start tag is matched where the prolog ends, not anywhere after it: `START_TAG`'s sticky flag); and
    `400 InvalidPartOrder` maps to `INVALID_PART`.
- **Why:** an `.m4b` sent as `audio/x-m4b`, an `.f4v` as `video/x-f4v` and an `.opus` as `audio/x-opus+ogg` were
  each a `mismatch` (reproduced; the same in 0.5.0). The types come from the tables clients use: shared-mime-info
  (`freedesktop.org.xml.in`) gives `.m4b` and `.f4b` `audio/x-m4b`, a subclass of `audio/mp4`, and gives Ogg a type
  per codec, each a subclass of `audio/ogg` or `video/ogg` and each ending in `+ogg` (`audio/x-opus+ogg` for
  `.opus`, `audio/x-vorbis+ogg`, `audio/x-flac+ogg`, `audio/x-speex+ogg`, `video/x-theora+ogg`,
  `video/x-ogm+ogg`), so the suffix is matched as `+zip` is. Chromium (`net/base/mime_util.cc`) and Firefox
  (`nsExternalHelperAppService.cpp`) have `.opus` as `audio/ogg` and no entry for `.m4b` in Chromium or `.f4v` in
  either, so the platform's type is sent. `video/x-f4v` is Apache httpd's type for `.f4v` (`docs/conf/mime.types`),
  which mime-db and the clients built on it follow. `InvalidPartOrder` is AWS S3's answer to a completion whose
  "list of parts was not in ascending order" (API Reference, CompleteMultipartUpload); R2's error list has no such
  code, and R2 completed a list in descending order with `200` (measured 2026-11-21,
  `docs/research/r2-spike-findings.md`). The driver sorts the parts, so the row holds the mapping for S3.
- **If wrong:** `deny: ["video/*"]` does not refuse an MP4 sent as `audio/x-m4b`, as it does not one sent as
  `audio/mp4` (`M11-R133`). `audio/x-m4r` (a ringtone) and other names outside the three tables are still a
  `mismatch`.
- **Status:** in force.
- **Visible in:** `src/plugins/sniff-containers.ts`, `src/plugins/sniff.ts`,
  `src/plugins/content-checks-containers.test.ts`, `src/plugins/sniff-text.test.ts`,
  `src/storage/s3/bucket-settings.test.ts`, `src/storage/storage-error.test.ts`, `docs/guide/plugins.md`,
  `docs/research/r2-spike-findings.md`.

### M11-R258: a document's root that the read does not reach, `<?` as an HTML parser reads it, and a name that ends in a space

- **Decision:**
  1. **One rule for a root the 4 KiB read does not reach.** Text that has shown a doctype is a document. When the
     text ends before its root, in the doctype (`M11-R220`), in the blanks, the comment or the processing
     instruction after it, or in the first characters of a comment or of the root's own tag (`<!-`, `<sv`), it is
     `application/xml`, unless the HTML reading found a root or the text opens as a web
     page (`<!--`, `<!DOCTYPE html`: `M10-K12`, `M11-R131`). Text that opens with a processing instruction and shows
     no doctype is not known to be a document: one still open where the text ends, or one that is all the text
     holds, shows no type.
  2. **A processing instruction is read both ways when there is no `<?xml`.** An XML parser ends it at `?>`; an
     HTML parser reads `<?` as the start of a bogus comment and ends it at the first `>` (HTML Standard §13.2.5.6,
     tag open state: "unexpected-question-mark-instead-of-tag-name … Reconsume in the bogus comment state";
     §13.2.5.41, bogus comment state: `>` emits the comment). The root either reading finds decides, as for a
     doctype (`M11-R220`).
  3. **A file name's extension is read after the dots and spaces the name ends with.** `"a.txt "` sent as
     `text/plain` is accepted with the key extension `.txt`; `"payload.html. ."` sent as `image/png` is refused as
     `.html`. The name itself is kept as sent.
- **Why:** reproduced: `<!DOCTYPE svg><!--` + 5,000 blanks + `--><svg onload=…>`, `<!DOCTYPE svg>` + 5,000 blanks +
  `<svg…>` and the same with `<?p …?>` each showed no type in the 4,096 bytes the plugin reads, while a doctype
  still open there read as XML and a comment at the start as a web page: three answers to one question. And
  `<?p a><script>alert(1)</script> ?><y>` showed no type, though a browser that gets it as a web page runs the
  script. The rule stops at the doctype because of PHP: source files open with `<?php` and, by PHP's own
  convention, never close it, so "an open processing instruction is XML" would refuse every PHP file over 4 KiB
  that 0.5.0 took, and one that closes its tag where the file ends as well. A name ending in a space was refused
  "The file name's extension does not match its type text/plain", which is not true of `a.txt`: Windows drops the
  dots and spaces a name ends with when it makes the file (Microsoft, "Naming Files, Paths, and Namespaces": "Do not
  end a file or directory name with a space or a period"; Chromium's `net/base/filename_util_internal.cc`: "Handle
  CreateFile() stripping trailing dots and spaces on filenames"), which is why trailing dots were already dropped
  before the extension was read. macOS and Linux keep such a name; there its extension names no type, so reading
  it as Windows does refuses nothing those systems would open.
- **If wrong:** a file that is nothing but a doctype and blanks or a comment (`<!DOCTYPE x>` and a line break) now
  reads as XML where it showed no type. `<!DOCTYPE svg>` followed by a comment that runs past the read is refused
  as XML when sent as a non-XML type, where it passed as sent. A root hidden behind an opening processing
  instruction longer than 4 KiB (`<?p ` + blanks + `?><svg…>`) still shows no type: the guide's Limits say so. PHP
  source whose first `>` is directly followed by one of the fifteen tags or `<svg` (`<?php // a -> <b>x</b>`;
  `<?php echo $a ?>` is not such a case) is refused as the web page an HTML parser makes of it. `<!x>` and `</x>`,
  which an HTML parser also skips, are not read: only what `M11-R131` names as the prolog, and `<?`.
- **Status:** in force; extends `M11-R220`.
- **Visible in:** `src/plugins/sniff-text.ts`, `src/plugins/sniff-text.test.ts`, `src/server/accept.ts`,
  `src/server/accept.test.ts`, `docs/guide/plugins.md` (the recognition table, Limits).

### M11-R259: the untyped table for content 0.6.0 reads differently, and the measurements after the final fixes

- **Decision:** no behaviour; the record of three measurements taken after `M11-R250` to `M11-R258`.
  1. **The rest of the untyped table.** `M11-R255` lists the cells the decision changed. Fifteen more files, each
     one that 0.6.0's sniffer reads as another type than 0.5.0's, were run through the same 625 shapes. Untyped,
     each answers as its new type does:

     | Untyped file | 0.5.0 | 0.6.0 | Entry |
     |---|---|---|---|
     | Text that opens with `<!--` | passes (no type) | refused, a web page | `M11-R131` |
     | `<hta:application` as the root | passes (no type) | refused, a web page | `M11-R136` |
     | A doctype still open after 4 KiB; a doctype whose quoted `]>` hides an `svg` root | passes (no type) | refused, XML or SVG | `M11-R220` |
     | A doctype, then a comment, blanks or a processing instruction past the read | passes (no type) | refused, XML | `M11-R258` |
     | `<?p a><script>…` | passes (no type) | refused, a web page | `M11-R258` |
     | `<a,b> denotes…` | refused, a web page | passes (no type) | `M11-R131` |
     | One MPEG audio frame header with no second one; `FF FF 00 00` | refused where the route takes no audio | passes (no type) | `M11-R136` |
     | A Word file whose entries are streamed | judged as a ZIP | judged as a Word file | `M11-R132`, `M11-R212` |

     A refused row passes where `allow` names its kind and the route accepts it, as any file of that type does. A
     short PHP file (`<?php echo 1; ?>`) and a file with an ID3 tag answer as in 0.5.0 on every shape.
  2. **Time.** `sniff` on 35 adversarial inputs of 4,096 bytes (blanks; a doctype followed by runs of `] `, `<!-`,
     `<!--`, quotes, `<?`, `<?>`, `<!---->`; the same without a doctype; a tag name that never ends; a UTF-16
     doctype; ZIP headers; brands; frame headers), 300 calls each after 300 to warm up, Node 24.22.2: the largest
     median is 0.13 ms and the largest single call 0.35 ms. The fuzz test (`src/plugins/sniff-fuzz.test.ts`, over
     20,000 inputs and 2,000 doctypes built from the grammar) passes unchanged.
  3. **Size.** `cloudrop/plugins` is 6.46 kB (6.27 kB before these fixes, ceiling 7 kB, provisional) and the bundled
     server 34.48 kB (34.35 kB, ceiling 36 kB, provisional). Neither ceiling moved.
- **Why:** the owner's bar for 0.6.0 is that nothing which worked in 0.5.0 gets worse unseen; a table of the
  decision alone would leave out what the sniffer changed underneath it.
- **If wrong:** the table holds the files and shapes that were run, not every file: a format neither release
  recognises answers the same in both by construction.
- **Status:** in force.
- **Visible in:** `scripts/size-limit.config.ts` (the measured size), this file.

### M11-R260: a resumed upload's `/abort` carries `keep` until the server proves the upload unfinished

- **Decision:** an upload that `resume()` rebuilt from a record starts with `keepStored` set (`newUpload` in
  `src/client/upload.ts`), so every `/abort` sent for its ticket carries `keep: true`. The mark ends with the one
  thing that proves no `/complete` finished the upload: a `/complete` answered `PARTS_MISSING`, `NO_SUCH_UPLOAD` or
  `NOT_UPLOADED`, which the server says only after it looked in the bucket and found the upload open, or gone with
  nothing of it stored. From then on the page's own count of the `/complete` calls it sends (`mayBeComplete`,
  `M3-S14`) decides, as for any upload. Every way a resumed upload ends:

  | A resumed upload ends by | Sent before | Sent now |
  | --- | --- | --- |
  | `abort()` of the file or the job, the caller's signal, or `close({ abort: true })`, before the probe is sent (the file paused, or the page offline) | `/abort` | `/abort` with `keep` |
  | The same once the probe failed without proof: a proxy's `429` page, `RATE_LIMITED`, `STORAGE_ERROR`, a refusal of the handler, `UNKNOWN_ROUTE`, any refusal for good, a `headers` function that failed | `/abort` | `/abort` with `keep` |
  | The same while the probe is in flight | the answer is waited for (`M11-R86`), then as its row here | the same |
  | A probe answered `UPLOAD_EXPIRED` or `INVALID_TOKEN`: the start over (`M11-R90`) | `/abort` | `/abort` with `keep` |
  | `retry()` that replaces the ticket after a refusal for good (`M11-R89`) | `/abort` | `/abort` with `keep` |
  | `pagehide` on the failed file, after a failure a resume cannot fix | `/abort` | `/abort` with `keep` |
  | A probe answered `PARTS_MISSING`, also in the ticket's last 15 minutes (`M9-H3`), or `NO_SUCH_UPLOAD`, then any of the above | `/abort` | `/abort`: the upload is proven unfinished |
  | A probe that got no answer or a `SERVER_ERROR`, then a cancel | nothing (`M3-S14`) | nothing |
  | `close()` without `abort`, `pagehide` after a failure a resume can fix, a cancel while the checks run | nothing | nothing |
  | `discard()` of the listed upload | `/abort` with `keep` (`M3-U94`) | the same |
  | `forget()` | nothing | nothing |

- **Why:** reproduced on a server without a store, two ways. A tab closed while `/complete` was in flight; the server
  completed the file and ran `onComplete`. After the reload: (A) `resume(upload, file)`, `pause()`, then `abort()`
  before the probe was sent; (B) the probe answered by a proxy's `429` page six times, the file failing
  `RATE_LIMITED`, then `abort()`, which is the "Dismiss" of the React guide. Both sent a plain `/abort` with a live
  token, and the server deleted the finished object: `{"status":"aborted","aborts":[["token"]],"stored":null,
  "onComplete":1}`. The upload built for the probe knew nothing of the earlier page's `/complete`: its doubt is not in
  the record, and only the probe's answer settles it. 0.5.0 has the same code. With a store the row is `completed`
  and the object stays, `keep` or not. The other paths were read for the same shape, an `/abort` sent while the page
  does not know whether a `/complete` finished: a `/complete` the page sends itself is counted on its upload, across
  pauses and same-ticket retries, until one of the three proving answers or the server's word that the ticket is over
  (`M11-R201`, which then sends `keep`); a ticket that arrives for a cancelled file (`M4-F2`, `M11-R261`) never had a
  `/complete`; a ticket `pagehide` kept is discarded with `keep` (`M11-R91`). None was found.
  A fuzz then ran 24,000 sequences (seeds 20261121, 801, 5150 and 77001, 6,000 each; 12,114 on a server without a
  store, 11,886 with the memory store; 65 s on four workers, about 11 ms a sequence): a first page that closed during
  `/complete`, lost its answer in place (`start()` and `upload()`), or closed before its part was sent, then up to 12
  steps of resume, pause, resume, abort, dismiss, the signal, retry, both closes, discard, forget, offline, online,
  `pagehide`, reload, and a change of what `/complete` is answered (the server, a lost success, no connection, a
  `headers` function that throws, a `429` page, a `502` page, `RATE_LIMITED`, `UPLOAD_EXPIRED`, `INVALID_TOKEN`,
  `UNKNOWN_ROUTE`, `ORIGIN_NOT_ALLOWED`). The server finished 20,403 files; 5,902 `/abort`s named one of them, in
  5,889 sequences, each with `keep`; none was deleted, and with the store every one's row stayed `completed`. No
  exception for `discard()` or `forget()` was needed. Against the client before this entry the same property failed
  at its 12th sequence (`resume()` with the probe answered `RATE_LIMITED`, then `close({ abort: true })`).
- **What `keep` costs when the upload really was unfinished:** without a store, nothing for an upload whose parts
  never became an object: the server aborts the multipart upload either way (`abortAndDelete` in
  `src/server/abort.ts`), so its parts leave the bucket at once and `onAbort` runs. What stays is an object the bucket
  had put together while the server never finished that `/complete` (a hook threw, or the process stopped between the
  bucket's answer and `onComplete`): a plain `/abort` deleted it, and `keep` leaves it in the bucket, without
  `onAbort`. No lifecycle rule removes a finished object. The page that sent such a `/complete` kept that object
  already (`M3-S14`); a page that resumes the upload now keeps it too. With a store, nothing: the row decides, and a
  landed object under a `pending` row is deleted with it.
- **If wrong:** a server without a store collects the objects of completions that failed after the bucket finished
  and whose user then cancelled the resume; an app that cannot have that uses a store. A first page's `/complete`
  still running on the server when the resumed page's `/abort` arrives races it as in `M11-R201`'s "If wrong". A
  server older than `M3-U94` ignores `keep`.
- **Status:** in force. Amends `M11-R201` ("only a ticket whose doubt the server ended carries `keep`") and corrects
  `M3-U94`'s "Every other client path refuses that delete".
- **Visible in:** `src/client/upload.ts` (`newUpload`, `complete`), `src/client/resume-keep.test.ts` (the two
  reproductions), `src/client/finished-kept-fuzz.test.ts` (40 seeded sequences in the unit lane, about 0.5 s),
  `src/client/resume-job.test.ts` (the proven-unfinished row), `docs/guide/resume.md` ("The server is asked first"),
  `docs/guide/react.md` ("Resume after a reload"), `docs/guide/client.md` ("Cancel").

### M11-R261: a cancel leaves an `/upload` in flight to answer, and aborts each ticket it brings

- **Decision:** `job.abort()`, the caller's signal, `close()` and, for an `/upload` that asks for one file, that
  file's `abort()` no longer cut an `/upload` that has left the page. The files end `aborted` at once and `done`
  resolves as before, without waiting. The request is left to answer, at most its 30 seconds (`ASK_TIMEOUT_MS`) and
  with no further attempt, and each ticket the answer brings gets one `/abort` (`unlessCancelled` in
  `src/client/launch.ts`). A request that has not been sent is still stopped: one whose `headers` or `account`
  function is running, or that waits for a retry's `/abort`. `close()` waits for that answer and those `/abort`s with
  every other `/abort` it waits for (`M8-L1`), with or without `abort`: a ticket that arrives then has no record a
  reload could resume.
- **Why:** reproduced on a server with a store and a quota of 1,000 bytes: `start()` of a 600-byte file, then
  `job.abort()` after the server had reserved and before its answer arrived. The fetch was cut, so no ticket came
  and nothing was aborted: the row stayed `pending`, and the owner's next `start()` was `QUOTA_EXCEEDED` until the
  sweep. The same through `close()`, and for a one-file retry's new `/upload` cancelled by the file's `abort()`.
  0.5.0 has the same code. `M4-F2` aborts the ticket that arrives for one file cancelled while the job's `/upload`
  goes on; when the whole ask was cancelled that ticket never arrived. The other choice was to document the cost. A
  person who picks the wrong file and cancels at once, then picks the right one, is the ordinary case, and the fix
  costs one request left open for its answer. It is safe: such a ticket was never given to a file, so it has no
  lock, no record, no `PUT` and no `/complete`, and a plain `/abort` of it can delete nothing finished.
- **If wrong:** what a cancelled `/upload` reserved still waits for the sweep when no answer reaches the page: the tab
  closed, the connection dropped, or the 30 seconds passed. Cancelled files are never retried (`M3-U37`), so nothing
  sends that ask's key again (`M11-R92`). The server does the work of an `/upload` whose caller cancelled, and a
  plugin's `onAbort` hears of each ticket. `close()` on a server that does not answer `/upload` resolves after up to
  40 seconds (the request's 30 and the `/abort`'s 10) instead of at once; it already waits up to 2 minutes for a
  `/complete` in flight. A custom `fetch` that keeps a request open past the client's timeout holds it as long.
- **Status:** in force. Amends `M4-F2` (a cancel of the whole ask), `M8-L1` (what `close()` waits for) and `M8-L2`
  ("its `/upload` in flight is cancelled").
- **Visible in:** `src/client/launch.ts` (`unlessCancelled`), `src/client/endpoints.ts` (`answerOnceSent`),
  `src/client/close.ts`, `src/client/cancelled-ask.test.ts`, `src/client/close.test.ts`, `src/client/resume.test.ts`,
  `src/client/types.ts`, `src/client.ts`, `docs/guide/client.md` ("Cancel", "Close the client").

### M11-R262: four behaviours of the client and the hooks that no test held now fail a test when removed

- **Decision:** four tests were added or made stronger, each seen red against the code with the named behaviour
  removed:

  | Behaviour | Test | Removed to see it fail |
  | --- | --- | --- |
  | `NOT_UPLOADED` ends a doubt, so a cancel afterwards sends `/abort` (`M11-R81`) | `src/client/upload-abort.test.ts`, "a doubt the server ended with NOT_UPLOADED" | `NOT_UPLOADED` in the list that clears the doubt (`upload.ts`): the cancel sent nothing |
  | A read of `useResumable` that answers after a newer one started does not replace the newer list | `src/react/rerender.test.ts`, "when an older read answers after a newer one" | `read === now.reads` (`use-resumable.ts`): the upload `forget()` had removed was listed again |
  | `useResumable` never shows the records of another factory (`M11-R5`, which was tested for a changed route only) | `src/react/rerender.test.ts`, "from another factory, without a remount" | `listed.source === source`: the first render of the second factory listed the first one's upload |
  | A ticket whose part plan the client refuses makes the whole `/upload` answer unreadable (`M11-R85`) | `src/client/endpoints.test.ts`, the six "refuses" rows of the part-plan table | the status in `unreadableAnswer(response.status)` replaced by `500`: the rows asserted the code alone and passed |

- **Why:** the final review found each behaviour stated in a decision or a comment and held by no assertion. The six
  refused rows of the part-plan table all get one message, "The upload server sent an answer this client cannot read
  (HTTP 200) ...", not retryable; none differs, and each row now asserts the code, the message and `retryable`.
- **If wrong:** nothing: tests only.
- **Status:** in force.
- **Visible in:** the three test files named above.

### M11-R263: the client, resume, React and Hono guides say what the code does, and every block of theirs compiles

- **Decision:** `docs/guide/client.md` ("Cancel", "Close the client") says what a cancel does with an `/upload` in
  flight (`M11-R261`) and that a resumed upload's `/abort` carries `keep` (`M11-R260`); `docs/guide/resume.md` ("The
  server is asked first") says when a resumed upload sends `keep`, what ends it, and what it costs with and without a
  store; `docs/guide/react.md` ("Resume after a reload") no longer says that Dismiss deletes what the upload sent
  "unless a `/complete` may have finished it", which a resumed upload did not honour before `M11-R260`.
  `docs/guide/hono.md`: the step 7 block imports the `API_ORIGIN` it uses, and step 10 names the row's Dismiss and its
  Reload after `ACCOUNT_CHANGED` (`M11-R12`) beside Cancel and Retry.
- **Why:** each sentence was wrong or silent about what the final review proved. The 34 `ts` and `tsx` blocks of the
  four guides were then type-checked against the workspace: each block written out as one module, with the context
  it assumes declared above it (a `createCloudrop` server with the routes `avatar`, `files` and `documents` for the
  client, resume and React guides; the Hono example's own server type, schema and components for the Hono guide;
  `declare` for the names a guide calls the app's own, such as `showError` and `getToken`), and `tsc --noEmit` run on
  them in `examples/vite-react` (28 modules) and `examples/hono` (5, the step 6 routes inside step 5's
  `createCloudrop`) against the built package. One block failed, the missing `API_ORIGIN`; a wrong route name, a
  wrong field of a result and a wrong option of `api.sweep`, each put into a block on purpose, were all reported. The
  blocks that show an example's code were read against `examples/hono/src`, `examples/vite-react/src` and
  `examples/next/components/upload`: none had drifted.
- **If wrong:** the harness was a scratch script and is not in the repository: a later change to a guide block is
  checked by nothing until someone repeats it. BullMQ, which step 8 of the Hono guide uses, is no dependency of the
  workspace, so its two constructors were declared by hand and only `uploads.api.sweep` was checked there.
- **Status:** in force.
- **Visible in:** `docs/guide/client.md`, `docs/guide/resume.md`, `docs/guide/react.md`, `docs/guide/hono.md`.

### M11-R264: `close()` also waits for an `/upload` whose files were all cancelled one by one

- **Decision:** every ask's runs are counted with the client's unanswered `/abort`s (`launch` in
  `src/client/launch.ts`), and the run of a file cancelled while its job's `/upload` goes on ends only once the
  `/abort` of the ticket that arrives for it was answered. `close()`, with or without `abort`, so resolves after that
  answer and that `/abort`, as `M11-R261` promises for a cancel of the whole ask.
- **Why:** found by the confirmation review and reproduced on a server with a store and a quota of 1,000 bytes:
  `start()` of a 600-byte file, then the file's own `abort()` after the server had reserved and before its answer
  arrived, then `close({ abort: true })`. The job left the client's jobs once its only file had ended, so `close()`
  resolved at once while the `/upload` was still to answer; the late ticket's `/abort` (`M4-F2`) was sent after
  `close()` had resolved, which a sign-out that clears the session right after could refuse.
- **If wrong:** `close()` waits for runs of jobs it no longer stops, at most what `M11-R261` already allows: the
  `/upload`'s 30 seconds and the `/abort`'s 10.
- **Status:** in force. Amends `M11-R261` (what `close()` waits for).
- **Visible in:** `src/client/launch.ts`, `src/client/cancelled-ask.test.ts`.
