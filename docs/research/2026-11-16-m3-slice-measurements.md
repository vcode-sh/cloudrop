# M3 slice measurements: browser, RustFS, Wrangler and Next.js

Measured 2026-11-16 on the development machine (Ubuntu 26.04.1 LTS, kernel 7.0.0-43, Node 24.22.2, Bun 1.4.4), before
the audit of [`2026-11-16-m3-vertical-slice.md`](../superpowers/plans/2026-11-16-m3-vertical-slice.md). It answers the
plan's "Unverified behaviour" rows U4 and U5, U6 for the server entries only, and the parts of U1 to U3 and U10 that
local backends can answer, and it sizes Task 9's browser job. No live R2 was used: U1 to U3 on R2 stay with Task 10.

Each behaviour was observed once per run, in the runs listed. Presigned URLs are shown as their path only; the local
backends' fixed test keys (`scripts/rustfs.sh`, `fixtures/wrangler/wrangler.jsonc`) are the only credentials used.

Revised the same day after its review (`m2-review-reports/hardening-lane-P-review.md`): no measurement was re-run. The
conclusions on S22 and U6 were corrected, predictions and statements derived from code are labelled as such, sizes are
named as on-disk sizes, and each section says which commands were recorded and which were not.

## Method

All scratch work lived in `~/projects/.worktrees/cloudrop/scratch-m3-measure/` and was deleted afterwards, with the
harness and its logs. What the scratch work ran is therefore known only from this document and the lane P report
(`.superpowers/sdd/2026-11-16-hardening/lane-P-report.md`); where neither records a command, the section says so.

- **Server:** cloudrop's built `packages/cloudrop/dist` at `9df61ef`: `createCloudrop` with `s3()`, one route `files`
  (`text/plain`, `application/octet-stream`, 100 MB), `multipartThreshold: "8MB"`, mounted with `toNodeHandler` on
  `http://localhost:3050`, which also served a blank page.
- **Browser:** headless Chromium from `@playwright/test@1.65.1`, launched by a Node script (not the test runner). The
  page did what the M3 client will do, by hand: `POST /api/cloudrop/upload`, `PUT` each signed URL with exactly the
  signed headers and a `Blob` body, read `response.headers.get("etag")`, then `POST /api/cloudrop/complete`. The
  stored objects were read back through the `s3()` driver: `head` and `getRange`. The page's `page.evaluate` code was
  not recorded.
- **Files:** `hello.txt`, 14 bytes `"hello cloudrop"`, `text/plain` (single PUT); `big.bin`, 20,971,520 bytes of
  `index % 251`, `application/octet-stream` (multipart: 8 MiB parts, 3 parts), with the bytes at
  `8 MiB - 2 … 8 MiB + 1` and `16 MiB - 2 … 16 MiB + 1` compared.
- **Expired URL:** `storage.presignPut(key, { size: 5, type: "text/plain", expiresIn: 1 })`, used 2.5 s later.
- **CORS rule (RustFS):** S3 `PutBucketCors` XML with `Content-MD5`, signed by `aws4fetch@1.0.20`: origins
  `http://localhost:3050` and `http://127.0.0.1:3050`; methods `PUT`, `GET`, `HEAD`; allowed headers `content-type`,
  `content-disposition`, `if-none-match`, `x-amz-meta-cloudrop-id`; expose `ETag`; `MaxAgeSeconds` 60. This is the
  plan's Task 8 rule with this lane's port instead of 5173.

## 1. RustFS 1.0.5 in a browser

`rustfs/rustfs:1.0.5` (image created 2026-11-10, revision `34e6449`), label `cloudrop.test=rustfs`. Three runs (about
3 s each); the table is run 3, on a fresh container. Run 2 reused run 1's container, whose bucket still held the CORS
rule, so its "before the rule" rows are void; every other row matched run 3.

Commands recorded: `CLOUDROP_RUSTFS_NAME=cloudrop-lane-p-rustfs CLOUDROP_RUSTFS_PORT=19050 scripts/rustfs.sh up` to
start the container and `scripts/rustfs.sh down` (same variables) to remove it. The harness that made the requests
below was a scratch Node script; its command line was not recorded.

