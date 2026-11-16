# M3 vertical slice decisions

Decisions of the M3 vertical slice (2026-11-16): the browser client `cloudrop/client`, the Next.js example
`examples/next` and the browser lanes. Plan: `docs/superpowers/plans/2026-11-16-m3-vertical-slice.md`, section
"Decisions".

Numbering:

- `M3-S1` to `M3-S26` are the plan's decisions S1 to S26, with the same number. `M3-S27` is the `NoInfer` return type of
  `route()` (plan audit I-2), which the plan carried without a number.
- `M3-S28` upward are the controller's rulings during execution. The slice's ledger names them `S-1` to `S-17`, with a
  hyphen; that list is not the plan's, so ledger `S-4` is `M3-S29`, never `M3-S4`. Each entry names its ledger id.

Plan decisions without an entry here, because an earlier entry holds them or they change neither behaviour nor a
public contract:

- S4, the 31 names of `cloudrop/client`: `M3-O1` as scoped by `M3-H13`, the count fixed in `M3-H15`.
- S5, the client codes `UPLOAD_REJECTED`, `ABORTED` and `NETWORK_ERROR`: `M3-O3`.
- S6, `invalidInput` and `isPlainObject` moved to `src/input.ts`: an internal move under `M2-X35` (`5421196`).
- S19, the lint rule that keeps server and storage code out of the client (`biome.json`, the override for
  `src/client.ts` and `src/client/**`): it enforces a global constraint and changes no behaviour.
- S24, measuring the browser on live R2: done once; the results are in `docs/research/r2-spike-findings.md`
  ("Browser, 2026-11-16").
- S25, `src/server/protocol.test.ts` stays: a test-suite choice.

Commit ids below are on the branch `feat/m3-slice`. Paths are under `packages/cloudrop/src/` unless they say
otherwise.

## Plan decisions

### M3-S1: one file per `upload()` call

- **Decision:** `upload(route, file)` takes one `File` and resolves to one `{ data, error }`.
- **Why:** one file maps one-to-one onto a result without a per-file result inside a result. Several files per
  `/upload` request (spec §5.4) belong to the scheduler plan.
- **If wrong:** accepting an array later widens the parameter, a non-breaking change; a hook API built on the
  single-file call in M4 may need reshaping then.
- **Status:** in force (`bc06db2`); owner accepted (M3-O4). The scheduler plan owns several files and `error.file`.
- **Visible in:** `client.ts` (`CloudropClient`), spec §6.4.

### M3-S2: the signature of `upload()`

- **Decision:** `upload(route, file, options?)` with `options = { metadata?, signal? }`. `route` is
  `RouteName<TCloudrop>`, `metadata` is `RouteMetadata<TCloudrop, TName>`, and the options argument is required
  exactly when the route's metadata is (`UploadArguments`). `upload` does not use `this`, so
  `const { upload } = createCloudropClient()` works.
- **Why:** the route's schema already says whether metadata is required; the types make a missing one a compile error.
- **If wrong:** every parameter is a semver promise; changing one after release is breaking.
- **Status:** in force (`bc06db2`).
- **Visible in:** `client.ts` (`UploadOptions`, `UploadArguments`, `CloudropClient`), `client/types.test.ts`.

### M3-S3: the result of `upload()` is the `/complete` answer

- **Decision:** `upload()` resolves to `Result<CompleteResponse<RouteResult<TCloudrop, TName>>>`: the stored file
  (`data.file`) and what the route's `onComplete` returned (`data.data`), `null` without one. No new result type.
- **Why:** the wire type already carries both, and `RouteResult` is already the JSON form of `onComplete`'s result.
- **If wrong:** a client-side result type would have to be added beside the wire type, and both promised.
- **Status:** in force (`bc06db2`). An inline route without `onComplete` types as `null` since M3-S27.
- **Visible in:** `client.ts`, `protocol/types.ts` (`CompleteResponse`).

### M3-S7: the plan in the token decides the parts

