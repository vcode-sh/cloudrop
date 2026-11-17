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
  `xmlTexts`) trims, for numbers, dates, booleans, codes, ETags (quoted hex, never meaningful whitespace) and the CORS
  lists. Keys, upload IDs, continuation tokens and the lifecycle rule's ID and prefix are read with `xmlText`.
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
- **Why:** audit F11. `StorageDriver` is public; a custom driver whose `presignPart` throws left an open upload that
  held its parts until the bucket's lifecycle rule removed it.
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
  `abortContexts(shared, files, reason)` in `plugins.ts` builds the `onAbort` contexts for `runBeforeUpload`, `/upload`
  and `tokenAbortContexts` (which replaces `abortContext` for `/abort` and `/complete`). Two parts of the design's list
  were narrowed: `allOk` stays in `storage/s3/responses.ts` instead of moving to `errors.ts`, and `node.ts` keeps its
  copy loop.
- **Why:** design §4 accepted the simplifications. In `errors.ts`, `allOk` lands in the chunk `cloudrop/next` and
  `cloudrop/node` import, measured +0.11 kB gzip on both summed budgets (1.12 of 1.1 kB, 3.21 of 3.2 kB) for code
  neither runs. `NodeRequest` yields `Uint8Array<ArrayBufferLike>`, which `BlobPart` accepts only through an `as`;
  narrowing the public type would break only hand-built requests (a real Node stream is typed `any`), still not worth
  it for a loop of six lines.
- **If wrong:** none in behaviour: every existing test passes unchanged. `server/presign.ts` importing from
  `storage/s3/` is the cost of the first narrowing.
- **Status:** in force.
- **Source:** design §4, audit F13 (S1 to S4).
- **Visible in:** `server/complete.ts`, `server/presign.ts`, `server/http.ts` (`readJson`), `server/plugins.ts`
  (`abortContexts`), `server/token-request.ts` (`tokenAbortContexts`), `server/upload.ts`, `server/abort.ts`.

### M4-F14: a bundled-and-minified budget for `cloudrop`

- **Decision:** `scripts/size-limit.config.ts` adds "cloudrop (bundled)": `dist/index.js` bundled and minified with
  every export, gzip, limit 23.5 kB (21.33 kB measured plus about 10%), beside the summed 36 kB budget, which stays.
- **Why:** audit F14. The summed budget counts the published files with their doc comments and messages (34.08 kB
  now); what a Workers app ships is the bundle, which the summed figure overstates by about 60%.
- **If wrong:** an app that imports only part of the server ships less than this budget, so it bounds the worst case,
  not the typical one.
- **Status:** in force.
- **Source:** design §4, audit F14.
- **Visible in:** `scripts/size-limit.config.ts`.

<!-- Task B appends its entries above this line. -->

### API, configuration and documentation (design §5, `M4-F15` to `M4-F21`)

### M4-F15: `route(policy, callbacks?)`; the single-object form is gone

- **Decision:** `route()` takes two arguments. The first, `RoutePolicy`, holds `accept`, `maxSize`, `maxFiles`,
  `metadata`, `visibility` and `authorize`; the second, optional `RouteCallbacks`, holds `prefix`, `key` and
  `onComplete`. Inside each object any order compiles. The single-object form is removed with no shim (pre-1.0), and
  the public type `RouteOptions` is replaced by `RoutePolicy` and `RouteCallbacks`. An option in the wrong argument is a
  type error (excess property) and, for JavaScript callers, `route()` throws `INVALID_CONFIG` naming the option and the
  argument it belongs in; `route-config.ts` still validates the merged definition at `createCloudrop`, and plugins'
  `extendRoute` still sees one merged `RouteDefinition`.
