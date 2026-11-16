# M2 plan decisions

The design decisions of the M2 plan (`docs/superpowers/plans/2026-11-15-m2-server.md`, section "Decisions"), numbered 1
to 32, in their final form. The plan text is the version before the audit; where the audit or execution changed a
decision, the entry gives the final wording and says what changed. "If wrong" is the cost of reversing the decision
later.

### M2-D1: the token carries metadata and name

- **Decision:** The upload token carries `metadata` and `name` themselves, not a `metadataHash`.
- **Why:** `/complete` takes only `{ token }` and `onComplete` needs the metadata; a hash would force the client to
  resend and persist it. Changing either still breaks the signature.
- **If wrong:** larger tokens; metadata is capped at 2 KiB (M2-D3) to bound them.
- **Status:** in force.
- **Visible in:** spec §5.2, `src/server/token.ts`.

### M2-D2: token format

- **Decision:** `base64url(JSON).base64url(HMAC-SHA256)`, payload `v: 1`. The signature is compared as base64url text
  in constant time, because 32 bytes have four base64 spellings. A token is expired from its `exp` second on. Tokens
  over 16,384 characters are refused before any HMAC.
- **Why:** text comparison closes the alternative-spelling forgery; the length cap stops HMAC work on junk.
- **If wrong:** a format change needs `v: 2` and a period accepting both.
- **Status:** amended by audit T3-1: the plan's cap of 8,192 characters was below the size of tokens `/upload` can
  issue. M2-X18 adds that `exp` must be a safe integer.
- **Visible in:** spec §5.2, `src/server/token.ts`.

### M2-D3: `owner` is the JSON of `authorize`'s result

- **Decision:** The token's `owner` is the JSON of `authorize`'s result, capped at 2 KiB, readable by the browser
  (signed, not encrypted), so it holds ids, not secrets. `onComplete` gets the token's copy, typed `Jsonified<T>` (a
  `Date` arrives as a string). Cloudrop's own `request`, `metadata` and `file` replace same-named fields of the result.
- **Why:** the server keeps no state between `/upload` and `/complete`.
- **If wrong:** apps that need richer objects at completion reload them by id.
- **Status:** in force. M2-X25 makes the JSON a single checked snapshot; M2-X6 requires a plain object.
- **Visible in:** spec §4 and §5.2, `src/server/upload.ts`, `src/protocol/types.ts` (`Jsonified`).

### M2-D4: `authorize` runs only at `/upload`

- **Decision:** No second `authorize` call at `/sign`, `/complete` or `/abort`. The token is the authority for its 24
  hours (spec §5.2); a session revoked mid-upload can still finish that one upload.
- **Why:** stateless endpoints; the token already binds the owner.
- **If wrong:** a revoked session finishes uploads already started, unless the app re-checks in `onComplete`.
- **Status:** in force, confirmed by the owner (M2-X3). The `onComplete` TSDoc says to re-check sessions there.
- **Visible in:** spec §5.2, `src/server/route.ts` (TSDoc), README "Uploads and the token".

### M2-D5: secrets

- **Decision:** Secrets are strings of at least 32 characters, from `secret` or `CLOUDROP_SECRET` through `fromEnv`,
  imported once at construction as non-extractable HMAC keys.
- **Why:** no request derives a key, and no plaintext secret is needed after start-up. The speed gain is small; the
  security gain is the reason.
- **If wrong:** none known.
- **Status:** in force. Audit T3-3 added a TSDoc warning to use one secret per deployment.
- **Visible in:** `src/server/config.ts`, `src/server/token.ts`.

### M2-D6: `unauthorized()` is a root export

- **Decision:** `unauthorized(message?)` is a root export, branded with the registered symbol
  `Symbol.for("cloudrop.unauthorized")` and recognised only on a plain object, so no authorize result can pass for a
  refusal.
- **Why:** spec §4's example uses it, and a module-private symbol fails when two copies of cloudrop are installed.
- **If wrong:** a foreign object carrying the registered symbol is treated as a refusal, which fails closed.
- **Status:** amended by audit T7-1 (the plan had a module-private symbol). Cross-copy `CloudropError` handling waits
  for M5 (reviews-m2.md, Task 7).
- **Visible in:** `src/server/route.ts`, `src/index.ts`.

### M2-D7: route options