| Step | Observed |
|---|---|
| `PUT /lane-p` (create bucket) | `200` |
| Preflight before any CORS rule (`OPTIONS` on an object, `Origin: http://localhost:3050`, method `PUT`, the four headers) | `200`, **no** `access-control-*` header (only `vary`) |
| Browser `PUT` before any CORS rule | blocked: `TypeError: Failed to fetch`; console "No 'Access-Control-Allow-Origin' header is present" |
| `PutBucketCors` | `200`, empty body |
| `storage.getBucketCors()` | the rule as written: both origins, `PUT GET HEAD`, the four headers, expose `ETag` |
| `cloudrop.api.checkBucket({ origins: ["http://localhost:3050"] })` | `cors: ok` "Browsers on http://localhost:3050 can upload and read ETag."; `lifecycle: problem` (no rule set) |
| Preflight, allowed origin | `200`, `access-control-allow-origin: http://localhost:3050`, `-allow-methods: PUT, GET, HEAD`, `-allow-headers` the four headers, `-max-age: 60` |
| Preflight, `Origin: http://otherhost.localhost:3051` | `403`, no `access-control-*` |
| Browser single upload | `/upload` 200 (signed headers `content-type`, `content-disposition`, `x-amz-meta-cloudrop-id`, `if-none-match`); `PUT` 200; `etag` readable: `"5906d8a78510f7f6e2e1ca71bbc8b6d7"`; readable headers `content-length`, `etag`; `/complete` 200 with size 14, type `text/plain` |
| Stored single object | size 14, type `text/plain`, `cloudrop-id` present, bytes `hello cloudrop` |
| Browser multipart upload | `/upload` 200, `partSize` 8388608, `partCount` 3, part URLs carry no signed headers; `PUT` parts 1, 2, 3 each 200 with a readable quoted MD5 `ETag`; `/complete` 200, size 20971520 |
| Stored multipart object | `head` size 20971520; both boundary ranges equal the expected bytes |
| Browser `PUT` to the expired URL | **answered**, not opaque: status `403`, body readable, `<Code>AccessDenied</Code>`, `<Message>Request has expired</Message>` |
| Same expired `PUT` from Node with `Origin` | `403 AccessDenied` with `access-control-allow-origin: http://localhost:3050`, `-allow-methods`, `-expose-headers: ETag` |
| Expired key stored? | no |
| Browser `PUT` with `credentials: "include"` | blocked: `TypeError: Failed to fetch`; console "The value of the 'Access-Control-Allow-Credentials' header in the response is '' which must be 'true'" |
| Objects left under the run prefix after deleting | 0 |

"Part URLs carry no signed headers" means no header the browser must send: the server still signs each part's
`content-length` into the URL (`src/storage/s3/presign.ts`), which the browser derives from the `Blob`.

**Conclusions for the plan.**

- **U4 confirmed, Task 8 step 2's stop condition does not fire.** RustFS 1.0.5 accepts `PutBucketCors`, enforces it
  (other origins get `403`, the browser is blocked without it) and answers the preflight with the origin. The planned
  check "2xx **and** `access-control-allow-origin`" is the right one: without a rule RustFS still answers `200`, so a
  status-only check would pass falsely.
- **U3 on RustFS:** `ETag` is readable from JavaScript when the rule exposes it, for the single PUT and for every part.
- **U10 on RustFS:** `fetch` with a `Blob` body (and a `Blob.slice` per part) sent the signed length; every PUT was
  accepted and the stored sizes and bytes match. The backend side of Task 9's two rows holds on RustFS: the same
  requests made by hand succeeded and the stored bytes match. Whether the client sends them is Task 9's to show (a
  prediction until then).
- **U2 and decision S10, a difference to note:** RustFS answers an expired URL with a **readable** `403 AccessDenied`
  carrying CORS headers, where R2's docs say R2's 403 has none (`r2-platform-and-test-backends.md:400-401`). The browser
  lane on RustFS therefore can exercise only S10's "readable 403 except `SignatureDoesNotMatch` renews once" path,
  never the opaque `NETWORK_ERROR` path; Wrangler cannot either (below). Only Task 10 can observe R2's answer.