- **Why:** TypeScript infers type arguments from context-sensitive callbacks left to right within one object literal,
  so a callback written before `authorize` fixed `TAuth` at `object` (design §5.1, verified on tsc 7.0.2; `NoInfer`,
  inferring the whole `authorize` and wrapper helpers do not fix it). Callbacks in a later argument are inferred after
  the whole first argument. The placement check runs in `route()` because it is the only place that sees the two
  objects apart; silently ignoring a misplaced `prefix` would store files at the bucket root.
- **If wrong:** every route in an app moves to the new form, a mechanical change. A third-party wrapper that built
  routes from one object must split it.
- **Status:** in force. Amends M2-X6 (the ordering rule).
- **Source:** design §5.1, owner request 2026-11-17.
- **Visible in:** `server/route.ts`, `server/types.test.ts` (callbacks in every order, `metadata` after `authorize`),
  `server/route.test.ts`, every `route(` call in `src/`, `examples/next/lib/cloudrop.ts`, `README.md`,
  `docs/guide/server.md`, the design spec §4 sample.

### M4-F16: settings from the environment are read on the first request

- **Decision:** `CLOUDROP_SECRET` (when `secret` is omitted) and a storage preset's variables are read on the first
  request through one memoized reader, `ServerConfig.ready()` (`server/environment.ts`), which the handler awaits
  before any endpoint and every `cloudrop.api` call awaits too. Endpoints receive the resolved token keys
  (`EndpointConfig.tokenKeys`). Every option that needs no environment value, and every value passed explicitly
  (including `secret`), is still checked at construction. With `NODE_ENV === "development"` exactly, the environment
  is read at construction too, so `next dev` fails at start. A value missing at request time:
  1. The handler answers `SERVER_ERROR` 500 (with CORS headers for a trusted origin) and logs once
     `cloudrop: every request answers 500 until this is fixed. <message>` with the `INVALID_CONFIG` as the error; it
     logs again only when the message changes (a partial fix). Preflight, 404 and 405 answers need no environment.
  2. `cloudrop.api.*` resolve `{ data: null, error }` with that `INVALID_CONFIG`.
  3. Recovery, ruled: each request reads the environment again until it is complete, then the result is kept for the
     life of the server (per setting: token keys and the storage driver are memoized separately). A fixed environment
     recovers without a restart; a later change to the environment is not picked up.
  4. The message is the one construction used to throw, and when the storage and the secret are both missing the two
     messages are joined into one `INVALID_CONFIG`, so a first setup sees everything at once.