- **Decision:** `authorize`, `accept` and `maxSize` are required. `maxFiles` is 1 to 100, default 10. Route names match
  `[A-Za-z0-9_-]{1,64}`. `prefix` and `key` are functions and mutually exclusive.
- **Why:** `maxFiles` bounds parallel storage calls per request; route names are echoed in messages, so they follow a
  safe pattern.
- **If wrong:** loosening a bound later is not breaking; tightening is.
- **Status:** in force. M2-X6 adds that `authorize` is written first.
- **Visible in:** spec §4, `src/server/route-config.ts`, `src/server/config.ts` (`ROUTE_NAME`).

### M2-D8: size strings are binary and exact

- **Decision:** `B`, `KB`, `MB`, `GB` and `TB` are binary (1 KB = 1,024 bytes), like `KiB` to `TiB`; case-sensitive, no
  space. A fraction that is not a whole number of bytes is refused, never rounded.
- **Why:** one meaning per unit; a limit must not silently shift.
- **If wrong:** users expecting decimal units get limits 2 to 10 percent larger than they wrote.
- **Status:** in force. M2-X17 replaced the plan's floating-point arithmetic with exact BigInt arithmetic.
- **Visible in:** `src/server/size.ts`.

### M2-D9: `accept` takes MIME entries only

- **Decision:** `accept` takes `*/*`, `type/*` and `type/subtype`. A table of 36 common types checks that the file
  name's extension agrees; a type outside the table is matched by MIME alone. A browser's empty type becomes
  `application/octet-stream`; a type with parameters is refused.
- **Why:** the browser's type is client-controlled; the extension check catches the cheap mismatch.
- **If wrong:** a missing table entry means that type is matched by MIME only.
- **Status:** amended by M2-X15: the plan said 37 types; the table has 36. Browser MIME aliases wait for M3 evidence.
- **Visible in:** `src/server/accept.ts`.

### M2-D10: keys

- **Decision:** `fileId` is the key's ULID. The extension comes from the name when it agrees with the type, else from
  the type's usual extension. An unusable key from the application's `prefix` or `key` function is a server bug: 500
  `SERVER_ERROR`, with the reason in the log.
- **Why:** the client never chooses the key (spec §5.3); a bad app key must not reach storage.
- **If wrong:** none known.
- **Status:** in force. M2-X20 adds that a prefix starting with `/` is such a bug.
- **Visible in:** spec §5.3, `src/server/key.ts`.

### M2-D11: Content-Disposition

- **Decision:** `inline` for `image/*` except SVG, and for `video/*` and `audio/*`; `attachment` otherwise, with a
  quoted ASCII `filename` and an RFC 5987 `filename*`.
- **Why:** an inline SVG or HTML file served from the bucket is stored XSS (spec §7.5).
- **If wrong:** some safe types download instead of displaying.
- **Status:** in force. M2-X18 makes any non-canonical type text fall to `attachment`.
- **Visible in:** spec §7.5, `src/server/key.ts`.

### M2-D12: `/upload` order

- **Decision:** bounds, then metadata, `authorize`, policy, `beforeUpload`, sign. `authorize` receives the validated
  metadata.
- **Why:** a quota reservation in `beforeUpload` must cover only files that will be signed. The original spec diagram
  ran the plugins before the policy; spec §5 was edited.
- **If wrong:** reordering changes which refusal a client sees first.
- **Status:** in force.
- **Visible in:** spec §5, `src/server/upload.ts`.

### M2-D13: policy failures are per file

- **Decision:** A file the policy refuses becomes a `{ kind: "rejected", error }` ticket and the others go on. Bounds,
  metadata, `authorize`, file count and plugin refusals fail the whole call.
- **Why:** one wrong file in a batch should not cancel the rest.
- **If wrong:** clients must handle mixed results, which the protocol types already describe.
- **Status:** in force. The final fix wave (reviews-m2.md, final m9) also turns a throw while starting one file into a
  rejected ticket.
- **Visible in:** `src/server/upload.ts`, `src/protocol/types.ts`.

### M2-D14: origins

- **Decision:** Same-origin means `Origin` equals the origin of the request URL the handler sees. `trustedOrigins` are
  exact origins, never `"*"`. A request without `Origin` is accepted as a server or native-app call unless
  `Sec-Fetch-Site: cross-site` shows a browser; `Origin: null` is refused. CORS answers carry the exact origin with
  credentials. A trusted preflight may name its own request headers. No `X-Forwarded-*` header is trusted: behind a proxy, list the public origin.