- **Task 9 step 3's fault probe works as planned:** RustFS sends no `access-control-allow-credentials`, so
  `credentials: "include"` makes the browser block the PUT. The fallback probe is not needed.
- The plan's README note that the example needs "an abort-incomplete lifecycle rule" shows up here: `checkBucket`
  reports `lifecycle: problem` on a fresh RustFS bucket. `setup-rustfs.ts` writes only CORS, so a bucket check on the
  example's RustFS bucket will report the lifecycle unless the script also writes a rule (not measured whether RustFS
  accepts `PutBucketLifecycleConfiguration`).

## 2. Wrangler's local R2

`wrangler@4.162.0` (the devDependency, `workerd` 1.20261113.1), run the way `scripts/test-wrangler.sh` runs it, from a
scratch copy of `packages/cloudrop/fixtures/wrangler/` on port 18830, state in the scratch directory, endpoint
`http://127.0.0.1:18830/cdn-cgi/local/r2/s3`, region `auto`, bucket `contract`. One harness run (3.1 s) and one direct
ListParts probe.

Commands: the lane P report records "`wrangler@4.162.0 dev` on 18830 from a scratch copy of the fixture"; the exact
command line was not recorded. The one `scripts/test-wrangler.sh` runs is
`./node_modules/.bin/wrangler dev --config fixtures/wrangler/wrangler.jsonc --ip 127.0.0.1 --port <port> --persist-to <state> --log-level error`.
The harness and the ListParts probe were scratch scripts; their command lines were not recorded.

| Step | Observed |
|---|---|
| Preflight, `Origin: http://localhost:3050`, no rule ever written | `204`, `access-control-allow-origin: *`, `-allow-methods: GET,HEAD,PUT,POST,DELETE`, `-allow-headers` echoes the request, `-expose-headers: *` |
| Browser `PUT` with no rule | `200`, `etag` readable |
| `PutBucketCors` | `501 NotImplemented` "PutBucketCors not implemented" |
| `storage.getBucketCors()` | `STORAGE_ERROR` "The storage service does not support this request. Use R2 or another backend that implements it." |
| `api.checkBucket` | `STORAGE_ERROR` (the whole call fails) |
| Preflight, `Origin: http://otherhost.localhost:3051` | `403`, body `Invalid Origin header`, no CORS headers: Wrangler's dev server refuses non-local origins before any CORS logic |
| Browser single upload | `/upload` 200; `PUT` 200; `etag` `"5906d8a78510f7f6e2e1ca71bbc8b6d7"` readable; readable headers include `access-control-*`, `content-encoding`, `transfer-encoding` (expose `*`); `/complete` 200, size 14, type `text/plain`; stored bytes `hello cloudrop` |
| Browser multipart upload | `/upload` 200, 3 parts of 8 MiB; `PUT` parts 1, 2, 3 each **200** with a readable `ETag` (an opaque 172-character string, not an MD5) |
| `/complete` for the multipart upload | **`502`**, body `{"code":"STORAGE_ERROR","message":"The storage service refused the request. Contact the site owner if this keeps happening.","retryable":false}` |
| Server log for that request | `cloudrop: a storage request failed. CloudropError: The storage service does not support this request. Use R2 or another backend that implements it.` |
| Stored multipart object | none (`head` null, ranges `NOT_FOUND`) |
| Direct `ListParts` (`GET ?uploadId=…`) on a fresh upload | `501 NotImplemented` "ListParts not implemented"; `driver.listParts` → `STORAGE_ERROR`, `retryable: false`; `ListMultipartUploads` also `501`; `abortMultipart` succeeds |
| Browser `PUT` to the expired URL | answered: `403`, readable `<Code>ExpiredRequest</Code>`, "Request has expired"; raw answer carries `access-control-allow-origin: *` |
| Browser `PUT` with `credentials: "include"` | blocked: "must not be the wildcard '*' when the request's credentials mode is 'include'" |

**Conclusions for the plan.**

- **S22 partly contradicted by running it:** a browser can upload single files to Wrangler without a CORS rule and
  read `ETag`, but a multipart upload cannot finish: every part uploads, then `/complete` answers `502 STORAGE_ERROR`
  with `retryable: false`, not the retryable error S22 derived from the code. The driver maps ListParts' `501` to a
  non-retryable `STORAGE_ERROR` (`src/storage/storage-error.ts`, the `501` row, which comes before the retryable 5xx
  row), so S22's "retryable … 5xx is retryable" must be corrected. What the client sees is the generic "refused the
  request. Contact the site owner" message; only the server log says the storage does not support the request. The
  example README should say this in its own words, since the page will show the generic message.
- **The upload stays open on Wrangler** after that failure. This is from the code, not observed: `completeParts` in
  `src/server/complete.ts` returns on the ListParts error and never aborts, and the open upload could not be listed
  because `ListMultipartUploads` also answers `501`. `scripts/test-wrangler.sh` deletes its state each run; a Wrangler
  started by hand for the example keeps its state, so the example README should say how to clear it.
- **Wrangler's CORS is "any local origin":** `*` with any requested header, and a `403 Invalid Origin header` for a
  non-`localhost` origin. It cannot test CORS rules. `api.checkBucket` fails as a whole there (`STORAGE_ERROR`, from
  `GetBucketCors` answering `501`), as spec §9 defines it at `9df61ef`: `unknown` is reserved for settings the
  credentials may not read, or no origin to check, and `src/server/bucket-check.ts` passes every other read error
  through. Whether an unsupported setting should report `unknown` is a product question; the hardening phase's lane I
  changes that behaviour on purpose, so the README should describe the behaviour of the release it documents.
- **U2 on Wrangler:** the expired answer is readable (`ExpiredRequest` with `*`), like RustFS and unlike R2's docs.

## 3. Next.js with TypeScript 7.0.2