- **Why:** `next build` evaluates the route module while collecting page data, so a construction-time read made every
  build need production secrets (M3-H14's predicted cost). Workers bind the environment per request; reading at the
  first request, never at import, works there. Re-reading until success costs one failed lookup per request on a
  broken server and saves a restart once it is fixed; memoizing after success keeps the hot path free of environment
  reads and key imports.
- **If wrong:** a misconfigured production server starts and fails on its first request instead of at boot, which a
  health check that hits the handler catches; development still fails at start.
- **Size:** M4-F15 to M4-F18 together take the summed `cloudrop` budget from 34.09 to 36.33 kB gzip (published files
  with their doc comments) and the bundled one from 21.32 to 22.16 kB, measured 2026-11-17 against `c31a8b0`. The
  bundled budget (23.5 kB, M4-F14) holds; the summed one rises from 36 to 40 kB, the measured size plus about 10% as
  `scripts/size-limit.config.ts` prescribes. `readSetting` lives in `storage/lazy-driver.ts`, not `errors.ts`, which
  would have put it in the chunk `cloudrop/next` and `cloudrop/node` import (+0.15 kB each, measured).
- **Status:** in force. Amends M3-H14.
- **Source:** design §5.2.
- **Visible in:** `server/environment.ts`, `server/config.ts` (`ready`, `EndpointConfig`), `server/handler.ts`,
  `server/api.ts`, `server/cloudrop.ts` (TSDoc), `server/environment.test.ts`, `storage/lazy-driver.ts`
  (`readSetting`), `scripts/size-limit.config.ts`.

### M4-F17: `r2()` and `s3()` read every setting from the environment, lazily

- **Decision:** `s3()` reads `CLOUDROP_S3_ENDPOINT`, `CLOUDROP_S3_REGION`, `CLOUDROP_S3_BUCKET`,
  `CLOUDROP_S3_ACCESS_KEY_ID` and `CLOUDROP_S3_SECRET_ACCESS_KEY`; `r2()` adds `CLOUDROP_R2_BUCKET` to its three. Both
  take no argument at all. An option wins over its variable; an unset or empty option, and an empty variable, count as
  unset (so an empty `bucket` option is no longer a bucket-name error: it falls back to the variable). One
  `INVALID_CONFIG` names every missing setting by option and variable: "Missing S3 settings: region
  (CLOUDROP_S3_REGION), … Pass them to s3() or set the environment variables in parentheses." When any setting comes
  from the environment, the preset returns a lazy driver (`storage/lazy-driver.ts`) that builds the real driver on
  first use under M4-F16's rules: every method answers that `INVALID_CONFIG` until the settings are complete, and the
  server reads its state through a module-private `WeakMap`, so `StorageDriver` gains no public member. When every
  setting is passed, the preset returns the real driver, as before.
- **Why:** design §5.3: a cold-developer test found `s3()` read nothing. Explicit values are checked at construction by
  building the driver once with valid stand-ins for the settings the environment will supply: every check stays in
  `createS3Driver` and the presets, in one place, instead of a second per-setting copy that could drift. `rules` and
  `publicUrl` need no environment value, so route checks at construction still see them.
- **If wrong:** an app that relied on an empty `bucket` throwing at construction now learns at the first request.
- **Status:** in force.
- **Source:** design §5.3.
- **Visible in:** `storage/presets.ts`, `storage/lazy-driver.ts`, `storage/presets-env.test.ts`,
  `storage/presets.test.ts`, `examples/next/lib/cloudrop.ts` (`CLOUDROP_S3_ENDPOINT ? s3() : r2()`),
  `docs/guide/server.md`.

### M4-F18: `forbidden(message?)` answers `403 FORBIDDEN`

- **Decision:** `forbidden(message = "You are not allowed to upload files here.")` is exported beside
  `unauthorized()` and returned from `authorize`; `/upload` answers `403` with code `FORBIDDEN`, not retryable.
  Both return the public type `Refusal`, which replaces `Unauthorized`: the same `Symbol.for("cloudrop.unauthorized")`
  brand plus `code: "UNAUTHORIZED" | "FORBIDDEN"`. A branded refusal without a code (another copy of cloudrop, plain
  JavaScript) still means `UNAUTHORIZED`, and a missing message takes the default of its code. Plugin hooks return a
  `CloudropError`, never a `Refusal`, so a plugin refuses with `new CloudropError("FORBIDDEN", message)`.
  `FORBIDDEN` joins `CloudropErrorCode` and the handler's status table; the client keeps no list of server codes, so
  it needs no change.
- **Why:** design §5.4: a quota, plan or role refusal answered `UNAUTHORIZED`, telling the user to sign in when they
  already had. One brand keeps foreign copies' refusals recognised; one type keeps `authorize`'s return type
  `TAuth | Refusal`, so TypeScript never infers a second refusal type into `TAuth`.
- **If wrong:** code naming the `Unauthorized` type renames it to `Refusal`.
- **Status:** in force.
- **Source:** design §5.4.
- **Visible in:** `server/route.ts` (`forbidden`, `Refusal`, `refusalError`), `server/upload.ts`, `server/http.ts`,
  `errors.ts`, `index.ts`, `docs/guide/errors.md`, `docs/guide/server.md` (the quota plugin example).

<!-- Tasks C and E append their entries above this line. -->

## Bindings (`M4-B`)

<!-- Task D appends its entries above this line. -->