- **Why:** every browser sends `Origin` on POST; forwarded headers are spoofable unless a proxy is known.
- **If wrong:** operators behind proxies must list their public origin.
- **Status:** amended by audit T8-3 (the `Sec-Fetch-Site` refusal) and M2-X33 (a log hint names the origin to list).
  The Node adapter keeps only the Host header's origin and reads HTTP/2 `:authority` when there is no Host
  (reviews-m2.md, Task 14 I1 and final I1); since M3-H10 it answers 400 when the request names no single valid host.
- **Visible in:** spec §7.2, `src/server/http.ts`, `src/server/handler.ts`, `src/node.ts`.

### M2-D15: body cap

- **Decision:** A declared `Content-Length` over 65,536 bytes is answered 413 unread; a stream is cancelled once it
  passes the cap. The Node adapter answers the 413 and drains the rest of an oversized body in the background, bounded
  by Node's `requestTimeout`.
- **Why:** every endpoint body is small JSON; the drain lets the socket close promptly instead of waiting for Node's
  timeout.
- **If wrong:** none known.
- **Status:** amended in Task 14: the plan said to leave the rest for Node to discard; the measured drain is faster.
- **Visible in:** spec §7.3, `src/server/http.ts`, `src/node.ts`.

### M2-D16: errors on the wire

- **Decision:** One HTTP status per `CloudropErrorCode`, from `STATUS` in `http.ts` only. Storage failures become
  `STORAGE_ERROR` (or `RATE_LIMITED`) with a generic message. Any throw becomes 500 `SERVER_ERROR`, retryable only when
  `afterVerify` or `onComplete` failed after verification. Option `logger: { error, warn }`, default `console`.
- **Why:** clients branch on code and `retryable`; the full error goes to the log, never the wire.
- **If wrong:** a status change is a protocol change for M3's classifier.
- **Status:** amended by audit T11-1 (`afterVerify` retryable), by M2-X26 (an unknown code never answers 200), by the
  final fix wave (one status source; a storage 501 is not retryable) and by M2-X34 (a stale part is retryable).
- **Visible in:** `src/server/http.ts`, `src/storage/storage-error.ts`, `src/errors.ts`.

### M2-D17: error codes

- **Decision:** New codes `UNAUTHORIZED`, `ORIGIN_NOT_ALLOWED`, `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE`,
  `BODY_TOO_LARGE`, `UNKNOWN_ROUTE`, `INVALID_METADATA`, `TOO_MANY_FILES`, `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`,
  `INVALID_TOKEN`, `UPLOAD_EXPIRED`, `NOT_UPLOADED`, `PARTS_MISSING`, `VERIFICATION_FAILED`, `SERVER_ERROR`. Reused:
  `NOT_FOUND` (no endpoint at that path), `ALREADY_EXISTS` (completion collision), `NO_SUCH_UPLOAD` (aborted or
  expired). `CloudropError` gains `parts`. `UPLOAD_REJECTED` is a client classification and arrives in M3.
- **Why:** each refusal a client can act on differently has its own code.
- **If wrong:** removing a code is breaking; adding one is not.
- **Status:** in force.
- **Visible in:** `src/errors.ts`, `src/server/http.ts`.

### M2-D18: constants, not options

- **Decision:** Token and URL lifetimes and the 20-part batch are constants; `multipartThreshold` is the one tunable.
- **Why:** an option cannot be taken back; add one when a caller needs it.
- **If wrong:** adding an option later is not breaking.
- **Status:** in force.
- **Visible in:** spec §5.1 and §5.2, `src/server/presign.ts`, `src/server/token.ts`.

### M2-D19: verification

- **Decision:** For a single PUT, a HEAD must show the token's `cloudrop-id`, size and type. Another writer's id gives
  `VERIFICATION_FAILED` and the object stays; a wrong size or type deletes the object and gives `VERIFICATION_FAILED`.
  For multipart, a missing or wrong-sized part is `PARTS_MISSING`. Completion uses the server's part list and ETags with
  `If-None-Match: *`.
- **Why:** R2 accepts a wrong-sized part at UploadPart and refuses it only at completion (spike Q4); the server must not
  trust the client's part list.
- **If wrong:** a backend that rewrites `Content-Type` (adds a charset) fails every single PUT of that type; unmeasured.
- **Status:** in force. M2-X28 adds that a 412 on this upload's own object is an idempotent retry and that a failed
  delete keeps the reservation; M2-X34 makes a stale part retryable.