- **Decision:** the client never plans an upload. It numbers parts `1..partCount` and cuts part `n` with `sizeOfPart`
  from `plan.ts`, the function the server signs and verifies with. A multipart ticket whose `partCount` differs from
  `countParts(file.size, partSize)` is refused as an unreadable answer.
- **Why:** a server and client of different versions must fail, not upload wrong byte ranges.
- **If wrong:** a future planner change must keep `sizeOfPart` shared, or the client refuses every ticket.
- **Status:** in force (`6f533c8`, `bc06db2`).
- **Visible in:** `client/answers.ts` (the `partCount` check), `client/upload.ts` (`bodyOf`).

### M3-S8: `fetch` everywhere, with the credentials mode per request

- **Decision:** the slice sends every request with `fetch`. Bucket `PUT`s send exactly the ticket's headers with
  `credentials: "omit"`. Endpoint `POST`s send `content-type: application/json` with `credentials: "include"`, so a page
  on a trusted origin sends its session cookie, also to a cross-origin server the app lists in `trustedOrigins`.
- **Why:** a presigned URL needs no cookie, and a credentialed `PUT` would also need
  `Access-Control-Allow-Credentials` from the bucket: RustFS and Wrangler both make the browser block it
  (`docs/research/2026-11-16-m3-slice-measurements.md` §1, §2). Upload progress needs XHR (spec §3 item 5), which the
  progress plan adds.
- **If wrong:** an app that must not send cookies to its own upload server has no option to turn them off yet.
- **Status:** in force (`b0690aa`, `6f533c8`); owner accepted (M3-O4).
- **Visible in:** `client/bucket.ts` (`putObject`), `client/endpoints.ts` (`post`).

### M3-S9: the retry budget

- **Decision:** at most 6 attempts per request, the first included. Before attempt `k + 1` the client waits a random
  time in `[0, min(20 s, 0.5 s · 2^(k - 1))]` (full jitter), and at least the answer's `Retry-After`, capped at 20 s.
  Endpoint calls are retried when the error is `retryable` or there was no answer, `/upload` included. A part's
  attempts and the `/sign` calls it needs share one budget.
- **Why:** spec §6.2's first row ("0.5 s to 20 s, up to 6 attempts, honouring `Retry-After`"); the cap keeps a server's
  `Retry-After` from stalling the client. Not retrying `/upload` would make a brief network drop fail the file.
- **Bound, computed from `client/retry.ts`:** the five waits have ceilings of 0.5, 1, 2, 4 and 8 s, so without
  `Retry-After` one request waits at most 15.5 s in all and the 20 s ceiling never binds; with a `Retry-After` of
  20 s or more on every answer, at most 100 s. The ceiling reaches 20 s only at attempt 7 or later (uncapped, attempt 7
  would allow 32 s), which the budget never runs.
- **If wrong:** a retried `/upload` whose first request reached the server orphans a multipart upload until the
  lifecycle rule runs and holds a future quota reservation until it expires (M2-X27).
- **Status:** in force (`b0690aa`); owner accepted (M3-O4). Amended by M3-S29 (`Retry-After` on a proxy's 429 and on
  `/sign`).
- **Visible in:** `client/retry.ts` (`MAX_ATTEMPTS`, `retryDelay`, `withRetry`), `client/parts.ts` (`nextStep`).

### M3-S10: what the client does with each bucket answer

- **Decision:** a `PUT` to the bucket is classified by status; the S3 code is read only to split 403:

  | Answer | Outcome | Error once attempts run out |
  |---|---|---|
  | 2xx, or 412 (a retried create-only `PUT` whose first attempt landed) | stored | none |
  | `fetch` threw, signal not aborted | opaque: renew the URL once, wait, retry | `NETWORK_ERROR`, retryable |
  | 403 `SignatureDoesNotMatch` | rejected, never retried | `UPLOAD_REJECTED` |
  | any other 403 | expired: renew once, retry at once; refused again, the file fails | `UPLOAD_REJECTED` |
  | 429, 503 | wait, retry | `RATE_LIMITED`, retryable |
  | 501 | rejected | `UPLOAD_REJECTED` |
  | 408, other 5xx | wait, retry | `STORAGE_ERROR`, retryable |
  | any other 4xx | rejected | `UPLOAD_REJECTED` |