`npm view` on 2026-11-16: `next` `latest` is **16.4.6** (the plan's version; `canary` 16.5.0-canary.52), `react` and
`react-dom` 19.3.1, `@types/react` and `@types/react-dom` 19.3.0, `@types/node@24.19.2` exists, `typescript` `latest`
7.0.2 (2026-07-08), newest 6.x 6.0.3 (2026-04-16). TypeScript 7.0.2's package `exports["."]` is `./lib/version.cjs`;
`lib/` holds `tsc.js`, `getExePath.js` and `version.cjs` only.

Layout, mirroring the plan: a scratch monorepo with `"workspaces": ["packages/*", "examples/*"]`, `packages/cloudrop`
holding a copy of the built `package.json` (exports unchanged) and `dist/`, and `examples/next` with the plan's exact
`package.json` dependencies (exact versions), the plan's `lib/cloudrop.ts` verbatim, and
`app/api/cloudrop/[...all]/route.ts` = `export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);`. No client
component imported the workspace package (`cloudrop/client` did not exist at `9df61ef`). `bun install` used Bun's
isolated linker (as the repo does): `examples/next/node_modules/cloudrop` is a symlink to `packages/cloudrop`.
`NEXT_TELEMETRY_DISABLED=1`.

Commands: the lane P report records "`next build` in five variants, a type-error fault probe, `tsc --noEmit`,
`next start -p 3050` + one POST", with `NEXT_TELEMETRY_DISABLED=1`. The exact invocation of each build and the
variables set per variant are not recorded beyond the names the table gives.

| Run | Result |
|---|---|
| `next build`, no `tsconfig.json`, no environment | Next created a `tsconfig.json`, "Finished TypeScript in 152ms", then **failed** at "Collecting page data": `Failed to collect configuration for /api/cloudrop/[...all]`, cause `CloudropError INVALID_CONFIG: Missing R2 settings: bucket, accountId (CLOUDROP_R2_ACCOUNT_ID), …` |
| Same, with the four `CLOUDROP_S3_*` values but no `CLOUDROP_SECRET` | failed at the same step: `Missing the upload token secret. Set CLOUDROP_SECRET or pass secret to createCloudrop(); …` |
| Same, with the settings and a secret | **exit 0** in 0.67 s, with the `.next` the two failed builds left behind (warm); whether the figure is wall time or Next's own was not recorded. Routes `○ /`, `○ /_not-found`, `ƒ /api/cloudrop/[...all]` |
| Fault probe: `export const broken: number = "not a number";` in `app/page.tsx` | exit 1: `app/page.tsx(9,14): error TS2322: Type 'string' is not assignable to type 'number'. Failed to type check.` The same error from `tsc --noEmit` (TS 7.0.2); restored tree: `tsc` exit 0 |
| Strict `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `target` ES2022, `moduleResolution` bundler) and an empty typed `next.config.ts`, clean `.next` | exit 0 in 1.62 s (clean `.next`; wall time or Next's own figure not recorded), but Next **rewrote** `tsconfig.json`: added `allowJs`, `incremental`, mandatory `esModuleInterop` and `resolveJsonModule`, and `.next/dev/types/**/*.ts` to `include` |
| That rewritten file reformatted by the repo's Biome 2.6.8, built again | exit 0, `tsconfig.json` unchanged (sha256 equal) |
| `tsc --noEmit` without `next-env.d.ts` and `.next` | exit 0 for this minimal app |
| `next start -p 3050`, `POST /api/cloudrop/upload` with `Origin: http://localhost:3050` and no cookie | `401`, `{"error":{"code":"UNAUTHORIZED","message":"Sign in as the demo user first.","retryable":false}}` |

Why TypeScript 7 works: Next 16.4.6 defaults `experimental.useTypeScriptCli` to `true`
(`next/dist/server/config-shared.js:263`) and spawns TypeScript 7's `lib/tsc.js` instead of loading a compiler API
(`next/dist/lib/typescript/runTypeScriptCli.js:57-66`, a comment there names TypeScript 7's extensionless ESM bin). It
throws "TypeScript 7.0.2 does not provide the compiler API required by Next.js … or install TypeScript 6 instead" only
when that option is turned off (`verify-typescript-setup.js:129-130`, message at `runTypeScriptCli.js:86`).

**Conclusions for the plan.**

- **U5 confirmed: Next.js 16.4.6 builds with TypeScript 7.0.2 and type-checks with it.** Fallback S22a is not needed;
  TypeScript 6.0.3 was not tried for that reason. "Not settled" item 12 can be closed. `next.config.ts` must not set
  `experimental.useTypeScriptCli: false`.
- **U6 confirmed for the server entries only:** Next resolved `cloudrop` and `cloudrop/next` through `exports` to
  `dist/` across the workspace symlink in the route handler, with no `next.config.ts` setting and no Turbopack `root`
  (one lockfile at the scratch root, as in the repo). `cloudrop/client` does not exist at `9df61ef`, and no client
  component imported the workspace package, so resolution in the browser bundle is not measured; keep Task 8 step 3's
  fallback.
- **New, changes Task 8 and Task 9:** `next build` evaluates the route module while collecting page data, so the
  plan's `lib/cloudrop.ts` runs `s3()`/`r2()` and `createCloudrop` **at build time** and the build fails with
  `INVALID_CONFIG` unless the storage settings **and** `CLOUDROP_SECRET` are present then. Task 9's `webServer` and
  `scripts/test-browser.sh` export them before `bun run build`, so the lane is fine. Task 8 step 3 relies on the
  `.env.local` from step 2 (that Next reads `.env.local` during `build` was not measured here). Any CI step or
  `verify` that builds the example without those variables fails; Task 9 adds only `typecheck` to `verify`, which
  needs none. Task 10's live run is affected the same way: its settings must be in the environment of the
  `webServer` build. The README should say the build needs the settings, or the example should create the server
  lazily (a design choice for the owner, not measured).
- **Commit `examples/next/tsconfig.json` in the shape Next writes** (with `allowJs`, `incremental`, `esModuleInterop`,
  `resolveJsonModule` and `.next/dev/types/**/*.ts`), formatted by Biome. Otherwise every build rewrites it and leaves
  the tree dirty. Next keeps a Biome-formatted copy unchanged.
- The plan's `typecheck` (`tsc --noEmit`) works with TypeScript 7.0.2 and does not need a prior build for a minimal app.
  The real example's page may need `next-env.d.ts` once it imports assets.

## 4. Playwright in this environment

Commands recorded: `bun add --exact @playwright/test@1.65.1`; `playwright install chromium` and
`playwright install --only-shell chromium`, each into its own empty `PLAYWRIGHT_BROWSERS_PATH`;
`playwright install-deps --dry-run chromium`. The launch script run three times was a scratch script; its command line
was not recorded.

| Item | Observed |
|---|---|
| Version | `@playwright/test@1.65.1`, npm `latest` (released 2026-11-13); browser Chrome for Testing **159.0.8154.6** (Playwright `chromium` v1255) |
| Package install | `bun add --exact @playwright/test@1.65.1`: 3 packages from Bun's warm cache (not a cold-install figure) |
| `playwright install chromium` into an empty `PLAYWRIGHT_BROWSERS_PATH` | **13.2 s**; downloads Chrome for Testing, the headless shell and FFmpeg: 414 MB + 282 MB + 5 MB on disk |
| `playwright install --only-shell chromium` into another empty path | **5.9 s**; headless shell and FFmpeg only, 287 MB on disk |
| System packages | `playwright install-deps --dry-run chromium`: "All system dependencies are installed."; `ldd` of both binaries: nothing missing |
| Headless launch, three runs each, full install and shell-only | launch 21–23 ms, first page 31–33 ms, whole Node process 0.21–0.22 s; `navigator.userAgent` contains `Headless` |
| One harness run (server, browser, single and 20 MiB multipart upload, expiry wait of 2.5 s) | 2.9–3.1 s wall |

The launch figures are warm: the browser files had just been written and the page cache could not be dropped without
root, so a first run on a cold disk was not measured. The shared `~/.cache/ms-playwright` holds `chromium-1228`,
`-1243` and `-1248`, not `-1255`, so Task 9 step 1 will write about 700 MB there (or 287 MB with `--only-shell`), on
disk; the compressed download is smaller and was not measured.

**Conclusions for the plan.**

- **S23 / Task 9 confirmed:** Playwright 1.65.1 runs headless Chromium here with no extra system package; locally
  `bunx playwright install chromium` without `--with-deps` is enough, as Task 9 step 1 says.
- **Smaller CI job:** headless runs use the headless shell, so the CI step can be
  `bunx playwright install --with-deps --only-shell chromium`: less than half the installed size (287 MB instead of
  701 MB on disk) and time (5.9 s instead of 13.2 s here; a CI runner's network will differ). `--with-deps` on
  `ubuntu-latest` was not measured here.
- The browser work itself is cheap (about 3 s for both rows' traffic); the job's cost will be the Chromium install,
  `bun install` and `next build`, not the test. The one clean build of the minimal app took 1.62 s here; the real
  example adds a client page, so expect more.

## Summary of what changes in the plan

| Plan item | Verdict |
|---|---|
| U4, Task 8 step 2 | Confirmed: RustFS 1.0.5 accepts and enforces `PutBucketCors`; keep the "2xx and allow-origin" check (status alone passes without a rule) |
| U3, U10 (local backends) | Confirmed on RustFS and Wrangler for requests made by hand: `ETag` readable, `Blob` bodies match the signed length. The client's own requests are Task 9's; R2 still open (Task 10) |
| U2, S10 | Both local backends answer an expired URL with a readable `403` and CORS headers; the opaque path is exercised only on R2 (Task 10) or by unit tests |
| S22 | Contradicted in part: Wrangler multipart ends in `502 STORAGE_ERROR` with `retryable: false`, not retryable as S22 says; generic client message |
| U5, S22a, "Not settled" 12 | Confirmed: Next 16.4.6 builds and type-checks with TypeScript 7.0.2; the TypeScript 6 fallback is not needed |
| U6, Task 8 step 3 | Confirmed for server imports (`cloudrop`, `cloudrop/next`); `cloudrop/client` in a client component not measured, keep the fallback |
| Task 8, Task 9, Task 10, README | New: `next build` needs the storage settings and `CLOUDROP_SECRET`; commit `tsconfig.json` in Next's shape |
| Task 9 step 3 | Confirmed: the `credentials: "include"` probe fails on RustFS |
| S23, Task 9 CI job | Confirmed headless with no extra packages; `--only-shell` halves the install size and time |