- **Visible in:** spec §5.4 and §7, `src/server/complete.ts`.

### M2-D20: `/abort`

- **Decision:** An expired token may abort an incomplete multipart upload but never deletes a stored object. A live
  token can delete its own stored object (matched by `cloudrop-id`), even after completion, until `exp`. Retained
  objects keep their reservations; `onAbort` runs only when nothing from the upload is kept.
- **Why:** spec §5.5 requires `/abort` to clean up; without the delete, a single-PUT object nobody completes is an
  orphan the lifecycle rule cannot clean.
- **If wrong:** a live token is a 24-hour delete capability for its own file (owner-accepted, M2-X1); the 1.1 database
  adapters close it.
- **Status:** amended by audit T10-1 (the plan let an expired token delete) and owner ruling M2-X1. `/abort` works even
  when a deploy removed the token's route (reviews-m2.md, final I3). M2-X27 says `/abort` is not revocation.
- **Visible in:** spec §5.5, `src/server/abort.ts`, `src/server/token-request.ts`.

### M2-D21: plugins

- **Decision:** `{ id, server?: { beforeUpload, afterVerify, onAbort, extendRoute } }`. A hook refuses by returning a
  `CloudropError`; the first refusal stops the rest. `onAbort` runs when a file a plugin's `beforeUpload` accepted is
  refused, cannot be started, is rejected or collides at `/complete`, or is cancelled through `/abort`. Nothing runs at
  token expiry, so a reservation needs its own expiry. Hooks can run more than once for one file, so reserve and release
  are idempotent by `file.id`. `onAbort` errors are logged and never stop the others. `extendRoute` may throw
  `INVALID_CONFIG` at construction.
- **Why:** M5's `limits()` plugin needs reserve-and-release hooks around a stateless server.
- **If wrong:** M5 reshapes the hook contract before 1.0.
- **Status:** amended by audit T10-2 (`onAbort` only when nothing is kept) and by the Task 17 review, which removed the
  plan's promise that `onAbort` runs for every file that will not complete. `extendRoute`'s design belongs to M5
  (M2-P4).
- **Visible in:** spec §8, `src/server/plugins.ts`, `src/server/config.ts`.

### M2-D22: visibility

- **Decision:** A route is public by default when the storage has `publicUrl`, otherwise private. Public without
  `publicUrl` is `INVALID_CONFIG`; a private route on a storage with `publicUrl` warns at construction. `file.url` is
  `null` on private routes.
- **Why:** spec §7.8; a URL that does not work must not be returned.
- **If wrong:** none known.
- **Status:** in force.
- **Visible in:** spec §7.8, `src/server/route-config.ts`.

### M2-D23: `api.getUrl`

- **Decision:** Without options it returns the plain public URL. Otherwise it signs a GET at the start of an
  `expiresIn` window (1 to 302,400 s, default 3,600 s), valid for two windows, so every viewer in a window shares one
  URL with at least `expiresIn` seconds left. `download` is a signed `response-content-disposition`.
- **Why:** shared URLs cache well; two windows guarantee the promised remaining lifetime.
- **If wrong:** none known. Wrangler ignores `download` (gap `responseOverrides`); R2 and RustFS apply it (measured).
- **Status:** in force. The Task 13 review made `expiresIn: null` mean "omitted" in both places it is read.
- **Visible in:** spec §9, `src/server/api.ts`, `docs/research/test-backends.md`.

### M2-D24: `api.deletePrefix`

- **Decision:** The prefix must be a folder ending in `/`, so `users/4/` never matches `users/42/`, and a prefix no key
  can start with (leading slash, control characters) is refused. It lists from the start after each page, refuses
  listed keys outside the prefix, fails when keys it just deleted reappear, stops after 10,000 pages and returns
  `{ deleted, verifiedAt }`.
- **Why:** it serves erasure requests, so `verifiedAt` must be a real proof.
- **If wrong:** none known.
- **Status:** amended by the Task 13 review (refuse an unmatchable prefix). See also M1-R17.
- **Visible in:** spec §9, `src/server/api.ts`.

### M2-D25: `api.checkBucket`

- **Decision:** It reads the bucket's CORS and lifecycle through two new driver reads (allowed by M1-R20).
  `STORAGE_DENIED` becomes `unknown`: R2 object tokens get 403 for both reads (measured). It checks the given origins,
  default `trustedOrigins`, as exact canonical origins. With `NODE_ENV === "development"` exactly, the first request
  runs it once in the background and logs each problem.
- **Why:** a missing CORS or abort-incomplete lifecycle rule is the most common setup failure.
- **If wrong:** the success path with an admin read token is unmeasured; it follows S3's documented codes.
- **Status:** amended by M2-X22 and M2-X40 (an unexplained 404 is a non-retryable storage error).
- **Visible in:** spec §9 and §12, `src/server/bucket-check.ts`, `src/storage/s3/bucket-settings.ts`.

### M2-D26: Node types for `cloudrop/node`

- **Decision:** Structural `NodeRequest` and `NodeResponse` interfaces live in `src/node.ts`; the library tsconfig keeps
  `types: []`. `node.test.ts` passes the adapter to `http.createServer`, which `tsconfig.test.json` checks against real
  Node types.
- **Why:** M1-R5.
- **If wrong:** none known.
- **Status:** in force.
- **Visible in:** `src/node.ts`, `src/node.test.ts`, `AGENTS.md`.

### M2-D27: adapters take `{ handler }` only

- **Decision:** `cloudrop/next` and `cloudrop/node` take `{ handler }` and import no server code. `toNextHandler`
  returns `GET`, `POST` and `OPTIONS`.
- **Why:** adapter bundles stay small and independent of the server module.
- **If wrong:** none known.
- **Status:** in force. M2-X29 adds construction-time validation of `{ handler }`.
- **Visible in:** spec §4, `src/next.ts`, `src/node.ts`.

### M2-D28: metadata

- **Decision:** A route without a schema refuses any metadata, including `null`. With a schema, the first issue's
  message (at most 200 characters including its path, line breaks normalised) reaches the client. A schema that throws
  is a server bug.
- **Why:** unvalidated client data must not be signed into the token.
- **If wrong:** none known.
- **Status:** amended by audit T5-1 (the 200-character bound includes the path) and M2-X19 (log-safe text; a schema
  output JSON cannot encode is a server bug).
- **Visible in:** `src/server/schema.ts`.

### M2-D29: client types

- **Decision:** `Cloudrop<TRoutes>` extends the protocol's `InferableCloudrop` through a type-only `"~routes"` property.
  `RouteName`, `RouteMetadata` (the schema's input type) and `RouteResult` (`Jsonified` of `onComplete`'s awaited
  result, `null` without one) read it. `authorize` must be written before the callbacks that use its result.
- **Why:** M3's client infers everything from `typeof cloudrop`.
- **If wrong:** a builder API would lift the ordering rule at the cost of the one-object route shape.
- **Status:** amended by audit T12-1 (the plan claimed either order works; it does not) and owner ruling M2-X6.
- **Visible in:** `src/protocol/types.ts`, `src/server/route.ts`, `src/server/types.test.ts`.

### M2-D30: deferred M1 items, folded in

- **Decision:** `configError` lives once, in `errors.ts`. `head()` refuses an answer without an ETag. Credential
  scrubbing walks the whole cause chain (depth 8). The `test-backends.md` "after both runs" wording is fixed.
- **Why:** M1 left these open.
- **If wrong:** none.
- **Status:** closed in Task 1 (`c0d5b92`, `configError`) and Task 6 (`91fb510`, `916b152`); M2-X21 hardens the scrub.
- **Visible in:** `src/errors.ts`, `src/storage/s3/objects.ts`, `src/storage/s3/transport.ts`.

### M2-D31: the live lane

- **Decision:** `bun run test:live` runs the storage contract and the server lane. The server lane uses a random secret
  per run and a route whose prefix is the run prefix. Each lane prints its run prefix once, so a stopped run can name
  what to clean.
- **Why:** live tests write only under `live-test/cloudrop-<random>/` and delete what they create.
- **If wrong:** none.
- **Status:** amended: the prefix printing was met only in letter until `d5dacc2` (reviews-m2.md, final m13).
- **Visible in:** `scripts/test-live-r2.ts`, `src/server/handler.r2.integration.test.ts`.

### M2-D32: no-store on every handler response

- **Decision:** Every handler response, including the preflight, carries `cache-control: no-store`.
- **Why:** responses hold tokens and presigned URLs.
- **If wrong:** none.
- **Status:** in force (M2-X26 added the preflight).
- **Visible in:** `src/server/http.ts`.
