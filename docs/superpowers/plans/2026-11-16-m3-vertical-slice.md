# M3 vertical slice: the first client and a real application, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The thinnest client that makes the spec's quickstart (§1) work in a real application: `cloudrop/client`
with `createCloudropClient` and one `upload(route, file, options?)` call that returns `{ data, error }`, a Next.js
example in `examples/next` that uploads a small file (single PUT) and a multipart file from the browser, and the proof:
the real client driving the real handler on the fake R2, type tests for the inference, and one browser check.

**Architecture:** `src/client.ts` is the entry of `cloudrop/client`. It builds a small context (base path, `fetch`) and
hands each call to `src/client/upload.ts`, which talks to the server through `src/client/endpoints.ts` (JSON POSTs to
the four endpoints, answers validated by `src/client/answers.ts`) and to the bucket through `src/client/bucket.ts` (one
presigned `PUT`, its answer classified). `src/client/parts.ts` sends the parts of a file, four at a time, signing
unsigned parts lazily in batches and renewing URLs; `src/client/retry.ts` holds the bounded backoff. The client
imports only `src/errors.ts`, `src/input.ts` (new, neutral), `src/plan.ts` and `src/protocol/types.ts`, never storage or
server code; Biome enforces the boundary. The server decides every byte range: the client reads `partSize` and
`partCount` from the ticket and cuts the file with `sizeOfPart` from `src/plan.ts`.

**Tech stack:** as on `feat/m2-server`: Bun 1.4.4, TypeScript 7.0.2, Vitest 5.1.0 (on Node 24), tsdown 0.23.7, Biome
2.6.8, plus lane G's `size-limit`, `@size-limit/file`, `publint` and `@arethetypeswrong/cli` (see "Before Task 1"). The
slice adds, checked on npm on 2026-11-16: in `packages/cloudrop` (dev only) `@size-limit/esbuild@14.3.0` (decision S20,
owner); in the new `examples/next` workspace `next@16.4.6` (released 2026-11-09), `react@19.3.1` and
`react-dom@19.3.1` (2026-10-14), `@playwright/test@1.65.1` (2026-11-13), `@types/react@19.3.0`,
`@types/react-dom@19.3.0`, `@types/node@24.19.2`, `aws4fetch@1.0.20` (the version `packages/cloudrop` already pins).
Re-check each version with `npm view <name>@<version> time` before installing; pin exactly. `packages/cloudrop` gains no
runtime dependency.

**Spec:** [`docs/superpowers/specs/2026-11-15-cloudrop-design.md`](../specs/2026-11-15-cloudrop-design.md). Binding
here: §1 (quickstart, results, size), §3 (`cloudrop/client`, the `protocol` boundary), §5 (the four endpoints), §6.1 to
§6.2 (the parts this slice implements), §7 (signed headers, secrets in errors), §11 (lanes), §12 (measured R2 behaviour
and what is still unverified). Evidence: [`docs/research/r2-spike-findings.md`](../../research/r2-spike-findings.md),
[`docs/research/test-backends.md`](../../research/test-backends.md),
[`docs/research/r2-platform-and-test-backends.md`](../../research/r2-platform-and-test-backends.md).

## Before Task 1

This plan was written on `feat/m2-server` at `71c3377`. It executes on that branch **after** the controller has merged
lane G (gates, package checks, trimmed root entry) and lane Docs (Task 17 of M2). What this plan relies on from them:

- Lane G: root scripts `verify` (check, typecheck, test, build, package checks), `package:check`, `test:rustfs`,
  `test:wrangler`; `bun run check` also runs `scripts/check-file-size.ts` (250 lines per source file, 400 per test file)
  and Biome's `complexity/noExcessiveCognitiveComplexity` at 15; `packages/cloudrop/package.json` has a
  `package:check` script running publint, attw and size-limit with one budget per published entry; the root entry no
  longer exports the 18 wire types, `Jsonified`, `RouteTypes`, `StandardIssue` or `StandardResult` (lane G brief G5,
  ruling R38).
- Lane Docs: `AGENTS.md` names `bun run verify` as the gate.

Read the merged `packages/cloudrop/package.json`, `biome.json` and `.github/workflows/ci.yml` before Task 1: Tasks 7
and 9 extend them and must keep lane G's structure (every action pinned to a commit SHA, no new action). Record the
unit-lane baseline (`bun run test`: N passed, 1 skipped) in Task 1's report; every task below states how many tests it
adds to that N.

## Global constraints

- Everything in English: code, comments, docs, commit messages, test names, script output.
- `packages/cloudrop` has zero runtime dependencies; `src/` uses web-platform APIs only (`fetch`, `Blob`, `File`,
  `AbortSignal`, `URL`) and compiles with `types: []` (`packages/cloudrop/tsconfig.json:7`).
- The client imports only `src/errors.ts`, `src/input.ts`, `src/plan.ts`, `src/rules.ts` (through `plan.ts`) and
  `src/protocol/types.ts`. Never `src/storage/**` or `src/server/**`, not even a type (decision S19).
- Public calls return `{ data, error }` (`Result<T>`, `packages/cloudrop/src/errors.ts:64`). `upload()` never rejects
  for an expected failure (spec §6.4, line 238); `createCloudropClient` throws `INVALID_CONFIG` for a configuration
  mistake, like `createCloudrop` (`errors.ts:74-77`).
- Error messages say what happened and what to do next, and never contain a presigned URL, a token, a key from another
  file or a raw storage body (spec §7.7, lines 262-263; `AGENTS.md`). Every client message is a fixed string or a fixed
  string with an HTTP status number.
- Never print, log or commit a credential, a token or a presigned URL. Tests record request labels such as
  `PUT part 2`, never URLs.
- File size: about 200 to 220 lines per source file; hard caps 250 (source) and 400 (`*.test.ts`), enforced by
  `bun run check`. Cognitive complexity at most 15 per function. Every file in the file map is planned under 220 lines;
  reach the numbers by separating responsibilities, never by reformatting or `biome-ignore`.
- Every exported name is a semver promise; the public entry exports exactly the names in decision S4.
- `isolatedDeclarations`: every exported function and constant has an explicit type.
- Tests are colocated. `*.test.ts` is the unit lane (`bun run test`); `*.browser.test.ts` is the new browser lane
  (`bun run test:browser`) and fails, never skips, when its backend is missing. Type tests are compiled by
  `bun run typecheck`.
- Focused unit command: `cd packages/cloudrop && bunx vitest run --project unit <file>`.
- Run every gate on Node 24: prefix with `PATH=~/.nvm/versions/node/v24.22.2/bin:$PATH`.
- Containers carry the label `cloudrop.test` and are removed by the script that started them; no Next.js, Playwright,
  RustFS or Wrangler process is left after a task. Live R2 writes only under `live-test/cloudrop-<32 hex>/` and deletes
  it.
- Git: stage exact paths, conventional commits, never push. Never `git stash`, `reset`, `clean` or `checkout --`. Never
  create worktrees in `/tmp`.
- Load `.claude/skills/testing-patterns` before writing tests and `.claude/skills/code-quality` before each commit.

## Decisions

Each decision says where it comes from. "Owner" marks the ones listed again under "Not settled here": the plan
proceeds with the recommendation, and the owner may overrule it before execution.

- **S1 One file per `upload()` call (owner).** Spec §5.4 (line 184) lets one `/upload` request start several files,
  and the snapshot of §6.4 tracks files one by one; both belong to the scheduler plan. One file maps one-to-one onto
  `{ data, error }` without a per-file result inside a result. Accepting an array later widens the parameter, a
  non-breaking change.
- **S2 Signature.** `upload(route, file, options?)`, `options = { metadata?, signal? }`. `route` is
  `RouteName<TCloudrop>` (`protocol/types.ts:171`); `metadata` is `RouteMetadata<TCloudrop, TName>` (`:174`) and the
  options argument is required exactly when that type does not include `undefined` (a schema whose input is required).
  `file` is a `File`: it has the name `/upload` needs (`FileDescriptor`, `protocol/types.ts:17-21`). `upload` does not
  use `this`, so `const { upload } = createCloudropClient()` works, as the quickstart destructures (spec line 39).
- **S3 Result type.** `Promise<Result<CompleteResponse<RouteResult<TCloudrop, TName>>>>`: the existing wire type
  (`protocol/types.ts:103-107`) carries `{ file, data }`, and `RouteResult` (`:177`) is already the JSON form of the
  route's `onComplete` result, `null` without one (`server/route.ts:56`, tested at `server/types.test.ts:79-89`). No new
  result type.
- **S4 Public surface of `cloudrop/client` (owner).** Values: `createCloudropClient`, `CloudropError`. Types:
  `ClientOptions`, `CloudropClient`, `UploadOptions`, `UploadArguments`, `Result`, `CloudropErrorCode`,
  `CompleteResponse`, `UploadedFile`. Ten names, each a semver promise. The other 16 wire types (`UploadRequest`,
  `FileTicket`, `SignedRequest`, `ErrorBody`, …) stay unexported: no signature of the client names them, and ruling R38
  only moved the decision here. `CloudropError` is the same class the root exports (one shared chunk), so `instanceof`
  agrees across entries.
- **S5 Three client error codes (owner).** `UPLOAD_REJECTED` (named by spec §6.2 line 208 and by M2 decision D17 as
  "a client classification"), and two the spec does not name: `ABORTED` (the caller's signal fired) and
  `NETWORK_ERROR` (no answer at all, retryable). They join `CloudropErrorCode` (`errors.ts:1-30`). The server's status
  table must not grow fake statuses for them, so `STATUS` in `server/http.ts:9-37` becomes keyed by
  `ServerErrorCode = Exclude<CloudropErrorCode, ClientErrorCode>` and `hasKnownCode` (`http.ts:60`) becomes a type
  guard. A plugin that returns a client code gets the generic 500 that any unknown code gets today
  (`server/handler.ts:93-98`, tested at `server/handler.test.ts:347-372`).
- **S6 The neutral module is `src/input.ts` (ruling R35).** It holds `invalidInput` and `isPlainObject`, moved
  verbatim from `src/storage/validate.ts:10-19`: the two helpers the client needs (arguments from plain JavaScript;
  answers from the server). `formatBytes` (`validate.ts:154-157`) stays: no client code formats a size, and its
  callers are storage (`validate.ts:163-164`) and server modules that depend on storage anyway
  (`server/upload.ts:13`, `server/route-config.ts:6`). Importers, all changed in Task 1, no re-export left behind:
  - `invalidInput`: `storage/s3/copy.ts:4`, `storage/s3/multipart.ts:4`, `storage/s3/objects.ts:8`,
    `storage/s3/presign.ts:7`, `server/api.ts:6`, `server/http.ts:6`, `server/sign.ts:7`,
    `server/token-request.ts:2`, `server/upload.ts:13`.
  - `isPlainObject`: `storage/validate.ts:51` (its own `metadataProblem`), `server/api.ts:6`, `server/route.ts:2`,
    `server/token-request.ts:2`, `server/upload.ts:13`.
  - Server modules importing `storage/validate.ts` before the move: eight (`api`, `http`, `key`, `route`,
    `route-config`, `sign`, `token-request`, `upload`); after it, four (`api` and `key` for `keyProblem`,
    `route-config` and `upload` for `formatBytes`).
- **S7 The plan in the token decides.** The client never calls `planUpload`; it numbers parts `1..ticket.partCount`
  and cuts part `n` as `file.slice((n - 1) * partSize, (n - 1) * partSize + sizeOfPart(file.size, partSize, n))`
  with `sizeOfPart` from `src/plan.ts:31-34`, the function the server signs with (`server/presign.ts:74`) and verifies
  with (`server/complete.ts:91-93`). `answers.ts` refuses a multipart ticket whose `partCount` differs from
  `countParts(file.size, partSize)` (`plan.ts:25`): a server or client version mismatch must fail, not upload wrong
  ranges.
- **S8 Transport: `fetch` everywhere in the slice.** Spec §3 (line 86) wants XHR for upload progress; progress is out
  of the slice, so XHR arrives with the progress plan. Bucket `PUT`s send exactly the ticket's `headers` (the rule at
  `protocol/types.ts:29-32`) with `credentials: "omit"`: a presigned URL needs no cookie, and a credentialed request
  would also need `Access-Control-Allow-Credentials` from the bucket. Endpoint `POST`s send
  `content-type: application/json` (required, `server/http.ts:140-142`) with `credentials: "include"` (owner), so a
  page on a trusted origin sends its session cookie; the server answers such requests with the exact origin and
  `access-control-allow-credentials: true` (`http.ts:107`).
- **S9 Retry budget.** At most 6 attempts per request, full-jitter backoff: before attempt `k + 1` wait a random time in
  `[0, min(20 s, 0.5 s · 2^(k - 1))]`; a `Retry-After` the answer carries is waited at least, capped at 20 s (spec §6.2
  line 206 gives "0.5 s to 20 s, up to 6 attempts, honouring Retry-After" without a cap; the cap keeps every wait inside
  the spec's range). Endpoint calls are retried when the error is `retryable` (the server says so,
  `server/http.ts:42-46`) or there was no answer.
- **S10 Bucket answers (spec §6.2 table, lines 204-211; spike rows 7 and 9; `test-backends.md:44`):**

  | Answer | Outcome | Error if attempts run out |
  |---|---|---|
  | 2xx, or 412 (a retried create-only PUT whose first attempt landed, spec §5.4 line 180) | stored | — |
  | `fetch` threw, signal not aborted (network, or an expired R2 URL answered without CORS headers) | opaque: renew once, wait, retry | `NETWORK_ERROR`, retryable |
  | 403 `SignatureDoesNotMatch` | rejected, never retried | `UPLOAD_REJECTED` |
  | any other readable 403 (`ExpiredRequest` on R2, `AccessDenied` on RustFS, no code) | expired: renew once, retry at once; refused again with the renewed URL, the file fails | `UPLOAD_REJECTED` |
  | 429, 503 (R2 sends S3 code `ServiceUnavailable` with 429, spike Q9) | retry after backoff | `RATE_LIMITED`, retryable |
  | 408, other 5xx | retry after backoff | `STORAGE_ERROR`, retryable |
  | any other 4xx (400 `BadDigest`, 404 `NoSuchUpload`, …) | rejected | `UPLOAD_REJECTED` |

  Classification is by status first, as the driver does (`storage/storage-error.ts:58-67`); the S3 code is read only
  to split 403. Treating every readable 403 except `SignatureDoesNotMatch` as expired is wider than the spec's row
  (owner): RustFS reports an expired URL as `403 AccessDenied` (`test-backends.md:44`), and one extra `/sign` is the
  whole cost when the 403 meant something else.
- **S11 URL renewal.** A URL with less than 60 s left by the client's clock is renewed through `/sign` before it is
  used, at most once per attempt, so a client clock that runs ahead costs one `/sign` per part, never a loop. After an
  opaque or expired outcome the part's URL is renewed once per part per `sendParts` call (spec §6.2 line 207: "renew
  the signature once"); a renewed URL that is refused as expired again fails the file at once, since a fresh URL
  refused again points at a clock or permission problem that more attempts cannot fix. `/sign` renews one part (`{ token, parts: [n] }`) or the single PUT (`{ token }`,
  `server/sign.ts:30-33`).
- **S12 Parts.** At most 4 parts of a file in flight (spec §6.1 line 197; 8 on one key were not throttled, spike Q9).
  Parts the ticket carried no URL for (`PARTS_PER_SIGN` = 20, `protocol/types.ts:12`, `server/upload.ts:145`) are
  signed lazily: the first worker that reaches an unsigned part asks `/sign` for it and the next unsigned parts, up to
  20; other workers wait on that call. The first part that fails for good fails the call; parts already in flight
  finish and no new part starts (spec §6.2 line 213).
- **S13 `PARTS_MISSING` repair.** `/complete` answers `PARTS_MISSING` with part numbers (`server/complete.ts:94-102`,
  carried by `ErrorBody.parts`, `protocol/types.ts:121-122`); the client re-sends exactly those parts and completes
  again, at most 2 repair rounds (3 `/complete` answers), then returns the `PARTS_MISSING` error. The spec gives no
  bound (§6.3 lines 225-227); a bound is needed so a part that never lands cannot loop.
- **S14 Cancellation.** `options.signal` reaches every `fetch` and every backoff pause. When it fires before the upload
  completed, the client sends one `POST /abort { token }` without the signal, ignores its answer (the bucket's
  lifecycle rule cleans the rest, spec §5.5 line 188) and returns `ABORTED`. A signal already aborted at the call
  starts no request. A signal that fires after `/complete` succeeded changes nothing: the result is returned, because
  `/abort` with a live token would delete the completed object (ruling R1, `server/abort.ts:24-30`).
- **S15 No `/abort` after a failure (owner).** A file that fails for any reason other than cancellation is left to
  the lifecycle rule: after a `/complete` attempt the object may be verified and `onComplete` may have run
  (`server/complete.ts:157-166`), and `/abort` would delete it. The resume plan owns re-trying a failed upload.
- **S16 Every answer is validated.** A non-JSON answer, a JSON answer of the wrong shape, or a `/sign` answer without
  exactly the asked parts becomes `SERVER_ERROR` with the message of `unreadableAnswer(status)` (retryable when
  `status >= 500`), so a wrong `basePath` or a proxy's HTML page never makes `upload()` reject.
- **S17 Arguments.** `upload` checks what plain JavaScript can get wrong (route not a non-empty string, file not a
  `File`, options not an object, signal not an `AbortSignal`) and returns `INVALID_INPUT` before any request.
  `createCloudropClient` checks `basePath` (a path such as `/api/cloudrop` or an absolute `http(s)` URL; no trailing
  slash, query or fragment; default `"/api/cloudrop"`, the server's default at `server/config.ts:118`) and that some
  `fetch` exists, and throws `INVALID_CONFIG` otherwise.
- **S18 Default `fetch`.** `(url, init) => globalThis.fetch(url, init)`: browsers throw "Illegal invocation" when
  `fetch` is called as a method of another object, and a late lookup picks up a `fetch` patched after the client was
  created (test tools, service-worker shims).
- **S19 The import boundary is a lint rule.** A `biome.json` override for `packages/cloudrop/src/client.ts` and
  `packages/cloudrop/src/client/**` (test files excluded) turns on `style/noRestrictedImports` with patterns for
  `storage` and `server` paths. Whether Biome's gitignore-style patterns match relative specifiers such as
  `../storage/validate.ts` is unverified; Task 7 proves it with a fault probe.
- **S20 Bundle budget (owner: one dev dependency).** Spec §1 (line 22) allots "client plus React under about 8 kB
  gzip". The slice's budget is the measured gzip size of `import { createCloudropClient } from "cloudrop/client"` plus
  10 %, rounded up to the next 0.1 kB, and the task stops if the measurement exceeds 4 kB (half of the allotment, which
  leaves the other half for the scheduler, XHR progress, persistence and hooks). tsdown splits shared code into hashed
  chunks (measured: `dist/errors-*.js`, `dist/types-*.js` beside the entries), so measuring `dist/client.js` alone would
  miss them; `@size-limit/esbuild` bundles the import and measures what an application ships.
- **S21 The example.** `examples/next`, its own workspace package `cloudrop-example-next` (private), the root
  `workspaces` gains `"examples/*"`. Next.js 16.4.6 app router, React 19.3.1, port 5173 (the live test bucket's CORS
  rule names `http://localhost:5173`, spec §12 line 367). Storage from the environment: `s3()` when
  `CLOUDROP_S3_ENDPOINT` is set (RustFS or Wrangler), otherwise `r2()` with its `CLOUDROP_R2_*` defaults. Authorization
  is a demo cookie the page sets and `authorize` reads, labelled as a stand-in for a session (owner).
  `multipartThreshold: "8MB"` makes a 20 MiB file a three-part upload (8, 8, 4 MiB: `planParts`, `plan.ts:40-48`,
  first part size 8 MiB, `plan.ts:13`).
- **S22 Local backends for the example (owner).** RustFS is the documented default: it implements ListParts and real
  CORS (`r2-platform-and-test-backends.md:240`, unmeasured for CORS, see U4). Wrangler's local R2 answers
  cross-origin requests without a CORS rule (`r2-platform-and-test-backends.md:224`) but answers ListParts with
  `501 NotImplemented` (`test-backends.md:75`); the server's `/complete` lists parts first (`server/complete.ts:82`), so
  a multipart upload ends with a retryable `STORAGE_ERROR` there (5xx is retryable, `storage/storage-error.ts:64-67`;
  derived from the code, not measured). The example README documents Wrangler for single uploads only.
- **S23 Browser lane.** Playwright 1.65.1, Chromium only, files named `*.browser.test.ts`, run by
  `scripts/test-browser.sh` against a disposable RustFS container and the example built with `next build` and served
  with `next start`. A CI job runs it on every pull request (owner: CI minutes).
- **S24 Live R2 in the browser (owner).** Task 10 runs the same browser check against the owner's test bucket and
  measures spec §12's open items 1 (browser PUT and parts, reading `ETag`, CORS on an expired URL's 403) once, recording
  the result in `docs/research/r2-spike-findings.md`.
- **S25 `src/server/protocol.test.ts` stays.** It pins the wire format without the client (its header,
  `protocol.test.ts:1-2`); the client tests prove the client against the same server. Pruning the overlap is a later
  audit (A9), once the client is the main consumer.

Out of the slice, each owned by a later plan:

| Out | Owner |
|---|---|
| Shared pool, `concurrency: 'auto'`, `smallest-first` (§6.1) | M3 scheduler plan |
| Stall detection (no progress for 30 s), `offline`/`online` pause, the rest of §6.2 | M3 scheduler plan (needs XHR progress) |
| Persistence, fingerprints, `resumable()`, OPFS, `retry()` of a failed file (§6.3) | M3 resume plan |
| XHR transport, `upload.onprogress`, EWMA speed and ETA, snapshots, `pause()`/`resume()` (§6.4) | M3 progress plan |
| Web Workers for hashing and sniffing (§3 item 5) | M5 plugins plan (`checksums()`, `images()`) |
| Chaos proxy (§11.3) | M3 chaos plan |
| `cloudrop/react`, `useUpload`, `useDropzone`, shadcn registry | M4 |
| Client plugin hooks, `$Infer` (§8) | M5 |
| Several files per call, `error.file` (§1 line 19) | M3 scheduler plan (with S1) |

No progress callback is included: with `fetch` it could only report whole parts, and its shape would then be decided
twice (owner, listed below).

## Unverified behaviour and where it gets measured

| # | Behaviour | Source of the doubt | Measured in |
|---|---|---|---|
| U1 | A browser `PUT` and `UploadPart` to R2 from a page succeed with our signed headers | spec §12 line 366; spike "Not verified" (lines 397-400) | Task 10 |
| U2 | An expired R2 URL's 403 carries CORS headers (readable) or not (opaque) | spec §12 line 366; spike Q7 (lines 236-244, BLOCKED); R2 docs say not (`r2-platform-and-test-backends.md:400-401`) | Task 10. The client handles both (S10) |
| U3 | `ETag` is readable from JavaScript | spec §12 line 366 | Task 10. The slice does not read it: `/complete` lists parts itself (`server/complete.ts:82-103`) |
| U4 | RustFS 1.0.5 accepts `PutBucketCors` and answers a preflight from `http://localhost:5173` | claimed, not measured (`r2-platform-and-test-backends.md:240`) | Task 8, step 2 (stop condition) |
| U5 | Next.js 16.4.6 builds with TypeScript 7.0.2 | TS 7's package ships `tsc.js` and no compiler API module (`node_modules/typescript/lib` holds `tsc.js`, `getExePath.js`, `version.cjs`) | Task 8, step 3 (fallback S22a below) |
| U6 | Next.js resolves the workspace package `cloudrop` through its `exports` to `dist/` | not tried | Task 8, step 3 |
| U7 | Biome's `noRestrictedImports` patterns match relative specifiers | not tried | Task 7, fault probe |
| U8 | size-limit's default compression and the esbuild plugin's tree-shaking of an ESM entry | not tried | Task 7, step 5 |
| U9 | `Retry-After` is readable in a browser only if the bucket's CORS rule exposes it; whether R2 sends it at all | not measured | Not in the slice; the client reads it when visible |
| U10 | `fetch` with a `Blob` body sends exactly the signed `content-length` | spike "Not verified" line 399 ("should match") | Task 9 (RustFS), Task 10 (R2) |

**S22a (fallback for U5, owner).** If `next build` fails with TypeScript 7.0.2, the example pins `typescript@6.0.3`
(the newest 6.x on npm on 2026-11-16) in its own `devDependencies`; `packages/cloudrop` keeps 7.0.2. Record the error
in the task report.

## File map

```
packages/cloudrop/
  src/input.ts                          invalidInput, isPlainObject (Task 1)                          ~25 lines
  src/errors.ts                         + UPLOAD_REJECTED, ABORTED, NETWORK_ERROR; ClientErrorCode (Task 2)
  src/server/http.ts                    STATUS keyed by ServerErrorCode; hasKnownCode a type guard (Task 2)
  src/client/failures.ts                the client's error constructors (Task 3)                     ~70 lines
  src/client/retry.ts                   MAX_ATTEMPTS, retryDelay, parseRetryAfter, pause, withRetry (Task 3) ~80
  src/client/bucket.ts                  BucketOutcome, classifyAnswer, putObject (Task 3)              ~90 lines
  src/client/answers.ts                 shape checks for the four endpoints' answers (Task 4)          ~110 lines
  src/client/endpoints.ts               ClientFetch, Ticket, Endpoints, createEndpoints (Task 4)       ~100 lines
  src/client/parts.ts                   PARTS_IN_FLIGHT, PartSender, nextStep, sendParts (Task 5)      ~140 lines
  src/client/upload.ts                  uploadFile: start, send, complete, repair, cancel (Task 6)     ~130 lines
  src/client.ts                         the cloudrop/client entry (Task 6)                            ~90 lines
  src/testing/client-fixture.ts         the server fixture behind a fetch the client can use (Task 4) ~100 lines
  tests: src/client/{retry,bucket,endpoints,parts,upload,upload-failures,types}.test.ts, src/client.test.ts
  package.json                          exports "./client"; dev @size-limit/esbuild; budget (Task 7)
  tsdown.config.ts                      entry src/client.ts (Task 7)
examples/next/                          (Task 8)
  package.json, next.config.ts, tsconfig.json, README.md
  lib/cloudrop.ts                       the server: createCloudrop with one route
  app/api/cloudrop/[...all]/route.ts    export const { GET, POST, OPTIONS } = toNextHandler(cloudrop)
  app/layout.tsx, app/page.tsx          the upload page ("use client")
  scripts/setup-rustfs.ts               bucket, CORS rule, preflight check, .env.local
  playwright.config.ts, app/upload.browser.test.ts (Task 9)
scripts/test-browser.sh                 the browser lane (Task 9)
package.json                            workspaces + examples/*; test:browser; verify (Tasks 8, 9)
biome.json, .gitignore                  client import rule; .next and Playwright output ignored (Tasks 7, 8)
.github/workflows/ci.yml                browser job (Task 9)
AGENTS.md, README.md, docs/research/*   (Tasks 10, 11)
```

Nothing under `src/client/` imports `src/storage/**` or `src/server/**`. `src/testing/client-fixture.ts` does: it is
test infrastructure, like `server-fixture.ts`, and is not an entry.

## Threats and the tests that close them

| Threat | Defence | Test (file › name) |
|---|---|---|
| A presigned URL or token in an error message | fixed messages; exact message asserted in every failure row | upload-failures › every row asserts `{ code, message, retryable }` exactly |
| Cookies sent to the bucket | `credentials: "omit"` on PUT | bucket › "sends the signed headers and no credentials to the bucket" |
| Bytes of one part sent under another part's URL | parts cut with the server's `sizeOfPart`; the bucket refuses another length (spike Q1) | upload › "uploads a multipart file…" (bytes on both sides of the boundary) |
| A wrong server answer making `upload()` reject | every answer validated (S16) | endpoints › non-JSON, wrong-shape and short `/sign` rows |
| Endless retries or repairs | 6 attempts (S9), 2 repair rounds (S13) | retry › "gives up after 6 attempts"; upload-failures › "gives up after two repair rounds" |
| A cancelled upload left open, or a completed one deleted by a late cancel | `/abort` on cancel only before completion (S14) | upload-failures › cancel rows |
| Server code in the browser bundle | Biome import rule (S19); budget (S20) | Task 7 fault probe; `bun run package:check` |

---

### Task 1: The neutral input module (ruling R35)

A pure move: same behaviour, same messages, no test changes.

**Files:**
- Create: `packages/cloudrop/src/input.ts`
- Modify: `packages/cloudrop/src/storage/validate.ts:1-19` (drop `invalidInput` and `isPlainObject`, import
  `isPlainObject` from `../input.ts`); the import lines listed in S6.

**Interfaces:**
- Produces: `invalidInput(message: string): CloudropError` (code `INVALID_INPUT`) and
  `isPlainObject(value: unknown): value is Record<string, unknown>`, both from `src/input.ts`, bodies and doc
  comments copied unchanged from `validate.ts:10-19`.

**Tests:** none new. Both helpers are covered through their callers (no test imports them directly:
`grep -rn "isPlainObject\|invalidInput" --include=*.test.ts packages/cloudrop/src` finds nothing on `71c3377`).

- [ ] **Step 1:** Record the baseline: `bun run verify` (or check, typecheck, test, build). Write N (unit tests passed)
  in the report.
- [ ] **Step 2:** Create `src/input.ts` with the two functions and a one-line header: "Untrusted input: the error for
  it, and the plain-object check every JSON reader uses. Shared by storage, server and client."
- [ ] **Step 3:** Delete them from `validate.ts`; add `import { isPlainObject } from "../input.ts";` there. Rewrite
  each importer in S6 to import from `../input.ts` (server) or `../../input.ts` (storage/s3), keeping its other
  `validate.ts` names where it had any.
- [ ] **Step 4:** `bun run typecheck` proves no importer was missed: `validate.ts` no longer exports either name, so a
  stale import fails to compile (the multi-line imports in `storage/s3/*.ts` defeat a one-line grep).
- [ ] **Step 5:** Gates: `bun run check`, `bun run typecheck`, `bun run test` (N passed, unchanged), `bun run build`.
- [ ] **Step 6:** Commit `refactor: move invalidInput and isPlainObject to a neutral input module`.

### Task 2: Client error codes, and a server status table that cannot send them

**Files:**
- Modify: `packages/cloudrop/src/errors.ts:1-30`, `packages/cloudrop/src/server/http.ts:9-37`, `:60`, `:62-66`
- Test: `packages/cloudrop/src/server/handler.test.ts:347-372`

**Interfaces:**
- Produces in `errors.ts`, after the "Upload endpoints" group:
  ```ts
    // Client (spec §6.2): never sent by the server.
    | "UPLOAD_REJECTED"
    | "ABORTED"
    | "NETWORK_ERROR";

  /** Codes only the client produces; the server's status table has no entry for them. */
  export type ClientErrorCode = "UPLOAD_REJECTED" | "ABORTED" | "NETWORK_ERROR";
  ```
  `ClientErrorCode` is not exported from `src/index.ts`.
- Produces in `http.ts`: `type ServerErrorCode = Exclude<CloudropErrorCode, ClientErrorCode>`;
  `STATUS … satisfies Record<ServerErrorCode, number>`;
  `export const hasKnownCode = (error: CloudropError): error is CloudropError & { code: ServerErrorCode } => Object.hasOwn(STATUS, error.code);`
  `errorResponse` keeps its body; `STATUS[error.code]` now type-checks through the guard.

**Tests (contract: the server never answers 200 or a made-up status for a code it cannot send; oracle: the existing
row's literal body; bug caught: a later edit adds the client codes to `STATUS`):**

| Row | Plugin's code | Expected |
|---|---|---|
| existing | `"QUOTA_EXCEEDED"` | 500 `SERVER_ERROR`, logged as today |
| new | `"ABORTED"` | the same 500 body and log line |

- [ ] **Step 1:** Turn the test at `handler.test.ts:348` into `it.each` over the two codes, title
  `"answers a plugin refusal with the code $code, which the server cannot send, as a generic 500"`. Keep every
  assertion. Run it: both rows pass today (the code is unknown to `STATUS`), which is the contract to keep.
- [ ] **Step 2:** Make the type changes. `bun run typecheck` passes.
- [ ] **Step 3:** Fault probe: add `ABORTED: 499,` to `STATUS`; `bun run typecheck` fails (excess property against
  `Record<ServerErrorCode, number>`) and the new row fails (499). Restore.
- [ ] **Step 4:** Gates as in Task 1; N + 1 tests. `wc -l handler.test.ts` stays at or below 400.
- [ ] **Step 5:** Commit `feat(errors): add the client's error codes UPLOAD_REJECTED, ABORTED and NETWORK_ERROR`.

### Task 3: Retry, bucket answers and the client's errors

**Files:**
- Create: `packages/cloudrop/src/client/failures.ts`, `packages/cloudrop/src/client/retry.ts`,
  `packages/cloudrop/src/client/bucket.ts`
- Test: `packages/cloudrop/src/client/retry.test.ts`, `packages/cloudrop/src/client/bucket.test.ts`

**Interfaces (produces):**

```ts
// failures.ts: every message the client writes. Each is exact; tests compare them literally.
export const aborted: () => CloudropError;            // ABORTED, "The upload was cancelled. Start it again to upload the file."
export const serverUnreachable: () => CloudropError;  // NETWORK_ERROR, retryable,
//   "The upload server could not be reached. Check the connection, then try again."
export const bucketUnreachable: () => CloudropError;  // NETWORK_ERROR, retryable,
//   "The file could not be sent to the storage service. Check the connection, then try again."
export const unreadableAnswer: (status: number) => CloudropError; // SERVER_ERROR, retryable when status >= 500,
//   `The upload server sent an answer this client cannot read (HTTP ${status}). Check that basePath points at the cloudrop handler and that the server runs the same cloudrop version.`
export const signatureMismatch: () => CloudropError;  // UPLOAD_REJECTED,
//   "The storage service refused the file because its bytes do not match what the server signed. Pick the file again and start a new upload."
export const linkRefused: () => CloudropError;        // UPLOAD_REJECTED,
//   "The storage service refused the upload link, also after it was renewed. Check the server's clock and the storage credentials' permissions, then start the upload again."
export const uploadRejected: (status: number) => CloudropError; // UPLOAD_REJECTED,
//   `The storage service refused the file (HTTP ${status}). Start the upload again, and contact the site owner if it keeps failing.`
export const storageBusy: () => CloudropError;        // RATE_LIMITED, retryable, "The storage service is busy. Try again in a moment."
export const storageDown: () => CloudropError;        // STORAGE_ERROR, retryable, "The storage service did not respond. Try again in a moment."

// retry.ts
export const MAX_ATTEMPTS: number; // 6
export function retryDelay(failedAttempts: number, retryAfterMs?: number): number;
export function parseRetryAfter(value: string | null, now?: number): number; // ms; 0 when absent or unusable
export function pause(ms: number, signal: AbortSignal): Promise<void>;     // resolves early when the signal fires
export function withRetry<T>(run: () => Promise<Result<T>>, signal: AbortSignal): Promise<Result<T>>;

// bucket.ts
export type BucketOutcome =
  | { kind: "stored" }
  | { kind: "opaque" | "expired" | "retry"; error: CloudropError; retryAfterMs: number }
  | { kind: "rejected" | "aborted"; error: CloudropError };
export function classifyAnswer(status: number, storageCode: string | undefined, retryAfterMs: number): BucketOutcome;
export function putObject(fetch: ClientFetch, target: SignedRequest, body: Blob, signal: AbortSignal): Promise<BucketOutcome>;
```

`storageBusy` and `storageDown` repeat the server's wording for the same conditions (`server/http.ts:75`, `:80`).
`ClientFetch` is declared in Task 4's `endpoints.ts`; in this task declare it there first as
`export type ClientFetch = (url: string, init: RequestInit) => Promise<Response>;` so `bucket.ts` can import it.

The exact algorithm for `retryDelay` (spec §6.2 line 206, S9):

```ts
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 20_000;

/** Full jitter: a random wait up to 0.5 s, 1 s, 2 s… (at most 20 s), never shorter than the answer's Retry-After. */
export function retryDelay(failedAttempts: number, retryAfterMs = 0): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failedAttempts - 1));
  return Math.min(MAX_DELAY_MS, Math.max(retryAfterMs, Math.random() * ceiling));
}
```

`withRetry` calls `run`; while the result's error is `retryable`, fewer than `MAX_ATTEMPTS` calls were made and the
signal has not fired, it waits `retryDelay(attempt)` with `pause` and calls again. It returns `aborted()` when the
signal fired, otherwise the last result.

`putObject` sends `fetch(target.url, { method: "PUT", headers: target.headers, body, credentials: "omit", signal })`.
A throw becomes `aborted` when `signal.aborted`, else `{ kind: "opaque", error: bucketUnreachable(), retryAfterMs: 0 }`.
A 2xx or 412 cancels the body (`response.body?.cancel()`) and is `stored`. Otherwise it reads the text (a failing read
counts as no code), takes the first `/<Code>([A-Za-z]{1,64})<\/Code>/` match, and returns
`classifyAnswer(status, code, parseRetryAfter(response.headers.get("retry-after")))`. `classifyAnswer` implements the
S10 table; the outcome's `error` is the "if attempts run out" column (`expired` → `linkRefused()`, other 403 or 4xx →
`uploadRejected(status)` or `signatureMismatch()`).

**Tests.** Doubles: `vi.spyOn(Math, "random")` (randomness), the fake R2 and a `fetch` double (network). Restore spies
in `afterEach`.

`retry.test.ts` (contract: spec §6.2 line 206; oracle: the full-jitter formula with a fixed random value, worked by
hand):

| Name | Input | Expected | Bug caught |
|---|---|---|---|
| waits up to 0.5 s after the first failure | attempt 1, random 0.5 | 250 | base off by a factor |
| doubles the ceiling per failure | attempt 3, random 0.5 | 1000 | linear growth |
| never waits longer than 20 s | attempt 7, random 0.5 | 10000 | uncapped ceiling (64 s · 0.5) |
| waits at least the answer's Retry-After | attempt 1, random 0, 3000 | 3000 | Retry-After ignored |
| caps Retry-After at 20 s | attempt 1, random 0, 60000 | 20000 | a server can stall the client |
| reads Retry-After seconds | `"3"` | 3000 | |
| reads Retry-After as an HTTP date | 10 s after `now` | 10000 | date form ignored |
| treats a past date, garbage or a negative number as no Retry-After | `"Thu, 01 Jan 1970 00:00:00 GMT"`, `"soon"`, `"-1"` | 0, 0, 0 | `NaN` reaching `setTimeout` |
| retries a retryable error until it succeeds | fails 5 times, then ok | ok, 6 calls | off-by-one budget |
| gives up after 6 attempts | always retryable | last error, 6 calls | endless retry |
| does not retry an error the server marked final | non-retryable | that error, 1 call | retrying 4xx |
| stops waiting when the upload is cancelled | abort during the pause | `ABORTED`, no further call, resolves without the timer firing | pause ignores the signal |

`bucket.test.ts` (contract: S10; oracle: the spec §6.2 table and the measured answers named in S10):

| Name | Input | Expected kind and error code |
|---|---|---|
| never retries a signature mismatch | 403 `SignatureDoesNotMatch` | rejected, `UPLOAD_REJECTED` (`signatureMismatch`) |
| renews an expired URL | 403 `ExpiredRequest` (R2, spike Q7) | expired, `UPLOAD_REJECTED` (`linkRefused`) |
| renews a RustFS expiry | 403 `AccessDenied` (`test-backends.md:44`) | expired |
| renews a 403 without a readable code | 403, no code | expired |
| retries throttling by status, whatever the S3 code says | 429 `ServiceUnavailable` (spike Q9), Retry-After 2000 | retry, `RATE_LIMITED`, `retryAfterMs` 2000 |
| retries 503 | 503 | retry, `RATE_LIMITED` |
| retries a server error | 500 | retry, `STORAGE_ERROR` |
| retries a timeout | 408 | retry, `STORAGE_ERROR` |
| fails a corrupted body | 400 `BadDigest` | rejected, `uploadRejected(400)` |
| fails a part of an aborted upload | 404 `NoSuchUpload` | rejected, `uploadRejected(404)` |
| counts a second create-only PUT as stored | the fake R2: one presigned single PUT sent twice (the second gets 412, spike Q2) | stored both times |
| reports a network failure as opaque | `fetch` double throws `TypeError` | opaque, `NETWORK_ERROR` retryable |
| reports a cancelled PUT as aborted | signal aborted, `fetch` double rejects with `AbortError` | aborted, `ABORTED` |
| sends the signed headers and no credentials to the bucket | `fetch` double records `init` | `init.headers` equals `target.headers`; `init.credentials === "omit"` |

The 412 row gets its URL from `serverFixture(...).single(...)` (`testing/server-fixture.ts:51`, `:104`) and sends with
`putObject(fixture.fake.fetch, …)`. The classifier rows call `classifyAnswer` directly (`test.each`, `$name`).

- [ ] **Step 1:** Write `retry.test.ts` and `bucket.test.ts`. Run them: they fail (modules missing).
- [ ] **Step 2:** Implement `failures.ts`, `retry.ts`, `bucket.ts` and the `ClientFetch` type.
- [ ] **Step 3:** Run the two files: 26 passed (12 + 14 rows; the three-input `parseRetryAfter` row is one `it.each`
  row per input, so count what Vitest reports and write it in the report).
- [ ] **Step 4:** Fault probes, one at a time, each restored: remove the cap in `retryDelay` (the 20 s rows fail);
  classify 403 `SignatureDoesNotMatch` as expired (its row fails); drop `credentials: "omit"` (last row fails).
- [ ] **Step 5:** Gates; `bunx biome lint --only=complexity/noExcessiveCognitiveComplexity packages/cloudrop/src/client`
  reports nothing.
- [ ] **Step 6:** Commit `feat(client): add the retry budget and the bucket answer classifier`.

### Task 4: Talking to the server

**Files:**
- Create: `packages/cloudrop/src/client/answers.ts`, `packages/cloudrop/src/client/endpoints.ts` (extend the file from
  Task 3), `packages/cloudrop/src/testing/client-fixture.ts`
- Test: `packages/cloudrop/src/client/endpoints.test.ts`

**Interfaces:**
- Consumes: wire types from `protocol/types.ts:16-128`; `isPlainObject`, `invalidInput` from `src/input.ts`;
  `countParts` from `src/plan.ts:25`; `failures.ts`.
- Produces:

```ts
// endpoints.ts
export type ClientFetch = (url: string, init: RequestInit) => Promise<Response>;
export type Ticket = SingleTicket | MultipartTicket;
export interface Endpoints {
  /** POST /upload for one file; a rejected ticket becomes its error. */
  start(route: string, file: File, metadata: unknown, signal: AbortSignal): Promise<Result<Ticket>>;
  /** POST /sign { token }: a new URL for a single PUT. */
  signSingle(token: string, signal: AbortSignal): Promise<Result<SignedRequest>>;
  /** POST /sign { token, parts }: one URL per asked part, nothing else. */
  signParts(token: string, parts: readonly number[], signal: AbortSignal): Promise<Result<SignedPart[]>>;
  /** POST /complete { token }. */
  complete(token: string, signal: AbortSignal): Promise<Result<CompleteResponse<unknown>>>;
  /** POST /abort { token }, once, without a signal; the answer is ignored. */
  abort(token: string): Promise<void>;
}
export function createEndpoints(basePath: string, fetch: ClientFetch): Endpoints;

// answers.ts: each returns the typed value, or null when the JSON has another shape.
export function readTicket(json: unknown, file: File): Ticket | ErrorBody | null;
export function readSignedRequest(json: unknown): SignedRequest | null;      // { put } of /sign
export function readSignedParts(json: unknown, asked: readonly number[]): SignedPart[] | null;
export function readCompleted(json: unknown): CompleteResponse<unknown> | null;
export function readErrorBody(json: unknown): ErrorBody | null;              // { error: { code, message, retryable, parts? } }

// testing/client-fixture.ts
export interface FaultCall { label: string; nth: number; init: RequestInit; forward(init: RequestInit): Promise<Response> }
export type Fault = (call: FaultCall) => Response | Promise<Response> | undefined;
export interface ClientFixture {
  server: ServerFixture;
  /** The client's fetch: the app origin goes to cloudrop.handler, the bucket to the fake R2. */
  fetch: ClientFetch;
  /** `${APP_ORIGIN}/api/cloudrop` */
  basePath: string;
  /** "POST /upload", "POST /sign", "POST /complete", "POST /abort", "PUT object", "PUT part 2": never a URL. */
  requests: string[];
}
export function clientFixture<TRoutes extends Record<string, Route>>(
  routes: TRoutes,
  options?: Parameters<typeof serverFixture<TRoutes>>[1] & { fault?: Fault },
): ClientFixture;
```

Rules for `endpoints.ts`. Every call `POST`s `JSON.stringify(body)` to `` `${basePath}/${endpoint}` `` with
`{ "content-type": "application/json" }`, `credentials: "include"` and the signal. A throw becomes `aborted()` when the
signal fired, else `serverUnreachable()`. A body that is not JSON becomes `unreadableAnswer(status)`. A non-2xx answer
becomes `new CloudropError(body.code, body.message, { retryable: body.retryable, parts: body.parts })` from
`readErrorBody` (the `code` string is taken as a `CloudropErrorCode`: a newer server's code passes through), or
`unreadableAnswer(status)` when the body has another shape. A 2xx answer that its reader refuses becomes
`unreadableAnswer(status)`. `start` sends `{ route, files: [{ name: file.name, size: file.size, type: file.type }],
metadata }` (`UploadRequest`, `protocol/types.ts:23-27`; `metadata` omitted when `undefined`) and turns a `rejected`
ticket into its error body's `CloudropError`.

Shapes `answers.ts` requires (anything else is `null`): `files` an array of exactly one ticket; a signed request has
string `url`, an object `headers` of string values and a string `expiresAt` that `Date.parse` reads; a multipart
ticket has a string `token`, safe integers `partSize > 0` and `partCount >= 1` with
`partCount === countParts(file.size, partSize)` (S7), and `parts` an array of signed requests each with an integer
`partNumber` from 1 to `partCount`; `/sign`'s `parts` holds exactly the asked numbers, each once; `/complete`'s `file`
is an object with string `id`, `key`, `name`, `type`, number `size`, and `url` a string or `null`; an error body has
string `code` and `message`, boolean `retryable`, and `parts`, when present, an array of positive integers (otherwise
dropped).

Rules for `client-fixture.ts`. It calls `serverFixture(routes, rest)` (`testing/server-fixture.ts:58-108`). Its `fetch`
labels the call, increments the label's count, and asks `fault` first; `forward(init)` sends to the real target. A URL
starting with `APP_ORIGIN` (`server-fixture.ts:15`) becomes `cloudrop.handler(new Request(url, { method, body,
headers: { ...init.headers, origin: APP_ORIGIN } }))`, as a same-origin browser sends it; any other URL goes to
`fake.fetch(url, init)`. It honours `init.signal`: `throwIfAborted()` before forwarding and after the answer, so a
cancelled request rejects with `AbortError` as a browser's does.

**Tests (`endpoints.test.ts`; contract: S16 and S8; oracle: the server's real answers through the fixture, and the
fetch rules of S8):**

| Name | Setup | Expected | Bug caught |
|---|---|---|---|
| reads a single-PUT ticket from /upload | 10-byte `image/png` file | `kind: "single"`, `put.headers["if-none-match"] === "*"` (`server/presign.ts:53`) | ticket dropped or misread |
| reads a multipart ticket and its first URLs | 8 MiB + 5 bytes, threshold `"8MB"` | `kind: "multipart"`, `partSize` 8 MiB, `partCount` 2, part numbers `[1, 2]` | |
| keeps the part numbers PARTS_MISSING names | `complete` before any PUT of that ticket | error `PARTS_MISSING`, `parts` `[1, 2]` (`server/complete.ts:94-102`) | `parts` dropped |
| answers a page that is not JSON as an unreadable answer | fault: 502 `text/html` | `SERVER_ERROR`, exact `unreadableAnswer(502)` message, retryable | `JSON.parse` throw escapes |
| does not retry an unreadable client error | fault: 404 `text/html` | `SERVER_ERROR`, retryable `false` | |
| refuses JSON of another shape | fault: 200 `{ "files": [] }` | `unreadableAnswer(200)` | `files[0]` undefined → TypeError |
| refuses a multipart ticket whose part count disagrees with the file | fault forwards `POST /upload` and answers its JSON with `partCount` 3 for the 8 MiB + 5 byte file | `unreadableAnswer(200)` | wrong byte ranges after a version mismatch (S7) |
| refuses a /sign answer without every asked part | fault: 200 `{ parts: [part 1 only] }` for `signParts([1, 2])` | `unreadableAnswer(200)` | a worker waits forever for part 2 |
| reports an unreachable server | fault throws `TypeError` | `NETWORK_ERROR`, `serverUnreachable()` message, retryable | |
| reports a cancelled call as aborted | aborted signal | `ABORTED` | |
| sends JSON with the page's credentials | fault records `init` and forwards | `content-type` `application/json`, `credentials` `"include"` | cookies missing cross-origin |

- [ ] **Step 1:** Write the fixture and the test file; run: fails (missing modules).
- [ ] **Step 2:** Implement `answers.ts` and `endpoints.ts`.
- [ ] **Step 3:** Run: 11 passed, each under 50 ms except the multipart rows (8 MiB through the fake; if over 250 ms,
  say why in a comment).
- [ ] **Step 4:** Fault probes: drop the `countParts` check in `readTicket` (its row fails); make `readSignedParts`
  accept a subset (its row fails).
- [ ] **Step 5:** Gates. N + 1 + 26 + 11 tests.
- [ ] **Step 6:** Commit `feat(client): add the endpoint calls and the answer checks`.

### Task 5: Sending parts

**Files:**
- Create: `packages/cloudrop/src/client/parts.ts`
- Test: `packages/cloudrop/src/client/parts.test.ts`

**Interfaces:**
- Consumes: `BucketOutcome`, `MAX_ATTEMPTS`, `retryDelay`, `pause`, `aborted`; `PARTS_PER_SIGN`, `SignedPart`,
  `SignedRequest`.
- Produces:

```ts
/** At most this many parts of one file in flight (spec §6.1). */
export const PARTS_IN_FLIGHT: number; // 4
export interface PartSender {
  signal: AbortSignal;
  /** The URLs the /upload ticket carried. */
  first: readonly SignedPart[];
  /** POST /sign for these parts; the answer holds exactly them (answers.ts checks it). */
  sign(partNumbers: readonly number[]): Promise<Result<SignedPart[]>>;
  /** PUT this part's bytes to the URL. */
  put(target: SignedRequest, partNumber: number): Promise<BucketOutcome>;
}
export type Step = { kind: "done" } | { kind: "fail"; error: CloudropError } | { kind: "again"; renew: boolean; waitMs: number };
export function nextStep(outcome: BucketOutcome, attempt: number, renewed: boolean): Step;
export function sendParts(sender: PartSender, partNumbers: readonly number[]): Promise<Result<void>>;
```

This is the algorithm the slice must get exactly right; write it as follows (module-level functions keep each one
under the complexity cap):

```ts
const RENEW_MARGIN_MS = 60_000;

interface Run {
  sender: PartSender;
  partNumbers: readonly number[];
  urls: Map<number, SignedRequest>;
  /** The /sign call that workers reaching unsigned parts share. */
  batch: Promise<CloudropError | null> | null;
}

const expiresSoon = (target: SignedRequest): boolean => Date.parse(target.expiresAt) - Date.now() < RENEW_MARGIN_MS;

/** A /sign failure, seen as the outcome of a part's attempt so one budget covers both. */
function signFailure(error: CloudropError): BucketOutcome {
  if (error.code === "ABORTED") return { kind: "aborted", error };
  return error.retryable ? { kind: "retry", error, retryAfterMs: 0 } : { kind: "rejected", error };
}

export function nextStep(outcome: BucketOutcome, attempt: number, renewed: boolean): Step {
  if (outcome.kind === "stored") return { kind: "done" };
  if (outcome.kind === "rejected" || outcome.kind === "aborted") return { kind: "fail", error: outcome.error };
  // A renewed URL refused as expired again will not get better (S11).
  if (attempt >= MAX_ATTEMPTS || (outcome.kind === "expired" && renewed)) return { kind: "fail", error: outcome.error };
  // A failure the browser hides (an expired R2 URL answers without CORS headers) or a readable expiry: new URL, once.
  const renew = (outcome.kind === "opaque" || outcome.kind === "expired") && !renewed;
  // A readable expiry is retried at once with the new URL; every other failure waits first (spec §6.2).
  const waitMs = renew && outcome.kind === "expired" ? 0 : retryDelay(attempt, outcome.retryAfterMs);
  return { kind: "again", renew, waitMs };
}

/** Signs `partNumber` and the next unsigned parts, at most PARTS_PER_SIGN, in one call that waiting workers share. */
function signAhead(run: Run, partNumber: number): Promise<CloudropError | null> {
  if (run.batch) return run.batch;
  const unsigned = run.partNumbers.filter((n) => n !== partNumber && !run.urls.has(n));
  const call = run.sender.sign([partNumber, ...unsigned].slice(0, PARTS_PER_SIGN)).then((signed) => {
    run.batch = null;
    if (signed.error) return signed.error;
    for (const part of signed.data) run.urls.set(part.partNumber, part);
    return null;
  });
  run.batch = call;
  return call;
}

async function urlFor(run: Run, partNumber: number, renew: boolean): Promise<Result<SignedRequest>> {
  let known = run.urls.get(partNumber);
  // A batch that did not include this part (another worker started it) is followed by one that does.
  while (known === undefined) {
    const error = await signAhead(run, partNumber);
    if (error) return fail(error);
    known = run.urls.get(partNumber);
  }
  if (!renew && !expiresSoon(known)) return ok(known);
  const renewed = await run.sender.sign([partNumber]);
  if (renewed.error) return renewed;
  const [part] = renewed.data;
  if (part === undefined) return fail(unreadableAnswer(200)); // unreachable: answers.ts checked the parts
  run.urls.set(partNumber, part);
  return ok(part);
}

async function sendPart(run: Run, partNumber: number): Promise<CloudropError | null> {
  let renew = false;
  let renewed = false;
  for (let attempt = 1; ; attempt++) {
    if (run.sender.signal.aborted) return aborted();
    const target = await urlFor(run, partNumber, renew);
    const outcome = target.error ? signFailure(target.error) : await run.sender.put(target.data, partNumber);
    const step = nextStep(outcome, attempt, renewed);
    if (step.kind === "done") return null;
    if (step.kind === "fail") return step.error;
    renew = step.renew;
    renewed ||= step.renew;
    await pause(step.waitMs, run.sender.signal);
  }
}

export async function sendParts(sender: PartSender, partNumbers: readonly number[]): Promise<Result<void>> {
  const run: Run = { sender, partNumbers, urls: new Map(sender.first.map((part) => [part.partNumber, part])), batch: null };
  const queue = [...partNumbers];
  let failure: CloudropError | null = null;
  // The first part that fails for good stops new parts; parts in flight finish (spec §6.2).
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined && failure === null; next = queue.shift()) {
      const error = await sendPart(run, next);
      failure ??= error;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARTS_IN_FLIGHT, queue.length) }, worker));
  return failure ? fail(failure) : ok(undefined);
}
```

Check before committing: the awaited result is read into `error` before `failure ??= error`. Writing
`failure ??= await sendPart(…)` would test `failure` before the await and assign after it, so a worker whose part
succeeded would overwrite another worker's failure with `null` (the "stops starting parts…" row catches it).
`failure ??= error` keeps the first failure. `unsigned` takes the lowest unsigned numbers because `partNumbers` is
ascending (the full list `1..n`, or `PARTS_MISSING`'s list, which the server builds in order,
`server/complete.ts:89-93`). Replace the "unreachable" line if Biome or the reviewer finds a cleaner way to read the
first element; do not add a cast.

**Tests (`parts.test.ts`; doubles: an in-memory `PartSender` whose `put` resolves after a microtask and records the
peak number of unfinished calls; `Math.random` stubbed to 0, so every backoff wait is 0 ms; `vi.useFakeTimers({ toFake:
["Date"] })` for expiry rows. Contract: S11 to S12; oracle: spec §5.2 (batches of 20), §6.1 (4 in flight), §6.2):**

| Name | Setup | Expected | Bug caught |
|---|---|---|---|
| signs the parts the ticket did not cover in batches of 20 | 45 parts, `first` = parts 1-20 | `sign` calls `[[21…40], [41…45]]`; every part put once; peak in flight 4 | eager signing; a sign call per part; unbounded parallelism |
| renews a URL that expires within a minute before using it | part 1 `expiresAt` = now + 30 s, part 2 = now + 61 s | `sign` calls `[[1]]`; part 1 sent to the renewed URL | stale URL sent |
| renews once after an opaque failure, then waits and retries | put: opaque, stored | calls in order: put, sign `[1]`, put | expired-without-CORS never renewed |
| renews only once per part | put: opaque, opaque, stored | one `sign` call | a sign storm during an outage |
| retries a readable expiry at once with a new URL | `nextStep(expired, 1, false)`, `Math.random` stubbed to 1 | `{ kind: "again", renew: true, waitMs: 0 }` | backoff before renewal |
| fails a part whose renewed URL is refused as expired | `nextStep(expired, 2, true)` | `{ kind: "fail", error: linkRefused() }` | six attempts on a URL that cannot work |
| stops starting parts after one fails for good, and lets the others finish | 10 parts, part 2 rejected; every `put` resolves one microtask after it starts | result `UPLOAD_REJECTED`; parts 1 to 5 put (part 1's worker takes part 5 before part 2's answer arrives), none of 6 to 10 | siblings aborted; the queue keeps going; part 5's success overwriting part 2's failure |
| gives up on a part after 6 attempts | put always `retry` (`storageDown`) | 6 puts, error `STORAGE_ERROR` retryable | endless retry |
| fails with a /sign error that cannot be retried | part 21 needs a URL, `sign` answers `UPLOAD_EXPIRED` | that error; no put for part 21 | sign errors swallowed |
| stops when the upload is cancelled | abort after the first put starts | `ABORTED`; no `sign` or `put` starts afterwards | work after cancel |

- [ ] **Step 1:** Write the tests; run: fail (module missing).
- [ ] **Step 2:** Implement `parts.ts` as above.
- [ ] **Step 3:** Run: 10 passed.
- [ ] **Step 4:** Fault probes: `PARTS_IN_FLIGHT = 5` (first row fails); drop `&& !renewed` (fourth row fails); start
  `worker` while `failure` is set (sixth row fails).
- [ ] **Step 5:** Gates; complexity check on `src/client` reports nothing. N + 38 + 10.
- [ ] **Step 6:** Commit `feat(client): send parts four at a time with lazy batch signing and URL renewal`.

### Task 6: `upload()` and the `cloudrop/client` entry

**Files:**
- Create: `packages/cloudrop/src/client/upload.ts`, `packages/cloudrop/src/client.ts`
- Test: `packages/cloudrop/src/client/upload.test.ts`, `packages/cloudrop/src/client/upload-failures.test.ts`,
  `packages/cloudrop/src/client.test.ts`

**Interfaces:**
- Consumes: everything above; `sizeOfPart` (`plan.ts:31-34`); `configError` (`errors.ts:75-77`); `RouteName`,
  `RouteMetadata`, `RouteResult`, `InferableCloudrop`, `CompleteResponse` (`protocol/types.ts:103-107`, `164-177`).
- Produces (`client.ts`, the public entry; decision S4):

```ts
export { CloudropError, type CloudropErrorCode, type Result } from "./errors.ts";
export type { CompleteResponse, UploadedFile } from "./protocol/types.ts";

export interface ClientOptions {
  /** Where the server's handler is mounted: a path on this page's origin or an absolute URL. Default "/api/cloudrop". */
  basePath?: string;
  /** Replaces the global fetch, for tests and runtimes that bring their own. */
  fetch?: ClientFetch;
}
export interface UploadOptions<TMetadata = unknown> {
  /** Validated by the route's schema on the server. */
  metadata?: TMetadata;
  /** Cancels the upload: requests stop, the server is told, and the result is ABORTED. */
  signal?: AbortSignal;
}
/** The options argument is required when the route's metadata is. */
export type UploadArguments<TMetadata> = undefined extends TMetadata
  ? [options?: UploadOptions<TMetadata>]
  : [options: UploadOptions<TMetadata> & { metadata: TMetadata }];
export interface CloudropClient<TCloudrop extends InferableCloudrop = InferableCloudrop> {
  upload<TName extends RouteName<TCloudrop>>(
    route: TName,
    file: File,
    ...options: UploadArguments<RouteMetadata<TCloudrop, TName>>
  ): Promise<Result<CompleteResponse<RouteResult<TCloudrop, TName>>>>;
}
export function createCloudropClient<TCloudrop extends InferableCloudrop = InferableCloudrop>(
  options?: ClientOptions,
): CloudropClient<TCloudrop>;
```

`createCloudropClient` checks `basePath` with
`/^(?:https?:\/\/[^/?#\s]+)?(?:\/[^/?#\s]+)+$/` and throws
`configError('basePath must be where the cloudrop handler is mounted, such as "/api/cloudrop" or "https://api.example.com/api/cloudrop": no trailing slash, query or fragment.')`;
it throws `configError("No fetch is available here. Pass createCloudropClient({ fetch }).")` when neither
`options.fetch` nor `globalThis.fetch` is a function. Its `upload` returns
`uploadFile(context, route, file, options[0])` with one cast to the inferred result type, commented: the server's
types reach the client through `import type` only, so the wire answer cannot be checked against them at run time.

`upload.ts`, the orchestration (exact, because the cancel and repair rules are subtle):

```ts
/** /complete may answer PARTS_MISSING this many times before the file fails (S13). */
const REPAIR_ROUNDS = 2;

export interface UploadContext {
  endpoints: Endpoints;
  fetch: ClientFetch;
}

function bodyOf(ticket: Ticket, file: File, partNumber: number): Blob {
  if (ticket.kind === "single") return file;
  const start = (partNumber - 1) * ticket.partSize;
  return file.slice(start, start + sizeOfPart(file.size, ticket.partSize, partNumber));
}

function senderFor(context: UploadContext, ticket: Ticket, file: File, signal: AbortSignal): PartSender {
  const put = (target: SignedRequest, partNumber: number) =>
    putObject(context.fetch, target, bodyOf(ticket, file, partNumber), signal);
  if (ticket.kind === "multipart") {
    return { signal, first: ticket.parts, put, sign: (parts) => context.endpoints.signParts(ticket.token, parts, signal) };
  }
  // A single PUT is part 1 of 1, so one routine sends both kinds.
  const sign = async (): Promise<Result<SignedPart[]>> => {
    const renewed = await context.endpoints.signSingle(ticket.token, signal);
    return renewed.error ? renewed : ok([{ partNumber: 1, ...renewed.data }]);
  };
  return { signal, first: [{ partNumber: 1, ...ticket.put }], put, sign };
}

async function sendAndComplete(
  context: UploadContext,
  ticket: Ticket,
  file: File,
  signal: AbortSignal,
): Promise<Result<CompleteResponse<unknown>>> {
  const sender = senderFor(context, ticket, file, signal);
  let parts = Array.from({ length: ticket.kind === "single" ? 1 : ticket.partCount }, (_, index) => index + 1);
  for (let round = 0; ; round++) {
    const sent = await sendParts(sender, parts);
    if (sent.error) return fail(sent.error);
    const done = await withRetry(() => context.endpoints.complete(ticket.token, signal), signal);
    const missing = done.error?.code === "PARTS_MISSING" ? done.error.parts : undefined;
    if (!missing?.length || round === REPAIR_ROUNDS) return done;
    parts = [...missing];
  }
}

export async function uploadFile(
  context: UploadContext,
  route: unknown,
  file: unknown,
  options: unknown,
): Promise<Result<CompleteResponse<unknown>>> {
  const problem = argumentProblem(route, file, options);
  if (problem) return fail(invalidInput(problem));
  // A signal per call, not one module-level object: the package declares sideEffects: false.
  const { metadata, signal = new AbortController().signal } = (options ?? {}) as UploadOptions;
  if (signal.aborted) return fail(aborted());
  const started = await withRetry(() => context.endpoints.start(route as string, file as File, metadata, signal), signal);
  if (started.error) return fail(signal.aborted ? aborted() : started.error);
  const result = await sendAndComplete(context, started.data, file as File, signal);
  // A completed upload stays completed: /abort with a live token would delete it (ruling R1).
  if (!result.error || !signal.aborted) return result;
  await context.endpoints.abort(started.data.token);
  return fail(aborted());
}
```

`argumentProblem(route, file, options): string | null` narrows `route` and `file` with type guards instead of the casts
above if that reads cleaner (the reviewer decides; behaviour is the same). Messages:
`'Name the upload route as text, such as upload("avatar", file).'`;
`'Pass the file as a File, such as one from <input type="file">.'`;
`"Pass the upload options as an object, such as { metadata, signal }."`;
`"options.signal must be an AbortSignal, such as new AbortController().signal."`.

**Tests.** All rows drive `createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch })` against
`clientFixture` (the real handler on the fake R2, `server-fixture.ts:58-108`). Bytes come from `offsetBytes`
(`testing/storage-contract.ts`, as `protocol.test.ts:15` uses it). Routes: `albums` as in `protocol.test.ts:26-32` plus
a `metadata` schema `{ albumId: string }` and `onComplete` returning `{ owner, bytes, albumId }`; `notes` with
`accept: "text/plain"`, `maxSize: 16`, `authorize: allowAnyone`. Threshold `"8MB"`. `Math.random` stubbed to 0.

`upload.test.ts` (contract: spec §5 and §5.4 through the real client; oracle: `protocol.test.ts`'s expected values and
the stored bytes):

| Name | Expected | Bug caught |
|---|---|---|
| uploads a small file in three requests and returns the route's result | `requests` = `["POST /upload", "PUT object", "POST /complete"]`; `data` = `{ file: { id, key: "users/42/<id>.png", name, size: 1000, type: "image/png", url: null }, data: { owner: "42", bytes: 1000, albumId: "a1" } }`; stored bytes equal | extra round trip; metadata not sent |
| uploads a multipart file in two parts cut where the server planned | 8 MiB + 5 bytes: `requests` has `PUT part 1`, `PUT part 2`, no `POST /sign`; bytes at `8 MiB - 2 … 8 MiB + 1` equal | wrong range arithmetic |
| returns authorize's refusal without sending bytes | `authorize` refuses: error `UNAUTHORIZED` with the route's message; no `PUT` in `requests` | refusal thrown, or bytes sent anyway |
| returns the server's verdict on a file the route refuses | 17-byte file to `notes`: `FILE_TOO_LARGE`, the server's message (`server/upload.ts:90-95`); no `PUT` | rejected ticket read as success |
| refuses arguments from plain JavaScript before any request | `upload(42, file)`, `upload("notes", "x")`, `upload("notes", file, { signal: {} })` | `INVALID_INPUT` with the three messages; `requests` empty |
| leaves metadata out of the request when the caller gives none | `notes` upload without options: success (the server refuses any metadata on a schemaless route, M2 D28) | `metadata: undefined` sent as `null` |

`upload-failures.test.ts` (contract: S10 to S14 through the real client and server; oracle: the measured R2 answers
named in S10, built by `fault` exactly as the fake sends them, `testing/fake-r2/responses.ts:11-13`):

| Name | Fault | Expected requests | Result |
|---|---|---|---|
| renews a URL the bucket calls expired and finishes | first `PUT object` answers 403 `ExpiredRequest` XML | upload, PUT, sign, PUT, complete | success |
| renews a URL about to expire before sending it | `fault` forwards `POST /upload`, then sets the system time 14 min 31 s later (Date faked) | upload, sign, PUT, complete | success |
| retries a busy bucket without renewing | first `PUT object` answers 503 | upload, PUT, PUT, complete | success |
| fails a file whose bytes do not match the signature, once | `forward` with `content-type` changed to `text/html` (the fake answers 403 `SignatureDoesNotMatch`, `fake-r2/signature.ts:16`) | upload, PUT | `UPLOAD_REJECTED`, `signatureMismatch()` message, not retryable |
| re-sends the parts /complete names as missing | first `PUT part 2` answers 200 without forwarding | upload, PUT part 1, PUT part 2, complete, PUT part 2, complete (the ticket's URL for part 2 is still valid, so no `/sign`) | success; bytes equal |
| gives up after two repair rounds | every `PUT part 2` answers 200 without forwarding | three `POST /complete` | `PARTS_MISSING`, `parts` `[2]` |
| cancels a multipart upload and tells the server | `fault` aborts the controller at the first `PUT part 1` | ends with `POST /abort` | `ABORTED`; `fixture.server.fake.pendingUploads()` is 0 |
| starts nothing for a signal that has already fired | aborted signal | none | `ABORTED` |
| reports an unreachable server after six tries | every `POST /upload` throws `TypeError` | six `POST /upload` | `NETWORK_ERROR`, `serverUnreachable()` message, retryable |

Every failure row asserts `{ code, message, retryable }` with `toEqual` against the literal from `failures.ts` or the
server's message: an exact message cannot contain a URL or a token.

`client.test.ts` (contract: S17, S18):

| Name | Input | Expected |
|---|---|---|
| accepts a path or an absolute URL | `"/api/cloudrop"`, `"https://api.example.com/api/cloudrop"` | no throw |
| refuses a base path the handler cannot be at | `"api/cloudrop"`, `"/api/cloudrop/"`, `"/api?x=1"`, `""` | throws `CloudropError` `INVALID_CONFIG` with the S17 message |
| calls the global fetch at request time, not as a method | `globalThis.fetch` replaced with a recording function after the client was created (`vi.stubGlobal`) | the recording function received the `/upload` call with `this` undefined |

- [ ] **Step 1:** Write the three test files; run: fail (modules missing).
- [ ] **Step 2:** Implement `upload.ts` and `client.ts`.
- [ ] **Step 3:** Run: `upload.test.ts` 6 (8 with the three-input row as `it.each`), `upload-failures.test.ts` 9,
  `client.test.ts` 3 (7 with `it.each` inputs); write what Vitest reports. Measure with `--reporter=verbose`; the
  multipart rows move 8 MiB and may pass 50 ms; any row over 250 ms states why in a comment.
- [ ] **Step 4:** Fault probes: `REPAIR_ROUNDS = 0` ("re-sends the parts…" fails); drop the `!result.error ||` guard
  and abort right after completion in a scratch row (the object is deleted: prove it, then delete the scratch row);
  send `metadata: null` when absent (last `upload.test.ts` row fails).
- [ ] **Step 5:** Gates; complexity check; `wc -l` of every new file under the caps.
- [ ] **Step 6:** Commit `feat(client): add createCloudropClient and upload()`.

### Task 7: Publish `cloudrop/client`: export, types, import rule, budget

**Files:**
- Modify: `packages/cloudrop/package.json` (`exports`, dev dependency, size budget), `packages/cloudrop/tsdown.config.ts:4`,
  `biome.json`
- Test: `packages/cloudrop/src/client/types.test.ts`

**Interfaces:**
- Produces: `"./client": { "types": "./dist/client.d.ts", "default": "./dist/client.js" }` beside `"./next"` and
  `"./node"`; tsdown entry `"src/client.ts"`.

**Type tests (`types.test.ts`; contract: S2 and S3; oracle: the route definitions in the file, as in
`server/types.test.ts:35-89`; compiled by `bun run typecheck`, one runtime `it` so Vitest does not report an empty
file).** Build a `cloudrop` with `avatar` (required metadata schema `{ albumId: string }` in, `onComplete` returning
`{ url: file.url, at: new Date() }`), `notes` (no schema, no `onComplete`) and `optional` (schema input
`{ a: string } | undefined`), then `const client = createCloudropClient<typeof cloudrop>()`:

| Row | Expression | Expected |
|---|---|---|
| route names | `Parameters<typeof client.upload>[0]` | `"avatar" \| "notes" \| "optional"` |
| result type | `client.upload("avatar", file, { metadata: { albumId: "a" } })` | `Promise<Result<CompleteResponse<{ url: string \| null; at: string }>>>` |
| required metadata | `client.upload("avatar", file)` | `@ts-expect-error` |
| metadata type | `client.upload("avatar", file, { metadata: { albumId: 1 } })` | `@ts-expect-error` |
| no metadata on a schemaless route | `client.upload("notes", file, { metadata: { a: "x" } })` | `@ts-expect-error` |
| schemaless result | `client.upload("notes", file)` | `Promise<Result<CompleteResponse<null>>>` |
| optional metadata | `client.upload("optional", file)` and with `{ metadata: { a: "x" } }` | both compile |
| unknown route | `client.upload("banner", file)` | `@ts-expect-error` |
| untyped client | `createCloudropClient().upload("anything", file)` | `Promise<Result<CompleteResponse<unknown>>>` |
| destructuring | `const { upload } = client; upload("notes", file)` | compiles |

Biome override (S19), added to `biome.json` (read Biome's own docs for the exact `overrides` shape, as lane G did for
its rule; do not write it from memory):

```json
{
  "includes": ["packages/cloudrop/src/client.ts", "packages/cloudrop/src/client/**", "!**/*.test.ts"],
  "linter": {
    "rules": {
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "patterns": [
              {
                "group": ["**/storage/**", "**/server/**", "./storage/**", "./server/**", "../storage/**", "../server/**"],
                "message": "cloudrop/client must not import storage or server code. Import from errors, input, plan or protocol."
              }
            ]
          }
        }
      }
    }
  }
}
```

- [ ] **Step 1:** Write `types.test.ts`; `bun run typecheck` passes only once `client.ts` exists (Task 6), so the RED
  here is a fault probe: change `UploadArguments` to always `[options?: …]`; typecheck reports the "required metadata"
  `@ts-expect-error` as unused. Restore.
- [ ] **Step 2:** Add the entry and the export. `bun run build`; `dist/client.d.ts` exists and exports exactly the S4
  names: `grep -E "^export" packages/cloudrop/dist/client.d.ts`. Read the d.ts: it imports nothing from a server or
  storage chunk.
- [ ] **Step 3:** Add the Biome override. Fault probe (U7): add `import { keyProblem } from "../storage/validate.ts";`
  to `src/client/upload.ts`; `bun run check` must fail with the message above. Restore. If it does not fail, find
  the pattern form that does (Biome docs), and record what matched in the report.
- [ ] **Step 4:** `bun add -d --exact @size-limit/esbuild@14.3.0` in `packages/cloudrop` (after
  `npm view @size-limit/esbuild@14.3.0 time`). U8: read size-limit's README for the default compression and the
  esbuild plugin's `import` option.
- [ ] **Step 5:** Add the budget entry next to lane G's entries:
  `{ "name": "cloudrop/client", "path": "dist/client.js", "import": "{ createCloudropClient }", "gzip": true, "limit": "<measured + 10 %>" }`.
  Measure first with a high limit; if the measurement is over 4 kB, STOP and report it (S20). Record raw, gzip and the
  limit in the commit body.
- [ ] **Step 6:** `bun run package:check` passes (publint and attw see the new export). Gates. N + 48 + the Task 6
  count + 1.
- [ ] **Step 7:** Commit `feat(client): publish cloudrop/client with its type tests, import rule and size budget`.

### Task 8: The Next.js example

**Files:**
- Create: everything under `examples/next/` in the file map except the Playwright files.
- Modify: root `package.json` (`"workspaces": ["packages/*", "examples/*"]`), `.gitignore` (`.next/`,
  `next-env.d.ts`, `test-results/`, `playwright-report/`), `biome.json` (ignore `**/.next`, `**/next-env.d.ts`,
  `**/test-results`, `**/playwright-report`), `bun.lock` (through `bun install` only).

**Interfaces:**
- Consumes: `createCloudrop`, `route`, `r2`, `s3`, `unauthorized` from `cloudrop` (root exports,
  `src/index.ts:32-54`, `:70`); `toNextHandler` from `cloudrop/next` (`src/next.ts:15-25`); `createCloudropClient` from
  `cloudrop/client`.
- Produces: an app at `http://localhost:5173` with a page that has a "Sign in as the demo user" button, a file input
  labelled "File to upload", and a `role="status"` line that reads
  `Uploaded <name> (<size> bytes) as <key>` or `<code>: <message>`.

`examples/next/package.json`: name `cloudrop-example-next`, `private: true`, `type: "module"`; scripts `dev`
(`next dev -p 5173`), `build` (`next build`), `start` (`next start -p 5173`), `typecheck` (`tsc --noEmit`),
`setup:rustfs` (`bun scripts/setup-rustfs.ts`), `test:browser` (`playwright test`); dependencies `cloudrop:
"workspace:*"`, `next`, `react`, `react-dom`; devDependencies `@playwright/test`, `@types/node`, `@types/react`,
`@types/react-dom`, `aws4fetch`, `typescript` (versions from the tech stack, exact).

`lib/cloudrop.ts` (the quickstart's server half; keep it this short):

```ts
import { createCloudrop, r2, route, s3, unauthorized } from "cloudrop";

const endpoint = process.env.CLOUDROP_S3_ENDPOINT;
const storage = endpoint
  ? s3({
      endpoint,
      region: process.env.CLOUDROP_S3_REGION ?? "us-east-1",
      bucket: process.env.CLOUDROP_S3_BUCKET ?? "",
      accessKeyId: process.env.CLOUDROP_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.CLOUDROP_S3_SECRET_ACCESS_KEY ?? "",
    })
  : r2({ bucket: process.env.CLOUDROP_R2_BUCKET ?? "" });

/** Demo only: the page sets this cookie. A real app reads its session here. */
const demoUser = (request: Request): string | undefined =>
  /(?:^|;\s*)demo-user=([a-z0-9-]{1,32})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];

export const cloudrop = createCloudrop({
  storage,
  // Small enough that the page's 20 MiB test file goes in three parts; the default is 64 MiB.
  multipartThreshold: "8MB",
  routes: {
    files: route({
      accept: ["text/plain", "application/octet-stream", "image/*"],
      maxSize: "100MB",
      authorize: ({ request }) => {
        const userId = demoUser(request);
        return userId ? { userId } : unauthorized("Sign in as the demo user first.");
      },
      prefix: ({ userId }) => `${process.env.CLOUDROP_EXAMPLE_PREFIX ?? "example"}/${userId}`,
      onComplete: ({ file }) => ({ key: file.key }),
    }),
  },
});
```

`s3()` and `r2()` throw `INVALID_CONFIG` naming every missing setting (`storage/presets.ts:40-43`), so the `?? ""`
fallbacks surface as one clear start-up error. `createCloudrop` reads `CLOUDROP_SECRET` (`server/config.ts:64-77`).

`app/api/cloudrop/[...all]/route.ts`: `export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);` (M2 D27 adds
`OPTIONS` to the spec's `{ GET, POST }`, spec line 36).

`app/page.tsx` (`"use client"`): `import type { cloudrop } from "../lib/cloudrop";`,
`const client = createCloudropClient<typeof cloudrop>();` at module scope, a button that sets
`document.cookie = "demo-user=demo; path=/; SameSite=Lax"`, and an `onChange` that calls
`client.upload("files", file)` and writes the status line from `{ data, error }`. No other state, no styling beyond
what makes it readable. `import type` keeps `lib/cloudrop.ts` (and the secret) out of the browser bundle (spec §1 line
42).

`scripts/setup-rustfs.ts` (Bun; English output, one line per step, never a secret):
1. Reads `CLOUDROP_S3_ENDPOINT` (default `http://127.0.0.1:19000`), bucket `cloudrop-example`, the RustFS keys
   `cloudrop-test` / `cloudrop-test-secret` (`scripts/rustfs.sh:9-10`).
2. Creates the bucket with an `aws4fetch` `AwsClient` (`service: "s3"`, `region: "us-east-1"`); 409 means it exists.
3. Puts the CORS rule (S3 `PutBucketCors` XML with `Content-MD5`): origins `http://localhost:5173` and
   `http://127.0.0.1:5173`, methods `PUT`, `GET`, `HEAD`, allowed headers `content-type`, `content-disposition`,
   `if-none-match`, `x-amz-meta-cloudrop-id` (the headers `checkBucket` requires, `server/bucket-check.ts:21`), expose
   `ETag` (`bucket-check.ts:36`).
4. Sends a preflight (`OPTIONS` on an object URL, `Origin: http://localhost:5173`,
   `Access-Control-Request-Method: PUT`, `Access-Control-Request-Headers: content-type,if-none-match,x-amz-meta-cloudrop-id,content-disposition`)
   and exits 1 with "RustFS did not accept the CORS rule: browsers cannot upload to it. See examples/next/README.md."
   unless the answer is 2xx with `access-control-allow-origin: http://localhost:5173`.
5. Writes `.env.local` only if it does not exist: `CLOUDROP_SECRET` (32 random bytes, base64), the five
   `CLOUDROP_S3_*` values. Prints "Wrote .env.local" or "Kept the existing .env.local".

`README.md` (the example's): what it shows; prerequisites (Docker, Bun); run with RustFS (`scripts/rustfs.sh up` with
`CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs`, `bun run build` at the root, `bun run setup:rustfs`, `bun run dev`,
open `http://localhost:5173`, `scripts/rustfs.sh down` when done); run with Wrangler for single uploads only, using
`packages/cloudrop/fixtures/wrangler/wrangler.jsonc` (bucket `contract`, keys `cloudrop-local` /
`cloudrop-local-secret`, endpoint `http://127.0.0.1:<port>/cdn-cgi/local/r2/s3`, region `auto`) and why multipart
fails there (S22); run with R2 (`CLOUDROP_R2_*`, the bucket's CORS rule in the S3 JSON shape of spike Q8 with this
example's origin); what must be true of any bucket (the CORS rule above; `ETag` exposed because `checkBucket` asks
for it and the resume plan will read it; an abort-incomplete lifecycle rule).

- [ ] **Step 1:** `npm view` each version in the tech stack; create the files; `bun install` at the root.
- [ ] **Step 2 (U4, stop condition):** `CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs scripts/rustfs.sh up`, then
  `bun run --filter cloudrop-example-next setup:rustfs`. If the preflight check fails, STOP: report the RustFS answer
  (status and `access-control-*` headers) and do not continue to Task 9; the owner chooses another local backend.
- [ ] **Step 3 (U5, U6):** `bun run build` (root), then `bun run --filter cloudrop-example-next build`. If it fails on
  TypeScript, apply S22a and record the error. If Next cannot resolve `cloudrop/client`, record the error and fix it in
  `next.config.ts` (for example the Turbopack `root` for a workspace), citing the Next.js docs page used.
- [ ] **Step 4:** `bun run --filter cloudrop-example-next start`; in a browser on `http://localhost:5173`: upload
  before signing in (status shows `UNAUTHORIZED: Sign in as the demo user first.`), sign in, upload a small text file
  and a 20 MiB file. Both show `Uploaded …`. Stop the server and `scripts/rustfs.sh down`.
- [ ] **Step 5:** `bun run --filter cloudrop-example-next typecheck`; `bun run check` (Biome now formats the example);
  root gates unchanged.
- [ ] **Step 6:** `docker ps -a --filter label=cloudrop.test` is empty; no `next` process left (`pgrep -f "next start"`
  prints nothing).
- [ ] **Step 7:** Commit `feat(examples): add the Next.js example that uploads from the browser`.

### Task 9: The browser lane

**Files:**
- Create: `examples/next/playwright.config.ts`, `examples/next/app/upload.browser.test.ts`, `scripts/test-browser.sh`
- Modify: root `package.json` (`"test:browser": "scripts/test-browser.sh"`; `verify` gains
  `&& bun run --filter cloudrop-example-next typecheck` after the build), `.github/workflows/ci.yml` (job `browser`)

**Interfaces:**
- `scripts/test-browser.sh`, in the shape of `scripts/test-rustfs.sh`: fails when port 5173 or the RustFS port is in
  use; sets `CLOUDROP_RUSTFS_NAME=cloudrop-browser-rustfs-$$`; registers `trap '"$ROOT/scripts/rustfs.sh" down' EXIT`
  before `up`; runs `bun run build`; exports `CLOUDROP_SECRET` (random per run), the `CLOUDROP_S3_*` values and
  `CLOUDROP_EXAMPLE_PREFIX=browser`; runs `setup:rustfs` (it keeps any developer `.env.local`; exported variables take
  precedence over `.env` files in Next.js, which the task confirms in Next's docs); then
  `cd examples/next && bunx playwright test`.
- `playwright.config.ts`: `testDir: "app"`, `testMatch: "**/*.browser.test.ts"`, one worker, Chromium only,
  `baseURL: "http://localhost:5173"`, `webServer: { command: "bun run build && bun run start", url:
  "http://localhost:5173", reuseExistingServer: false, timeout: 180_000 }`, `trace`, `video` and `screenshot` off (no
  artefact may hold a presigned URL; Task 10 reuses this config).

**Tests (`upload.browser.test.ts`; contract: the quickstart works in a real browser against a real S3 API; oracle: the
bytes the test created, read back through the `s3()` driver with the lane's settings, and the request kinds the page
sent):**

| Name | Steps | Expected | Bug caught |
|---|---|---|---|
| uploads a small file with one PUT | sign in; `setInputFiles` `hello.txt`, `text/plain`, 14 bytes `"hello cloudrop"` | status `Uploaded hello.txt (14 bytes) as browser/demo/<ulid>.txt`; one bucket PUT without `partNumber`; `head(key)` size 14, type `text/plain`; `getRange` equals the bytes | CORS, signed headers or Blob framing wrong in a real browser (U10) |
| uploads a 20 MiB file in three parts | sign in; `big.bin`, `application/octet-stream`, 20 MiB of `index % 251` | status `Uploaded big.bin (20971520 bytes) …`; bucket PUTs with `partNumber` 1, 2, 3; `head(key).size` 20971520; bytes `8 MiB - 2 … 8 MiB + 1` and `16 MiB - 2 … 16 MiB + 1` equal | parts cut or sent wrongly from a browser |

PUTs are counted with `page.on("request")`, recording only the method and whether `partNumber` is present and its
value: never the URL.

CI job `browser` (after `check`, `ubuntu-latest`, 20 minutes, the same three pinned actions as the `rustfs` job, no new
action): `bun install --frozen-lockfile`, `cd examples/next && bunx playwright install --with-deps chromium`,
`bun run test:browser`.

- [ ] **Step 1:** `cd examples/next && bunx playwright install chromium` (locally without `--with-deps`, which needs
  root; this writes to `~/.cache/ms-playwright`).
- [ ] **Step 2:** Write the config, the test and the script. Run `bun run test:browser`: 2 passed. Record the wall time.
- [ ] **Step 3:** Fault probe: in `src/client/bucket.ts` send `credentials: "include"`; rebuild; the lane fails (the
  bucket's CORS answer has no `access-control-allow-credentials`, so the browser blocks the PUT). If it does not
  fail, record that RustFS allows credentialed CORS and probe instead by dropping `content-type` from the PUT
  headers (403). Restore.
- [ ] **Step 4:** Run once with the RustFS port taken by another process: the script exits 1 with the port message and
  starts nothing.
- [ ] **Step 5:** Cleanup check: no container with label `cloudrop.test`, no `next` process.
- [ ] **Step 6:** Gates, including `bun run verify`.
- [ ] **Step 7:** Commit `test(examples): add the browser lane that uploads through the example on RustFS`.

### Task 10: Live R2 from a browser (owner decision S24)

Run only after the owner agrees. It measures U1 to U3 and U10 on real R2 once, then leaves the browser lane able to
repeat the two rows against R2.

**Files:**
- Create: `scripts/test-browser-live.ts`; `examples/next/scripts/measure-r2-browser.ts` (deleted again in this task)
- Modify: `docs/research/r2-spike-findings.md` (a "Browser, 2026-11-<day>" section and the "Not verified" list),
  root `package.json` (`"test:browser:live": "bun scripts/test-browser-live.ts"`)

**Interfaces:** `scripts/test-browser-live.ts` reads settings exactly as `scripts/test-live-r2.ts:19-45` does (reusing
`VARIABLES`, `parseSettingsFile`, `explainMissing`, `createRedactor` from `scripts/live-r2-settings.ts`), sets
`CLOUDROP_EXAMPLE_PREFIX=live-test/cloudrop-<32 hex>` and leaves `CLOUDROP_S3_ENDPOINT` unset, so `lib/cloudrop.ts`
uses `r2()`. It runs `bunx playwright test` in `examples/next` through the redactor, and afterwards deletes the prefix
with `cloudrop.api.deletePrefix("<prefix>/")` and prints the proof's `deleted` count (never a key).

- [ ] **Step 1:** Confirm the test bucket's CORS rule `cloudrop-browser-tests` covers `http://localhost:5173` (spec
  §12 line 367) with an account token the owner provides, or ask the owner; never write CORS on that bucket.
- [ ] **Step 2:** `CLOUDROP_R2_ENV_FILE=~/.config/cloudrop/live-r2.env bun run test:browser:live`: 2 passed;
  `deleted` equals the objects written (2).
- [ ] **Step 3:** The measurement script launches Chromium through `@playwright/test`'s `chromium`, opens
  `http://localhost:5173` (the example started with the live settings), and from the page: (a) PUTs to a URL presigned
  with `expiresIn: 1` by `r2().presignPut` under the run prefix, after waiting 2 s, recording whether `fetch` rejected
  (`TypeError`) or answered (status, and whether the body was readable); (b) PUTs to a fresh URL and records whether
  `response.headers.get("etag")` is non-null. URLs are passed into `page.evaluate` as arguments and never printed. It
  deletes what it wrote.
- [ ] **Step 4:** Record in `r2-spike-findings.md`: date, browser and version, the two upload rows (U1, U10), the
  expired-URL result (U2), the `ETag` result (U3); strike them from "Not verified" (lines 397-400). Delete the
  measurement script.
- [ ] **Step 5:** Commit `test(examples): run the browser lane on live R2 and record the browser findings`.

### Task 11: Documentation

**Files:**
- Modify: `README.md` (client quickstart and the example), `AGENTS.md` (one line: `*.browser.test.ts` runs through
  `bun run test:browser`, which needs Docker and Playwright's Chromium), `docs/research/test-backends.md` (RustFS CORS
  result from Task 8; Wrangler multipart at `/complete` if measured), `.claude/skills/testing-patterns/references/repository.md`
  (the browser lane, only where the lane list is now wrong).

- [ ] **Step 1:** README: the five-line path as it now runs (server `createCloudrop` + `route`, the Next handler line,
  `createCloudropClient<typeof cloudrop>()`, `await upload("files", file)`), with `{ data, error }` handling, and one
  line saying hooks (`useUpload`) arrive in M4. No wire type is shown imported from `cloudrop` (lane Docs item 5).
- [ ] **Step 2:** Spec edits only for decisions the owner accepted from "Not settled here" (for example S5's codes in
  §6.2, S1 in §6.4); list each edit in the commit body.
- [ ] **Step 3:** `bun run check`; commit `docs: document cloudrop/client, the example and the browser lane`.

## Definition of done for the slice

- `bun run verify` passes on Node 24; the unit lane grew by the counts each task reported, with no test over 250 ms
  that does not say why.
- `bun run test:browser` passes (2 tests) and leaves no container or process; CI's `browser` job passes on the pull
  request.
- `dist/client.d.ts` exports exactly the S4 names; `dist/client.js` and its chunks contain no server or storage code
  (`grep -l "createCloudrop\|signRequest" packages/cloudrop/dist/client.js` prints nothing, and the size budget holds).
- The example runs from its README against RustFS without credentials.
- Every owner decision below is answered, or the report says which were taken as recommended.

## Self-review

### Coverage of the brief

| Brief item | Where |
|---|---|
| `createCloudropClient`, one `upload()`, `{ data, error }`, never rejects | S2, S3, S16, S17; Task 6 |
| Single PUT and multipart, `Blob.slice` | S7; Tasks 5, 6 |
| The four endpoints, renewal through `/sign`, `PARTS_MISSING` repair, bounded retry, `/abort` on cancel | S9 to S14; Tasks 3 to 6 |
| Types from `import type` of the server | S2, S3; Task 7 type tests |
| `examples/next` with `toNextHandler`, trivial explicit authorization, small and multipart uploads | S21; Task 8 |
| Running against Wrangler or RustFS without credentials; bucket requirements | S22; Task 8 README |
| Client-driven protocol on the fake R2, type tests, one browser check, lanes named | Tasks 4 to 7 (unit, typecheck), Task 9 (browser) |
| Out of the slice, each with its owner | the "Out of the slice" table |
| Wire types exported by `cloudrop/client` | S4 |
| Neutral module first, every importer named | S6; Task 1 |
| Part arithmetic from `src/plan.ts` | S7 |
| File-size and complexity rule | Global constraints; the file map's estimates; complexity checks in Tasks 3 to 6 |
| Zero dependencies, web APIs, results, safe messages | Global constraints; S8; Task 3 messages |
| Client budget in `package:check` | S20; Task 7 |
| Example dependencies in the example's workspace, versions checked | Tech stack; S21 |
| Unverified browser behaviour named with its measuring task | U1 to U10 |

### Placeholder scan

Searched for "TBD", "TODO", "implement later", "similar to Task", "add validation", "handle errors": none. Values an
implementer fills in are measurements: the baseline N (Task 1), the bundle size (Task 7), the browser lane's wall time
(Task 9) and the live findings (Task 10).

### Names used across tasks

`invalidInput`, `isPlainObject` (Task 1); `ClientErrorCode`, `ServerErrorCode`, `hasKnownCode` (Task 2);
`aborted`, `serverUnreachable`, `bucketUnreachable`, `unreadableAnswer`, `signatureMismatch`, `linkRefused`,
`uploadRejected`, `storageBusy`, `storageDown`, `MAX_ATTEMPTS`, `retryDelay`, `parseRetryAfter`, `pause`,
`withRetry`, `BucketOutcome`, `classifyAnswer`, `putObject`, `ClientFetch` (Task 3); `Ticket`, `Endpoints`,
`createEndpoints`, `readTicket`, `readSignedRequest`, `readSignedParts`, `readCompleted`, `readErrorBody`,
`clientFixture`, `ClientFixture`, `Fault`, `FaultCall` (Task 4); `PARTS_IN_FLIGHT`, `PartSender`, `Step`,
`nextStep`, `sendParts` (Task 5); `UploadContext`, `uploadFile`, `ClientOptions`, `UploadOptions`,
`UploadArguments`, `CloudropClient`, `createCloudropClient` (Task 6). Each is defined once, in the task named.

The code in this plan was not compiled: it is the exact algorithm for the two places where the order of checks
matters (`parts.ts`, `upload.ts`), written against the types read from the branch. The implementer compiles it, and
the reviewer checks it against the decisions, not the other way round.

## Not settled here (for the owner)

Each item: the plan's recommendation, then what it costs if wrong.

1. **One file per call (S1).** Recommended: `upload(route, file)`. If wrong: adding an array form later is a widening,
   but a hook API built on a single-file call in M4 may need reshaping.
2. **Public surface of `cloudrop/client` (S4).** Recommended: ten names; the other 16 wire types stay internal
   (R38 said "cloudrop/client will export the wire types"). If wrong: a third-party client author has no protocol
   types until one is exported (non-breaking to add).
3. **Error codes `ABORTED` and `NETWORK_ERROR` (S5).** The spec names only `UPLOAD_REJECTED`. If wrong: renaming a code
   after 0.x is breaking; before the first publish it is free.
4. **Every readable 403 except `SignatureDoesNotMatch` renews once (S10).** Recommended for RustFS's `AccessDenied`
   expiry. If wrong: one extra `/sign` before a permission error surfaces.
5. **No `/abort` after a failure (S15).** If wrong: orphaned parts stay until the lifecycle rule (R2 default 7 days);
   aborting instead risks deleting a verified object whose `/complete` answer was lost.
6. **Endpoint calls with `credentials: "include"` (S8).** If wrong: a cross-origin app's cookies are not sent (with
   `"same-origin"`), or cookies go to a cross-origin server the app did not mean to authenticate to (with `"include"`;
   the server must list the origin in `trustedOrigins` first).
7. **`/upload` is retried after a network failure (S9).** If its first request reached the server, a multipart upload
   is orphaned and a future quota plugin's reservation is held until it expires (R27). Not retrying makes a brief
   network drop fail the file.
8. **No progress callback in the slice.** If wrong: the example shows no progress for a large file, and the
   ergonomics feedback the slice exists for misses progress.
9. **`createCloudropClient` is the only way in until M4.** Spec §1 (lines 42-43) says it is "needed only to customize
   the client"; the hooks will wrap a default client. If wrong: a default `upload` export may be wanted now.
10. **Bundle budget with `@size-limit/esbuild` (S20).** One more dev dependency (it brings esbuild). The alternative,
    listing `dist/client.js` and its hashed chunks by glob, breaks when tsdown renames chunks.
11. **RustFS as the example's local backend; Wrangler documented for single uploads only (S22).** If wrong, and
    RustFS fails U4, the example needs another S3 backend with CORS and ListParts (SeaweedFS and Garage claim both,
    `r2-platform-and-test-backends.md:194-195`, unmeasured).
12. **TypeScript 6.0.3 in the example if Next 16.4.6 cannot build with 7.0.2 (S22a).** If wrong: the example uses a
    different compiler than the library.
13. **A `browser` CI job on every pull request (S23).** Costs a Chromium install and a Next build per run. Without it
    the lane rots.
14. **Live R2 from a browser in the slice (S24, Task 10).** Needs the owner's test bucket and confirmation of its CORS
    rule. Without it, spec §12's open browser items stay open until the browser-lane plan.
15. **Demo cookie authorization in the example (S21).** If wrong: `allowAnyone` is simpler but teaches nothing about
    `authorize`; a real auth library adds a dependency to the example.
16. **Keep `src/server/protocol.test.ts` (S25).** If wrong: some overlap with the client tests stays until an audit
    prunes it.
17. **Internal constants:** 60 s renewal margin (S11), 2 repair rounds (S13), Retry-After capped at 20 s (S9). None is
    public; each is one number to change.
18. **The server's log line for a client code returned by a plugin** still says "an error code cloudrop does not know"
    (`server/handler.ts:95`); with S5 cloudrop knows the code but cannot send it. Recommended: leave it until a plugin
    author is confused; rewording is a one-line change with its test at `handler.test.ts:367`.
