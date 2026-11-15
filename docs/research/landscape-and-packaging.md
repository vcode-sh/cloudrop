# 04 — OSS landscape, packaging in 2026, and design recommendations for an R2 uploader

Research date: **2026-11-15**. Sources are primary where possible: npm registry (`npm view`, `api.npmjs.org`),
GitHub API, published tarballs (`npm pack`, read locally), official docs. Download counts are for the week
**2026-11-07 → 2026-11-13** (`https://api.npmjs.org/downloads/point/last-week/<pkg>`). Stars and push dates are from
`gh api repos/<owner>/<repo>` on the research date. Bundle sizes are from the Bundlephobia API
(`https://bundlephobia.com/api/size?package=<pkg>`): minified + gzipped, whole package entry, so they are an upper bound
when tree-shaking applies.

Marking: **(unverified)** means a secondary source or my inference, not confirmed against a primary source.
**(src)** means I read the published tarball's source. Out of scope here, because a sibling document covers them:
files-sdk.dev, RustFS and R2 platform limits. Where this document leans on an R2 limit, it says so and points there.

---

## Part 1 — Landscape

### 1.1 Metadata

| Package | Maintainer(s) | License | Latest (date) | Weekly DL | Stars | Health | Bundle (gzip) |
|---|---|---|---|---|---|---|---|
| `@uppy/core` + `@uppy/aws-s3` | Transloadit (kvz, mifi, …) | MIT | 6.3.1 (2026-11-03) | 2.12 M / 1.17 M | 31.1k | Very active. v6 rewrite of aws-s3 on 2026-08-26 | 18.0 kB + 7.3 kB |
| `tus-js-client` (+ `@tus/server`, `@tus/s3-store`, `tusd`) | tus / Transloadit | MIT | 4.3.1 (2025-01-16); `next` 5.0.0-pre3 (2026-09-30) | 3.15 M (`@tus/s3-store` 133k) | 2.6k (tusd 3.9k) | Active | 12.8 kB |
| `uploadthing` / `@uploadthing/react` | Ping Labs (juliusmarminge, t3dotgg) | MIT | 7.7.4 (2025-08-17) | 273k / 177k | 5.4k | Slowing. No npm release in 15 months, last commit 2026-09-30 | `@uploadthing/react` 18.1 kB (`uploadthing` failed to build on Bundlephobia) |
| `@better-upload/client` / `server` | Nic13Gamer (single) | MIT | 3.0.20 (2026-10-19) | 54k / 49k | 1.3k | Active, small surface | client 3.3 kB |
| `pushduck` | abhay-ramesh (single) | MIT | 0.7.0 (2026-09-20) | 6.0k | 213 | Very active, pre-1.0, fast-moving | 26.7 kB (all entries) |
| `next-s3-upload` | ryanto | MIT (per npm; no license on the GitHub API) | 0.3.4 (2023-10-28) | 34k | 589 | Dormant (last push 2024-12) | 153.9 kB (bundles the AWS SDK) |
| `@aws-sdk/lib-storage` (`Upload`) | AWS | Apache-2.0 | 3.1169.0 (2026-11-13) | 16.2 M | 3.7k (monorepo) | Very active | 13.9 kB + `@aws-sdk/client-s3` 88.6 kB |
| `aws4fetch` | mhart (single) | MIT | 1.0.20 (2024-08-28) | 15.5 M | 892 | Stable, effectively finished (last push 2024-12) | 3.0 kB |
| Bun `S3Client` | Oven | MIT (Bun) | Bun runtime (docs banner shows v1.4.4) | n/a | 96.7k | Very active | n/a (built in) |
| `@vercel/blob` (client uploads) | Vercel | Apache-2.0 | 2.9.0 (2026-11-09) | 11.2 M | 600 (`vercel/storage`) | Very active | 30.5 kB |
| `filepond` | pqina (single company) | MIT | 4.32.14 (2026-11-11); v5 in beta (`5.0.0-beta.77`) | 376k | 16.4k | Active | 34.3 kB |
| `react-dropzone` | react-dropzone org | MIT | 20.2.0 (2026-11-08) | 19.9 M | 11.0k | Active | 6.3 kB |
| `unstorage` | unjs (pi0) | MIT | `latest` = 2.0.0-beta.0 (2026-10-20) | 26.7 M | 2.7k | Active | n/a (server-side KV) |
| `flydrive` | virk (AdonisJS) | MIT | 2.2.0 (2026-10-07) | 131k | 183 | Active | n/a (Node only) |
| `evaporate` (EvaporateJS) | TTLabs | BSD-3-Clause | 2.1.4 (2017-10-08) | 55k | 1.8k | Abandoned (last push 2024-01). Historical reference | 11.4 kB |