- **Why:** status, never the S3 code, as the server's driver classifies (R2 sends 429 with the code
  `ServiceUnavailable`, spike Q9). Every readable 403 except a bad signature counts as expired because RustFS reports
  an expired URL as `403 AccessDenied` (`docs/research/test-backends.md`, RustFS table). The opaque row is R2's real
  answer: an expired URL's 403 carries no CORS headers, so Chromium blocks it and `fetch` rejects
  (`docs/research/r2-spike-findings.md`, "Browser, 2026-11-16", row U2, matching R2's CORS documentation). RustFS and
  Wrangler answer a readable 403, so on them the "expired" row runs; only unit tests and live R2 reach the opaque row.
  Whether R2's other refusals (`403 SignatureDoesNotMatch`, a `400`) are readable from a page is unmeasured: the rows
  that end in `UPLOAD_REJECTED` are proven on the fake and RustFS only. If R2 sends them without CORS headers too, a
  browser sees them as opaque, and the file ends in a retryable `NETWORK_ERROR` after up to about 15 s of retries
  (`r2-spike-findings.md`, "Not verified").
- **If wrong:** a readable 403 that meant a permission problem costs one extra `/sign` before the file fails.
- **Status:** in force (`b0690aa`, renewal in `6fd5f14`); owner accepted (M3-O4).
- **Visible in:** `client/bucket.ts` (`classifyAnswer`, `putObject`), `client/failures.ts`.

### M3-S11: URL renewal

- **Decision:** a URL with less than 60 s left by the client's clock is renewed through `/sign` before it is used.
  After an opaque or expired outcome a part's URL is renewed once per part per `sendParts` call; a renewed URL refused
  as expired again fails the file at once. A renewal whose `/sign` failed is still owed: the next attempt does not
  reuse the refused URL. `/sign` renews one part or the single `PUT`.
- **Why:** spec §6.2's second row. A fresh URL refused again points at a clock or permission problem that more
  attempts cannot fix; a client clock that runs ahead costs one `/sign` per part, never a loop.
- **If wrong:** a backend that refuses a fresh URL once by accident fails the file instead of retrying.
- **Status:** in force (`6fd5f14`; the owed renewal in `54430a6`).
- **Visible in:** `client/parts.ts` (`RENEW_MARGIN_MS`, `urlFor`, `sendPart`).

### M3-S12: parts in flight and lazy signing

- **Decision:** at most 4 parts of a file in flight. Parts the ticket carried no URL for are signed when a worker
  reaches them, up to 20 per `/sign` (`PARTS_PER_SIGN`), and other workers wait on that call. The first part that
  fails for good fails the call: requests already sent finish, but no new part and no new attempt of another part
  starts, and a part waiting to retry stops waiting.
- **Why:** spec §6.1 and §6.2; 8 parallel parts on one key were not throttled on R2 (spike Q9). Once the file has
  failed, a part retrying with `Retry-After` would otherwise hold the answer for up to about 100 s (M3-S9) and send
  bytes nobody will complete (final review, Minor 5).
- **If wrong:** a large file uploads more slowly than the shared pool of the scheduler plan will allow.
- **Status:** in force (`6fd5f14`; the stop after a failure in `7bf1d89`).
- **Visible in:** `client/parts.ts` (`PARTS_IN_FLIGHT`, `signAhead`, `sendParts`).

### M3-S13: at most two `PARTS_MISSING` repair rounds

- **Decision:** when `/complete` answers `PARTS_MISSING` with part numbers, the client sends exactly those parts and
  completes again, at most 2 repair rounds (3 `/complete` answers), then returns the `PARTS_MISSING` error.
- **Why:** spec §6.3 gives no bound; without one a part that never lands would loop.
- **If wrong:** a bucket that loses a part three times running fails the file; the resume plan's `retry()` re-sends.
- **Status:** in force (`bc06db2`).
- **Visible in:** `client/upload.ts` (`REPAIR_ROUNDS`, `sendAndComplete`).

### M3-S14: cancellation

- **Decision:** `options.signal` reaches every request except `/complete` and `/abort`, and every backoff pause. A
  signal already aborted starts no request. After a cancel the client returns `ABORTED` and sends one
  `POST /abort { token }` (bounded by 10 s, answer ignored), unless some `/complete` attempt of the upload may have
  completed the file: one that got no answer (`NETWORK_ERROR`) or answered `SERVER_ERROR`. Then the file is kept. The
  flag is sticky across attempts and repair rounds, except that a `PARTS_MISSING` answer clears it (M3-S31). A
  `/complete` that succeeds is returned as a success even when the signal fired meanwhile, and a cancel during
  `/complete` returns once that request answers. A failure follows the same rule, with its `/abort` in the background
  (M3-S15).
- **Why:** the plan audit's C-1. The server may finish `/complete` and run `onComplete` after the browser stopped
  waiting, and `/abort` with a live token deletes the upload's own object (`server/abort.ts`, M2-X1). The keep rule is
  M3-H15 item 2 as amended by M3-H16.
- **If wrong:** an object the user believes cancelled stays until the app deletes it; once the token expires,
  `/abort` cannot delete it either. A server that never answers `/complete` holds the cancelled `upload()` until the
  browser drops the connection. A cancel during `/upload` loses the token, so a multipart upload waits for the
  lifecycle rule. A single `PUT` cancelled after its bytes reached the bucket may land after `/abort`'s HEAD; that
  object is an orphan the lifecycle rule does not remove (the 1.1 database adapters close this gap).
- **Status:** in force (`bc06db2`, `cec31c9`). Spec §5.5 says the client never sends `/abort` after a `/complete` that
  may have succeeded.
- **Visible in:** `client/upload.ts` (`complete`, `uploadFile`), `client/endpoints.ts` (`complete`, `abort`),
  `client/upload-failures.test.ts` (the four `/complete` cancel rows).

### M3-S15: `/abort` after a failure, unless a `/complete` may have finished the file

- **Decision:** ledger ruling S-18. After `/upload` succeeded, a file that ends without success sends `/abort` exactly
  when no `/complete` attempt may have finished it (the flag of M3-S14), for a failure as for a cancel. On a failure
  `upload()` answers the original error at once and the `/abort` runs in the background; on a cancel `upload()` waits
  for it (at most 10 s) and answers `ABORTED`. `/abort` is sent with `keepalive: true`, so a tab closed right after the
  failure or cancel still delivers it. When a `/complete` may have finished the file, nothing is sent and the file is
  kept. A plugin's `onAbort` hook (`reason: "aborted"`) therefore also runs after such a failure, not only after a
  cancel: a quota plugin's reservation is released at once instead of at its own expiry.
- **Why:** the owner asked on 2026-11-16 for the approach that is best for performance, after the final review found
  that a failed single `PUT` (every file under 64 MiB) left a complete object that no lifecycle rule removes and that
  the app never recorded: the abort-incomplete-multipart rule only removes unfinished multipart uploads. The safety
  argument is M3-S14's: with no `/complete` that may have succeeded, `/abort` deletes only this upload's own object
  (`server/abort.ts`). Answering before `/abort` settles adds no latency to the failure; `/abort` never rejects
  (`client/endpoints.ts`, `abort`), so the background request cannot surface as an unhandled rejection.
- **If wrong:** a background request after a failure that the caller does not see, and an `onAbort` call a plugin may
  not expect after a failure (a second one after a `/complete` refusal that already ran it with `"rejected"`, which the
  idempotency rule by `file.id` allows). A file kept because a `/complete` may have finished it still stays until the
  app deletes it.
- **Status:** in force (`7ed3e60`); supersedes the first M3-S15 ("no `/abort` after a failure", `bc06db2`, owner
  accepted under M3-O4), which left parts to the lifecycle rule and single objects in the bucket for good. Amends
  M3-S31 and M3-H16 (their `/abort` now follows a failure too) and M2-D21 (when `onAbort` runs).
- **Visible in:** `client/upload.ts` (`uploadFile`), `client/endpoints.ts` (`abort`), `client/upload-abort.test.ts`.

### M3-S16: every answer is checked

- **Decision:** a non-JSON answer, a JSON answer of the wrong shape, or a `/sign` answer without exactly the asked
  parts becomes `SERVER_ERROR` with a message that names `basePath` and the cloudrop version, retryable from status
  500 on. A non-2xx 429 without cloudrop's body is the exception (M3-S30).
- **Why:** a wrong `basePath` or a proxy's HTML page must never make `upload()` reject or read garbage.
- **If wrong:** a newer server that adds a required field to an answer is refused by an older client.
- **Status:** in force (`6f533c8`); amended by M3-S29 and M3-S30 (a proxy's 429 page).
- **Visible in:** `client/answers.ts`, `client/endpoints.ts` (`post`, `refusal`), `client/failures.ts`
  (`unreadableAnswer`).

### M3-S17: argument and configuration checks

- **Decision:** `upload` returns `INVALID_INPUT` before any request when the route is not a non-empty string, the file
  is not a `File`, the options are not an object or the signal is not an `AbortSignal` (and, since M3-S28, when the
  metadata cannot be encoded as JSON). `createCloudropClient` throws `INVALID_CONFIG` when `basePath` is not a path such
  as `/api/cloudrop` or an absolute `http(s)` URL (no trailing slash, query or fragment; default `/api/cloudrop`), when
  a `fetch` option is given but is not a function ("The fetch option must be a function."), or when no `fetch` exists.
  `null` options count as none, as `createCloudrop` reads its own (`readConfig`, `server/config.ts`).
- **Why:** plain JavaScript callers get every one of these wrong; a configuration mistake fails at construction, as
  `createCloudrop` does.
- **If wrong:** a `basePath` with a query string, which some proxies need, is refused.
- **Status:** in force (`bc06db2`; `null` options and the `fetch` option's own message in `2cf2269`).
- **Visible in:** `client.ts` (`BASE_PATH`, `createCloudropClient`), `client/upload.ts` (`readArguments`).

### M3-S18: the default `fetch`

- **Decision:** without `options.fetch` the client calls `globalThis.fetch(url, init)`, looked up on every request, so
  `fetch` runs with `this` bound to `globalThis`.
- **Why:** browsers throw "Illegal invocation" when `fetch` runs as a method of another object, and a late lookup picks
  up a `fetch` patched after the client was created (test tools, service-worker shims). Ledger ruling S-8 confirmed this
  when a plan test row expected `this` to be `undefined`; the row was wrong, and the behaviour did not change.
- **If wrong:** none known.
- **Status:** in force (`bc06db2`).
- **Visible in:** `client.ts` (`send`), `client.test.ts`.

### M3-S20: the size budget of `cloudrop/client`

- **Decision:** `cloudrop/client` has a budget for the bundled, minified and tree-shaken gzip size of
  `import { createCloudropClient } from "cloudrop/client"`, measured with `@size-limit/esbuild` (one dev dependency).
  The three existing budgets (`cloudrop`, `cloudrop/next`, `cloudrop/node`) carry
  `disablePlugins: ["@size-limit/esbuild"]` and keep counting the summed files of each entry and the chunks it imports.
- **Why:** spec §1 states its target ("client plus React under about 8 kB gzip") as what an application ships, which
  is a bundle. Installed, the plugin bundles every check unless the check opts out (plan audit I-3); with
  `disablePlugins` the three summed figures stay byte-equal (33911, 967 and 3051 B, Task 7). The root figure had moved
  from 33381 to 33911 B before the plugin, because adding the client entry moved `plan`, `rules` and `input` into a
  shared chunk.
- **If wrong:** the two kinds of budget answer different questions and cannot be compared with each other.
- **Status:** in force (`653f6a4`); owner accepted (M3-O4). The 4 kB stop line is replaced by M3-S32.
- **Visible in:** `scripts/size-limit.config.ts`, `packages/cloudrop/package.json`.

### M3-S21: the Next.js example

- **Decision:** `examples/next` is a private workspace package, `cloudrop-example-next`: Next.js 16.4.6 app router,
  React 19.3.1, TypeScript 7.0.2, served on port 5173 (the live test bucket's CORS rule names
  `http://localhost:5173`). Storage comes from the environment: `s3()` when `CLOUDROP_S3_ENDPOINT` is non-empty,
  otherwise `r2()`. `multipartThreshold: "8MB"` makes a 20 MiB file a three-part upload (8, 8 and 4 MiB). The server is
  created when its module loads, so `next build` needs the settings (M3-H14), and the README says a build without
  secrets fails with `INVALID_CONFIG` (M3-H15).
- **Why:** the example shows the quickstart as users will write it (`typeof cloudrop`), single and multipart uploads,
  and a real `authorize`.
- **If wrong:** every build of the example needs the settings.
- **Status:** in force (`15d4caa`, `08d0207`); owner accepted (M3-O4). The demo cookie the page set is superseded by
  M3-S33.
- **Visible in:** `examples/next/`, its `README.md`.

### M3-S22: local backends for the example

- **Decision:** RustFS 1.0.5 is the example's documented default. Wrangler's local R2 is documented for single uploads
  only, with the error a multipart upload ends in.
- **Why:** measured (`docs/research/2026-11-16-m3-slice-measurements.md` §1, §2). RustFS accepts and enforces a CORS
  rule, and a browser uploads single files and every part there with `ETag` readable. Wrangler lets any `localhost`
  origin upload without a CORS rule, but every multipart `/complete` answers `502` with a non-retryable
  `STORAGE_ERROR` ("The storage service refused the request. Contact the site owner if this keeps happening."), because
  its ListParts answers `501 NotImplemented` and the driver maps 501 to a non-retryable error. The client returns that
  error after one `/complete` and then sends `/abort` (M3-S15), which aborts the multipart upload: Wrangler implements
  AbortMultipartUpload (measurements §2).
- **If wrong:** a developer on Wrangler sees the generic message; only the server log says the storage does not
  support the request.
- **Status:** in force (`15d4caa`); owner accepted (M3-O4).
- **Visible in:** `examples/next/README.md` ("Run with Wrangler (single uploads only)"),
  `examples/next/scripts/setup-rustfs.ts`, `storage/storage-error.ts`.

### M3-S23: the browser lane

- **Decision:** `*.browser.test.ts` files run only through `bun run test:browser` (`scripts/test-browser.sh`):
  Playwright 1.65.1 drives Chromium's headless shell against the example, built with `next build` and served with
  `next start`, on a disposable RustFS container labelled `cloudrop.test`. CI's `browser` job runs it on every pull
  request and installs only the headless shell (`--only-shell`). `bun run test:browser:live`
  (`scripts/test-browser-live.ts`) runs the same tests on the live test bucket, whose CORS rule
  `cloudrop-browser-tests` the owner confirmed on 2026-11-16.
- **Why:** nothing but a real browser proves CORS, `Blob.slice` and readable `ETag`s. The headless shell is 287 MB and
  5.9 s to install here, against 701 MB and 13.2 s for the full browser (measurements §4).
- **If wrong:** CI minutes for one more job per pull request (owner accepted); other browsers stay unmeasured.
- **Status:** in force (`9de4a32`, `2012286`, `738d2d8`); owner accepted (M3-O4). Three tests since ledger ruling S-12.
- **Visible in:** `scripts/test-browser.sh`, `scripts/test-browser-live.ts`, `examples/next/playwright.config.ts`,
  `examples/next/app/upload.browser.test.ts`, `.github/workflows/ci.yml` (`browser`).

### M3-S26: small decisions accepted with the plan

- **Decision:** the slice has no progress callback; `createCloudropClient` is the only way in until M4's hooks; the
  internal constants (the 60 s renewal margin, 2 repair rounds, `Retry-After` capped at 20 s) are not exported. A plugin
  that returns a client-only code makes the server log "cloudrop: /<endpoint> failed with an error code the server
  cannot send, so the client got a generic 500. Return a CloudropError with one of cloudrop's server codes, not a
  client-only code such as ABORTED." (the wording since `5603f60`).
- **Why:** with `fetch` a progress callback could report only whole parts, and its shape would be decided twice;
  constants that are not exported can change without a major release.
- **If wrong:** an app that needs progress waits for the progress plan; a constant someone needs to tune becomes an
  option later, which is not breaking.
- **Status:** in force (`bc06db2`, `5603f60`); owner accepted (M3-O4).
- **Visible in:** `client.ts`, `client/parts.ts`, `client/upload.ts`, `server/handler.ts`.

### M3-S27: `route()` keeps its own result type

- **Decision:** `route()`'s return type is wrapped in `NoInfer`, so a route's result type no longer follows the
  expected type of the position it is written in. An inline route without `onComplete`, written inside
  `createCloudrop({ routes })` as the quickstart does, gives the client `null` instead of `unknown`.
- **Why:** the plan audit's I-2, ruled part of the slice in M3-H15 (item 4): the client's result type must not depend on
  whether a route was assigned to a constant first.
- **If wrong:** the published declarations use `NoInfer`, so projects need TypeScript 5.4 or newer to read cloudrop's
  types; older compilers report "Cannot find name 'NoInfer'", or with `skipLibCheck` lose the route's result type.
- **Status:** in force (`653f6a4`). The README states TypeScript 5.4 or newer.
- **Visible in:** `server/route.ts` (`route`), `server/types.test.ts` ("types an inline route without onComplete as
  null, as the quickstart writes routes").

## Execution rulings

### M3-S28: metadata JSON cannot encode is refused before any request

- **Decision:** ledger ruling S-2. When `options.metadata` holds a value `JSON.stringify` throws on (a `BigInt`, a
  circular reference), `upload()` returns `INVALID_INPUT`, not retryable, saying the metadata must be JSON data.
- **Why:** retrying cannot fix it, and the `NETWORK_ERROR` it used to become (retried six times) misled the caller.
- **If wrong:** a caller whose `toJSON` throws only sometimes gets `INVALID_INPUT` instead of a retry.
- **Status:** in force (`bc06db2`); amends M3-S17.
- **Visible in:** `client/upload.ts` (`encodesAsJson`, `readArguments`).

### M3-S29: a proxy's 429 and a `/sign` answer's `Retry-After` are honoured

- **Decision:** ledger rulings S-4 and S-5. A non-2xx 429 from the upload server without cloudrop's error body (a
  rate-limit page in front of the app) is retryable like a 5xx and its `Retry-After` is waited. A `/sign` answer's
  `Retry-After` is honoured for parts too, through the same budget.
- **Why:** spec §6.2's first row lists 429; a rate-limit page is transient, and failing the file at once contradicted
  it. A rate-limited `/sign` is the same condition as a rate-limited endpoint.
- **If wrong:** up to six attempts against a proxy that keeps refusing; a part waits up to the header's value, capped at
  20 s, before signing again.
- **Status:** in force (`61b4e68`, `54430a6`); amends M3-S9 and M3-S16.
- **Visible in:** `client/endpoints.ts` (`refusal`, `post`), `client/retry.ts` (`waitAtLeast`, `retryAfterOf`),
  `client/parts.ts` (`signFailure`).

### M3-S30: an exhausted retry on a proxy's 429 is `RATE_LIMITED`

- **Decision:** ledger ruling S-7. A proxy's 429 page answers a retryable `RATE_LIMITED`, "The upload server is busy.
  Try again in a moment.", instead of the unreadable-answer `SERVER_ERROR` that blames `basePath`.
- **Why:** the status is readable and the cause is load, not a wrong `basePath`.
- **Effect on a cancel (M3-S14):** a proxy's 429 page on `/complete` is now `RATE_LIMITED`, which does not mark the
  file as possibly complete, so a cancel after it sends `/abort`. That is safe: a rate-limit page is answered before
  the request reaches the app, so no completion happened. A proxy's 502 or 504 page is still `SERVER_ERROR` and still
  keeps the file, and so does any other non-2xx page without cloudrop's body.
- **If wrong:** one more message in `client/failures.ts`.
- **Status:** in force (`54430a6`); amends M3-S16.
- **Visible in:** `client/failures.ts` (`serverBusy`), `client/endpoints.ts` (`refusal`).

### M3-S31: a `PARTS_MISSING` answer clears the doubt

- **Decision:** ledger ruling S-9. Wherever a `PARTS_MISSING` answer arrives, the first `/complete` or a repair round's,
  it clears the flag that keeps the file, so a cancel or a failure after it sends `/abort` (M3-S15).
- **Why:** the server answers `PARTS_MISSING` only after ListParts succeeded, while the multipart upload is still open
  (`server/complete.ts`, `completeParts`); a completed upload answers ListParts with `NoSuchUpload`, which ends in
  success instead. No `PUT` runs while `/complete` runs, so no earlier attempt can have completed the file, and
  `/abort` deletes nothing recorded while it frees the parts at once (plan re-review 2, D-3).
- **If wrong:** a recorded file is deleted. The one path found: a proxy holds an earlier `/complete` and delivers it
  after the repair `PUT`s, it completes the file, and the upload then ends without success: the user cancels, or,
  since M3-S15, the repair round fails with no user action at all. The `/abort` that follows deletes the
  recorded object: `abortMultipart` treats `NoSuchUpload` as success (`storage/s3/multipart.ts:115`), R2 answers an
  abort after completion with `204` (spike Q11), and `server/abort.ts` then deletes the upload's own object while the
  token is valid (`server/abort.test.ts:86`). Not considered a realistic threat.
- **Status:** in force (`cec31c9`); amends M3-H16 and M3-S14. Amended by M3-S15 (S-18): the `/abort` it allows now
  also follows a failure.
- **Visible in:** `client/upload.ts` (the `complete` closure), `client/upload-failures.test.ts`.

### M3-S32: `cloudrop/client`'s budget is 4.7 kB gzip

- **Decision:** ledger ruling S-10. The bundled `cloudrop/client` budget is 4.7 kB gzip (the measured 4194 B plus about
  10 %, as every budget here is set), replacing M3-S20's stop line of 4 kB.
- **Why:** spec §1's target is "client plus React under about 8 kB gzip", which 4.2 kB leaves room for. Shrinking
  before M4 measures the React half would be optimisation without a target, and the client's messages are deliberately
  full sentences.
- **If wrong:** M4 has about 3.3 kB left for the React bindings. Revisit when `cloudrop/react` exists.
- **Status:** in force (`653f6a4`); amends M3-S20.
- **Visible in:** `scripts/size-limit.config.ts`.

### M3-S33: the example signs in through a server route

- **Decision:** ledger ruling S-11. The example's sign-in form posts to `app/api/demo-sign-in/route.ts`, which answers
  `303` with an `HttpOnly` cookie `demo-user=demo` that `authorize` reads. It replaces the cookie the page set with
  `document.cookie` (M3-S21).
- **Why:** it removes a `biome-ignore`, has no timing race and shows a real session cookie. It is still a demo: any
  visitor can set that cookie, and the README and `lib/cloudrop.ts` say it must never ship.
- **If wrong:** one more file in the example.
- **Status:** in force (`08d0207`); supersedes M3-S21's page cookie.
- **Visible in:** `examples/next/app/api/demo-sign-in/route.ts`, `examples/next/lib/cloudrop.ts`.

### M3-S34: the browser lane's RustFS listens on 19100

- **Decision:** ledger ruling S-13. `scripts/test-browser.sh` starts RustFS on port 19100 by default
  (`CLOUDROP_RUSTFS_PORT` overrides it), apart from `scripts/test-rustfs.sh`'s 19000.
- **Why:** both RustFS lanes can run at once with their defaults.
- **If wrong:** one more port to remember.
- **Status:** in force (`2012286`).
- **Visible in:** `scripts/test-browser.sh`, `AGENTS.md` (Gates).
