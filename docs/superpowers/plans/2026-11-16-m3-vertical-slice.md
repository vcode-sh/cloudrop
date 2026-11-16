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

**Tech stack:** as on `main` after the hardening phase: Bun 1.4.4, TypeScript 7.0.2, Vitest 5.1.0 (on Node 24), tsdown
0.23.7, Biome 2.6.8, `size-limit` 14.3.0 with `@size-limit/file`, `publint` 0.3.25 and `@arethetypeswrong/cli` 0.18.5
(all in `packages/cloudrop/package.json`). The slice adds, checked on npm on 2026-11-16: in `packages/cloudrop` (dev
only) `@size-limit/esbuild@14.3.0` (S20); in the new `examples/next` workspace `next@16.4.6` (released 2026-11-09),
`react@19.3.1` and `react-dom@19.3.1` (2026-10-14), `@playwright/test@1.65.1` (2026-11-13), `@types/react@19.3.0`,
`@types/react-dom@19.3.0`, `@types/node@24.19.2`, `aws4fetch@1.0.20` (the version `packages/cloudrop` already resolves)
and `typescript@7.0.2` (Next 16.4.6 builds and type-checks with it, measured). Re-check each version with
`npm view <name>@<version> time` before installing; pin exactly. `packages/cloudrop` gains no runtime dependency.

**Spec:** [`docs/superpowers/specs/2026-11-15-cloudrop-design.md`](../specs/2026-11-15-cloudrop-design.md). Binding
here: §1 (quickstart, results, size), §3 (`cloudrop/client`, the `protocol` boundary), §5 (the four endpoints), §6.1 to
§6.2 (the parts this slice implements), §7 (signed headers, secrets in errors), §9 (`checkBucket`), §11 (lanes), §12
(measured R2 behaviour and what is still unverified). The spec is cited by section and item, never by line: other
lanes edit it while this plan waits for execution. Evidence:
[`docs/research/r2-spike-findings.md`](../../research/r2-spike-findings.md),
[`docs/research/test-backends.md`](../../research/test-backends.md),
[`docs/research/r2-platform-and-test-backends.md`](../../research/r2-platform-and-test-backends.md), and the
measurements made for this plan,
[`docs/research/2026-11-16-m3-slice-measurements.md`](../../research/2026-11-16-m3-slice-measurements.md) (called "the
measurements" below; its sections are §1 RustFS, §2 Wrangler, §3 Next.js, §4 Playwright).

**Decision ids:** `docs/decisions/` holds every ruling (`docs/decisions/README.md` gives the prefixes). The owner's
answers of 2026-11-16 are `M3-O1` to `M3-O4`, the hardening phase's rulings `M3-H<n>`. Three of those rulings scope
this plan: `M3-H13` (what "all wire types" in M3-O1 covers, S4), `M3-H14` (the example creates the server when its
module loads, S21) and `M3-H15` (the five decisions of the plan audit,
[`2026-11-16-m3-vertical-slice.audit.md`](2026-11-16-m3-vertical-slice.audit.md)), whose item 2 `M3-H16` amends
(S14). If an id here does not resolve when the plan executes, report it rather than renumber it.

## Before Task 1

This plan executes on a branch from `main` **after** the controller has merged the hardening phase (`feat/hardening`:
lanes U, N, L, P, then I, L2, R and Z, then the plan audit and its revision). Its citations were checked on
`feat/hardening` at `7fc6f6f` and re-checked by the plan audit at `f946826`, after lane I merged; the four numbers the
audit found stale are corrected here. The quoted code and names are authoritative; correct a stale number in the task
report, not by guessing.

What this plan relies on, and the check for each before Task 1:

- **Gates (M2 lane G).** Root scripts `check` (Biome, then `scripts/check-file-size.ts`: 250 lines per source file,
  400 per test file), `typecheck`, `test`, `build`, `package:check`, `verify` (all five), `test:rustfs`,
  `test:wrangler`, `test:live` (`package.json`). Biome's `complexity/noExcessiveCognitiveComplexity` is an error at 15
  (`biome.json`). `bun run package:check` runs `scripts/check-package.sh`: publint and attw on the packed tarball,
  then size-limit with `scripts/size-limit.config.ts`, which holds one budget per published entry and counts each
  entry together with the chunks it imports (`withImportedChunks`). The root entry no longer exports the 18 wire
  types, `Jsonified`, `RouteTypes`, `StandardIssue` or `StandardResult` (ruling M2-X38).
- **One name for the file id (lane I, owner decision M3-O2).** The tickets of `/upload` and the answer of `/abort`
  carry `id`, as `UploadedFile` does; the token payload's field is `id` too. Check:
  `grep -n "fileId" packages/cloudrop/src/protocol/types.ts` prints nothing. If it prints a line, lane I has not
  merged: STOP and report.
- **`checkBucket` on a storage that cannot read a setting (lane I).** A bucket CORS or lifecycle read that the storage
  does not support (a `501`, as Wrangler's local R2 answers) reports that check as `status: "unknown"`, with a message
  that the storage cannot report the setting and where to check it, the way a denied read does; a real failure still
  fails the call (ruling M3-H12). Check: `grep -n "unknown" packages/cloudrop/src/server/bucket-check.ts` shows the new
  case. Landed at `f946826`: `bucket-check.ts:45` and `:82`.
- **Split server files (lane U).** `server/upload.ts` became `upload.ts` (orchestration) and `upload-request.ts` (the
  request and per-file checks); the handler tests are `handler.test.ts`, `handler-cors.test.ts`,
  `handler-failures.test.ts` and `handler-origin-hint.test.ts`. The citations below use the split files.
- **Node adapter (lane N).** `toNodeHandler` answers 400 to a request that names no single valid host, and reads
  `NodeRequest.rawHeaders` when present (optional, ruling M3-H8). The slice does not touch `src/node.ts`; the example
  uses `cloudrop/next`.
- **Decisions index.** `docs/decisions/README.md` exists; every ruling cited here resolves there.

Read the merged `packages/cloudrop/package.json`, `scripts/size-limit.config.ts`, `scripts/check-package.sh`,
`biome.json` and `.github/workflows/ci.yml` before Task 1: Tasks 7 and 9 extend them and must keep their structure
(every action pinned to a commit SHA, no new action). Record the unit-lane baseline (`bun run test`: N passed,
1 skipped) in Task 1's report; every task below states how many tests it adds to that N. The plan audit measured
N = 896 (1 skipped, 50 files) at `f946826`; record what the base shows, and a different N is not a failure.

## Global constraints

- Everything in English: code, comments, docs, commit messages, test names, script output.
- `packages/cloudrop` has zero runtime dependencies; `src/` uses web-platform APIs only (`fetch`, `Blob`, `File`,
  `AbortSignal`, `URL`) and compiles with `types: []` (`packages/cloudrop/tsconfig.json:7`).
- The client imports only `src/errors.ts`, `src/input.ts`, `src/plan.ts`, `src/rules.ts` (through `plan.ts`) and
  `src/protocol/types.ts`. Never `src/storage/**` or `src/server/**`, not even a type (decision S19).
- Public calls return `{ data, error }` (`Result<T>`, `packages/cloudrop/src/errors.ts:65`). `upload()` never rejects
  for an expected failure (spec §6.4, last item); `createCloudropClient` throws `INVALID_CONFIG` for a configuration
  mistake, like `createCloudrop` (`configError`, `errors.ts:75-78`).
- Error messages say what happened and what to do next, and never contain a presigned URL, a token, a key from another
  file or a raw storage body (spec §7.7; `AGENTS.md`). Every client message is a fixed string or a fixed string with an
  HTTP status number.
- Never print, log or commit a credential, a token or a presigned URL. Tests record request labels such as
  `PUT part 2`, never URLs.
- File size: about 200 to 220 lines per source file; hard caps 250 (source) and 400 (`*.test.ts`), enforced by
  `bun run check` (which also covers `examples/` from Task 8 on). Cognitive complexity at most 15 per function. Every
  file in the file map is planned under 220 lines;
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
- A ruling that changes behaviour or a public contract gets its `docs/decisions/` entry in the same change
  (`AGENTS.md`); Task 11 lists the entries this slice adds.
- Git: stage exact paths, conventional commits, never push. Never `git stash`, `reset`, `clean` or `checkout --`. Never
  create worktrees in `/tmp`.
- Load `.claude/skills/testing-patterns` before writing tests and `.claude/skills/code-quality` before each commit.

## Decisions

Each decision says where it comes from. The owner answered the plan's open questions on 2026-11-16: S4 and the wire
name of the file id were decided (M3-O1, M3-O2), S5's codes were accepted (M3-O3), and every other recommendation was
accepted as written (M3-O4). Those are marked "(owner, accepted 2026-11-16)". Where the measurements or the plan audit
changed a decision after that, the decision says so; the audit's five decisions were ruled as it recommended
(M3-H15), and "Not settled here" records that nothing is open.

- **S1 One file per `upload()` call (owner, accepted 2026-11-16).** Spec §5.4 lets one `/upload` request start several
  files ("Multiple files in one `/upload` call share one round trip"), and the snapshot of §6.4 tracks files one by
  one; both belong to the scheduler plan. One file maps one-to-one onto `{ data, error }` without a per-file result
  inside a result. Accepting an array later widens the parameter, a non-breaking change; a hook API built on the
  single-file call in M4 may need reshaping then.
- **S2 Signature.** `upload(route, file, options?)`, `options = { metadata?, signal? }`. `route` is
  `RouteName<TCloudrop>` (`protocol/types.ts:171`); `metadata` is `RouteMetadata<TCloudrop, TName>` (`:174`) and the
  options argument is required exactly when that type does not include `undefined` (a schema whose input is required).
  `file` is a `File`: it has the name `/upload` needs (`FileDescriptor`, `protocol/types.ts:17-21`). `upload` does not
  use `this`, so `const { upload } = createCloudropClient()` works, as the quickstart destructures (spec §1).
- **S3 Result type.** `Promise<Result<CompleteResponse<RouteResult<TCloudrop, TName>>>>`: the existing wire type
  (`protocol/types.ts:103-107`) carries `{ file, data }`, and `RouteResult` (`:177`) is already the JSON form of the
  route's `onComplete` result, `null` without one (`server/route.ts:56`, tested at `server/types.test.ts:79-88` and
  `:133-150`). No new result type. Today `null` holds only for a route assigned to a constant first: written
  inline inside `createCloudrop({ routes })`, as spec §1 does, `route()` infers its result from the expected `Route`,
  and a route without `onComplete` gives the client `unknown` (measured by the plan audit, I-2). Task 7 step 1 fixes it
  in the server with `NoInfer` on `route()`'s return type (ruled part of this slice, M3-H15).
- **S4 Public surface of `cloudrop/client` (owner decision M3-O1, scoped by ruling M3-H13; the 31 names ruled in
  M3-H15).** Exactly these 31 names, each a semver promise:
  - Values (2): `createCloudropClient`, `CloudropError`.
  - Client types (6): `ClientOptions`, `CloudropClient`, `UploadOptions`, `UploadArguments`, `Result`,
    `CloudropErrorCode`.
  - Wire types (19), every exported type of `src/protocol/types.ts` that describes a request or an answer of the four
    endpoints: `AbortRequest`, `AbortResponse`, `CompleteRequest`, `CompleteResponse`, `Endpoint`, `ErrorBody`,
    `ErrorResponse`, `FileDescriptor`, `FileTicket`, `MultipartTicket`, `RejectedFile`, `SignedPart`,
    `SignedRequest`, `SignRequest`, `SignResponse`, `SingleTicket`, `UploadedFile`, `UploadRequest`,
    `UploadResponse`. These are the 18 the root entry dropped (ruling M2-X38) plus `UploadedFile`, which the root also
    keeps.
  - Route inference types (4): `InferableCloudrop`, `RouteName`, `RouteMetadata`, `RouteResult`, the types a client
    user annotates with (`RouteName<typeof cloudrop>`, a wrapper over `CloudropClient<T extends InferableCloudrop>`);
    the root entry exports the same four for server code (`src/index.ts:2-8`), so exporting them here adds no new
    promise. `InferableCloudrop` is also the constraint of the public `CloudropClient` generic.

  Not exported from `cloudrop/client` (M3-H13): the constants `MAX_BODY_BYTES`, `PARTS_PER_SIGN`, `MAX_NAME_LENGTH`
  (values are a stronger promise than types); `RouteTypes`, `Jsonified` (nobody annotates client code with them, and the
  root does not export them either, M2-X38); `RequestHandler` (a server adapter type); `ClientFetch` (the client's
  internal fetch type, reachable as `ClientOptions["fetch"]`); `CloudropErrorOptions` (client code never constructs an
  error). Adding one later is not breaking. `CloudropError` is the same class the root exports (one shared chunk), so
  `instanceof` agrees across entries.
- **S5 Three client error codes (owner decision M3-O3).** `UPLOAD_REJECTED` (named by spec §6.2's
  `SignatureDoesNotMatch` row and by M2-D17 as "a client classification"), and two the spec does not name yet:
  `ABORTED` (the caller's signal fired) and `NETWORK_ERROR` (no answer at all, retryable). They join
  `CloudropErrorCode` (`errors.ts:1-30`). The server's status table must not grow fake statuses for them, so `STATUS`
  in `server/http.ts:9-37` becomes keyed by `ServerErrorCode = Exclude<CloudropErrorCode, ClientErrorCode>` and
  `hasKnownCode` (`http.ts:63`) becomes a type guard. A plugin that returns a client code gets the generic 500 that any
  unknown code gets today (`server/handler.ts:92-98`, tested at `server/handler-failures.test.ts:79-104`).
- **S6 The neutral module is `src/input.ts` (ruling M2-X35).** It holds `invalidInput` and `isPlainObject`, moved
  verbatim from `src/storage/validate.ts:10-19`: the two helpers the client needs (arguments from plain JavaScript;
  answers from the server). M2-X35 also names `formatBytes` (`validate.ts:154-157`); it stays, because no client code
  formats a size and its callers are storage (`validate.ts:163-164`) and server modules that depend on storage anyway
  (`server/upload-request.ts:6`, `server/route-config.ts:5`). Importers, all changed in Task 1, no re-export left
  behind:
  - `invalidInput`: `storage/s3/copy.ts:4`, `storage/s3/multipart.ts:3-10` (the name at `:4`),
    `storage/s3/objects.ts:4-17` (at `:8`), `storage/s3/presign.ts:4-13` (at `:7`), `server/api.ts:6`,
    `server/http.ts:6`, `server/sign.ts:7`, `server/token-request.ts:2`, `server/upload-request.ts:6`.
  - `isPlainObject`: `storage/validate.ts:51` (its own `metadataProblem`), `server/api.ts:6`, `server/route.ts:2`,
    `server/token-request.ts:2`, `server/upload-request.ts:6`, `server/upload.ts:7`.
  - Server modules importing `storage/validate.ts` before the move: nine (`api`, `http`, `key`, `route`,
    `route-config`, `sign`, `token-request`, `upload`, `upload-request`); after it, four (`api` and `key` for
    `keyProblem`, `route-config` and `upload-request` for `formatBytes`).
- **S7 The plan in the token decides.** The client never calls `planUpload`; it numbers parts `1..ticket.partCount`
  and cuts part `n` as `file.slice((n - 1) * partSize, (n - 1) * partSize + sizeOfPart(file.size, partSize, n))`
  with `sizeOfPart` from `src/plan.ts:31-34`, the function the server signs with (`server/presign.ts:74`) and verifies
  with (`server/complete.ts:91-93`). `answers.ts` refuses a multipart ticket whose `partCount` differs from
  `countParts(file.size, partSize)` (`plan.ts:25`): a server or client version mismatch must fail, not upload wrong
  ranges.
- **S8 Transport: `fetch` everywhere in the slice (owner, accepted 2026-11-16, for the credentials mode).** Spec §3
  item 5 wants XHR for upload progress; progress is out of the slice, so XHR arrives with the progress plan. Bucket
  `PUT`s send exactly the ticket's `headers` (the rule at `protocol/types.ts:29-32`) with `credentials: "omit"`: a
  presigned URL needs no cookie, and a credentialed request would also need `Access-Control-Allow-Credentials` from the
  bucket (measured: RustFS and Wrangler both make the browser block it, the measurements §1 and §2). Endpoint `POST`s
  send `content-type: application/json` (required, `server/http.ts:143-145`) with `credentials: "include"`, so a page
  on a trusted origin sends its session cookie; the server answers such requests with the exact origin and
  `access-control-allow-credentials: true` (`http.ts:110`). With `"include"`, cookies also go to a cross-origin server
  the app lists in `trustedOrigins`.
- **S9 Retry budget (owner, accepted 2026-11-16, for retrying `/upload`).** At most 6 attempts per request,
  full-jitter backoff: before attempt `k + 1` wait a random time in `[0, min(20 s, 0.5 s · 2^(k - 1))]`; a
  `Retry-After` the answer carries is waited at least, capped at 20 s (spec §6.2's first row gives "0.5 s to 20 s, up
  to 6 attempts, honouring `Retry-After`" without a cap; the cap keeps every wait inside the spec's range). Endpoint
  calls are retried when the error is `retryable` (the server says so, `server/http.ts:42-46`) or there was no answer.
  That includes `/upload` after a network failure: if the first request reached the server, a multipart upload is
  orphaned until the lifecycle rule and a future quota reservation is held until it expires (M2-X27); not retrying
  would make a brief network drop fail the file.
- **S10 Bucket answers (spec §6.2 table; spike rows 7 and 9; the measurements §1 and §2):**

  | Answer | Outcome | Error if attempts run out |
  |---|---|---|
  | 2xx, or 412 (a retried create-only PUT whose first attempt landed, spec §5.4 first item) | stored | — |
  | `fetch` threw, signal not aborted (network, or an expired R2 URL answered without CORS headers) | opaque: renew once, wait, retry | `NETWORK_ERROR`, retryable |
  | 403 `SignatureDoesNotMatch` | rejected, never retried | `UPLOAD_REJECTED` |
  | any other readable 403 (`ExpiredRequest` on R2 and on Wrangler, `AccessDenied` on RustFS, no code) | expired: renew once, retry at once; refused again with the renewed URL, the file fails | `UPLOAD_REJECTED` |
  | 429, 503 (R2 sends S3 code `ServiceUnavailable` with 429, spike Q9) | retry after backoff | `RATE_LIMITED`, retryable |
  | 501 (the storage does not implement the request) | rejected, never retried | `UPLOAD_REJECTED` |
  | 408, other 5xx | retry after backoff | `STORAGE_ERROR`, retryable |
  | any other 4xx (400 `BadDigest`, 404 `NoSuchUpload`, …) | rejected | `UPLOAD_REJECTED` |

  Classification is by status, as the driver's is (`storage/storage-error.ts:52-74`: 429 and 503 by status, never by
  S3 code; 501 non-retryable before the retryable 5xx row); the S3 code is read only to split 403. Treating every
  readable 403 except `SignatureDoesNotMatch` as expired is wider than the spec's row (owner, accepted 2026-11-16):
  RustFS reports an expired URL as `403 AccessDenied` (`test-backends.md:66`; measured in a browser, the measurements
  §1), and one extra `/sign` is the whole cost when the 403 meant something else (RustFS also answers an unsigned
  header with `403 AccessDenied`, `test-backends.md:67`: renewed once, refused again, the file fails with
  `linkRefused`).

  What the renewal logic sees on each backend, measured with requests made by hand (the measurements §1, §2): RustFS
  and Wrangler both answer an expired URL with a **readable** 403 carrying CORS headers (`AccessDenied` and
  `ExpiredRequest`), so in a browser they take the "expired" row. R2's documentation says its expired-URL 403 has no
  CORS headers (`r2-platform-and-test-backends.md:400-401`), which would make the browser's `fetch` throw: the
  "opaque" row. Neither local backend produces that answer, so the opaque row is proven by unit tests (Task 5's
  "renews once after an opaque failure") and by R2's real answer, which only Task 10 observes.
- **S11 URL renewal.** A URL with less than 60 s left by the client's clock is renewed through `/sign` before it is
  used, at most once per attempt, so a client clock that runs ahead costs one `/sign` per part, never a loop. After an
  opaque or expired outcome the part's URL is renewed once per part per `sendParts` call (spec §6.2's second row:
  "Renew the signature once through `/sign`"); a renewed URL that is refused as expired again fails the file at once,
  since a fresh URL refused again points at a clock or permission problem that more attempts cannot fix. `/sign`
  renews one part (`{ token, parts: [n] }`) or the single PUT (`{ token }`, `server/sign.ts:30-40`).
- **S12 Parts.** At most 4 parts of a file in flight (spec §6.1 second item; 8 on one key were not throttled, spike
  Q9). Parts the ticket carried no URL for (`PARTS_PER_SIGN` = 20, `protocol/types.ts:12`, used at
  `server/upload.ts:38`) are signed lazily: the first worker that reaches an unsigned part asks `/sign` for it and the
  next unsigned parts, up to 20; other workers wait on that call. The first part that fails for good fails the call;
  parts already in flight finish and no new part starts (spec §6.2, the paragraph after the table).
- **S13 `PARTS_MISSING` repair.** `/complete` answers `PARTS_MISSING` with part numbers (`server/complete.ts:94-102`,
  carried by `ErrorBody.parts`, `protocol/types.ts:121-122`); the client re-sends exactly those parts and completes
  again, at most 2 repair rounds (3 `/complete` answers), then returns the `PARTS_MISSING` error. The spec gives no
  bound (§6.3, last item); a bound is needed so a part that never lands cannot loop.
- **S14 Cancellation (corrected by the plan audit, C-1; the keep rule ruled in M3-H15, amended by M3-H16).**
  `options.signal` reaches every `fetch` except `/complete` and `/abort`, and every backoff pause. A signal already
  aborted at the call starts no request. A cancel stops the upload before the next request starts; `/complete` runs
  without the signal, because the server may finish it (and run `onComplete`) after the browser gave up waiting, and
  `/abort` with a live token would then delete a recorded file (ruling M2-X1, `server/abort.ts:23-31`). After a cancel
  the client returns `ABORTED` and sends one `POST /abort { token }` (bounded by 10 s, answer ignored) unless any
  `/complete` attempt of this upload may have completed the file: one that got no answer (`NETWORK_ERROR`) or answered
  `SERVER_ERROR`, which the handler sends after verifying the object and keeping it (`unfinished()`,
  `server/complete.ts:17-23`) and which a proxy's unreadable page becomes (S16). Then the file is kept, never deleted.
  The flag is sticky across attempts: `/complete` is repeatable (`server/complete.ts:17`), so a later refusal says
  nothing about an earlier attempt that may have finished (M3-H16). A `/complete` that succeeds is returned as a success
  even when the signal fired meanwhile. A cancel during `/complete` returns once that request answers: it runs to its
  end so that its answer, not the cancel, decides whether the file is kept, and a server that never answers holds the
  cancelled `upload()` until the browser drops the connection. Cancelling during `/upload` loses the token: the
  multipart upload (if any) waits for the lifecycle rule and a plugin's reservation for its expiry (M2-X27). A single
  PUT cancelled after its bytes reached the bucket may land after `/abort`'s HEAD; that object is an orphan the
  lifecycle rule does not remove (the 1.1 adapters close it). Cost of keeping the file (M3-H15, M3-H16): an object the
  user believes cancelled stays until the app deletes it.
- **S15 No `/abort` after a failure (owner, accepted 2026-11-16).** A file that fails for any reason other than
  cancellation is left to the lifecycle rule: after a `/complete` attempt the object may be verified and `onComplete`
  may have run (`server/complete.ts:147-170`), and `/abort` would delete it. The resume plan owns re-trying a failed
  upload. Cost: orphaned parts stay until the lifecycle rule runs (R2's default is 7 days).
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
  `packages/cloudrop/src/client/**` (test files excluded) turns on `style/noRestrictedImports` with the two patterns
  `**/storage/**` and `**/server/**`. Measured by the plan audit (Biome 2.6.8, U7): they match `./`, `../` and `../../`
  specifiers and an `import type`, and skip `*.test.ts`. Task 7's fault probe proves the override is wired into this
  repository's `biome.json`.
- **S20 Bundle budget (owner, accepted 2026-11-16: one dev dependency).** Spec §1 allots "Client plus React under
  about 8 kB gzip", the size an application ships. The slice's budget is the gzip size of
  `import { createCloudropClient } from "cloudrop/client"` as `@size-limit/esbuild` bundles it (tree-shaken and
  minified, what an application ships) plus 10 %, rounded up to the next 0.1 kB, and the task stops if the measurement
  exceeds 4 kB (half of the allotment, which leaves the other half for the scheduler, XHR progress, persistence and
  hooks). The budget goes into `scripts/size-limit.config.ts` beside the three existing ones. Those count an entry
  together with the hashed chunks it imports, unminified and not tree-shaken (`withImportedChunks`), so they do not
  miss shared chunks; the reason to add the esbuild plugin for the client is the different question it answers: the
  minified, tree-shaken size the spec's 8 kB is stated in. Installed, the plugin bundles every check unless the check
  lists it in `disablePlugins` (read from `size-limit@14.3.0` and `@size-limit/esbuild@14.3.0`'s code by the plan audit,
  I-3; `esbuild` is not an accepted option key), so the three existing entries gain
  `disablePlugins: ["@size-limit/esbuild"]` and keep measuring summed files. Task 7 records their figures before and
  after and stops if one changes. Task 7 also records the client entry's `withImportedChunks` figure for comparison.
- **S21 The example (owner, accepted 2026-11-16, for the demo cookie).** `examples/next`, its own workspace package
  `cloudrop-example-next` (private), the root `workspaces` gains `"examples/*"`. Next.js 16.4.6 app router, React
  19.3.1, TypeScript 7.0.2, port 5173 (the live test bucket's CORS rule names `http://localhost:5173`, spec §12 "Still
  unverified" item 1). Storage from the environment: `s3()` when `CLOUDROP_S3_ENDPOINT` is non-empty (RustFS or
  Wrangler), otherwise `r2()` with its `CLOUDROP_R2_*` defaults. Authorization is a demo cookie the page sets and
  `authorize` reads, labelled as a stand-in for a session. `multipartThreshold: "8MB"` makes a 20 MiB file a
  three-part upload (8, 8, 4 MiB: `planParts`, `plan.ts:40-48`, first part size 8 MiB, `plan.ts:13`).

  **The server is created when its module loads, so `next build` needs the settings (ruling M3-H14; confirmed with
  the README line below in M3-H15).** Measured (the measurements §3):
  `next build` evaluates the route module while it collects page data, so `lib/cloudrop.ts` runs `s3()`/`r2()` and
  `createCloudrop` at build time and the build fails with `INVALID_CONFIG` unless the storage settings and
  `CLOUDROP_SECRET` are set then. The example keeps that shape and requires the settings at build time, instead of
  creating the server lazily, because: the example exists to show the quickstart (spec §1 exports
  `const cloudrop = createCloudrop(…)` and the client reads `typeof cloudrop`); a lazy getter would turn that into a
  function and the client's type into `ReturnType<typeof getCloudrop>`, which is not what users will write; and a
  missing setting then fails the build, earlier than the first upload. Cost: every build of the example needs the
  settings. Task 8 gets them from `.env.local` (that `next build` reads it is unmeasured, U11), Tasks 9 and 10 export
  them before building, and `verify` only type-checks the example, which needs none. A build that has no secrets (a
  Docker build stage with secrets only at run time) must pass them as build secrets or fails with `INVALID_CONFIG`;
  the example README says so in one sentence (Task 8). `export const dynamic` does not avoid it: Next reads that export
  from the evaluated module. `CLOUDROP_SECRET` has no `NEXT_PUBLIC_` prefix, so Next does not inline it into browser
  code; Task 8 checks that no file under `.next/static` contains it.
- **S22 Local backends for the example (owner, accepted 2026-11-16; corrected by the measurements §1 and §2).** RustFS
  1.0.5 is the documented default: it accepts and enforces `PutBucketCors`, answers the preflight with the origin, and
  a browser uploads single files and every part with `ETag` readable (measured). Wrangler's local R2 lets any local
  origin upload without a CORS rule (`access-control-allow-origin: *`; a non-`localhost` origin gets
  `403 Invalid Origin header`), and a browser uploads single files there, but a multipart upload cannot finish: every
  part uploads, then `/complete` answers `502` with `{ code: "STORAGE_ERROR", message: "The storage service refused
  the request. Contact the site owner if this keeps happening.", retryable: false }`, because ListParts answers
  `501 NotImplemented` (`test-backends.md:97`) and the driver maps `501` to a non-retryable `STORAGE_ERROR`
  (`storage/storage-error.ts:63-68`), which `completeParts` passes through `storageFailure`
  (`server/complete.ts:82-87`, `server/http.ts:75-90`). The plan's earlier "retryable `STORAGE_ERROR`" was wrong. What
  the client does with it: `withRetry` does not retry a non-retryable error, so `upload()` returns that error after
  one `/complete`; it sends no `/abort` (S15). The upload then stays open in Wrangler's state (from the code: nothing
  aborts it; Wrangler's `ListMultipartUploads` also answers `501`, so it cannot be listed). Only the server log says
  "The storage service does not support this request." The example README documents Wrangler for single uploads only,
  in those words. `api.checkBucket` on Wrangler reports CORS and lifecycle as `unknown` (ruling M3-H12,
  `server/bucket-check.ts:45`, `:82`).
- **S23 Browser lane (owner, accepted 2026-11-16: CI minutes).** Playwright 1.65.1, Chromium only (headless, which
  uses Chromium's headless shell), files named `*.browser.test.ts`, run by `scripts/test-browser.sh` against a
  disposable RustFS container and the example built with `next build` and served with `next start`. A CI job runs it
  on every pull request and installs only the headless shell (`--only-shell`: 287 MB on disk and 5.9 s here, against
  701 MB and 13.2 s for the full install, the measurements §4).
- **S24 Live R2 in the browser (owner, accepted 2026-11-16).** Task 10 runs the same browser check against the owner's
  test bucket and measures spec §12's "Still unverified" item 1 (browser PUT and parts, reading `ETag`, CORS on an
  expired URL's 403) once, recording the result in `docs/research/r2-spike-findings.md`. It needs the owner's test
  bucket and a confirmation of its CORS rule, checked when Task 10 runs (its step 1 is the precondition and the stop
  condition; ruled in M3-H15). Spec §12 records that the rule `cloudrop-browser-tests` was added on 2026-11-15 for
  `http://localhost:5173` and `http://127.0.0.1:5173`.
- **S25 `src/server/protocol.test.ts` stays (owner, accepted 2026-11-16).** It pins the wire format without the client
  (its header, `protocol.test.ts:1-2`); the client tests prove the client against the same server. Pruning the overlap
  is a later audit (M2 audit finding T7-3, "A9"), once the client is the main consumer.
- **S26 Small decisions accepted with the plan (owner, accepted 2026-11-16).** No progress callback in the slice (with
  `fetch` it could only report whole parts, and its shape would be decided twice); `createCloudropClient` is the only
  way in until M4 (spec §1 says it is "needed only to customize the client"; the hooks will wrap a default client);
  the internal constants (60 s renewal margin, S11; 2 repair rounds, S13; `Retry-After` capped at 20 s, S9) are not
  public, each one number to change; the server's log line for a client code returned by a plugin keeps saying "an
  error code cloudrop does not know" (`server/handler.ts:94`), reworded only if a plugin author is confused.

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
| Several files per call, `error.file` (§1 "Results, not exceptions") | M3 scheduler plan (with S1) |

## Unverified behaviour and where it gets measured

The measurements settled U4 and U5, U6 for the server entries, and the local-backend half of U1 to U3 and U10, each
with requests a page made by hand, not with the client. The plan audit settled U7 and U8 and added U15. What is left:

| # | Behaviour | State | Measured in |
|---|---|---|---|
| U1 | A browser `PUT` and `UploadPart` from a page succeed with our signed headers | RustFS and Wrangler: yes, by hand (the measurements §1, §2). R2: not measured (spike "Not verified", `r2-spike-findings.md:395-400`) | Task 9 (the client on RustFS), Task 10 (R2) |
| U2 | An expired URL's 403 carries CORS headers (readable) or not (opaque) | RustFS (`AccessDenied`) and Wrangler (`ExpiredRequest`): readable (the measurements §1, §2). R2: its docs say opaque (`r2-platform-and-test-backends.md:400-401`); spike Q7 was blocked (`r2-spike-findings.md:236-244`) | Task 10. The client handles both (S10); only R2 can show the opaque case |
| U3 | `ETag` is readable from JavaScript | RustFS (rule exposes it) and Wrangler (`*`): yes. R2: not measured | Task 10. The slice does not read it: `/complete` lists parts itself (`server/complete.ts:82-103`) |
| U4 | RustFS 1.0.5 accepts `PutBucketCors` and answers a preflight from `http://localhost:5173` | **Settled** (the measurements §1, on port 3050 with the same rule shape) | Task 8 step 2 runs it again as the setup check |
| U5 | Next.js 16.4.6 builds with TypeScript 7.0.2 | **Settled**: builds and type-checks through TypeScript's CLI (`experimental.useTypeScriptCli`, default `true`; the measurements §3). The TypeScript 6 fallback is dropped | — |
| U6 | Next.js resolves the workspace package `cloudrop` through its `exports` to `dist/` | Settled for the server entries (`cloudrop`, `cloudrop/next` in a route handler). `cloudrop/client` in a `"use client"` page (the browser bundle) is not measured: the entry did not exist | Task 8 step 3 (fallback and stop condition kept) |
| U7 | Biome's `noRestrictedImports` patterns match relative specifiers | **Settled** (plan audit, Biome 2.6.8): `**/storage/**` and `**/server/**` match `./`, `../`, `../../` and `import type`, and skip `*.test.ts` | Task 7 step 4 (fault probe: the override is wired in) |
| U8 | `@size-limit/esbuild`'s tree-shaking of an ESM entry, and whether installing it changes the three existing file-based budgets | **Settled** from `size-limit@14.3.0` and `@size-limit/esbuild@14.3.0`'s code (plan audit): the plugin applies to every check unless the check lists it in `disablePlugins` | Task 7 steps 5 and 6 (the three figures stay byte-equal; stop otherwise) |
| U15 | The extra install `examples/*` adds to every CI job's `bun install --frozen-lockfile` (Next with its SWC binaries, React, Playwright's package; no browser download) | not measured (plan audit, X-6) | Task 9, the first CI run, beside U13 |
| U9 | `Retry-After` is readable in a browser only if the bucket's CORS rule exposes it; whether R2 sends it at all | not measured | Not in the slice; the client reads it when visible |
| U10 | `fetch` with a `Blob` body sends exactly the signed `content-length` | RustFS and Wrangler: yes, by hand, single PUT and `Blob.slice` parts (the measurements §1, §2). R2 and the client's own requests: not measured (spike "Not verified", `r2-spike-findings.md:398-399`, "should match") | Task 9 (RustFS), Task 10 (R2) |
| U11 | `next build` reads `examples/next/.env.local` | not measured (Next's documented behaviour) | Task 8 step 3 |
| U12 | RustFS 1.0.5 accepts `PutBucketLifecycleConfiguration` with an abort-incomplete rule | not measured; without a rule `checkBucket` reports `lifecycle: problem` (the measurements §1) | Task 8 step 2 (no stop: uploads work without it) |
| U13 | `bunx playwright install --with-deps --only-shell chromium` on `ubuntu-latest` | not measured (locally `--with-deps` was not needed) | Task 9, the first CI run |
| U14 | Variables exported before `next build`/`next start` win over `.env.local`, also when exported empty | from the code of `@next/env@16.4.6` (`dist/index.js`: a file's value is used only when the key is `undefined` in the original environment), not measured | Task 9 (exported values), Task 10 (an empty `CLOUDROP_S3_ENDPOINT`) |

## File map

```
packages/cloudrop/
  src/input.ts                          invalidInput, isPlainObject (Task 1)                          ~25 lines
  src/errors.ts                         + UPLOAD_REJECTED, ABORTED, NETWORK_ERROR; ClientErrorCode (Task 2)
  src/server/http.ts                    STATUS keyed by ServerErrorCode; hasKnownCode a type guard (Task 2)
  src/server/route.ts                   NoInfer on route()'s return type (Task 7)
  src/client/failures.ts                the client's error constructors (Task 3)                     ~70 lines
  src/client/retry.ts                   MAX_ATTEMPTS, retryDelay, parseRetryAfter, pause, withRetry (Task 3) ~80
  src/client/bucket.ts                  BucketOutcome, classifyAnswer, putObject (Task 3)              ~90 lines
  src/client/answers.ts                 shape checks for the four endpoints' answers (Task 4)          ~120 lines
  src/client/endpoints.ts               ClientFetch (Task 3); Ticket, Endpoints, createEndpoints (Task 4) ~105 lines
  src/client/parts.ts                   PARTS_IN_FLIGHT, PartSender, nextStep, sendParts (Task 5)      ~140 lines
  src/client/upload.ts                  uploadFile: start, send, complete, repair, cancel (Task 6)     ~145 lines
  src/client.ts                         the cloudrop/client entry (Task 6)                            ~110 lines
  src/testing/client-fixture.ts         the server fixture behind a fetch the client can use (Task 4) ~105 lines
  tests: src/client/{retry,bucket,endpoints,parts,upload,upload-failures,types}.test.ts, src/client.test.ts;
         one new `it` in src/server/types.test.ts (Task 7)
  package.json                          exports "./client"; dev @size-limit/esbuild (Task 7)
  tsdown.config.ts                      entry src/client.ts (Task 7)
scripts/size-limit.config.ts            the cloudrop/client budget (Task 7)
examples/next/                          (Task 8)
  package.json, next.config.ts, tsconfig.json (in the shape Next writes), README.md
  lib/cloudrop.ts                       the server: createCloudrop with one route; the exported storage
  app/api/cloudrop/[...all]/route.ts    export const { GET, POST, OPTIONS } = toNextHandler(cloudrop)
  app/layout.tsx, app/page.tsx          the upload page ("use client")
  scripts/setup-rustfs.ts               bucket, CORS rule, preflight check, lifecycle rule, .env.local
  playwright.config.ts, app/upload.browser.test.ts (Task 9)
scripts/test-browser.sh                 the browser lane (Task 9)
scripts/test-browser-live.ts            the browser lane on live R2 (Task 10)
scripts/check-file-size.ts              also lists examples/*/**/*.ts and *.tsx (Task 8)
package.json                            workspaces + examples/*; test:browser; test:browser:live; verify (Tasks 8-10)
biome.json, .gitignore                  client import rule; .next and Playwright output ignored (Tasks 7, 8)
.github/workflows/ci.yml                browser job; the example's typecheck in the check job (Task 9)
AGENTS.md, README.md, docs/research/*, docs/decisions/*   (Tasks 10, 11)
```

Nothing under `src/client/` imports `src/storage/**` or `src/server/**`. `src/testing/client-fixture.ts` does: it is
test infrastructure, like `server-fixture.ts`, and is not an entry.

## Threats and the tests that close them

| Threat | Defence | Test (file › name) |
|---|---|---|
| A presigned URL or token in an error message | fixed messages; exact message asserted in every failure row | upload-failures › every row asserts `{ code, message, retryable }` exactly |
| Cookies sent to the bucket | `credentials: "omit"` on PUT | bucket › "sends the signed headers and no credentials to the bucket"; Task 9's fault probe in a real browser |
| Bytes of one part sent under another part's URL | parts cut with the server's `sizeOfPart`; the bucket refuses another length (spike Q1) | upload › "uploads a multipart file…" (bytes on both sides of the boundary) |
| A wrong server answer making `upload()` reject | every answer validated (S16) | endpoints › non-JSON, wrong-shape and short `/sign` rows |
| Endless retries or repairs | 6 attempts (S9), 2 repair rounds (S13) | retry › "gives up after 6 attempts"; upload-failures › "gives up after two repair rounds" |
| A cancelled upload left open, or a completed one deleted by a late cancel | `/abort` only when no `/complete` attempt may have succeeded; `/complete` runs without the signal (S14) | upload-failures › cancel rows and the four /complete cancel rows |
| A route result typed `unknown` for the quickstart's inline routes | `NoInfer` on `route()` (S3, Task 7 step 1) | types › "types an inline route without onComplete as null, as the quickstart writes routes" |
| Server code in the browser bundle | Biome import rule (S19); budget (S20) | Task 7 fault probe; `bun run package:check` |
| The upload secret in the browser bundle | `import type` of the server; no `NEXT_PUBLIC_` prefix (S21) | Task 8 step 3, the `.next/static` check |

---

### Task 1: The neutral input module (ruling M2-X35)

A pure move: same behaviour, same messages, no test changes.

**Files:**
- Create: `packages/cloudrop/src/input.ts`
- Modify: `packages/cloudrop/src/storage/validate.ts:1`, `:10-19` (drop `invalidInput` and `isPlainObject` and the
  now unused `CloudropError` import, import `isPlainObject` from `../input.ts`); the import lines listed in S6.

**Interfaces:**
- Produces: `invalidInput(message: string): CloudropError` (code `INVALID_INPUT`) and
  `isPlainObject(value: unknown): value is Record<string, unknown>`, both from `src/input.ts`, bodies and doc
  comments copied unchanged from `validate.ts:10-19`.

**Tests:** none new. Both helpers are covered through their callers (no test imports them directly:
`grep -rn "isPlainObject\|invalidInput" --include=*.test.ts packages/cloudrop/src` finds nothing on `7fc6f6f`; run it
again on the base and record the answer).

- [ ] **Step 1:** Run the checks of "Before Task 1". Record the baseline: `bun run verify`. Write N (unit tests
  passed) in the report.
- [ ] **Step 2:** Create `src/input.ts` with the two functions and a one-line header: "Untrusted input: the error for
  it, and the plain-object check every JSON reader uses. Shared by storage, server and client."
- [ ] **Step 3:** Delete them from `validate.ts`, replace its `import { CloudropError } from "../errors.ts";` with
  `import { isPlainObject } from "../input.ts";` (nothing else in the file uses `CloudropError`). Rewrite
  each importer in S6 to import from `../input.ts` (server) or `../../input.ts` (storage/s3), keeping its other
  `validate.ts` names where it had any.
- [ ] **Step 4:** `bun run typecheck` proves no importer was missed: `validate.ts` no longer exports either name, so a
  stale import fails to compile (the multi-line imports in `storage/s3/*.ts` defeat a one-line grep).
- [ ] **Step 5:** Gates: `bun run check`, `bun run typecheck`, `bun run test` (N passed, unchanged), `bun run build`.
- [ ] **Step 6:** Commit `refactor: move invalidInput and isPlainObject to a neutral input module`.

### Task 2: Client error codes, and a server status table that cannot send them

**Files:**
- Modify: `packages/cloudrop/src/errors.ts:1-30`, `packages/cloudrop/src/server/http.ts:9-37`, `:62-63`, `:65-69`
- Test: `packages/cloudrop/src/server/handler-failures.test.ts:79-104`

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
  `ClientErrorCode` is not exported from `src/index.ts` or `src/client.ts`.
- Produces in `http.ts`: `type ServerErrorCode = Exclude<CloudropErrorCode, ClientErrorCode>`;
  `STATUS … satisfies Record<ServerErrorCode, number>`;
  `export const hasKnownCode = (error: CloudropError): error is CloudropError & { code: ServerErrorCode } => Object.hasOwn(STATUS, error.code);`
  (keep its doc comment at `:62`). `errorResponse` keeps its body; `STATUS[error.code]` now type-checks through the
  guard.

**Tests (contract: the server never answers 200 or a made-up status for a code it cannot send; oracle: the existing
row's literal body and log line; bug caught: a later edit adds the client codes to `STATUS`):**

| Row | Plugin's code | Expected |
|---|---|---|
| existing | `"QUOTA_EXCEEDED"` | 500 `SERVER_ERROR`, logged as today |
| new | `"ABORTED"` | the same 500 body and log line, with `code: "ABORTED"` in the logged error |

- [ ] **Step 1:** Turn the test at `handler-failures.test.ts:80` into `it.each` over the two codes, title
  `"answers a plugin refusal with the code $code, which the server cannot send, as a generic 500"`. Keep every
  assertion; the logged error's `code` becomes the row's code. Run it: both rows pass today (the code is unknown to
  `STATUS`), which is the contract to keep.
- [ ] **Step 2:** Make the type changes. `bun run typecheck` passes.
- [ ] **Step 3:** Fault probe: add `ABORTED: 499,` to `STATUS`; `bun run typecheck` fails (excess property against
  `Record<ServerErrorCode, number>`) and the new row fails (499). Restore.
- [ ] **Step 4:** Gates as in Task 1; N + 1 tests. `wc -l handler-failures.test.ts` stays at or below 400 (110 today).
- [ ] **Step 5:** Commit `feat(errors): add the client's error codes UPLOAD_REJECTED, ABORTED and NETWORK_ERROR`.

### Task 3: Retry, bucket answers and the client's errors

**Files:**
- Create: `packages/cloudrop/src/client/failures.ts`, `packages/cloudrop/src/client/retry.ts`,
  `packages/cloudrop/src/client/bucket.ts`
- Create: `packages/cloudrop/src/client/endpoints.ts` (only `ClientFetch`; Task 4 fills it)
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
export const storageDown: () => CloudropError;        // STORAGE_ERROR, retryable, "The storage service failed. Try again in a moment."

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

`storageBusy` and `storageDown` repeat the server's wording for the same conditions (`server/http.ts:78` and `:83`).
`ClientFetch` is declared in Task 4's `endpoints.ts`; in this task declare it there first as
`export type ClientFetch = (url: string, init: RequestInit) => Promise<Response>;` so `bucket.ts` can import it.

The exact algorithm for `retryDelay` (spec §6.2's first row, S9):

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
signal has not fired, it waits `retryDelay(attempt)` with `pause` and calls again. It checks the signal before each
attempt and after each pause, and returns `aborted()` when the signal fired there. A success or a non-retryable error
is returned as it is, even when the signal fired while that call ran (S14: a `/complete` that succeeded stays a
success), and so is the last retryable error once the attempts run out.

`putObject` sends `fetch(target.url, { method: "PUT", headers: target.headers, body, credentials: "omit", signal })`.
A throw becomes `aborted` when `signal.aborted`, else `{ kind: "opaque", error: bucketUnreachable(), retryAfterMs: 0 }`.
A 2xx or 412 cancels the body (`response.body?.cancel()`) and is `stored`. Otherwise it reads the text (a failing read
counts as no code), takes the first `/<Code>([A-Za-z]{1,64})<\/Code>/` match, and returns
`classifyAnswer(status, code, parseRetryAfter(response.headers.get("retry-after")))`. `classifyAnswer` implements the
S10 table in its order (403 split by code, then 429/503, then 501, then 408 and other 5xx, then other 4xx); the
outcome's `error` is the "if attempts run out" column (`expired` → `linkRefused()`, 501 and other 4xx →
`uploadRejected(status)`, `SignatureDoesNotMatch` → `signatureMismatch()`).

**Tests.** Doubles: `vi.spyOn(Math, "random")` (randomness), the fake R2 and a `fetch` double (network). Restore spies
in `afterEach`.

`retry.test.ts` (contract: spec §6.2's first row; oracle: the full-jitter formula with a fixed random value, worked by
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
| keeps a success that arrives after a cancel | `run` aborts the controller, then resolves ok | ok, 1 call | a completed `/complete` reported as `ABORTED` (S14) |

`bucket.test.ts` (contract: S10; oracle: the spec §6.2 table and the measured answers named in S10):

| Name | Input | Expected kind and error code |
|---|---|---|
| never retries a signature mismatch | 403 `SignatureDoesNotMatch` | rejected, `UPLOAD_REJECTED` (`signatureMismatch`) |
| renews an expired URL | 403 `ExpiredRequest` (R2, spike Q7; Wrangler, the measurements §2) | expired, `UPLOAD_REJECTED` (`linkRefused`) |
| renews a RustFS expiry | 403 `AccessDenied` (`test-backends.md:66`; the measurements §1) | expired |
| renews a 403 without a readable code | 403, no code | expired |
| retries throttling by status, whatever the S3 code says | 429 `ServiceUnavailable` (spike Q9), Retry-After 2000 | retry, `RATE_LIMITED`, `retryAfterMs` 2000 |
| retries 503 | 503 | retry, `RATE_LIMITED` |
| fails a request the storage does not implement | 501 `NotImplemented` | rejected, `uploadRejected(501)` |
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
- [ ] **Step 3:** Run the two files: 13 + 15 rows (the three-input `parseRetryAfter` row is one `it.each` row per
  input, so Vitest reports 30); write what Vitest reports in the report.
- [ ] **Step 4:** Fault probes, one at a time, each restored: remove the cap in `retryDelay` (the 20 s rows fail);
  classify 403 `SignatureDoesNotMatch` as expired (its row fails); drop the 501 rule (its row fails: 501 retried);
  drop `credentials: "omit"` (last row fails); return `aborted()` whenever the signal has fired, also after a success
  ("keeps a success that arrives after a cancel" fails).
- [ ] **Step 5:** Gates; `bunx biome lint --only=complexity/noExcessiveCognitiveComplexity packages/cloudrop/src/client`
  reports nothing. N + 1 + the count of step 3.
- [ ] **Step 6:** Commit `feat(client): add the retry budget and the bucket answer classifier`.

### Task 4: Talking to the server

**Files:**
- Create: `packages/cloudrop/src/client/answers.ts`, `packages/cloudrop/src/testing/client-fixture.ts`
- Modify: `packages/cloudrop/src/client/endpoints.ts` (extend the file from Task 3)
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
  /** POST /complete { token }, without the caller's signal: a cancel must not cut off a /complete the server may finish. */
  complete(token: string): Promise<Result<CompleteResponse<unknown>>>;
  /** POST /abort { token }, once; never rejects, gives up after ABORT_TIMEOUT_MS (10 s); the answer ({ id }) is ignored. */
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
  options?: Parameters<typeof serverFixture<TRoutes>>[1] & {
    fault?: Fault;
    /** Added to every request to the app, as a browser's session cookie would be: the client itself sends none. */
    appHeaders?: Record<string, string>;
  },
): ClientFixture;
```

Rules for `endpoints.ts`. Every call `POST`s `JSON.stringify(body)` to `` `${basePath}/${endpoint}` `` with
`{ "content-type": "application/json" }`, `credentials: "include"` and the signal (`complete` and `abort` send none).
A throw becomes `aborted()` when the signal fired, else `serverUnreachable()`; for `complete`, which has no signal, a
throw is always `serverUnreachable()`. `abort` sends `signal: AbortSignal.timeout(ABORT_TIMEOUT_MS)` with
`const ABORT_TIMEOUT_MS = 10_000;` (so a server that never answers cannot hold a cancelled `upload()` open), and wraps
the call in `catch`: it resolves whatever happens. No test of its own: the cancel rows show `/abort` is sent. A body
that is not JSON becomes `unreadableAnswer(status)`. A non-2xx answer becomes `new CloudropError(body.code, body.message, { retryable: body.retryable, parts: body.parts })` from
`readErrorBody` (the `code` string is taken as a `CloudropErrorCode`: a newer server's code passes through), or
`unreadableAnswer(status)` when the body has another shape. A 2xx answer that its reader refuses becomes
`unreadableAnswer(status)`. `start` sends `{ route, files: [{ name: file.name, size: file.size, type: file.type }],
metadata }` (`UploadRequest`, `protocol/types.ts:23-27`; `metadata` omitted when `undefined`) and turns a `rejected`
ticket into its error body's `CloudropError`.

Shapes `answers.ts` requires (anything else is `null`). Wire field names as on the merged server (M3-O2: the file id is
`id` everywhere):
- `/upload`: `files` an array of exactly one ticket. A `single` or `multipart` ticket has string `id`, `key`, `token`
  and `expiresAt` (one `Date.parse` reads). A `rejected` ticket has an `error` that is an error body.
- A signed request has string `url`, an object `headers` of string values and a string `expiresAt` that `Date.parse`
  reads; a single ticket's `put` is one.
- A multipart ticket has safe integers `partSize > 0` and `partCount >= 1` with
  `partCount === countParts(file.size, partSize)` (S7), and `parts` an array of signed requests each with an integer
  `partNumber` from 1 to `partCount`.
- `/sign`: `put` a signed request, or `parts` holding exactly the asked numbers, each once.
- `/complete`: `file` an object with string `id`, `key`, `name`, `type`, number `size`, and `url` a string or `null`;
  `data` any JSON value (`null` without `onComplete`).
- An error body has string `code` and `message`, boolean `retryable`, and `parts`, when present, an array of positive
  integers (otherwise dropped).

Rules for `client-fixture.ts`. It calls `serverFixture(routes, rest)` (`testing/server-fixture.ts:58-108`). Its `fetch`
labels the call, increments the label's count, and asks `fault` first; `forward(init)` sends to the real target. A URL
starting with `APP_ORIGIN` (`server-fixture.ts:15`) becomes `cloudrop.handler(new Request(url, { method, body,
headers: { ...init.headers, ...appHeaders, origin: APP_ORIGIN } }))`, as a same-origin browser sends it; any other URL
goes to `fake.fetch(url, init)`. It honours `init.signal`: `throwIfAborted()` before forwarding and after the answer,
so a cancelled request rejects with `AbortError` as a browser's does.

**Tests (`endpoints.test.ts`; contract: S16 and S8; oracle: the server's real answers through the fixture, and the
fetch rules of S8):**

| Name | Setup | Expected | Bug caught |
|---|---|---|---|
| reads a single-PUT ticket from /upload | 10-byte `image/png` file | `kind: "single"`, an `id` string, `put.headers["if-none-match"] === "*"` (`server/presign.ts:53`) | ticket dropped or misread |
| reads a multipart ticket and its first URLs | 8 MiB + 5 bytes, threshold `"8MB"` | `kind: "multipart"`, `partSize` 8 MiB, `partCount` 2, part numbers `[1, 2]` | |
| keeps the part numbers PARTS_MISSING names | `complete` before any PUT of that ticket | error `PARTS_MISSING`, `parts` `[1, 2]` (`server/complete.ts:94-102`) | `parts` dropped |
| answers a page that is not JSON as an unreadable answer | fault: 502 `text/html` | `SERVER_ERROR`, exact `unreadableAnswer(502)` message, retryable | `JSON.parse` throw escapes |
| does not retry an unreadable client error | fault: 404 `text/html` | `SERVER_ERROR`, retryable `false` | |
| refuses JSON of another shape | fault: 200 `{ "files": [] }` | `unreadableAnswer(200)` | `files[0]` undefined → TypeError |
| refuses a multipart ticket whose part count disagrees with the file | fault forwards `POST /upload` and answers its JSON with `partCount` 3 for the 8 MiB + 5 byte file | `unreadableAnswer(200)` | wrong byte ranges after a version mismatch (S7) |
| refuses a /sign answer without every asked part | fault: 200 `{ parts: [part 1 only] }` for `signParts([1, 2])` | `unreadableAnswer(200)` | a worker waits forever for part 2 |
| reports an unreachable server | fault throws `TypeError` | `NETWORK_ERROR`, `serverUnreachable()` message, retryable | |
| reports a cancelled call as aborted | `start` with an aborted signal | `ABORTED` | |
| sends JSON with the page's credentials | fault records `init` and forwards | `content-type` `application/json`, `credentials` `"include"` | cookies missing cross-origin |

- [ ] **Step 1:** Write the fixture and the test file; run: fails (missing modules).
- [ ] **Step 2:** Implement `answers.ts` and `endpoints.ts`.
- [ ] **Step 3:** Run: 11 passed, each under 50 ms except the multipart rows (8 MiB through the fake; if over 250 ms,
  say why in a comment).
- [ ] **Step 4:** Fault probes: drop the `countParts` check in `readTicket` (its row fails); make `readSignedParts`
  accept a subset (its row fails).
- [ ] **Step 5:** Gates. N + the counts of Tasks 2 and 3 + 11.
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
    // urlFor may have waited for a /sign; the upload may have been cancelled meanwhile.
    if (run.sender.signal.aborted) return aborted();
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
| renews once after an opaque failure, then waits and retries | put: opaque, stored | calls in order: put, sign `[1]`, put | expired-without-CORS never renewed (the R2 path no local backend produces, S10) |
| renews only once per part | put: opaque, opaque, stored | one `sign` call | a sign storm during an outage |
| retries a readable expiry at once with a new URL | `nextStep(expired, 1, false)`, `Math.random` stubbed to 1 | `{ kind: "again", renew: true, waitMs: 0 }` | backoff before renewal |
| fails a part whose renewed URL is refused as expired | `nextStep(expired, 2, true)` | `{ kind: "fail", error: linkRefused() }` | six attempts on a URL that cannot work |
| stops starting parts after one fails for good, and lets the others finish | 10 parts, part 2 rejected; every `put` resolves one microtask after it starts | result `UPLOAD_REJECTED`; the parts put are a subset of 1 to 5 that includes 1 to 4 (with this double part 1's worker takes part 5 before part 2's answer arrives, but the exact count follows microtask order, not the contract), none of 6 to 10. The test carries a comment naming the bug it guards: `failure ??= await sendPart(…)` lets part 5's success overwrite part 2's failure | siblings aborted; the queue keeps going; part 5's success overwriting part 2's failure |
| gives up on a part after 6 attempts | put always `retry` (`storageDown`) | 6 puts, error `STORAGE_ERROR` retryable | endless retry |
| fails with a /sign error that cannot be retried | part 21 needs a URL, `sign` answers `UPLOAD_EXPIRED` | that error; no put for part 21 | sign errors swallowed |
| stops when the upload is cancelled | abort after the first put starts | `ABORTED`; no `sign` or `put` starts afterwards | work after cancel |

- [ ] **Step 1:** Write the tests; run: fail (module missing).
- [ ] **Step 2:** Implement `parts.ts` as above.
- [ ] **Step 3:** Run: 10 passed.
- [ ] **Step 4:** Fault probes: `PARTS_IN_FLIGHT = 5` (first row fails); drop `&& !renewed` (fourth row fails); start
  `worker` while `failure` is set (the "stops starting parts" row fails); drop the signal check after `urlFor` (the
  cancel row fails: three more `put` calls).
- [ ] **Step 5:** Gates; complexity check on `src/client` reports nothing. N + the counts so far + 10.
- [ ] **Step 6:** Commit `feat(client): send parts four at a time with lazy batch signing and URL renewal`.

### Task 6: `upload()` and the `cloudrop/client` entry

**Files:**
- Create: `packages/cloudrop/src/client/upload.ts`, `packages/cloudrop/src/client.ts`
- Test: `packages/cloudrop/src/client/upload.test.ts`, `packages/cloudrop/src/client/upload-failures.test.ts`,
  `packages/cloudrop/src/client.test.ts`

**Interfaces:**
- Consumes: everything above; `sizeOfPart` (`plan.ts:31-34`); `configError` (`errors.ts:75-78`); `RouteName`,
  `RouteMetadata`, `RouteResult`, `InferableCloudrop`, `CompleteResponse` (`protocol/types.ts:103-107`, `:164-177`).
- Produces (`client.ts`, the public entry; decision S4, all 31 names):

```ts
export { CloudropError, type CloudropErrorCode, type Result } from "./errors.ts";
export type {
  AbortRequest,
  AbortResponse,
  CompleteRequest,
  CompleteResponse,
  Endpoint,
  ErrorBody,
  ErrorResponse,
  FileDescriptor,
  FileTicket,
  MultipartTicket,
  RejectedFile,
  SignedPart,
  SignedRequest,
  SignRequest,
  SignResponse,
  SingleTicket,
  UploadedFile,
  UploadRequest,
  UploadResponse,
} from "./protocol/types.ts";
// The route inference types a client user annotates with (S4, ruling M3-H13); the root exports the same four.
export type { InferableCloudrop, RouteMetadata, RouteName, RouteResult } from "./protocol/types.ts";

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

interface Sent {
  result: Result<CompleteResponse<unknown>>;
  /** Some /complete got no answer or a SERVER_ERROR, so the server may have completed the file: a cancel keeps it. */
  mayBeComplete: boolean;
}

async function sendAndComplete(context: UploadContext, ticket: Ticket, file: File, signal: AbortSignal): Promise<Sent> {
  const sender = senderFor(context, ticket, file, signal);
  let parts = Array.from({ length: ticket.kind === "single" ? 1 : ticket.partCount }, (_, index) => index + 1);
  let mayBeComplete = false;
  // Without the signal: the server may finish a /complete (and run onComplete) after the browser stopped waiting (S14).
  const complete = async (): Promise<Result<CompleteResponse<unknown>>> => {
    const done = await context.endpoints.complete(ticket.token);
    // Sticky: a later answer does not undo an earlier /complete that may have finished (S14, M3-H16).
    mayBeComplete ||= done.error?.code === "NETWORK_ERROR" || done.error?.code === "SERVER_ERROR";
    return done;
  };
  for (let round = 0; ; round++) {
    const sent = await sendParts(sender, parts);
    if (sent.error) return { result: fail(sent.error), mayBeComplete: false };
    const done = await withRetry(complete, signal);
    const missing = done.error?.code === "PARTS_MISSING" ? done.error.parts : undefined;
    if (!missing?.length || round === REPAIR_ROUNDS) return { result: done, mayBeComplete };
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
  const { result, mayBeComplete } = await sendAndComplete(context, started.data, file as File, signal);
  // A completed upload stays completed: /abort with a live token would delete it (ruling M2-X1).
  if (!result.error || !signal.aborted) return result;
  // A /complete that may have succeeded: keep the file rather than delete a recorded one (M3-H15, M3-H16).
  if (!mayBeComplete) await context.endpoints.abort(started.data.token);
  return fail(aborted());
}
```

`withRetry` checks the signal before each attempt and in its pause (Task 3), so a cancel during the backoff after an
answered `/complete` error the server sends before it completes the file (`RATE_LIMITED`, `STORAGE_ERROR`,
`PARTS_MISSING`, `NOT_UPLOADED`) still ends in `/abort`, unless an earlier attempt set `mayBeComplete`; a cancel during
a `/complete` that then succeeds returns the success.

`argumentProblem(route, file, options): string | null` narrows `route` and `file` with type guards instead of the casts
above if that reads cleaner (the reviewer decides; behaviour is the same). Messages:
`'Name the upload route as text, such as upload("avatar", file).'`;
`'Pass the file as a File, such as one from <input type="file">.'`;
`"Pass the upload options as an object, such as { metadata, signal }."`;
`"options.signal must be an AbortSignal, such as new AbortController().signal."`.

A non-retryable `/complete` error (Wrangler's `502 STORAGE_ERROR` on a multipart upload, S22) leaves `withRetry` after
one call and `sendAndComplete` returns it: no repair round, no `/abort`.

**Tests.** All rows drive `createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch })` against
`clientFixture` (the real handler on the fake R2, `server-fixture.ts:58-108`). Bytes come from `offsetBytes`
(`testing/storage-contract.ts`, as `protocol.test.ts:15` uses it). Routes, defined in each test file:
- `albums`: `accept: ["image/png", "application/octet-stream"]`, `maxSize: "100MB"`, a `metadata` schema
  `{ albumId: string }`, `authorize` returning `{ userId }` from the `x-user` request header or
  `unauthorized("Sign in to upload to an album.")` without it, ``prefix: ({ userId }) => `users/${userId}` ``,
  `onComplete` returning `{ owner: userId, bytes: file.size, albumId: metadata.albumId }` (the shape of
  `protocol.test.ts:26-32`, plus the schema and the refusal).
- `notes`: `accept: "text/plain"`, `maxSize: 16`, `authorize: allowAnyone`, no schema, no `onComplete`.

Fixture options: `{ multipartThreshold: "8MB", appHeaders: { "x-user": "42" } }` (the stand-in for a session cookie,
which `credentials: "include"` would carry in a browser), except where a row says otherwise. `Math.random` stubbed to
0.

`upload.test.ts` (contract: spec §5 and §5.4 through the real client; oracle: `protocol.test.ts`'s expected values and
the stored bytes):

| Name | Expected | Bug caught |
|---|---|---|
| uploads a small file in three requests and returns the route's result | `requests` = `["POST /upload", "PUT object", "POST /complete"]`; `data` = `{ file: { id, key: "users/42/<id>.png", name, size: 1000, type: "image/png", url: null }, data: { owner: "42", bytes: 1000, albumId: "a1" } }`; stored bytes equal | extra round trip; metadata not sent |
| uploads a multipart file in two parts cut where the server planned | 8 MiB + 5 bytes: `requests` has `PUT part 1`, `PUT part 2`, no `POST /sign`; bytes at `8 MiB - 2 … 8 MiB + 1` equal | wrong range arithmetic |
| returns authorize's refusal without sending bytes | fixture without `appHeaders`: error `UNAUTHORIZED`, "Sign in to upload to an album."; no `PUT` in `requests` | refusal thrown, or bytes sent anyway |
| returns the server's verdict on a file the route refuses | 17-byte file to `notes`: `FILE_TOO_LARGE` with the server's message (`server/upload-request.ts:78-83`); no `PUT` | rejected ticket read as success |
| refuses arguments from plain JavaScript before any request | `upload(42, file)`, `upload("notes", "x")`, `upload("notes", file, { signal: {} })` | `INVALID_INPUT` with the three messages; `requests` empty |
| leaves metadata out of the request when the caller gives none | `notes` upload without options: success (the server refuses any metadata on a schemaless route, M2-D28) | `metadata: undefined` sent as `null` |

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
| keeps a file whose /complete finished while the upload was cancelled | `POST /complete`: forward, abort the controller, return the forwarded answer | upload, PUT, complete; no `/abort` | success with the route's `data`; `fixture.server.storage.head(key)` finds the object |
| keeps a file whose /complete answer was lost to a cancel | `POST /complete`: forward, abort the controller, then throw `TypeError` | upload, PUT, complete; no `/abort` | `ABORTED`; the object exists |
| cleans up after a cancel during a /complete the server refused | first `POST /complete`: abort the controller, answer 503 `{ error: { code: "RATE_LIMITED", message: "The storage service is busy. Try again in a moment.", retryable: true } }` without forwarding (`storageFailure`, `server/http.ts:15`, `:77-80`) | upload, PUT, complete, abort | `ABORTED`; `head(key)` is `null` |
| keeps a file an earlier /complete may have finished after a later one was refused | first `POST /complete`: forward, then answer 500 `{ error: { code: "SERVER_ERROR", message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.", retryable: true } }` instead (`unfinished()`, `server/complete.ts:18-23`, `server/http.ts:36`); second: abort the controller, answer the 503 `RATE_LIMITED` body of the row above without forwarding | upload, PUT, complete, complete; no `/abort` | `ABORTED`; the object exists |
| starts nothing for a signal that has already fired | aborted signal | none | `ABORTED` |
| reports an unreachable server after six tries | every `POST /upload` throws `TypeError` | six `POST /upload` | `NETWORK_ERROR`, `serverUnreachable()` message, retryable |

Every failure row asserts `{ code, message, retryable }` with `toEqual` against the literal from `failures.ts` or the
server's message: an exact message cannot contain a URL or a token.

The four `/complete` cancel rows (contract: S14 as corrected and M3-H16; oracle: the stored object and the request
list, from the real handler on the fake; bug caught: the signal reaching `/complete`, `/abort` after an unanswered
`/complete`, or `/abort` when only the last of several `/complete` attempts was a refusal)
upload a small `albums` file as the first `upload.test.ts` row does (one `PUT object`, an `onComplete` that returns
data); `key` is the ticket's key, read from the forwarded `/upload` answer.

`client.test.ts` (contract: S4, S17, S18):

| Name | Input | Expected |
|---|---|---|
| accepts a path or an absolute URL | `"/api/cloudrop"`, `"https://api.example.com/api/cloudrop"` | no throw |
| refuses a base path the handler cannot be at | `"api/cloudrop"`, `"/api/cloudrop/"`, `"/api?x=1"`, `""` | throws `CloudropError` `INVALID_CONFIG` with the S17 message |
| calls the global fetch at request time, not as a method | `globalThis.fetch` replaced with a recording function after the client was created (`vi.stubGlobal`) | the recording function received the `/upload` call with `this` undefined |
| exports only the two values of the public surface | `Object.keys(await import("./client.ts")).sort()` | `["CloudropError", "createCloudropClient"]` (the other 29 names are types; Task 7 step 3 checks them in the d.ts) |

- [ ] **Step 1:** Write the three test files; run: fail (modules missing).
- [ ] **Step 2:** Implement `upload.ts` and `client.ts`.
- [ ] **Step 3:** Run: `upload.test.ts` 6 rows (8 tests with the three-input row as `it.each`),
  `upload-failures.test.ts` 13, `client.test.ts` 4 rows (8 tests with `it.each` inputs); write what Vitest reports.
  Measure with `--reporter=verbose`; the multipart rows move 8 MiB and may pass 50 ms; any row over 250 ms states why
  in a comment.
- [ ] **Step 4:** Fault probes: `REPAIR_ROUNDS = 0` ("re-sends the parts…" fails); drop the `!result.error ||` guard
  ("keeps a file whose /complete finished…" fails: an `/abort` appears and the object is gone); pass `signal` to
  `endpoints.complete` again (the same row fails); drop the `!mayBeComplete` condition ("keeps a file whose /complete
  answer was lost…" fails); write `=` for `||=` in the `complete` closure, or drop its `SERVER_ERROR` test ("keeps a
  file an earlier /complete may have finished…" fails both times); send `metadata: null` when absent (last
  `upload.test.ts` row fails); add `export const probe = 1;` to `client.ts` (the surface row fails). Restore each.
- [ ] **Step 5:** Gates; complexity check; `wc -l` of every new file under the caps.
- [ ] **Step 6:** Commit `feat(client): add createCloudropClient and upload()`.

### Task 7: Publish `cloudrop/client`: export, types, import rule, budget

**Files:**
- Modify: `packages/cloudrop/package.json` (`exports`, dev dependency), `packages/cloudrop/tsdown.config.ts:4`,
  `scripts/size-limit.config.ts`, `biome.json`, `packages/cloudrop/src/server/route.ts:122-124`
- Test: `packages/cloudrop/src/client/types.test.ts`, `packages/cloudrop/src/server/types.test.ts`

**Interfaces:**
- Produces: `"./client": { "types": "./dist/client.d.ts", "default": "./dist/client.js" }` beside `"./next"` and
  `"./node"`; tsdown entry `"src/client.ts"`.

**Type tests (`types.test.ts`; contract: S2 and S3; oracle: the route definitions in the file, as in
`server/types.test.ts:34-88`; compiled by `bun run typecheck`, one runtime `it` so Vitest does not report an empty
file).** Build a `cloudrop` with `avatar` (required metadata schema `{ albumId: string }` in, `onComplete` returning
`{ url: file.url, at: new Date() }`), `notes` (no schema, no `onComplete`) and `optional` (schema input
`{ a: string } | undefined`), then `const client = createCloudropClient<typeof cloudrop>()`. Routes are written inline
inside `createCloudrop({ routes })`, as spec §1 does (with constants the "schemaless result" row would pass even
without step 1's fix):

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
| wire types carry `id` | `MultipartTicket["id"]`, `AbortResponse["id"]`, `UploadedFile["id"]` imported from `../client.ts` | each `string`; `@ts-expect-error` on `SingleTicket["fileId"]` (M3-O2) |
| inference types from the client entry | `RouteName<typeof cloudrop>`, `RouteMetadata<typeof cloudrop, "avatar">`, `RouteResult<typeof cloudrop, "notes">` imported from `../client.ts` | `"avatar" \| "notes" \| "optional"`, `{ albumId: string }`, `null` |

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
                "group": ["**/storage/**", "**/server/**"],
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

- [ ] **Step 1 (audit I-2, ruled part of this slice in M3-H15):** In `src/server/route.ts`, change the return type of
  `route()` (`:122-124`) to `NoInfer<Route<SchemaInput<TSchema>, CompleteData<Awaited<TResult>>>>` with the comment
  `// NoInfer: written inside createCloudrop({ routes }), the call would otherwise infer TResult from the expected Route`
  `// and type a route without onComplete as unknown, not null.` Add to `src/server/types.test.ts`, inside
  `describe("type inference for the client", …)`:

  ```ts
    it("types an inline route without onComplete as null, as the quickstart writes routes", () => {
      const inline = createCloudrop({
        storage: r2({ bucket: "uploads", accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "k", secretAccessKey: "s" }),
        secret: "test-secret-0123456789abcdef0123456789",
        routes: { notes: route({ accept: "text/plain", maxSize: 1024, authorize: allowAnyone }) },
      });
      expectTypeOf<RouteResult<typeof inline, "notes">>().toEqualTypeOf<null>();
    });
  ```

  RED first: without the `NoInfer` `bun run typecheck` fails with "Expected: null, Actual: unknown". It passes after,
  and the existing rows of `server/types.test.ts` (`Route<undefined, null>` for a void `onComplete`,
  `Route<undefined, { id: string }>` for an async one) stay equal (measured by the plan audit).
- [ ] **Step 2:** Write `client/types.test.ts`; `bun run typecheck` passes only once `client.ts` exists (Task 6), so the
  RED here is a fault probe: change `UploadArguments` to always `[options?: …]`; typecheck reports the "required
  metadata" `@ts-expect-error` as unused. Restore.
- [ ] **Step 3:** Add the entry and the export. `bun run build`; `dist/client.d.ts` exists. Take the names of its final
  `export { … }` statement, sort them and compare them with the 31 names of S4 sorted; record the comparison in the
  report (no extra, none missing). Read the d.ts: it imports nothing from a server or storage chunk.
- [ ] **Step 4:** Add the Biome override. Fault probe: add `import { keyProblem } from "../storage/validate.ts";` to
  `src/client/upload.ts`; `bun run check` must fail with the message above. Restore. The patterns themselves are
  settled (U7); this probe proves the override is wired into this repository's `biome.json`.
- [ ] **Step 5 (U8, settled):** Record the three existing figures (`bun run package:check`).
  `npm view @size-limit/esbuild@14.3.0 time`; `bun add -d --exact @size-limit/esbuild@14.3.0` in `packages/cloudrop`.
  Add `disablePlugins: ["@size-limit/esbuild"]` to the three existing entries of `scripts/size-limit.config.ts`, with
  the comment `// Summed files, not a bundle: these budgets count the entry and its chunks as published.` Run
  `bun run package:check` again: the three figures are byte-equal to the recorded ones. If one differs, STOP and report
  both sets.
- [ ] **Step 6:** Add the budget entry to `scripts/size-limit.config.ts`, after the three existing ones and in their
  style, without `disablePlugins`: `{ name: "cloudrop/client", path: join(dist, "client.js"), import:
  "{ createCloudropClient }", gzip: true, limit: "<measured + 10 %>" }`, with a comment that this one entry is bundled
  (tree-shaken and minified), the size an application ships, which spec §1's 8 kB is stated in. Measure first with a
  high limit; if the measurement is over 4 kB, STOP and report it (S20). Record in the commit body: the bundled gzip
  figure, the limit, and for comparison the gzip figure of `withImportedChunks("client.js")`.
- [ ] **Step 7:** `bun run package:check` passes (publint and attw see the new export). Gates. N + every count so far
  + 2 (the runtime `it` of `client/types.test.ts` and the new `it` of `server/types.test.ts`).
- [ ] **Step 8:** Commit `feat(client): publish cloudrop/client with its type tests, import rule and size budget`.

### Task 8: The Next.js example

**Files:**
- Create: everything under `examples/next/` in the file map except the Playwright files.
- Modify: root `package.json` (`"workspaces": ["packages/*", "examples/*"]`), `.gitignore` (`.next/`,
  `next-env.d.ts`, `*.tsbuildinfo`, `test-results/`, `playwright-report/`; `.env.local` is already covered by
  `.env.*`), `biome.json` (ignore `**/.next`, `**/next-env.d.ts`, `**/test-results`, `**/playwright-report`),
  `bun.lock` (through `bun install` only), `scripts/check-file-size.ts` (add `:(glob)examples/*/**/*.ts` and
  `:(glob)examples/*/**/*.tsx` to the listed paths; `.next/` is git-ignored, so `--exclude-standard` drops it; update
  the header comment, which names only `packages/*/src` and `scripts`).

**Interfaces:**
- Consumes: `createCloudrop` (`src/index.ts:12`), `route` and `unauthorized` (`:23-34`), `r2` and `s3` (`:50`) from
  `cloudrop`; `toNextHandler` from `cloudrop/next` (`src/next.ts:15-25`); `createCloudropClient` from
  `cloudrop/client`.
- Produces: an app at `http://localhost:5173` with a page that has a "Sign in as the demo user" button, a file input
  labelled "File to upload", and a `role="status"` line that reads
  `Uploaded <name> (<size> bytes) as <key>` or `<code>: <message>`.

`examples/next/package.json`: name `cloudrop-example-next`, `private: true`, `type: "module"`; scripts `dev`
(`next dev -p 5173`), `build` (`next build`), `start` (`next start -p 5173`), `typecheck` (`tsc --noEmit`),
`setup:rustfs` (`bun scripts/setup-rustfs.ts`), `test:browser` (`playwright test`); dependencies `cloudrop:
"workspace:*"`, `next`, `react`, `react-dom`; devDependencies `@playwright/test`, `@types/node`, `@types/react`,
`@types/react-dom`, `aws4fetch`, `typescript` (versions from the tech stack, exact).

`next.config.ts`: `import type { NextConfig } from "next"; const config: NextConfig = {}; export default config;`.
Never set `experimental.useTypeScriptCli: false`: with TypeScript 7 Next type-checks through `tsc`, and turning that
off makes the build fail for want of a compiler API (the measurements §3).

`tsconfig.json`, in the shape Next 16.4.6 writes, so that `next build` and `next dev` leave it unchanged (the
measurements §3: Next rewrites a strict file that lacks its values; a file that holds them stays byte-equal). Start
from this, which holds the example's strict options and every value Next's `writeConfigurationDefaults.js` adds or
requires for TypeScript 7 (derived from Next's code; step 3 proves it):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "incremental": true,
    "module": "esnext",
    "esModuleInterop": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", ".next/types/**/*.ts", ".next/dev/types/**/*.ts", "**/*.mts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

`lib/cloudrop.ts` (the quickstart's server half; keep it this short):

```ts
import { createCloudrop, r2, route, s3, unauthorized } from "cloudrop";

// An empty CLOUDROP_S3_ENDPOINT counts as unset, so the live run can switch a RustFS .env.local back to R2.
const endpoint = process.env.CLOUDROP_S3_ENDPOINT;
// Exported for the browser test, which reads the uploads back through the same storage.
export const storage = endpoint
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

// Created when the module loads, as the quickstart shows: `next build` loads it too, so the build needs the storage
// settings and CLOUDROP_SECRET (see README.md).
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

`s3()` and `r2()` throw `INVALID_CONFIG` naming every missing setting (`throwIfMissing`, `storage/presets.ts:39-42`),
so the `?? ""` fallbacks surface as one clear start-up (and build) error. `createCloudrop` reads `CLOUDROP_SECRET`
(`server/config.ts:64-77`). In development the handler checks the bucket once and warns about settings that would
break uploads (`server/handler.ts:107-116`): on the example's RustFS bucket expect no warning if step 2's lifecycle
rule was accepted, one lifecycle warning otherwise.

`app/api/cloudrop/[...all]/route.ts`: `export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);` (the spec §1
quickstart line; `OPTIONS` answers preflights from `trustedOrigins`, M2-D27).

`app/page.tsx` (`"use client"`): `import type { cloudrop } from "../lib/cloudrop";`,
`const client = createCloudropClient<typeof cloudrop>();` at module scope, a button that sets
`document.cookie = "demo-user=demo; path=/; SameSite=Lax"`, and an `onChange` that calls
`client.upload("files", file)` and writes the status line from `{ data, error }`. No other state, no styling beyond
what makes it readable. The button has `type="button"` (Biome `a11y/useButtonType`). `import type` keeps
`lib/cloudrop.ts` (and the secret) out of the browser bundle (spec §1, the paragraph after the quickstart).

`scripts/setup-rustfs.ts` (Bun; English output, one line per step, never a secret):
1. Reads `CLOUDROP_S3_ENDPOINT` (default `http://127.0.0.1:19000`), bucket `cloudrop-example`, the RustFS keys
   `cloudrop-test` / `cloudrop-test-secret` (`scripts/rustfs.sh:9-10`).
2. Creates the bucket with an `aws4fetch` `AwsClient` (`service: "s3"`, `region: "us-east-1"`); 409 means it exists.
3. Puts the CORS rule (S3 `PutBucketCors` XML with `Content-MD5`): origins `http://localhost:5173` and
   `http://127.0.0.1:5173`, methods `PUT`, `GET`, `HEAD`, allowed headers `content-type`, `content-disposition`,
   `if-none-match`, `x-amz-meta-cloudrop-id` (the headers `checkBucket` requires, `server/bucket-check.ts:24`), expose
   `ETag` (`bucket-check.ts:39`). This is the rule shape measured on RustFS 1.0.5 (the measurements §1).
4. Sends a preflight (`OPTIONS` on an object URL, `Origin: http://localhost:5173`,
   `Access-Control-Request-Method: PUT`, `Access-Control-Request-Headers: content-type,if-none-match,x-amz-meta-cloudrop-id,content-disposition`)
   and exits 1 with "RustFS did not accept the CORS rule: browsers cannot upload to it. See examples/next/README.md."
   unless the answer is 2xx **and** carries `access-control-allow-origin: http://localhost:5173`. Status alone is not
   enough: RustFS answers a preflight `200` without any `access-control-*` header when no rule exists (measured).
5. Puts a lifecycle rule (S3 `PutBucketLifecycleConfiguration` XML with `Content-MD5`): one enabled rule, empty prefix,
   `AbortIncompleteMultipartUpload` after 1 day. A 2xx prints "Lifecycle rule set"; any other answer prints
   "RustFS did not accept the lifecycle rule (HTTP <status>); the dev server will warn about it. Uploads work without
   it." and the script goes on (U12).
6. Writes `.env.local` only if it does not exist: `CLOUDROP_SECRET` (32 random bytes, base64), the five
   `CLOUDROP_S3_*` values. Prints "Wrote .env.local" or "Kept the existing .env.local". Skips this step when
   `CLOUDROP_SETUP_ENV_FILE=0` (the browser lane sets it: it exports every setting itself, and an `.env.local` it wrote
   would point the developer's next `bun run dev` at the lane's removed container).

`README.md` (the example's):
- What it shows; prerequisites (Docker, Bun).
- **The build needs the settings:** `next build` loads `lib/cloudrop.ts`, so `CLOUDROP_SECRET` and the storage
  settings must be set when building, from `.env.local` or the environment; a build without them fails with
  `INVALID_CONFIG` naming what is missing. Exported variables win over `.env.local`. A build that has no secrets (a
  Docker build stage with secrets only at run time) must pass them as build secrets, or it fails with
  `INVALID_CONFIG` (S21, M3-H14).
- Run with RustFS: `CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs scripts/rustfs.sh up`, `bun run build` at the root,
  `bun run setup:rustfs`, `bun run dev`, open `http://localhost:5173`; `CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs
  scripts/rustfs.sh down` when done.
- Run with Wrangler, for single uploads only: start it as the Wrangler lane does, from `packages/cloudrop`:
  `./node_modules/.bin/wrangler dev --config fixtures/wrangler/wrangler.jsonc --ip 127.0.0.1 --port 18787 --persist-to fixtures/wrangler/.state`;
  settings endpoint `http://127.0.0.1:18787/cdn-cgi/local/r2/s3`, region `auto`, bucket `contract`, keys
  `cloudrop-local` / `cloudrop-local-secret` (`packages/cloudrop/fixtures/wrangler/wrangler.jsonc`). No CORS rule is
  needed: Wrangler lets any `localhost` page upload. A file above 8 MB fails at the end with
  `STORAGE_ERROR: The storage service refused the request. Contact the site owner if this keeps happening.`: Wrangler's
  local R2 does not implement ListParts, which the server needs to verify a multipart upload (the server log says "The
  storage service does not support this request"). The parts stay in Wrangler's state; stop Wrangler and delete
  `packages/cloudrop/fixtures/wrangler/.state` to clear them. `api.checkBucket` there reports CORS and lifecycle as
  unknown: Wrangler cannot report bucket settings.
- Run with R2: `CLOUDROP_R2_*`, the bucket's CORS rule in the S3 JSON shape of spike Q8 with this example's origin.
- What must be true of any bucket: the CORS rule above; `ETag` exposed because `checkBucket` asks for it and the
  resume plan will read it; an abort-incomplete lifecycle rule.

- [ ] **Step 1:** `npm view` each version in the tech stack; create the files; `bun install` at the root.
- [ ] **Step 2 (setup check, U12):** `CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs scripts/rustfs.sh up`, then
  `bun run --filter cloudrop-example-next setup:rustfs`. The preflight check passes (measured for RustFS 1.0.5 with
  this rule shape); a failure is a regression in the setup to debug, not an owner decision. Record whether the
  lifecycle rule was accepted.
- [ ] **Step 3 (U6 for the browser bundle, U11, tsconfig):** Hash `examples/next/tsconfig.json` (`sha256sum`). Run
  `bun run build` (root), then `bun run --filter cloudrop-example-next build`.
  - If it fails with `INVALID_CONFIG` naming a missing setting, `next build` did not read `.env.local` (U11): record
    that, and change the README and Task 9's script to export the settings before building.
  - If Next cannot resolve `cloudrop/client` in `app/page.tsx` (the browser bundle; only the server entries were
    measured), record the error and fix it in `next.config.ts` (for example the Turbopack `root` for a workspace),
    citing the Next.js docs page used. If no documented setting fixes it, STOP and report.
  - Hash `tsconfig.json` again: the hash is unchanged. If Next rewrote it, run `bun run fix`, build again, and commit
    the file in the shape Next wrote once the hash is stable across two builds (as measured).
  - The secret is not in the browser bundle: `grep -rqF "$CLOUDROP_SECRET" examples/next/.next/static` (with the value
    read from `.env.local` into the variable, never echoed) exits 1. Print only "secret not found in .next/static".
- [ ] **Step 4:** `bun run --filter cloudrop-example-next start`; in a browser on `http://localhost:5173`: upload
  before signing in (status shows `UNAUTHORIZED: Sign in as the demo user first.`), sign in, upload a small text file
  and a 20 MiB file. Both show `Uploaded …`. Stop the server and `scripts/rustfs.sh down` (same name).
- [ ] **Step 5:** `bun run --filter cloudrop-example-next typecheck`; `bun run check` (Biome now formats the example,
  and `bun run check` now also caps the example's files); root gates unchanged.
- [ ] **Step 6:** `docker ps -a --filter label=cloudrop.test` is empty; no `next` process of this task left (find it by
  its working directory, not `pgrep -f "next start"`, which also matches the shell that runs the search and another
  session's Next).
- [ ] **Step 7:** Commit `feat(examples): add the Next.js example that uploads from the browser`.

### Task 9: The browser lane

**Files:**
- Create: `examples/next/playwright.config.ts`, `examples/next/app/upload.browser.test.ts`, `scripts/test-browser.sh`
- Modify: root `package.json` (`"test:browser": "scripts/test-browser.sh"`; `verify` gains
  `&& bun run --filter cloudrop-example-next typecheck` after the build), `.github/workflows/ci.yml` (job `browser`;
  in job `check`, which runs the gates one by one rather than `verify`, a step
  `bun run --filter cloudrop-example-next typecheck` after `bun run package:check`)

**Interfaces:**
- `scripts/test-browser.sh`, in the shape of `scripts/test-rustfs.sh`: fails when port 5173 or the RustFS port is in
  use; sets `CLOUDROP_RUSTFS_NAME=cloudrop-browser-rustfs-$$`; registers `trap '"$ROOT/scripts/rustfs.sh" down' EXIT`
  before `up`; runs `bun run build`; exports `CLOUDROP_SECRET` (random per run), the `CLOUDROP_S3_*` values and
  `CLOUDROP_EXAMPLE_PREFIX=browser` and `CLOUDROP_SETUP_ENV_FILE=0`; runs `setup:rustfs` (which then writes no
  `.env.local` and leaves any developer one untouched; the exported variables win over it, U14, and the `next build`
  inside Playwright's `webServer` inherits them, which the build needs, S21); then
  `cd examples/next && bunx playwright test`.
- `playwright.config.ts`: `testDir: "app"`, `testMatch: "**/*.browser.test.ts"`, one worker, Chromium only,
  `baseURL: "http://localhost:5173"`, `webServer: { command: "bun run build && bun run start", url:
  "http://localhost:5173", reuseExistingServer: false, timeout: 180_000 }`, `trace`, `video` and `screenshot` off (no
  artefact may hold a presigned URL; Task 10 reuses this config).

**Tests (`upload.browser.test.ts`; contract: the quickstart works in a real browser against a real S3 API; oracle: the
bytes the test created, read back through the `storage` that `lib/cloudrop.ts` exports (RustFS in this lane, R2 in
Task 10), and the request kinds the page sent). The expected key starts with
`` `${process.env.CLOUDROP_EXAMPLE_PREFIX}/demo/` ``; the test fails when that variable is unset, never defaults:**

| Name | Steps | Expected | Bug caught |
|---|---|---|---|
| uploads a small file with one PUT | sign in; `setInputFiles` `hello.txt`, `text/plain`, 14 bytes `"hello cloudrop"` | status `` Uploaded hello.txt (14 bytes) as ${CLOUDROP_EXAMPLE_PREFIX}/demo/<ulid>.txt ``; one bucket PUT without `partNumber`; `head(key)` size 14, type `text/plain`; `getRange` equals the bytes | CORS, signed headers or Blob framing wrong in a real browser (U10) |
| uploads a 20 MiB file in three parts | sign in; `big.bin`, `application/octet-stream`, 20 MiB of `index % 251` | status `` Uploaded big.bin (20971520 bytes) as ${CLOUDROP_EXAMPLE_PREFIX}/demo/<ulid>.bin ``; bucket PUTs with `partNumber` 1, 2, 3; `head(key).size` 20971520; bytes `8 MiB - 2 … 8 MiB + 1` and `16 MiB - 2 … 16 MiB + 1` equal | parts cut or sent wrongly from a browser |

The test imports `storage` from `../lib/cloudrop`, so the Playwright process evaluates that module too and needs the
same settings and `CLOUDROP_SECRET` as the build; it inherits them from the script that started it (this task's
`scripts/test-browser.sh`, Task 10's `scripts/test-browser-live.ts`).

PUTs are counted with `page.on("request")`, recording only the method and whether `partNumber` is present and its
value: never the URL. The same files and checks passed with requests made by hand on RustFS 1.0.5 (the measurements
§1); these rows prove the client sends them. The lane does not exercise URL renewal: RustFS answers an expired URL
with a readable 403 (S10), and the opaque path exists only on R2 (Task 10) and in Task 5's unit rows.

CI job `browser` (after `check`, `ubuntu-latest`, 20 minutes, the same three pinned actions as the `rustfs` job, no new
action): `bun install --frozen-lockfile`, `cd examples/next && bunx playwright install --with-deps --only-shell
chromium`, `bun run test:browser`. `--with-deps` on `ubuntu-latest` is unmeasured (U13), and so is the extra install
`examples/*` adds to every job's `bun install --frozen-lockfile` (U15): the first CI run records both times in the PR
description.

- [ ] **Step 1:** `cd examples/next && bunx playwright install --only-shell chromium` (locally without `--with-deps`,
  which needs root and was not needed here, the measurements §4; this writes about 287 MB on disk to
  `~/.cache/ms-playwright`, which holds no `chromium-1255` yet).
- [ ] **Step 2:** Write the config, the test and the script. Run `bun run test:browser`: 2 passed. Record the wall time.
- [ ] **Step 3:** Fault probe: in `src/client/bucket.ts` send `credentials: "include"`; rebuild; the lane fails (the
  bucket's CORS answer has no `access-control-allow-credentials`, so the browser blocks the PUT: measured on RustFS
  1.0.5, the measurements §1). Restore.
- [ ] **Step 4:** Run once with the RustFS port taken by another process: the script exits 1 with the port message and
  starts nothing.
- [ ] **Step 5:** Cleanup check: no container with label `cloudrop.test`, no `next` process of this run (by working
  directory, as in Task 8 step 6).
- [ ] **Step 6:** Gates, including `bun run verify`.
- [ ] **Step 7:** Commit `test(examples): add the browser lane that uploads through the example on RustFS`.

### Task 10: Live R2 from a browser (decision S24)

Run only after the test bucket's CORS rule is confirmed (step 1: the precondition and the stop condition, ruled in
M3-H15). It measures U1 to U3 and U10 on real R2 once, then leaves the browser lane able to repeat the two rows against
R2.

**Files:**
- Create: `scripts/test-browser-live.ts`; `examples/next/scripts/measure-r2-browser.ts` (deleted again in this task)
- Modify: `docs/research/r2-spike-findings.md` (a "Browser, 2026-11-<day>" section and the "Not verified" list),
  root `package.json` (`"test:browser:live": "bun scripts/test-browser-live.ts"`)

**Interfaces:** `scripts/test-browser-live.ts` reads settings exactly as `scripts/test-live-r2.ts:19-45` does (reusing
`VARIABLES`, `parseSettingsFile`, `explainMissing`, `createRedactor` and `exitCodeFor` from
`scripts/live-r2-settings.ts`). It starts `bunx playwright test` in `examples/next` with an environment that holds the
R2 settings, a random `CLOUDROP_SECRET`, `CLOUDROP_EXAMPLE_PREFIX=live-test/cloudrop-<32 hex>` and
`CLOUDROP_S3_ENDPOINT=""`: Playwright's `webServer` runs `next build` in that environment, which the build needs (S21),
and the empty endpoint makes `lib/cloudrop.ts` use `r2()` even when a RustFS `.env.local` exists (U14: an exported
variable, empty or not, wins over `.env.local`). Everything the child prints passes through the redactor. Afterwards it
deletes the prefix with `cloudrop.api.deletePrefix("<prefix>/")` and prints the proof's `deleted` count (never a key).

- [ ] **Step 1:** Confirm the test bucket's CORS rule `cloudrop-browser-tests` covers `http://localhost:5173` (spec
  §12 "Still unverified" item 1; the spec records the rule as added on 2026-11-15 for `http://localhost:5173` and
  `http://127.0.0.1:5173`) with an account token the owner provides, or ask the owner; never write CORS on that
  bucket. If neither confirms it, STOP and report: run none of steps 2 to 5.
- [ ] **Step 2:** `CLOUDROP_R2_ENV_FILE=~/.config/cloudrop/live-r2.env bun run test:browser:live`: 2 passed;
  `deleted` equals the objects written (2), which also proves the example used R2, not RustFS.
- [ ] **Step 3:** The measurement script launches Chromium through `@playwright/test`'s `chromium`, routes
  `http://localhost:5173/` to a blank page with `page.route(…, (route) => route.fulfill({ contentType: "text/html",
  body: "<!doctype html>" }))` and opens it, so the page has the origin the CORS rule names without a server, and from
  the page: (a) PUTs to a
  URL presigned with `expiresIn: 1` by `r2().presignPut` under the run prefix, after waiting 2 s, recording whether
  `fetch` rejected (`TypeError`) or answered (status, and whether the body was readable); (b) PUTs to a fresh URL and
  records whether `response.headers.get("etag")` is non-null. URLs are passed into `page.evaluate` as arguments and
  never printed. It deletes what it wrote.
- [ ] **Step 4:** Record in `r2-spike-findings.md`: date, browser and version, the two upload rows (U1, U10), the
  expired-URL result (U2), the `ETag` result (U3); strike them from "Not verified" (`r2-spike-findings.md:395-400`).
  If (a) rejected, the client takes S10's opaque row on R2, which Task 5's "renews once after an opaque failure" row
  covers; if it answered, record that R2 now sends CORS headers on expired URLs, unlike its docs and like both local
  backends. Delete the measurement script.
- [ ] **Step 5:** Commit `test(examples): run the browser lane on live R2 and record the browser findings`.

### Task 11: Documentation and decisions

**Files:**
- Modify: `README.md` (client quickstart and the example), `AGENTS.md` (one line: `*.browser.test.ts` runs through
  `bun run test:browser`, which needs Docker and Playwright's Chromium headless shell), `docs/research/test-backends.md`
  (a link to the measurements for RustFS's browser CORS and Wrangler's multipart `/complete`),
  `.claude/skills/testing-patterns/references/repository.md` (the browser lane, only where the lane list is now
  wrong), the spec, `docs/decisions/`.

- [ ] **Step 1:** README: the five-line path as it now runs (server `createCloudrop` + `route`, the Next handler line,
  `createCloudropClient<typeof cloudrop>()`, `await upload("files", file)`), with `{ data, error }` handling, and one
  line saying hooks (`useUpload`) arrive in M4. Wire types are imported from `cloudrop/client`, never from `cloudrop`.
- [ ] **Step 2:** Spec edits for the decisions the owner accepted, each listed in the commit body: §6.2 names the
  client codes `ABORTED` and `NETWORK_ERROR` beside `UPLOAD_REJECTED` (S5); §6.4 says the slice's `upload(route, file)`
  takes one file until the scheduler plan (S1); §3 says "`cloudrop/client` exports the wire types of the four
  endpoints and the route inference types `RouteName`, `RouteMetadata`, `RouteResult` and `InferableCloudrop`" (S4,
  M3-H13); §5.5 gains "The client never sends `/abort` after a `/complete` that may have succeeded." (S14).
- [ ] **Step 3:** `docs/decisions/`: add the entries this slice's decisions need, following `docs/decisions/README.md`
  ("Adding an entry"). M3-O1 to M3-O4 and M3-H13 to M3-H15 exist already: S4's surface is M3-H13 (with the 31 names
  of M3-H15), S21 is M3-H14, and the audit's five decisions are M3-H15; cite those, do not repeat them. Add one entry
  per decision of this plan that changes behaviour or a public contract and has no entry yet, in a new series
  `M3-S<n>` numbered as this plan's decisions (S9's entry takes the number 9). That series needs, in the same change,
  a row in the README's prefix table and an entry in `AGENTS.md`'s list of series (the "Rules" item on
  `docs/decisions/`). At least:
  - S9 (retry budget), S10 (bucket answers), S11 (renewal), S13 (repair rounds), S15 (no `/abort` after a failure),
    S22 (local backends; Wrangler's multipart `/complete`);
  - S14 as corrected by the audit (C-1): `/complete` runs without the signal, and after a cancel the file is kept when
    any `/complete` attempt got no answer or answered `SERVER_ERROR` (cite M3-H15 and M3-H16 for the ruling);
  - S20 with the size-limit split (I-3): the three existing budgets carry `disablePlugins: ["@size-limit/esbuild"]`
    and count summed files; only the client entry is bundled;
  - the `NoInfer` return type of `route()` (I-2, ruled in M3-H15), as its own entry (number 27, the next one this plan
    does not use): a route's result type no longer follows the expected type of its position, so an inline route without
    `onComplete` gives the client `null`.
  List the new series in the report for the owner.
- [ ] **Step 4:** `bun run check`; commit `docs: document cloudrop/client, the example and the browser lane`.

## Definition of done for the slice

- `bun run verify` passes on Node 24; the unit lane grew by the counts each task reported, with no test over 250 ms
  that does not say why.
- `bun run test:browser` passes (2 tests) and leaves no container or process; CI's `browser` job passes on the pull
  request.
- `dist/client.d.ts` exports exactly the 31 names of S4; the client entry ships no server or storage code: no file in
  `withImportedChunks("client.js")` (the entry and every chunk it imports) contains `signToken`, `presignPut` or
  `storageError` (`grep -l`), and the size budget holds; the three existing budgets measure what they measured before
  the esbuild plugin was installed.
- A cancel never deletes a file whose `/complete` may have succeeded (the four `/complete` cancel rows), and an inline
  route without `onComplete` types the client's result as `null` (the `server/types.test.ts` row).
- The example runs from its README against RustFS without credentials; `examples/next/tsconfig.json` is unchanged by
  `next build`; `.next/static` does not contain the secret; the README says a build without secrets fails; the browser
  lane leaves no `.env.local` behind; `bun run check` caps the example's files and CI's `check` job type-checks it.
- The README documents Wrangler for single uploads only, with the error a multipart upload ends in.
- Every decision this slice changes or adds has its `docs/decisions/` entry (Task 11 step 3).
- Task 10 ran, or its report says the CORS precondition was not confirmed and spec §12's browser items stay open.
- "Not settled here" still holds nothing open, or the report names what became open during execution.

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
| Wire types exported by `cloudrop/client` | S4 (M3-O1 as scoped by M3-H13: the 19 wire types and the 4 inference types, listed) |
| Neutral module first, every importer named | S6; Task 1 |
| Part arithmetic from `src/plan.ts` | S7 |
| File-size and complexity rule | Global constraints; the file map's estimates; complexity checks in Tasks 3 to 6 |
| Zero dependencies, web APIs, results, safe messages | Global constraints; S8; Task 3 messages |
| Client budget in `package:check` | S20; Task 7 |
| Example dependencies in the example's workspace, versions checked | Tech stack; S21 |
| Unverified browser behaviour named with its measuring task | U1 to U14 |

### Coverage of the revision (2026-11-16)

| Input | Where it landed |
|---|---|
| M3-O1, every wire type | S4 (31 names since the audit, M3-H13), Task 6 `client.ts`, Task 7 step 3, client.test surface row, Definition of done |
| M3-O2, `id` on the wire | Before Task 1 check; Task 4 shapes; Task 7 type row |
| M3-O3, client codes | S5; Task 2 |
| M3-O4, other recommendations accepted | "(owner, accepted 2026-11-16)" on S1, S8, S9, S10, S15, S20 to S25; S26 |
| RustFS CORS measured | S8, S10, S22, U4; Task 8 steps 2-3; Task 9 step 3 |
| Wrangler multipart `/complete` is `502`, not retryable | S22 (corrected), Task 6 note, Task 8 README |
| Next 16.4.6 with TypeScript 7.0.2; build needs settings | Tech stack, S21, U5, U11; Task 8 `next.config.ts`, step 3; Tasks 9, 10 |
| Next rewrites `tsconfig.json` | Task 8 `tsconfig.json` and step 3 |
| Playwright `--only-shell` | S23; Task 9 step 1 and CI job; U13 |
| Opaque expired-URL answer only on R2 | S10; Task 5 row; Task 9 note; Task 10 step 4 |
| `cloudrop/client` in the browser bundle unmeasured | U6; Task 8 step 3 (fallback and stop kept) |
| Split server files; `checkBucket` and Node adapter changes | Before Task 1; S6; citations throughout; S22 |

### Coverage of the plan audit (2026-11-16, rulings M3-H13 to M3-H16)

| Finding | Where it landed |
|---|---|
| C-1 a cancel during `/complete` deletes a recorded file | S14 (replaced); Task 3 `withRetry` rule and its new row; Task 4 `Endpoints.complete` without signal, endpoint rules; Task 6 `Sent`, `sendAndComplete`, `uploadFile`, three `upload-failures` rows (four since M3-H16), step 3 count 12 (13 since M3-H16), step 4 probes; threat table; Task 11 steps 2 and 3; Definition of done |
| I-1 the four inference types | S4 (31 names); Task 6 export block; Task 7 type row and step 3; Definition of done; Task 11 step 2 |
| I-2 `unknown` for an inline route | S3; Task 7 **Files**, step 1 (`NoInfer`, new `server/types.test.ts` row), inline routes in the type tests, step 7 count; file map; threat table; Task 11 step 3 |
| I-3 the esbuild plugin bundles every check | S20; U8 settled; Task 7 steps 5 and 6; Definition of done; Task 11 step 3 |
| I-4 the browser test cannot run on R2 | Task 8 `lib/cloudrop.ts` exports `storage`; Task 9 oracle, both rows' keys, the note on the test's environment |
| M-1 to M-14, X-1 | Task 1 step 3 and **Files** (M-1); Task 3 **Files** (M-2); "Before Task 1" and Task 8 citations (M-3); S19, U7, Biome override (M-4); Task 4 `abort` (M-5); `sendPart` and Task 5 probes (M-6); Task 5 row (M-7); "Before Task 1", S22, Task 8 README (M-8); Task 8 `app/page.tsx` (M-9); Task 8 **Files**, step 5, Global constraints (M-10); Task 8 `setup-rustfs.ts` item 6, Task 9 script (M-11); Task 9 **Files** (M-12); Task 10 step 3 (M-13); Task 11 steps 2 and 3 (M-14); threat table (X-1) |
| X-2 counts | "Before Task 1" (N = 896); Task 3 step 3 (+1 row); Task 6 step 3; Task 7 step 7 |
| X-6 unverified | U7, U8 settled; U15 added; Task 9 CI note |
| Re-review N-1 to N-3 (the keep rule looked only at the last `/complete`; a cancel's wait; row 3's status) | Ruled in M3-H16: S14; Task 6 `Sent`, the `complete` closure, the note after `uploadFile`, row 3 (503 `RATE_LIMITED`), the new row, step 3 count 13, step 4 probe; threat table; Task 11 step 3; Definition of done; "Not settled here" |
| Owner decisions 1 to 5 | Ruled in M3-H15: S4, S14, S21 and the Task 8 README line, Task 7 step 1, Task 10 step 1; removed from "Not settled here" |

### Placeholder scan

Searched for "TBD", "TODO", "implement later", "similar to Task", "add validation", "handle errors": none. Values an
implementer fills in are measurements: the baseline N (Task 1), the bundle sizes (Task 7), the browser lane's wall time
(Task 9), the CI install time (Task 9) and the live findings (Task 10).

### Names used across tasks

`invalidInput`, `isPlainObject` (Task 1); `ClientErrorCode`, `ServerErrorCode`, `hasKnownCode` (Task 2);
`aborted`, `serverUnreachable`, `bucketUnreachable`, `unreadableAnswer`, `signatureMismatch`, `linkRefused`,
`uploadRejected`, `storageBusy`, `storageDown`, `MAX_ATTEMPTS`, `retryDelay`, `parseRetryAfter`, `pause`,
`withRetry`, `BucketOutcome`, `classifyAnswer`, `putObject`, `ClientFetch` (Task 3); `Ticket`, `Endpoints`,
`createEndpoints`, `ABORT_TIMEOUT_MS`, `readTicket`, `readSignedRequest`, `readSignedParts`, `readCompleted`,
`readErrorBody`, `clientFixture`, `ClientFixture`, `Fault`, `FaultCall`, `appHeaders` (Task 4); `PARTS_IN_FLIGHT`,
`PartSender`, `Step`, `nextStep`, `sendParts` (Task 5); `UploadContext`, `Sent`, `uploadFile`, `ClientOptions`,
`UploadOptions`, `UploadArguments`, `CloudropClient`, `createCloudropClient` (Task 6); `storage` in
`examples/next/lib/cloudrop.ts` (Task 8), `CLOUDROP_SETUP_ENV_FILE` (Task 8, set in Task 9). Each is defined once, in
the task named.

The plan audit compiled the client's public declarations (S2, S3, Task 7's type table) and the `NoInfer` change against
the real server types. The runtime code in this plan was not compiled: it is the exact algorithm for the two places
where the order of checks matters (`parts.ts`, `upload.ts`), written against the types read from the branch. The
implementer compiles it, and the reviewer checks it against the decisions, not the other way round.

## Not settled here (for the owner)

The owner answered the plan's eighteen questions on 2026-11-16 (M3-O1 to M3-O4); the measurements closed the
TypeScript 6 fallback. Nothing is open. Settled since the plan audit:

- **The edge of "all wire types" (S4):** ruled in M3-H13; the 31 names, with the four route inference types, in
  M3-H15.
- **A cancel after a `/complete` that may have succeeded (S14):** the file is kept, never deleted (M3-H15), when any
  attempt may have succeeded, not only the last (M3-H16).
- **The build needs the settings (S21):** stands, with a README line for builds without secrets (M3-H14, M3-H15).
- **The I-2 server type fix:** part of this slice, Task 7 step 1 (M3-H15).
- **Task 10's prerequisites:** the test bucket and its CORS rule `cloudrop-browser-tests` for `http://localhost:5173`
  are confirmed when Task 10 runs; its step 1 is the precondition and the stop condition (M3-H15). Without the
  confirmation, spec §12's open browser items stay open until the browser-lane plan.