Newer or adjacent packages found by npm search ("r2 upload", "presigned multipart", "r2 uploader", "s3 multipart upload
browser", keyword `r2`):

| Package | Notes | Weekly DL |
|---|---|---|
| `@convex-dev/r2` 0.10.4 | R2 upload component, **requires Convex**. React and Svelte hooks. Signed PUT with a UUID key; `checkUpload` / `onUpload` hooks. No multipart or progress in the README. [repo](https://github.com/get-convex/r2) | 216k |
| `@rpldy/uploader` 1.13.0 (react-uploady) | Generic upload queue engine, not S3-aware | 62k |
| `s3mini` 1.0.3 | Tiny S3 client for Node, Bun and Workers. README says "No Browser support!" R2 tested; multipart with retries; presign GET/PUT only. [repo](https://github.com/good-lly/s3mini) | n/a |
| `@upstash/blob` 0.0.13 | New vendor blob SDK with browser and React uploads (created 2026-08-25) | 3.1k |
| `presigned-multipart-upload` 0.1.1 | Created 2026-10-30. React/Angular presigned multipart with retry, pause and resume | 41 |
| `cloudflare-r2-uploader`, `@kasifraza/s3-upload-helper`, `@zerodot/s3` | Tiny, single-author, no traction | ≤ 60 |

Read: there is **no dedicated, popular, framework-agnostic R2 browser uploader**. Everything with traction is either a
general UI toolkit (Uppy, FilePond), a vendor service (UploadThing, Vercel Blob, Convex), or a server SDK
(lib-storage, Bun, s3mini, FlyDrive).

### 1.2 Feature notes per candidate (with sources)

**Uppy 6 (`@uppy/aws-s3`)** — [docs](https://uppy.io/docs/aws-s3/), [CHANGELOG in tarball](https://github.com/transloadit/uppy/blob/main/packages/%40uppy/aws-s3/CHANGELOG.md)
- Rewritten from scratch in 6.0. There are now three mutually exclusive signing modes: `signRequest({method,key,uploadId?,partNumber?}) → {url,key?,headers?}`
  (one function covers PutObject, Create, UploadPart, ListParts, Complete and Abort), `getCredentials()` (browser SigV4
  with STS temporary credentials), and `companionEndpoint`. `retryDelays` was removed; the old per-operation hooks were
  removed too.
- Multipart above 100 MiB by default (`shouldUseMultipart`). `getChunkSize` defaults to size/10,000, auto-clamped to
  ≥ 5 MiB and ≤ 10,000 parts.
- **Concurrency:** `limit` (default 6) counts *files*. The docs say "A single file's parts upload sequentially". The source
  confirms it: the part loop `await`s each `uploadPart` in turn ((src) `lib/S3Uploader.js`). So one large file gets no
  intra-file parallelism.
- Retries: automatic exponential backoff, 3 attempts. Offline wait, stall detection, and one re-sign on an expired
  token ((src) `lib/s3-client/S3mini.js` doc comment).
- Pause/resume per file and globally. Resume uses `ListParts`. `uploadId` and `key` are persisted in file state
  (`s3Multipart`) "so Golden Retriever can restore it after page refresh" ((src)).
- Resume across reloads needs `@uppy/golden-retriever`. That plugin stores files only up to **10 MiB each** in
  IndexedDB by default. Larger files need an opt-in Service Worker, which "doesn't persist across browser crashes or
  restarts" ([docs](https://uppy.io/docs/golden-retriever/)).
- R2 is explicitly supported (region `'auto'`). Uppy does not handle R2's equal-part rule specially, but its part size
  is deterministic per file, so all non-last parts come out equal.
- No checksums documented. No size enforcement on the server side: the signer is yours to write.
- Bindings: React (`@uppy/react` 6.1.1, with headless components and hooks such as `useDropzone`, `useFileInput`,
  `useUppyState` — [docs](https://uppy.io/docs/react/)), Vue (`@uppy/vue` 4.0.1), Svelte (`@uppy/svelte` 6.0.1).
- `@uppy/core` depends on `preact`, `lodash`, `p-queue`, `p-retry` and others (`npm view @uppy/core dependencies`), so
  "headless" still ships a UI runtime in the dependency graph.

**tus protocol (`tus-js-client` + `@tus/s3-store` / `tusd`)**
- Client defaults ((src) `lib.esm/upload.js`): `retryDelays: [0, 1000, 3000, 5000]`, `parallelUploads: 1`,
  `storeFingerprintForResuming: true` (URL storage in `localStorage`), `chunkSize: Infinity`. Protocols available:
  `tus-v1`, `ietf-draft-03` and `ietf-draft-05`.
- The bytes go **through your server**. That costs egress and CPU and disqualifies serverless and edge hosting with
  body limits. The server also needs temporary disk ("parts of its body will be temporarily stored on disk") and a
  distributed lock when you run more than one instance ([tusd S3 docs](https://tus.github.io/tusd/storage-backends/aws-s3/)).
- R2: "all parts (except the last one) must have the same size". Fix it by setting `-s3-min-part-size` equal to
  `-s3-part-size` (tusd), or `partSize` equal to `minPartSize` (`@tus/s3-store`)
  ([tusd docs](https://tus.github.io/tusd/storage-backends/aws-s3/), [@tus/s3-store README](https://github.com/tus/tus-node-server/tree/main/packages/s3-store),
  [tusd#1137](https://github.com/tus/tusd/issues/1137)).
- tus is the best *resumability* protocol, but it is the wrong default for a direct-to-bucket uploader.

**UploadThing** — [docs](https://docs.uploadthing.com/uploading-files)
- Files land in **UploadThing-managed storage**. Bring-your-own-bucket was announced as future work in the
  [v7 launch post](https://docs.uploadthing.com/blog/v7-launch), and the S3-compatibility issue was closed "not planned"
  ([#28](https://github.com/pingdotgg/uploadthing/issues/28)). It is not an R2 uploader.
- It is still the DX reference. File routes declare type, size and count limits plus `middleware` for auth. An
  HMAC-signed ingest URL carries `x-ut-file-size`, and "The upload will fail if any parameter doesn't match": size is
  **enforced at ingest**, which plain R2 cannot do. `onUploadComplete` arrives via a signed callback, and
  `awaitServerData` makes the client wait for it. Range-based resume uses `HEAD` → `x-ut-range-start`.
- Server adapters: Express, Fastify, WinterCG fetch, H3. Clients: React, Solid, Svelte, Vue, Expo.

**better-upload** — [docs](https://better-upload.com/docs), [llms-full.txt](https://better-upload.com/llms-full.txt)
- Server: `route({ fileTypes, maxFileSize, multipart, partSize (default 50 MB), signedUrlExpiresIn, onBeforeUpload, onAfterSignedUrl })`.
  Built-in clients include `cloudflare()`, `aws()`, `backblaze()`, `tigris()` and Neon. Built on `aws4fetch`,
  `fast-xml-parser` and `zod` ((src) `package.json`). Adapters: `next`, `node`, plus any `Request`-based framework.
- **Signs `content-length` and `content-type` into the presigned PUT** (`signQuery: true, allHeaders: true`). Each
  part URL also signs its exact `content-length` ((src) `dist/s3-*.mjs`, `signPutObject` and `signUploadPart`). This is
  the right pattern.
- Client: React hooks only (`useUploadFile`, `useUploadFiles`), plus copy-paste shadcn components.
  `multipartBatchSize` controls part concurrency (default: all parts at once). `retry` defaults to 0 and `retryDelay`
  to 0. `signal` handles abort. No pause, no resume, no persistence.
- Equal part sizes come from a fixed server `partSize`, which is R2-safe.

**pushduck** — [repo](https://github.com/abhay-ramesh/pushduck), [docs](https://pushduck.org/docs), [v0.7.0 notes](https://github.com/abhay-ramesh/pushduck/releases/tag/v0.7.0)
- The most feature-complete newcomer. 0.7.0 shipped:
  - a headless engine (`pushduck/core`) with React, Vue, Svelte, Solid and React Native bindings;
  - multipart with "plan, sign and resume";
  - `createWebStore()` resume via `localStorage`, with 6-hour expiry;
  - per-part retries (`maxAttempts` 3) and concurrency (4);
  - a fixed equal part size "because Cloudflare R2 rejects an upload whose non-final parts differ";
  - progress, speed and ETA;
  - a typed error table with a `retryable` flag;
  - a wire-protocol conformance suite with Go and Python servers.

  Sources: [large-files guide](https://github.com/abhay-ramesh/pushduck/blob/main/docs/content/docs/guides/large-files.mdx), (src).
- Its own security fixes in 0.7.0 point at the bug class to design against: "authorise completion, which anyone could
  previously forge", "bind a completion to the key it was presigned for", "stop erasing non-Latin filenames, which
  silently overwrote files", "stop trusting a part listing".
- Caveats:
  - The public [limitations page](https://pushduck.org/docs/limitations) still says "Multipart support is on the roadmap
    but not yet shipped" and "No automatic retry", which contradicts 0.7.0. The docs are out of date.
  - A single maintainer and 6k downloads a week.
  - One package with nine optional framework peers (express, fastify, next, react, solid-js, svelte, vue, zod) ((src)
    `package.json`).
  - The resume fingerprint is name + size + mtime, and after a reload the user must re-select the file.

**next-s3-upload** — default mode: the server calls STS `GetFederationToken` with an inline policy for one key, and the
browser runs `@aws-sdk/lib-storage` with those credentials. There is an alternative `presigned` strategy ((src)
`dist/handler-*.mjs`). STS federation tokens are AWS-only, so R2 can only use the presigned path. Dormant.

**`@aws-sdk/lib-storage` `Upload`** — `queueSize` (4), `partSize` (5 MiB), `leavePartsOnError`, `abort()`,
`httpUploadProgress` events with `{loaded,total,part}`. When `requestChecksumCalculation` is `WHEN_SUPPORTED` it
defaults `ChecksumAlgorithm` to CRC32 ((src) `dist-es/Upload.js`, `dist-types/types.d.ts`). You cannot resume a given
`UploadId` across processes. In a browser it needs credentials, and it pulls in about 100 kB gz of SDK. It is a server
or CLI tool. [README](https://github.com/aws/aws-sdk-js-v3/blob/main/lib/lib-storage/README.md)

**aws4fetch** — SigV4 with `fetch` and SubtleCrypto. `signQuery: true` produces presigned URLs; `allHeaders: true`
signs every header. Built-in retries (10 retries, 50 ms initial, exponential with full jitter). 2.5 kB gz claimed.
[README](https://github.com/mhart/aws4fetch). Cloudflare's R2 presigned-URL docs tell you to set `allHeaders: true` so
that `Content-Type` is signed ([R2 docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)). It is the de
facto signer under better-upload, pushduck and unstorage.

**Bun `S3Client`** — `presign({method, expiresIn, type, acl, contentDisposition})` runs synchronously and locally.
**No content-length option is documented.** `writer({partSize, queueSize, retry})` does multipart. R2 works through
`endpoint`. Server-only. [docs](https://bun.com/docs/runtime/s3)

**`@vercel/blob` client uploads** — [docs](https://vercel.com/docs/vercel-blob/client-upload)
- The best DX reference for the token flow. The client calls
  `upload(pathname, file, { access, handleUploadUrl, multipart, onUploadProgress, abortSignal, clientPayload })`.
- The server calls `handleUpload({ body, request, onBeforeGenerateToken, onUploadCompleted })`.
  `onBeforeGenerateToken` returns `{ allowedContentTypes, maximumSizeInBytes, validUntil, addRandomSuffix, allowOverwrite, cacheControlMaxAge, ifMatch, tokenPayload, callbackUrl }`
  ((src) `dist/client.d.ts`).
- The docs make authentication mandatory: "You **must** authenticate and authorize users in the `onBeforeGenerateToken`
  callback".
- `onUploadCompleted` is a webhook, so it fails on localhost without a tunnel. That is a DX wart worth avoiding.
- Vercel storage only.

**FilePond** — a UI with its own chunk protocol (POST, then PATCH with `Upload-Offset`, then HEAD to resume) and
`chunkRetryDelays`. It cannot talk S3 multipart natively; you have to write a custom `process` function
([server docs](https://pqina.nl/filepond/docs/api/server/)).

**react-dropzone** — file *selection* only (drop zone and input props). No transport. Treat it as complementary.

**Unstorage S3 driver** — KV-style server driver on `aws4fetch`, R2 tested. No presign, no multipart
([docs](https://unstorage.unjs.io/drivers/s3)). Not an uploader.

**FlyDrive** — Node-only disk abstraction. `getSignedUploadUrl(key, { expiresIn, contentType })` for direct PUT. No
multipart API ([Disk API](https://flydrive.dev/docs/disk_api)). Useful as a server helper, not as an uploader.

**EvaporateJS** — historical. It pioneered browser S3 multipart with `maxConcurrentParts`, per-part MD5
(`computeContentMd5`), automatic retries, pause/resume/cancel, transfer rate and ETA, and `customAuthMethod` signing
([repo](https://github.com/TTLabs/EvaporateJS)). Its feature list is still a good checklist, but it is BSD-3 and
abandoned.

### 1.3 Comparison matrix

Legend: ✅ yes · ◐ partial or DIY · ❌ no · — not applicable. "Server handler" means the library ships the signing
endpoint for you.

| Feature | Uppy 6 aws-s3 | tus (+s3-store) | UploadThing | better-upload 3 | pushduck 0.7 | lib-storage | aws4fetch | Bun S3 | Vercel Blob client | FilePond | evaporate |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Own bucket / R2 | ✅ | ✅ (via server) | ❌ | ✅ | ✅ | ✅ (server) | ✅ | ✅ (server) | ❌ | ◐ custom | ◐ AWS-centric |
| Direct-to-bucket presigned PUT | ✅ | ❌ (proxied) | ◐ (to their ingest) | ✅ | ✅ | ❌ (credentials) | ✅ (primitive) | ✅ (presign only) | ◐ (their store) | ❌ | ❌ (signed requests) |
| Presigned multipart | ✅ | — | ❌ | ✅ | ✅ | ❌ | ◐ primitive | ❌ | ✅ (their store) | ❌ | ✅ |
| Part concurrency within a file | ❌ sequential | ◐ `parallelUploads` | — | ✅ | ✅ (4) | ✅ (4) | — | ✅ (`queueSize`) | (unverified) | — | ✅ |
| Adaptive part size | ◐ size/10k clamp | ◐ server | — | ❌ fixed | ◐ clamp | ❌ fixed | — | ❌ | (unverified) | ❌ | ❌ |
| Adaptive concurrency (throughput) | ❌ | ❌ | — | ❌ | ❌ | ❌ | — | ❌ | (unverified) | ❌ | ❌ |
| Resume across page reload | ◐ Golden Retriever ≤10 MiB IDB, SW otherwise | ✅ URL fingerprint, re-select file | ◐ Range resume, DIY | ❌ | ◐ `localStorage`, re-select file | ❌ | — | — | ❌ (unverified) | ◐ retry only | ◐ (unverified) |
| Pause / resume / abort | ✅/✅/✅ | ✅/✅/✅ | ◐ | ❌/❌/✅ | ❌/◐/✅ | ❌/❌/✅ | — | — | ❌/❌/✅ | ✅ | ✅ |
| Retries with backoff | ✅ (3) | ✅ | (unverified) | ◐ (fixed delay, default 0) | ✅ (3/part) | ◐ SDK retry | ✅ | ✅ (`retry`) | ✅ (`async-retry` dep) | ✅ | ✅ |
| Progress bytes / speed / ETA | ✅/◐/◐ | ✅/❌/❌ | ✅/❌/❌ | ✅/❌/❌ | ✅/✅/✅ | ✅/❌/❌ | — | — | ✅/❌/❌ | ✅/❌/❌ | ✅/✅/✅ |
| Checksums / integrity | ❌ | ◐ (checksum extension, server) | (unverified) | ◐ server helper only | (unverified) | ✅ CRC32 default | — | ❌ documented | (unverified) | ❌ | ✅ MD5 |
| Size enforcement beyond the declared size | ❌ (DIY signer) | ✅ (server sees bytes) | ✅ (ingest) | ✅ signed content-length | ◐ route `maxFileSize` | — | — | ❌ | ✅ `maximumSizeInBytes` | — | ❌ |
| Type validation (MIME / magic bytes) | ✅ restrictions (MIME/ext) / ❌ | ❌ | ✅ / ❌ | ✅ / ❌ | ✅ / ❌ | — | — | — | ✅ / ❌ | ✅ plugin / ❌ | ❌ |
| Server handler / router | ❌ (Companion or DIY) | ✅ `@tus/server` | ✅ | ✅ | ✅ | — | — | — | ✅ `handleUpload` | ❌ | ❌ |
| Framework adapters (server) | — | Node, Express… | Express, Fastify, H3, fetch | Next, Node, fetch | Next, Express, Fastify, fetch | — | — | — | fetch / Next | — | — |
| React / Vue / Svelte | ✅/✅/✅ | ❌ (via Uppy) | ✅/✅/✅ | ✅/❌/❌ | ✅/✅/✅ (+Solid, RN) | ❌ | ❌ | ❌ | ❌ (vanilla) | ✅/✅/✅ adapters | ❌ |
| Headless core | ◐ (Preact in deps) | ✅ | ◐ | ◐ (`uploadFile` helper) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Web Worker offload | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | — | ❌ | ❌ | ❌ |
| R2-specific handling | ◐ region `auto` | ◐ config flag documented | — | ✅ `cloudflare()` client | ✅ equal parts, `cloudflareR2` | ❌ | ◐ docs | ✅ endpoint | — | — | ❌ |
| Runtime targets | Browser | Browser, Node, RN | Browser + server runtimes | Browser + any fetch server | Browser, RN, Node, Bun, Deno (tested) | Node, browser | Any (fetch + SubtleCrypto) | Bun | Browser + Node/edge | Browser | Browser, Node (Electron) |

Cells marked (unverified) were not confirmed in docs or source during this pass.

### 1.4 Gaps nobody fills well

1. **One MIT package that does all of it for your own R2 bucket.** You want headless core, presigned multipart with
   intra-file concurrency, retries, pause and resume, persistence, and a shipped server handler, all at once. Uppy has
   the client but no server and sequential parts. better-upload has the server but no resume and no retries by
   default. pushduck comes closest but is pre-1.0, single-maintainer, and its docs contradict its code.
2. **Real size enforcement on R2.** R2 has no presigned POST, so there is no `content-length-range`
   ([R2 docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)). Signing the exact `content-length` is the
   community workaround, but Cloudflare documents enforcement only for `Content-Type`, and reports on whether a
   mismatched length is rejected conflict ([community thread](https://community.cloudflare.com/t/cloudflare-r2-presigned-url-limit-file-size/455122)) (unverified).
   No library verifies the stored object (HEAD and `ListParts` sizes) before it reports success.
3. **End-to-end integrity from the browser.** No browser uploader computes per-part checksums (CRC32C or SHA-256) and
   signs them into part URLs. EvaporateJS did MD5 in 2017. Whether R2 accepts `x-amz-checksum-*` on presigned part
   uploads belongs to the sibling R2 doc (unverified here).
4. **Web Worker offload.** No one hashes, sniffs magic bytes or slices large files in a worker.
5. **Adaptive throughput.** No one adapts concurrency to measured throughput and error rate. Part size cannot vary
   within an R2 upload (equal-parts rule), so adaptivity has to come from *concurrency*, or from a part size chosen per
   file *up front*.
6. **Resume of large files after reload without re-selecting the file.** Golden Retriever stops at 10 MiB in IndexedDB.
   pushduck and tus need the user to re-select the file. Nobody offers an opt-in OPFS staging copy
   (`navigator.storage.getDirectory()` is Baseline widely available since March 2023
   ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory))).
7. **A stateless, tamper-proof completion step.** pushduck's own 0.7.0 fixes show that completion forgery and key
   rebinding are real bugs. The other libraries leave completion to the user or depend on vendor webhooks.
8. **Verified multi-backend conformance in CI.** Only pushduck ships a protocol conformance suite. No library
   publishes a matrix against R2 itself plus S3-compatible emulators.

---

## Part 2 — How to build and ship it in 2026

### 2.1 Module format: ESM-only

- `require(esm)` is unflagged in Node **20.19, 22.12 and 23.0+**, and "no longer experimental" since **25.4.0**
  ([Node docs](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require)).
- Node 20 and 25 are EOL. 22 (Maintenance), 24 and 26 (LTS) are the supported lines
  ([Node releases](https://nodejs.org/en/about/previous-releases)).
- So CJS consumers on supported Node can `require()` an ESM-only package. One constraint: **no top-level await
  anywhere in the graph**, or `ERR_REQUIRE_ASYNC_MODULE` is thrown (same source).
- JSR accepts ESM only ([JSR publishing](https://jsr.io/docs/publishing-packages)).
- **Recommendation:** ESM-only, `"type": "module"`, `engines.node >= 22.12`, no TLA, no dual build.

### 2.2 `exports` map and conditions

- `types` comes first and `default` last. Key order is significant ([Node packages](https://nodejs.org/api/packages.html#community-conditions-definitions)).
- Core Node conditions: `node-addons`, `node`, `import`, `require`, `module-sync`, `default`. Community conditions:
  `types`, `browser`, `development`, `production`.
- Runtime keys (`bun`, `deno`, `workerd`, `edge-light`, `react-native`, `react-server` …) are defined by WinterTC
  [Runtime Keys](https://runtime-keys.proposal.wintercg.org/), which says they "are not intended to be used in web
  browsers".
- **Recommendation:** write the core and server code against Web APIs only (`fetch`, `Request`, `Response`,
  `crypto.subtle`, `Blob`, `AbortSignal`). Then ship **one universal build per entry, with no runtime conditions**.
  Add a `browser`/`default` split only if a Node-specific path ever becomes necessary. That keeps
  `{ "types", "default" }` per subpath, avoids the dual-package hazard, and passes attw's `esm-only` profile.
- Use explicit subpaths: `.`, `./server`, `./react`, `./vue`, `./svelte` (or separate packages, see 2.8). No wildcards.

### 2.3 Build tool

| Tool | State on 2026-11-15 | Verdict |
|---|---|---|
| **tsdown** 0.23.7 (2026-11-06), 4.3k★ | Rolldown-based, "official project of Rolldown"; Oxc-based `.d.ts` when `isolatedDeclarations` is on, otherwise falls back to the TypeScript compiler; built-in `exports` generation, `publint` and `attw` options (attw default profile `esm-only`) ([guide](https://tsdown.dev/guide/), [dts](https://tsdown.dev/options/dts), [lint](https://tsdown.dev/options/lint), [exports](https://tsdown.dev/options/package-exports)) | **Use this** |
| tsup 9.0.0 (2026-10-14) | README: "This project is not actively maintained anymore. Please consider using tsdown instead." ([repo](https://github.com/egoist/tsup)) | Avoid for new work |
| unbuild 3.6.1 (2025-08-15) | README: experimenting with `obuild` (0.4.45) "as the next next-gen successor" ([repo](https://github.com/unjs/unbuild)) | Avoid |

TypeScript 7.0 (released 2026-07-08, Go port, `typescript@7.0.2` is `latest`) **"does not ship with an API"**. Tools
that need the compiler API should use `@typescript/typescript6`
([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)). So turn on
`isolatedDeclarations`: tsdown then emits `.d.ts` through Oxc and never needs the TS JS API. JSR's "no slow types"
rule pushes the same way. Whether tsdown's TS-compiler fallback works with TS 7 is (unverified). Pin TS 6 via the
alias if you need the fallback.

### 2.4 Validating the published package

- **publint** 0.3.25 and **@arethetypeswrong/cli** 0.18.5 (or tsdown's `publint: 'ci-only'` and
  `attw: { profile: 'esm-only', level: 'error' }`; both are optional deps you install yourself
  ([tsdown lint](https://tsdown.dev/options/lint))).
- Run them on the **packed tarball** (`npm pack` then `attw --pack`), not on the workspace, so `files` mistakes
  surface.
- Add a smoke test that imports each subpath from a scratch project under Node, Bun and Deno, plus one `require()` from
  CJS.

### 2.5 JSR co-publishing

- JSR publishes TypeScript source, requires ESM, enforces "no slow types" by default (opt-out
  `--allow-slow-types` slows users down), and supports tokenless OIDC publishing **from GitHub Actions only** with
  provenance ([JSR docs](https://jsr.io/docs/publishing-packages)).
- npm consumers reach JSR packages through the `@jsr/` scope.
- **Recommendation:** worth doing for Deno users, and nearly free once `isolatedDeclarations` is on. Keep `jsr.json`
  version in sync through the release tool. Run `jsr publish --dry-run` in CI.

### 2.6 npm trusted publishing and provenance

From the [npm trusted publishers docs](https://docs.npmjs.com/trusted-publishers):

- GitHub Actions **on GitHub-hosted runners only**: "Self-hosted runners are not currently supported". The publish
  job must run on `ubuntu-latest`, not on a self-hosted runner.
- npm CLI **≥ 11.5.1** and Node **≥ 22.14.0**. `permissions: id-token: write` (on both caller and callee when using
  reusable workflows).
- Provenance is automatic for a public repo plus a public package, so `--provenance` is not needed.
- `repository.url` must match the repo exactly. The config must see its first successful publish within 2 days.
  Afterwards, set "Require two-factor authentication and disallow tokens".
- Configs created after 2026-09-03 allow `npm stage publish` by default. `npm publish` is optional, which gives a
  2FA-approved staged-publish flow.
- The first-ever publish of a package name needs a token or local login before OIDC can be configured (community
  sources: [setup-npm-trusted-publish](https://github.com/azu/setup-npm-trusted-publish)) (unverified against npm docs).
- **Bun:** `bun publish` has no OIDC support ([oven-sh/bun#22423](https://github.com/oven-sh/bun/issues/22423), open)
  and no provenance ([#15601](https://github.com/oven-sh/bun/issues/15601), open).
  - Plain `npm publish` does not rewrite `workspace:` or `catalog:` specifiers.
  - Pack with the workspace tool (`bun pm pack` or `pnpm pack`), then `npm publish ./pkg.tgz` (community workaround,
    unverified).
  - Gate it by checking that the tarball's `package.json` has no `workspace:` or `catalog:` strings.

### 2.7 Release tooling

| | Changesets (`@changesets/cli` 3.0.3, 2026-09-14; `changesets/action` v2.1.2 for Changesets v3) | release-please 17.11.2 |
|---|---|---|
| Model | Intent files per PR, then a version PR, then publish | Conventional commits, then a release PR, then tags and GitHub releases |
| Monorepo | First-class (linked/fixed groups, independent versions) | Manifest config |
| Publishes to npm | Yes (`changeset publish`) | **No**: "does not handle publication to package managers" ([README](https://github.com/googleapis/release-please)) |
| OIDC | Supported. Recommends split sub-actions so that "only the publish job gets `id-token: write`" ([action README](https://github.com/changesets/action)) | n/a (your publish job) |

**Recommendation:** Changesets. Per-package intent and human-written changelog lines suit a core plus adapters
monorepo. Use the split `version`/`publish` jobs, with only `publish` holding `id-token: write`.

### 2.8 Size budgets, tree-shaking, peer deps, layout

- **size-limit** 14.3.0. `@size-limit/preset-small-lib` now uses the rolldown and file plugins. The `import` option
  budgets a named import (`"{ createUploader }"`) to prove tree-shaking ([repo](https://github.com/ai/size-limit)).
  `andresz1/size-limit-action` comments on PRs.
  - Proposed budgets: core ≤ 6 kB gz, each framework binding ≤ 1 kB gz on top of core, `server` ≤ 8 kB gz including
    the SigV4 signer.
  - Measured incumbents for scale: better-upload client 3.3 kB, aws4fetch 3.0 kB, Uppy core + aws-s3 ≈ 25 kB,
    pushduck (all entries) 26.7 kB.
- **`"sideEffects": false`** in every package, and no module-level side effects (no global listeners at import time)
  ([webpack tree-shaking guide](https://webpack.js.org/guides/tree-shaking/)).
- **Peer deps:** one package per framework (`@x/react` with `peerDependencies: { react: "^18 || ^19" }`) is cleaner
  than one package with many optional peers. Compare pushduck's nine optional peers ((src)) with Uppy's per-framework
  packages.
- **Layout** (Bun workspaces or pnpm, `catalog:` for shared versions):

```
packages/
  core/      # headless engine: planner, scheduler, state machine, transports, persistence (no deps)
  server/    # Request -> Response handler, SigV4 presigner, policy, token, R2/S3 ops (no deps or aws4fetch)
  react/     # useSyncExternalStore binding
  vue/       # shallowRef + onScopeDispose binding
  svelte/    # readable store / runes binding
  testing/   # conformance suite + fake bucket (private, or published for adapter authors)
apps/docs/   # documentation site
examples/    # next, hono-on-workers, sveltekit, vanilla
```

### 2.9 Docs site

| Option | Version | Notes |
|---|---|---|
| Starlight (Astro) | 0.43.1 (2026-11-13), 9.6k★ | Framework-neutral docs; good fit for a multi-framework library |
| Fumadocs | 16.19.3 (2026-11-14), 13.6k★ | Next.js-based; pushduck uses it ((src) MDX imports) |
| VitePress | 1.6.4 (2025-08-05); `next` 2.0.0-alpha.21 | Stable line not updated for 15 months |
| TypeDoc | 0.28.20 | API reference generation |

**Recommendation:** Starlight, plus a generated API reference, plus `llms.txt` / `llms-full.txt` (better-upload ships
one, and it made this research faster). Every framework example should be a runnable app in `examples/` that CI
builds.

### 2.10 License hygiene

- `LICENSE` (MIT) holding the copyright holder's legal name and year, `"license": "MIT"` in every `package.json`, and
  `LICENSE` included in each tarball (`files`).
- **Provenance of code:** the author must own what they publish. Per [opensource.guide/legal](https://opensource.guide/legal/):
  an "employee IP agreement" can give an employer control, especially when the project overlaps the business or "you
  use any company resources". Code lifted from private or client repositories needs explicit written clearance from
  the owner, or a clean-room rewrite.
- Third-party code: MIT, Apache or BSD can be incorporated if notices are retained. Never copy AGPL code (MinIO and
  Garage are AGPL). Running them as test services is fine. Keep a `THIRD_PARTY_NOTICES` file if any snippet is
  vendored. For example, Uppy's `lib/s3-client/S3mini.js` is MIT-licensed code you could learn from, but copying it
  needs attribution.
- Contributions: DCO (`Signed-off-by`) rather than a CLA. The same guide says a CLA is "Probably not" needed.

### 2.11 Security policy

- `SECURITY.md` with a supported-versions table and a private channel. Enable GitHub **private vulnerability reporting**,
  which owners of public repositories can turn on
  ([GitHub docs](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository)).
- Threat model in the docs covers: forged completion, key injection or path traversal, oversized uploads, MIME spoofing,
  presigned URL leakage (short expiry), open CORS, and orphaned multipart storage cost.

### 2.12 Testing matrix

| Lane | Tooling | What it proves |
|---|---|---|
| Unit | `bun test` or Vitest 5.1 | Part planner (5 MiB ≤ part ≤ 5 GiB, ≤ 10,000 parts, equal non-final parts), state machine transitions, retry classifier, token HMAC, policy |
| Browser | Vitest browser mode with `@vitest/browser-playwright`, instances chromium, firefox and webkit; `headless` defaults true in CI ([docs](https://vitest.dev/guide/browser/)) | Real XHR upload progress, CORS preflight, `AbortSignal`, `localStorage`/IndexedDB/OPFS persistence, Worker hashing |
| Integration (CI, every PR) | Docker service containers on GitHub-hosted runners | Full flows against S3-compatible servers |
| Live R2 (nightly + release gate) | Dedicated test bucket, scoped token, lifecycle rule to abort stale multipart | R2-only behaviour no emulator reproduces (equal-parts rejection, signed content-length behaviour, checksum headers, CORS) |
| Runtime smoke | Node 22/24/26, Bun, Deno, workerd (`wrangler dev` or Miniflare) | Server handler imports and signs without Node APIs |
| Conformance | Shared JSON fixtures (as pushduck does) | Wire protocol stability across versions (expand-then-contract) |

S3-compatible servers for CI, as of the research date:

- **MinIO** repository is **archived**: "THIS REPOSITORY IS NO LONGER MAINTAINED" ([repo](https://github.com/minio/minio)).
- **LocalStack** community repo is **archived** and consolidated into a unified image with a free non-commercial plan
  ([repo](https://github.com/localstack/localstack)).
- Live options, all Apache-2.0: **SeaweedFS** 4.53 (2026-11-08), **versitygw** v1.11.0 (2026-11-06), **adobe/S3Mock**
  5.2.3 (2026-09-19, mock).
- **Garage** is AGPL-3.0 (2026-11 activity). Fine to run as a service, never vendor its code.
- RustFS: see the sibling document.
- Use at least two independent servers, because no emulator models R2's equal-parts rule. The live R2 lane is not
  optional.

---

## Part 3 — Design recommendations

The pitch: **"Uppy-grade client robustness, UploadThing-grade server DX, for your own R2 bucket, with real enforcement
and a sub-6 kB headless core."**

### 3.1 Architecture

1. **Headless core as an explicit state machine.**
   - Per-file states: `queued → preparing (validate, hash, plan) → signing → uploading ⇄ paused → completing → verifying → done | failed | aborted`.
   - Parts track their own sub-state (`pending | inflight | done(etag) | failed(n)`).
   - Make the transition function pure (event in, state plus effects out), so it can be tested without a network.
   - Expose a store with `subscribe` / `getSnapshot`, so bindings are ~30-line wrappers (`useSyncExternalStore`, a Vue
     `shallowRef`, a Svelte store).
   - Reason: Uppy's core drags Preact, lodash and an event emitter into every install. pushduck rebuilt React on an
     extracted engine only in 0.7.0. Start where they ended up.
2. **One global scheduler across files *and* parts.**
   - A single concurrency budget (default 6 for HTTP/1.1 per-origin limits; higher on HTTP/2) shared by all in-flight
     requests.
   - Adaptive: additive increase while throughput rises, multiplicative decrease on errors and stalls.
   - Reason: Uppy uploads one file's parts sequentially, so a single 4 GB file uses one connection. better-upload
     defaults to "all parts at once", which overloads mobile links.
3. **Part planning that is R2-correct by construction.**
   - Pick the part size **once per upload** from the file size: start at 8–16 MiB, raise it until parts ≤ 10,000,
     round to whole MiB, clamp to [5 MiB, 5 GiB]. Never vary it within an upload.
   - Store the size in the upload record, so resume reproduces exact boundaries.
   - Reason: the R2 equal-parts rule. tusd and `@tus/s3-store` only document a config workaround.
   - The single-PUT threshold is configurable (default 64–100 MiB; Uppy and pushduck both use 100 MiB).
4. **Pluggable transports** behind one interface `send(request, body, { onProgress, signal })`:
   - `xhr` (browser default): fetch has no upload progress. Streaming request bodies need `duplex: 'half'`, HTTP/2+,
     and Chromium, and "always trigger a preflight" ([Chrome docs](https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests)).
   - `fetch` (Node, Bun, Deno, Workers, React Native).
   - Later, a `worker-proxy` strategy that streams through a Cloudflare Worker with an R2 binding, for when exact
     enforcement matters more than egress. Also later, a tus adapter for teams that already run tusd.
5. **Optional Web Worker offload.**
   - Slicing, CRC32C or SHA-256 per part, and magic-byte sniffing run in a module worker, with transferable
     `ArrayBuffer`s.
   - Fall back to the main thread when Workers are unavailable.
   - No incumbent does this (gap 4).
6. **Persistence adapters:** `memory` (default), `localStorage`, `indexedDB`, and opt-in `opfs-staging`.
   - `opfs-staging` copies the file into OPFS, so a reload can resume **without re-selecting**. It costs temporary disk
     space and needs `navigator.storage.persist()`. That is the gap Golden Retriever leaves above 10 MiB.
   - Record: `{ fingerprint (name, size, lastModified, + first/last 64 KiB hash), key, uploadId, partSize, uploadToken, parts[{n, etag, checksum}] }`.
   - Expire records after the server-side upload-token lifetime.
   - On resume, reconcile with `ListParts` and **verify each listed part's size against the plan** (pushduck learned
     "stop trusting a part listing" the hard way).

### 3.2 Server: framework-agnostic `Request → Response`

```ts
// One function. Mount it on any route in any runtime.
export const uploads = createUploadHandler({
  storage: r2({ accountId, accessKeyId, secretAccessKey, bucket }), // or s3({ endpoint, region, ... })
  secret: ENV.UPLOAD_TOKEN_SECRET,          // HMAC key for stateless upload tokens
  routes: {
    avatar: route({
      maxFileSize: '5MB',
      accept: ['image/png', 'image/jpeg', 'image/webp'],
      sniff: true,                           // verify magic bytes on completion (ranged GET of the first 4 KiB)
      authorize: async ({ request, file, meta }) => {
        const user = await auth(request);    // REQUIRED: returning nothing is a type error
        if (!user) throw new UploadError('UNAUTHORIZED');
        return { owner: user.id, key: `avatars/${user.id}/${ulid()}` };
      },
      onComplete: async ({ object, context }) => ({ url: publicUrl(object.key) }), // runs inside /complete
    }),
  },
});
// Hono: app.all('/uploads/*', c => uploads(c.req.raw))  · Next: export { uploads as GET, uploads as POST }
// Workers: export default { fetch: uploads }           · Node: toNodeHandler(uploads) (tiny adapter)
```

Design points and reasons:

- **The handler is the only adapter surface.** Every modern framework exposes the Web `Request`. Ship only a tiny Node
  `http` bridge. Better-upload's `adapters/next` and `adapters/node`, and pushduck's per-framework adapter files, are
  maintenance cost without value.
- **Stateless, signed upload tokens.**
  - `init` returns an HMAC-signed token binding `{route, key, uploadId?, size, contentType, partSize, owner, exp}`.
  - Every later call (`sign-parts`, `complete`, `abort`, `list-parts`) must present the token. The server ignores any
    key, size or uploadId from the body that is not in the token.
  - That closes completion forgery and key rebinding (pushduck 0.7.0 fixes #238 and #244) without a database.
- **Lazy, batched part signing.** Sign parts in batches (for example 20 at a time) with short expiry (≤ 15 min).
  Re-sign on 403 `AccessDenied` / `ExpiredRequest` instead of minting 10,000 URLs that live for hours.
- **Server-generated keys only.** The client may suggest a filename, which is used only for `Content-Disposition`
  (RFC 6266/5987 `filename*`). It is never trusted for the key. Default key: `<route>/<ulid>` with an optional
  sanitized extension. This avoids path traversal and the "non-Latin filenames … silently overwrote files" bug class.
- **Mandatory authorization.** Model it on Vercel's insistence that you "must authenticate and authorize users" before
  issuing a token. `authorize` is required in the type, and returns the owner, key and per-call limit overrides.
  Rate-limit and quota hooks are part of the same callback.
- **A synchronous `onComplete`**, run inside the client's `complete` request, with its return value passed back to the
  client. This avoids webhook-only flows that break on localhost (Vercel) or need a signed callback round trip
  (UploadThing's `awaitServerData`). R2 event notifications can be an optional extra.
- **Stable error codes** with a `retryable` flag and a human `message` saying what to do next. Clients branch on
  `code`. pushduck's error table is a good model.
- **Body cap and input bounds** on the handler: JSON only, small (≤ 16 KiB), bounded file count per `init`, bounded
  parts per `sign-parts`.

### 3.3 Size, type and integrity enforcement (R2 cannot do it for you)

Layered, because R2 has no presigned POST policy and its documented signed-header enforcement covers `Content-Type`
only ([R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)):

1. **Policy at `init`:** the declared `size` must be ≤ `maxFileSize`, and the declared `contentType` must be in
   `accept`. Reject before signing anything.
2. **Signed headers:**
   - Single PUT signs `content-length` (exact declared size) and `content-type`.
   - Each `UploadPart` URL signs its exact planned `content-length`.
   - Browsers cannot override `Content-Length` (a forbidden request header, [Fetch spec](https://fetch.spec.whatwg.org/#forbidden-request-header)),
     so an honest client always matches. A hostile client using curl can still try.
   - better-upload already does this ((src)). Whether R2 rejects a mismatched length is (unverified). The live-R2 CI
     lane must test it, and the result belongs in the sibling R2 doc.
3. **Server-verified completion (the real guarantee):**
   - Multipart: before `CompleteMultipartUpload`, call `ListParts` and check that the part count and each part's
     `Size` match the plan in the token. The sum must equal the declared size. Then complete with the server's own
     part list and ETags, not the client's.
   - Single PUT: `HEAD` the object and compare `Content-Length` and `Content-Type` with the token. On mismatch,
     `DELETE` and return `SIZE_MISMATCH`.
4. **Type by content, not by claim (opt-in `sniff`):** a ranged `GET` of the first 4 KiB at completion, checked against
   magic bytes. Client-side sniffing in the Worker is UX only.
5. **Quarantine option:** upload under a `pending/` prefix and promote after verification. Pair it with a bucket
   lifecycle rule that deletes `pending/` objects and aborts incomplete multipart uploads after N days. Whether that
   promotion costs a copy on R2 belongs to the sibling R2 doc.
6. **Integrity (opt-in, default off):**
   - Compute CRC32C or SHA-256 per part in the Worker and send it as `x-amz-checksum-*`, signed into the part URL.
   - Persist the checksums with the resume record.
   - Whether R2 honours this on presigned `UploadPart` is (unverified): gate the feature on the live-R2 test.
   - The AWS SDK's default CRC32 signing into presigned URLs is a known trap for browser PUTs (community report:
     [EVtivity PR #47](https://github.com/EVtivity/evtivity-csms/pull/47), unverified). The signer should sign exactly
     the headers the client will send.

### 3.4 Client API surface

```ts
const uploader = createUploader({
  endpoint: '/uploads',
  route: 'avatar',
  concurrency: 'auto',              // or a number
  retry: { attempts: 5, baseMs: 300, maxMs: 15_000 },  // exponential + full jitter, per request
  persist: indexedDBStore(),        // or localStorageStore(), opfsStaging(), memory (default)
  checksum: false,                  // 'crc32c' | 'sha256'
  worker: true,                     // offload hashing/sniffing/slicing
});
const handle = uploader.add(file, { meta });   // returns a handle: pause(), resume(), abort(), retry()
uploader.subscribe(() => render(uploader.getSnapshot())); // { files, totals: { bytes, total, speedBps, etaMs } }
await handle.done;                              // resolves with onComplete's return value
```

- **Progress model:** bytes from XHR `upload.onprogress`, aggregated across parts. Speed is an EWMA over about 3 s.
  ETA is remaining divided by the smoothed speed. Progress must never move backwards when a part is re-sent (pushduck
  fix #239).
- **Retry classifier:**
  - Retry: network errors, 408, 429, 5xx, S3 `SlowDown` / `RequestTimeout`.
  - Re-sign once: 403 on an expired URL.
  - Fail fast: other 4xx (pushduck fix #242).
  - Stall timeout: no progress for N seconds aborts and retries the part (pushduck fix #241; Uppy has stall detection).
  - Offline: pause on `offline`, resume on `online` (Uppy does this).
- **Validation on the client is advisory** (`accept`, `maxFileSize` mirrored from the route via `GET /uploads/config`
  or type inference). The server is the authority.
- **Typed routes without codegen:** export `type UploadRouter = typeof uploads`. `createUploader<UploadRouter>()`
  infers route names, `meta` input and `onComplete` output, like UploadThing and pushduck.

### 3.5 What to leave out (scope discipline)

- No UI components in the core packages. Offer a copy-paste recipe set (shadcn-style, as better-upload does) in docs.
- No remote sources (Google Drive and similar) and no image editing: that is Uppy plus Companion territory.
- No vendor storage service, no webhooks required, no database required.
- No CJS build, no TLA, no Node-only APIs in `core` or `server`.

### 3.6 Release checklist (first public version)

1. Live-R2 tests green for: equal-part enforcement, signed content-length mismatch behaviour, `ListParts`
   verification, abort, resume after reload with `indexedDB` and `opfs-staging`.
2. CI green against SeaweedFS and versitygw (plus S3Mock for fast unit-integration).
3. publint and attw (`esm-only`) on the packed tarballs. size-limit budgets enforced. A JSR dry run.
4. Changesets version PR. Publish from a GitHub-hosted runner via OIDC with provenance. Tokens disallowed on the npm
   package.
5. `LICENSE`, `SECURITY.md`, private vulnerability reporting, a threat-model page, and an `llms.txt`.

---

## Sources (index)

- Registry and GitHub metadata: `npm view <pkg>`, `https://api.npmjs.org/downloads/point/last-week/<pkg>`, `gh api repos/<owner>/<repo>`, Bundlephobia API — all on 2026-11-15.
- Uppy: https://uppy.io/docs/aws-s3/ · https://uppy.io/docs/golden-retriever/ · https://uppy.io/docs/react/ · tarball `@uppy/aws-s3@6.3.1`
- tus: https://tus.github.io/tusd/storage-backends/aws-s3/ · https://github.com/tus/tus-node-server/tree/main/packages/s3-store · https://github.com/tus/tusd/issues/1137 · tarball `tus-js-client@4.3.1`
- UploadThing: https://docs.uploadthing.com/uploading-files · https://docs.uploadthing.com/blog/v7-launch · https://github.com/pingdotgg/uploadthing/issues/28
- better-upload: https://better-upload.com/docs · https://better-upload.com/llms-full.txt · tarballs `@better-upload/server@3.0.20`, `@better-upload/client@3.0.20`
- pushduck: https://github.com/abhay-ramesh/pushduck · https://github.com/abhay-ramesh/pushduck/releases/tag/v0.7.0 · https://pushduck.org/docs · https://pushduck.org/docs/limitations · https://github.com/abhay-ramesh/pushduck/blob/main/docs/content/docs/guides/large-files.mdx · tarball `pushduck@0.7.0`
- next-s3-upload: https://github.com/ryanto/next-s3-upload · tarball `next-s3-upload@0.3.4`
- AWS lib-storage: https://github.com/aws/aws-sdk-js-v3/blob/main/lib/lib-storage/README.md · tarball `@aws-sdk/lib-storage@3.1169.0`
- aws4fetch: https://github.com/mhart/aws4fetch
- Bun S3: https://bun.com/docs/runtime/s3
- Vercel Blob: https://vercel.com/docs/vercel-blob/client-upload · tarball `@vercel/blob@2.9.0`
- FilePond: https://pqina.nl/filepond/docs/api/server/
- Unstorage: https://unstorage.unjs.io/drivers/s3 · FlyDrive: https://flydrive.dev/docs/introduction, https://flydrive.dev/docs/disk_api
- EvaporateJS: https://github.com/TTLabs/EvaporateJS · s3mini: https://github.com/good-lly/s3mini · Convex R2: https://github.com/get-convex/r2
- R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/ · content-length discussion: https://community.cloudflare.com/t/cloudflare-r2-presigned-url-limit-file-size/455122
- Fetch / browser: https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests · https://fetch.spec.whatwg.org/#forbidden-request-header · https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory
- Node: https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require · https://nodejs.org/api/packages.html#community-conditions-definitions · https://nodejs.org/en/about/previous-releases · https://runtime-keys.proposal.wintercg.org/
- Build: https://tsdown.dev/guide/ · https://tsdown.dev/options/dts · https://tsdown.dev/options/lint · https://tsdown.dev/options/package-exports · https://github.com/egoist/tsup · https://github.com/unjs/unbuild · https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- Publishing: https://docs.npmjs.com/trusted-publishers · https://jsr.io/docs/publishing-packages · https://github.com/changesets/action · https://github.com/googleapis/release-please · https://github.com/oven-sh/bun/issues/22423 · https://github.com/oven-sh/bun/issues/15601
- Size / tree-shaking: https://github.com/ai/size-limit · https://webpack.js.org/guides/tree-shaking/
- Testing: https://vitest.dev/guide/browser/ · https://github.com/minio/minio · https://github.com/localstack/localstack · SeaweedFS, versitygw, adobe/S3Mock, Garage GitHub repos
- Legal / security: https://opensource.guide/legal/ · https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository
