# files-sdk, RustFS and test backends, and R2 platform constraints

Research date: 2026-11-15. Primary sources only: official docs, GitHub repositories and source, the npm registry,
Docker Hub, changelogs and license files. Every claim cites its source. Claims marked **UNVERIFIED** were not
confirmed against a primary source and must be tested before the package relies on them. "Measured" means the
value came from a live API call made today (npm registry, GitHub API, Docker Hub API).

Context: the owner plans an MIT TypeScript package, a general-purpose, fast, feature-rich uploader for Cloudflare R2
(S3-compatible).

---

## A. files-sdk (https://files-sdk.dev/)

### A.1 Who maintains it: not Vercel

The claim that "Vercel is behind it" is **false** on every primary source checked.

| Fact | Value | Source |
|---|---|---|
| Repository | `haydenbleasel/files-sdk`, owned by a GitHub **User** account, not an organization | GitHub API `repos/haydenbleasel/files-sdk` (measured): `owner.type = "User"` |
| Author / npm maintainer | Hayden Bleasel, sole npm maintainer `haydenbleasel` | `npm view files-sdk author maintainers` (measured); https://www.npmjs.com/package/files-sdk |
| Author's employer | GitHub profile lists company `@OpenAI`. His site lists OpenAI as current employer and Vercel under "Previously" (Streamdown, AI Elements, Chat SDK). files-sdk appears under "Active projects", under the line "After hours I maintain open source software" | GitHub API `users/haydenbleasel` (measured); https://haydenbleasel.com/ |
| License | MIT, "Copyright (c) 2026 Hayden Bleasel" | https://github.com/haydenbleasel/files-sdk/blob/main/LICENSE; npm `license: MIT` |
| Contributors | haydenbleasel 545 commits; next human contributor 8 commits; the rest are bots and 1 to 3 commit contributors | GitHub API `contributors` (measured) |
| Where "Vercel" comes from | Vercel Blob is one of 49 adapters, and `vercel` is a repository topic. Nothing in the README, license or site names Vercel as sponsor or owner | README via GitHub API; https://files-sdk.dev/ |

The likely source of the confusion: the author is a former Vercel employee, and the package ships a Vercel Blob
adapter and Vercel AI SDK tools. **It is a personal side project, a single-maintainer bus factor.**

### A.2 Release history and activity (measured 2026-11-15)

| Metric | Value | Source |
|---|---|---|
| First publish | `0.0.0` on 2026-05-07; `1.0.0` on 2026-05-09 | `npm view files-sdk time` |
| Current version | `3.2.0`, published 2026-11-14 | same |
| Cadence | 37 versions in about 6 months. Three majors: 1.0 (May 9), 2.0 (Jun 21), 3.0 (Oct 9). Minors roughly every 1 to 2 weeks | same |
| Stars / forks | 1,609 / 55 | GitHub API `repos/haydenbleasel/files-sdk` |
| Issues | 0 open issues, 0 open PRs, 41 issues ever filed | GitHub search API |
| Downloads | 369,179 last week; 1,053,007 last 30 days | https://api.npmjs.org/downloads/point/last-week/files-sdk and `/last-month/` |
| Commits | about 673 on `main` | GitHub API commits pagination |
| Runtime | ESM only, `engines.node >= 22`, also Bun | `npm view files-sdk engines`; https://files-sdk.dev/ |
| Package size | 7.1 MB unpacked. Runtime deps: `mime`, `p-map`, `fflate`, `aws4fetch`, `commander`, `picomatch`, `safe-regex2`. About 50 optional peer deps (AWS SDK, Azure, GCS, React, Vue, Next, Hono and others) | `npm view files-sdk@3.2.0 dependencies peerDependencies dist.unpackedSize` |

### A.3 What it actually is

files-sdk is a **storage abstraction** (one `Files` class across 49 backends) with an upload gateway, framework server
handlers, UI clients and components, a CLI and MCP server, plugins and AI-tool wrappers
(https://files-sdk.dev/). It is not an upload engine. Its core surface is "`upload`, `download`, `head`, `exists`,
`delete`, `copy`, `move`, `list`/`listAll`, `search`, `url`, `signedUploadUrl`, `abortUpload`, plus `file(key)`"
(README, https://github.com/haydenbleasel/files-sdk).

- **Providers.** 49 adapters, Cloudflare R2 among them. Others include S3, MinIO, RustFS, GCS, Azure, Vercel Blob,
  Supabase, Dropbox, SFTP and fs (https://files-sdk.dev/docs/adapters).
- **Server handlers.** Next.js, Hono, Astro, Bun, Deno, Elysia, Express, Fastify, Koa, NestJS, Nitro, SvelteKit and
  TanStack Start (https://files-sdk.dev/docs/ui/server/gateway).
- **Clients.** React (`useFiles`, `useList`, `useFile`, `useSearch`), React Native, Vue and Svelte. UI components
  include a dropzone, a multipart uploader and upload progress (https://files-sdk.dev/docs/ui).

### A.4 R2 support in detail

Source: https://files-sdk.dev/docs/adapters/r2

```ts
import { Files } from "files-sdk";
import { r2 } from "files-sdk/r2";

const files = new Files({
  adapter: r2({ bucket: "uploads", accountId: process.env.R2_ACCOUNT_ID! }),
});
```

- **Three modes.**
  - HTTP with the `"aws-sdk"` client, which needs the optional peers `@aws-sdk/client-s3`, `s3-request-presigner`,
    `s3-presigned-post`, plus `lib-storage` for multipart and progress.
  - HTTP with `client: "fetch"`, an aws4fetch SigV4 engine of about 2.5 KB gzipped.
  - A Workers `R2Bucket` binding, or a hybrid of binding and HTTP credentials for signing.
- **Fetch engine limits.** The fetch engine is the default inside Workers, chosen silently because aws-sdk XML parsing
  needs `DOMParser`. On it, "`multipart` and resumable (`control`) uploads throw", and `ReadableStream` bodies "are
  buffered in memory, then sent as one PUT".
- **Bundle cost.** The AWS packages add "about 900 KiB (about 160 KiB gzipped)" to a Worker bundle if installed.
- **Signed uploads.** `signedUploadUrl()` on R2 returns a presigned **PUT**. R2 has no POST policy, so
  `maxSize`/`minSize` **throw `Unsupported`**: "enforce the limit in your app before issuing the URL". Content-Type is
  signed into the PUT URL for the S3 family (https://files-sdk.dev/docs/api/signed-upload-url).
- **Conditional writes.** These are "not advertised for R2", even though R2 supports `If-Match`/`If-None-Match` on
  PutObject and CompleteMultipartUpload (see C.6). This is a real gap.
- **Not addressed.** The docs never mention R2's equal-part-size rule (https://files-sdk.dev/docs/multipart only
  mentions the 5 MiB minimum) or flexible checksums.

### A.5 Upload features vs our needs

| Capability | files-sdk status | Source |
|---|---|---|
| Browser direct-to-bucket | Yes, for single-request uploads. A keyless `upload(file)` goes `via: "presign"` when the adapter can sign, otherwise `via: "proxy"` through the gateway | https://files-sdk.dev/docs/ui/server/upload-lifecycle |
| Browser **multipart** (presigned part URLs) | **No.** The `MultipartUploader` component is a multi-file queue. Without a prefix, each file goes up "in a single request … no multipart"; with a prefix, bytes stream through **your server**, which runs lib-storage multipart | https://files-sdk.dev/docs/ui/components/multipart-uploader |
| Server multipart | Yes, via `@aws-sdk/lib-storage`. Defaults: 5 MiB parts, concurrency 4. Auto-grows `partSize` to fit 10,000 parts when length is known. A failure retries the **whole** upload, never single parts, and never for streams | https://files-sdk.dev/docs/multipart |
| Resumable | Server, worker or CLI only: `UploadControl` with pause, resume and abort, plus a serializable token (the S3 `UploadId`) and `ListParts` on resume. **Not in the browser**: "An interrupted browser upload starts again from zero." Unsupported on the R2 Workers binding and the fetch engine | https://files-sdk.dev/docs/resumable |
| Progress | Yes: `onProgress` per call and ambient `files.progress` in React. Byte-level only on the aws-sdk path | https://files-sdk.dev/docs/ui/client/react; https://files-sdk.dev/docs/multipart |
| Checksums | Not exposed as a feature. There is an optional SHA-256 in receipts, a dedup plugin and `sync()` by size plus ETag. No `x-amz-checksum-*` support is documented | https://files-sdk.dev/ (feature list); R2 adapter page silent |
| React bindings | Yes (`files-sdk/react`) | https://files-sdk.dev/docs/ui/client/react |
| Size limit on presigned uploads | Enforced **after the fact**: a `head` at `complete`, then delete or quarantine | https://files-sdk.dev/docs/ui/server/upload-lifecycle |
| Completion hook | `onUploadComplete` with a stateless token (5 min default plus a 3600 s grace period), idempotent on `uploadId` | same |

React API shape (https://files-sdk.dev/docs/ui/client/react):

```tsx
const files = useFiles({ endpoint: "/api/files", headers: () => ({ authorization: token }) });
const { key } = await files.upload(file);
await files.upload(file, { onProgress: (p, perFile) => console.log(p.fraction, perFile[0]?.status) });
```

Server shape (https://files-sdk.dev/docs/ui/server/upload-lifecycle):

```ts
export const { GET, POST, PUT } = createRouteHandler(router);
// authorize hook returns e.g. { keyPrefix: `users/${user.id}/`, context: { userId: user.id } }
```

### A.6 Maturity and lock-in risk

- **Maturity.** Six months old, three majors in five months (breaking changes about every 2 to 3 months), one
  maintainer. High download numbers but low engagement: 41 issues ever, 0 open.
  - **UNVERIFIED** whether downloads are organic or driven by a dependent package; the npm API gives no
    breakdown.
- **Lock-in.** Moderate as an application dependency, because the `Files` class, the gateway contract, the token
  format and the plugin system are all proprietary shapes. Low as a reference, since the code is MIT.
- **Overlap with our package.** files-sdk's breadth (49 providers) is the opposite of our goal, which is depth on R2.
  Its weakest areas are exactly our core:
  - browser multipart with presigned parts
  - browser resumability
  - per-part retries
  - R2 equal-part enforcement
  - checksums
  - R2 conditional writes
  - Worker-native multipart

### A.7 Verdict: inspiration, not a dependency

**Use as inspiration; do not depend on it.** Ideas worth borrowing:

- the capability object (`files.capabilities.signedUpload.maxSize` etc.), so callers can branch before an
  `Unsupported` throw
- the `complete` step that verifies the landed object with `head` and enforces size after a presigned PUT, which is the
  only option on R2 since there is no POST policy
- the serializable `UploadControl` token
- the silent `client: "fetch"` default in Workers, which avoids bundling the AWS SDK

A possible later integration: ship a files-sdk-compatible adapter or plugin, so its users can drop our engine in.

---

## B. RustFS and the test-backend matrix

### B.1 RustFS facts

| Fact | Value | Source |
|---|---|---|
| What | "Open-source, S3-compatible high-performance object storage system" written in Rust; positioned as a MinIO alternative, with distributed and single-node modes | https://github.com/rustfs/rustfs (description, README) |
| License | **Apache-2.0** (verified in the LICENSE file and the GitHub license API) | https://github.com/rustfs/rustfs/blob/main/LICENSE |
| Owner | GitHub organization `rustfs`, founded 2024 per site metadata. No legal entity or location is stated. "Not affiliated with … MinIO, Inc." | GitHub API; https://rustfs.com/ |
| Maturity | 1.0.0 GA on 2026-09-16 (after a long alpha/beta/rc series); latest **1.0.5** on 2026-11-10. 36.1k stars, 65 open issues (measured) | https://github.com/rustfs/rustfs/releases |
| Docker | `rustfs/rustfs:1.0.5` (also `-glibc` variants), pushed 2026-11-10. Ports 9000 (S3) and 9001 (console). Runs as UID/GID 10001, so bind mounts must be writable by that user | Docker Hub API (measured); README "Docker Quick Start" |
| Quick start | `docker run -d -p 9000:9000 -p 9001:9001 -v $(pwd)/data:/data -v $(pwd)/logs:/logs rustfs/rustfs:1.0.5` | README |

S3 coverage relevant to an uploader. Sources: the RustFS compatibility matrix
https://github.com/rustfs/rustfs/blob/main/docs/architecture/s3-compatibility-matrix.md and the ceph s3-tests lists
`scripts/s3-tests/implemented_tests.txt` / `unimplemented_tests.txt`.

- **Multipart.** Create, upload, complete and abort are supported. Unimplemented tests:
  `test_multipart_reupload_checksum_and_etag` and `test_multipart_upload_complete_without_create`. ListParts edge cases
  are excluded from the gate.
- **Presigned URLs.** GET and PUT are supported.
- **POST Object.** 28 implemented tests. "POST Object form upload checksum handling: Not yet passing."
- **CORS.** 10 CORS s3-tests are implemented.
- **Checksums.**
  - CopyObject: CRC32, CRC32C, CRC64NVME, SHA1, SHA256, MD5 and others.
  - Implemented tests: `test_object_checksum_sha256`, `_crc64nvme`, `test_multipart_checksum_sha256`.
  - Unimplemented test: `test_get_checksum_object_attributes`.
- **Conditional writes.** If-Match and If-None-Match on PutObject and multipart are implemented
  (`test_put_current_object_if_none_match`, `test_multipart_put_object_if_match`).
- **Not R2-faithful.** **UNVERIFIED** whether RustFS enforces equal part sizes. AWS S3 does not require them, and
  RustFS mirrors S3 and MinIO semantics, so assume it accepts uneven parts that R2 would reject.

**Relevance:** RustFS is a server. It is useful as a fast, permissively licensed, S3-faithful CI backend, but it
**cannot prove R2 behavior**. It also supports features R2 lacks (POST policy, tagging, ACLs), so tests that pass
there can fail on R2.

### B.2 Alternatives: current status

| Backend | License | Status (2026-11-15) | Uploader-relevant notes | Sources |
|---|---|---|---|---|
| **MinIO (community)** | AGPL-3.0 | **Archived on GitHub, unmaintained** (see the timeline below this table). `minio/minio` on Docker Hub returns **404** (measured) | Do not adopt for a new OSS project | https://github.com/minio/minio (README, commit history); Docker Hub API |
| **SILO (pgsty fork of MinIO)** | AGPL-3.0 | Active community fork; release `RELEASE.2026-11-12…`; image `pgsty/minio` (last tag 2026-08-04) | Drop-in for MinIO-based tests if needed; third-party fork, bus-factor risk | https://github.com/pgsty/silo; Docker Hub API |
| **SeaweedFS** | Apache-2.0 | Active, 4.53 (2026-11-08); image `chrislusf/seaweedfs` | Multipart (all 7 ops), presigned, PostObject, CORS and conditional headers are all supported. Checksum and AbortIncompleteMultipartUpload support is **not documented** | https://github.com/seaweedfs/seaweedfs; https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API |
| **Garage** | **AGPL-3.0** | Active, v2.5.0 (2026-10-24); image `dxflrs/garage` | Multipart, presigned, PostObject and CORS are implemented. Lifecycle is partial (AbortIncompleteMultipartUpload and Expiration only). No versioning. Checksums and conditional writes are **not documented** on the compatibility page | https://git.deuxfleurs.fr/Deuxfleurs/garage; https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/ |
| **LocalStack** | Repository archived | The open-source repository was archived in March 2026 and consolidated into one image. **Since 2026.03.0 an auth token is required to start it, including free Hobby (non-commercial only)**; CI needs a CI auth token | Unsuitable for an OSS project's public CI (token secret, commercial terms) | https://github.com/localstack/localstack (README); https://blog.localstack.cloud/localstack-single-image-next-steps/; https://docs.localstack.cloud/aws/integrations/continuous-integration/ |
| **Adobe S3Mock** | Apache-2.0 | Active, 5.2.3 (2026-09-19); image `adobe/s3mock` | Lightweight Java mock; secondary option | https://github.com/adobe/S3Mock |
| **Wrangler / Miniflare local R2** | Apache-2.0 (workers-sdk) | **Experimental local S3 endpoint** since Wrangler **4.115.0** (opt-in per binding) | See B.3. The only backend that enforces **R2's equal-part rule** | https://developers.cloudflare.com/r2/local-development/ |

MinIO timeline (from https://github.com/minio/minio, its README commit history, and release notes):

- May 2025: release notes say the "Embedded UI Console is now deprecated and moved to object-browser"
  (https://github.com/minio/minio/releases/tag/RELEASE.2025-05-24T17-08-30Z).
- 2025-10-15: "source only releases". The last binary release was RELEASE.2025-10-15T17-29-55Z.
- 2025-12-03: the README is changed to "maintenance mode".
- 2026-01-06: the README points to AIStor Free / Enterprise.
- 2026-02-12: the README says "THIS REPOSITORY IS NO LONGER MAINTAINED".
- Last push to the repository: 2026-04-24; it is now archived.

### B.3 Cloudflare local R2 S3 endpoint (Wrangler / Miniflare)

Source: https://developers.cloudflare.com/r2/local-development/ (updated 2026-11-12) and the Miniflare source,
https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare/src/workers/r2.

- **Setup and status.**
  - Opt-in: add `local_dev.experimental_s3_credentials: { accessKeyId, secretAccessKey }` to the R2 binding.
  - The endpoint is `http://localhost:8787/cdn-cgi/local/r2/s3`; use `region: "auto"` and path-style addressing.
  - The docs mark it "experimental and may change".
- **Supported operations.**
  - SigV4 through either the header or presigned query, with expiry capped at 604,800 s (`MAX_EXPIRES_SECONDS` in
    `s3/auth.worker.ts`).
  - Operations: ListObjects(V2), Get/Head/Put/Copy/DeleteObject, DeleteObjects, CreateMultipartUpload, UploadPart,
    UploadPartCopy, CompleteMultipartUpload and AbortMultipartUpload.
  - "Cross-origin requests are always allowed", so it **cannot test CORS**.
- **Validates R2-specific rules** (`bucket.worker.ts`, around lines 500–525): every non-last part must be ≥ 5 MiB,
  "all but the last parts are the same size", and "the last part is not greater than all others".
- **Documented gaps** (header of `s3/index.worker.ts`):
  - "real R2 validates, stores, and echoes `x-amz-checksum-*` request headers (returning BadDigest on mismatch); the
    local binding … silently ignore[s]" them. Only Content-MD5 is verified.
  - "The aws-chunked content encoding … is not decoded either; clients must send plain bodies."
  - **ListParts, ListMultipartUploads** and `?cors`/`?lifecycle` configuration return NotImplemented. That breaks a
    resume-by-ListParts flow when testing locally.

### B.4 Recommended test-backend matrix

| Lane | Backend | What it proves | Runs in |
|---|---|---|---|
| Unit | In-process fake (pure TS) implementing the R2 rule set: equal parts, 5 MiB min, 10,000 parts, no POST, 4.995 GiB PUT cap, 7-day abort | Planner logic: part sizing, retry and resume state machine, error mapping | Every commit |
| Integration A (R2 rules) | **Wrangler local R2 S3 endpoint** (pinned Wrangler ≥ 4.115.0) | Equal-part enforcement, presigned SigV4 PUT/GET, multipart happy path, Content-MD5, Worker-binding code paths | Every PR |
| Integration B (S3 protocol depth) | **RustFS 1.0.x** (Apache-2.0, pinned tag) | ListParts-based resume, `x-amz-checksum-*` (CRC32/CRC32C/SHA256/CRC64NVME), conditional writes, real CORS preflight from a headless browser | Every PR |
| Integration C (optional) | SeaweedFS (Apache-2.0) | A second S3 implementation, to catch accidental reliance on RustFS quirks | Nightly |
| Contract | **Real R2 bucket** (dedicated test account; EU jurisdiction bucket too) | Ground truth: checksum types (CRC64NVME FULL_OBJECT, others COMPOSITE), presigned + CORS + ETag exposure, 412 semantics, 429 on the same key, jurisdiction endpoint, AWS SDK default-checksum interop | Nightly and pre-release; secrets only on the main repository, never on fork PRs |

Avoid MinIO (archived, no images), LocalStack (token and commercial terms), and Garage as primary (AGPL, sparse
checksum documentation). AGPL is fine for a test container, but RustFS covers the same ground under Apache-2.0.

---

## C. Cloudflare R2 platform facts that constrain an uploader

All from developers.cloudflare.com; page "last updated" dates are noted where shown.

### C.1 Size limits

Source: https://developers.cloudflare.com/r2/platform/limits/ (2026-10-30) and
https://developers.cloudflare.com/r2/objects/upload-objects/ (2026-07-29).

| Limit | Value |
|---|---|
| Single PUT max | 5 GiB, footnoted "5 MiB less than 5 GiB, so 4.995 GiB" |
| Max object (multipart) | "4.995 TiB" (5 TiB minus 5 GiB) |
| Part size | 5 MiB min (except the last), 5 GiB max per part (also capped at 4.995 GiB by the upload limit) |
| Max parts | 10,000 |
| **Equal parts** | "**All parts except the last must be the same size**" (upload-objects page). Error `10048 InvalidPart`: "All non-trailing parts must have the same size" (https://developers.cloudflare.com/r2/api/error-codes/, 2026-11-10). Enforced **at CompleteMultipartUpload**, not per part (release notes 2022-10-28, https://developers.cloudflare.com/r2/platform/release-notes/). The Miniflare source also rejects a last part **larger** than the others |
| Key length / metadata | 1,024 bytes / 8,192 bytes |
| Units | Base-2 (GiB) |

Design consequences:

- **Part size must be fixed before the first part is sent**, and it can never change.
  - S3's "grow parts as you go" trick for unknown-length streams is illegal on R2.
  - Max object size is `10,000 × partSize`. With 5 MiB parts that is only about 48.8 GiB. Reaching 4.995 TiB needs
    parts of about 524 MiB.
  - For unknown-length streams, the caller must give a size hint or accept a ceiling.
- **Uploads above 4.995 GiB must use multipart.**

### C.2 Multipart lifecycle and ETags

- **Auto-abort.**
  - "Incomplete multipart uploads are automatically aborted after 7 days by default."
  - This is configurable through lifecycle rules: "Buckets have a default lifecycle rule to expire multipart uploads
    seven days after initiation".
  - The lifecycle API supports `AbortIncompleteMultipartUpload`, with a maximum of 1,000 rules.
  - Sources: https://developers.cloudflare.com/r2/objects/upload-objects/;
    https://developers.cloudflare.com/r2/buckets/object-lifecycles/ (2026-10-26).
- **ETags.** A part's ETag is the MD5 of the part. A multipart object's ETag is "the hash of the concatenated binary
  MD5 sums of all parts, followed by a hyphen and the number of parts" (upload-objects page).
- **Part re-upload.** "Uploading to the same part number replaces the previous part"; if the re-upload fails, the
  earlier part is gone (https://developers.cloudflare.com/r2/api/s3/api/, 2026-11-10).
- **Part order.** Parts are auto-sorted at Complete (release notes 2024-01-26).

### C.3 Presigned URLs

Source: https://developers.cloudflare.com/r2/api/s3/presigned-urls/ (2026-11-12).

- **Methods.** GET, HEAD, PUT and DELETE. "**`POST` (multipart form uploads via HTML forms) is not currently
  supported.**" So there is no POST policy and no `content-length-range`. S3 PostObject does not appear in the
  compatibility table (https://developers.cloudflare.com/r2/api/s3/api/).
- **Expiry.** "1 second to 7 days (604,800 seconds)".
- **Content-Type** can be signed; a mismatch gives `403 SignatureDoesNotMatch`. With aws4fetch, use
  `allHeaders: true`.
- **Content-Length.** Not documented. **UNVERIFIED** whether signing a `content-length` header into a presigned PUT
  is enforced by R2; this needs a contract test. Until proven, size must be enforced server-side: issue URLs only
  after validating the declared size, then `HeadObject` at completion and delete oversize objects.
- **Endpoints.** Presigned URLs "cannot be used with custom domains"; they work only on the S3 endpoint
  `<account>.r2.cloudflarestorage.com` or its jurisdiction variants. The custom-domain alternative is WAF HMAC token
  auth (Pro plan or above).
- **Workers binding.** It "cannot generate presigned URLs"; use aws4fetch or the AWS SDK with credentials.
- **Reuse.** "The same presigned URL can be reused multiple times until it expires", so it is a bearer token.
- **Multipart parts.** Presigned UploadPart URLs follow from "PUT is supported", since UploadPart is a PUT with
  `partNumber`/`uploadId` query parameters. This is not explicitly documented by Cloudflare: **UNVERIFIED, contract
  test**.

### C.4 Checksums

Source: https://developers.cloudflare.com/r2/api/s3/api/ "Checksum Types" table.

| Algorithm | FULL_OBJECT | COMPOSITE |
|---|---|---|
| CRC64NVME | yes | no |
| CRC32 | no | yes |
| CRC32C | no | yes |
| SHA1 | no | yes |
| SHA256 | no | yes |

- **CRC64NVME** support for single and multipart objects, plus the FULL_OBJECT type on multipart, shipped 2025-07-03
  (https://developers.cloudflare.com/r2/platform/release-notes/).
- **MD5.** `Content-MD5` is supported on PutObject, CreateMultipartUpload and UploadPart (compatibility table).
- **SHA1/SHA256 on S3 putObject** since 2023-06-16 (release notes).
- **Real R2 validates and stores checksum headers.** The Miniflare source states that "real R2 validates, stores, and
  echoes x-amz-checksum-* request headers (returning BadDigest on mismatch)", captured from a real bucket on
  2026-06-11 (https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/workers/r2/s3/index.worker.ts).
  The error codes page lists `BadDigest` 10037 and `InvalidDigest` 10014.
- **Not supported:** `x-amz-checksum-algorithm` on CopyObject.
- **Workers binding.** `put()` accepts **one of** md5, sha1, sha256, sha384, sha512 ("Only a single hashing algorithm
  can be specified at once"). MD5 is stored by default for non-multipart objects. **There are no CRC options on the
  binding** (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/, 2026-11-04).

Consequences for us:

- Use **CRC32/CRC32C per part (COMPOSITE)** or **CRC64NVME (FULL_OBJECT)** for multipart.
- Use **SHA-256 or MD5** when the Worker binding is the write path.
- **UNVERIFIED** whether R2 accepts the aws-chunked trailing-checksum encoding (`STREAMING-UNSIGNED-PAYLOAD-TRAILER`).
  Cloudflare documents that the Java v2 SDK's chunked encoding causes 403, and that .NET needs
  `DisablePayloadSigning` because "R2 does not currently support the Streaming SigV4 implementation"
  (https://developers.cloudflare.com/r2/examples/aws/aws-sdk-java/, `/aws-sdk-net/`). Send plain bodies with
  checksum headers.

### C.5 AWS SDK v3 default-checksum change (January 2025)

- **The change.** `@aws-sdk/client-s3` **v3.729.0** made the S3 client compute a checksum on all uploads by default
  (default algorithm CRC32 for JS) and validate GET responses. The settings are `requestChecksumCalculation` and
  `responseChecksumValidation` (`WHEN_SUPPORTED` default, or `WHEN_REQUIRED`); the environment variables are
  `AWS_REQUEST_CHECKSUM_CALCULATION` and `AWS_RESPONSE_CHECKSUM_VALIDATION`. AWS states it "may introduce and enable
  new features by default … prior to them being supported … by third-party service implementations"
  (https://github.com/aws/aws-sdk-js-v3/issues/6810; https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html).
- **R2 history.**
  - 2025-01-17: Cloudflare docs said v3.729.0 was "currently incompatible with R2 APIs" and recommended pinning
    3.726.1 or setting both options to `"WHEN_REQUIRED"`.
  - 2025-07-07: that note was **removed** from the JS v3 page in the commit "R2-3134: Document CRC64NVME Support for
    Multipart Uploads", which implies the defaults now work.
  - Sources: cloudflare-docs commits `a4ba22d949`, `0f851d73dc`, `7a54d0e862` on
    `src/content/docs/r2/examples/aws/aws-sdk-js-v3.mdx`; the current page
    https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/ (2026-10-26) has no compatibility note.
- **Remaining risk for us.**
  - (a) **UNVERIFIED:** presigned PUT URLs generated by the default-config client may embed
    `x-amz-sdk-checksum-algorithm`/`x-amz-checksum-*` query parameters that a browser body will not match. Generate
    presigned URLs with `WHEN_REQUIRED` or with aws4fetch, and contract-test.
  - (b) Streaming bodies trigger aws-chunked trailers (see C.4).
  - (c) `@aws-sdk/lib-storage` currently drops `ChecksumCRC64NVME` from CompleteMultipartUpload parts. The issue is
    open and was filed 2026-11-07: https://github.com/aws/aws-sdk-js-v3/issues/8411.
  - Recommendation: do not depend on lib-storage for R2 multipart. Own the multipart state machine and set checksum
    headers explicitly.

### C.6 Conditional writes

Source: https://developers.cloudflare.com/r2/api/s3/conditional-operations/.

- **Supported headers.** `If-Match`, `If-None-Match`, `If-Modified-Since` and `If-Unmodified-Since` on **PutObject**,
  **CreateMultipartUpload** and **CompleteMultipartUpload**. CopyObject uses `cf-copy-destination-if-*` instead.
- **Atomicity.** Conditions are evaluated "atomically against the committed bucket state"; concurrent
  `If-None-Match: *` gives one winner, and the others get `412 PreconditionFailed`.
- **Multipart create-only.** "To create a multipart object only if its key does not exist, send `If-None-Match: *` on
  `CompleteMultipartUpload`." Conditions on CreateMultipartUpload "are not retained … and are not re-evaluated at
  completion" (an R2 extension; AWS does not support them on Create).
- **Failure aborts the upload.** On a conditional Complete failure, "the upload is no longer available and is treated
  as aborted" (release notes 2023-08-11). Parts are lost, so check early with a Create-time condition as well.
- **UploadPartCopy** source conditionals are not supported (compatibility table).

### C.7 CORS

Source: https://developers.cloudflare.com/r2/buckets/cors/ (2026-09-23).

- **Presigned uploads need a bucket CORS policy.** `AllowedMethods` must match (GET, PUT, HEAD, DELETE).
  `AllowedHeaders` must include every header the client sends, "such as headers for content type, checksums, caching,
  or custom metadata".
- **Multipart in the browser.** Expose `ETag` via `ExposeHeaders` so JavaScript can read part ETags. Optional
  `MaxAgeSeconds`; browsers cap it at about 2 hours.
- **Gotchas.**
  - "Expired presigned URLs return a `403 ExpiredRequest` … R2 does not include CORS response headers on expired
    presigned URL responses, so browser JavaScript cannot read the error body." The client must treat an opaque
    network error on PUT as "maybe expired", then refresh the URL and retry.
  - Rule propagation "can, in rare cases, take up to 30 seconds".
  - Origins allow at most one `*` wildcard and no port wildcards.
  - Custom-domain caches need a purge after CORS changes.
- **Uploads go to the S3 endpoint**, since presigned URLs do not work on custom domains. The CORS policy therefore
  applies on `<account>.r2.cloudflarestorage.com`.

### C.8 Workers R2 binding API

Source: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/.

- **Multipart.** `createMultipartUpload(key, options)` and `resumeMultipartUpload(key, uploadId)`; the latter
  performs no validity check. `R2MultipartUpload.uploadPart(partNumber, value)` ("Each part must be uniform in size"),
  `.abort()` and `.complete(parts)`. "Uncompleted multipart uploads will be automatically aborted after 7 days."
- **No ListParts in the binding.** The client must track part ETags (upload-objects page: "the multipart state … is
  tracked by the client").
- **Streams.** `put()` and `uploadPart()` need a **known-length** stream (Content-Length or `FixedLengthStream`),
  otherwise a `TypeError`.
- **Conditionals and checksums.** `onlyIf` conditionals, `httpMetadata`, `customMetadata`, `storageClass` and
  `ssecKey`. Checksums are md5/sha1/sha256/sha384/sha512, one at a time.
- **Request body limits** for a Worker on your domain depend on the **zone plan**: Free 100 MB, Pro 100 MB, Business
  200 MB, Enterprise up to 5 GB. Over the limit returns 413. Worker memory is 128 MB
  (https://developers.cloudflare.com/workers/platform/limits/, 2026-11-13).
- **Consequence:** a Worker-proxied upload path must use parts below 100 MB on Free/Pro zones, and must stream rather
  than buffer within 128 MB.

### C.9 Endpoints: S3 API vs custom domain vs r2.dev; jurisdictions

- **S3 API.** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; region `auto` (https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/).
- **Jurisdictions.** `https://<ACCOUNT_ID>.<JURISDICTION>.r2.cloudflarestorage.com` with jurisdictions `eu`,
  `fedramp` (Enterprise, on request) and `us`. A jurisdiction endpoint cannot reach buckets outside that jurisdiction.
  Workers bindings need a `jurisdiction` field (https://developers.cloudflare.com/r2/reference/data-location/,
  2026-08-19).
- **Custom domains.** Public read with cache, WAF and Access, but no presigned URLs. The zone must be in the same
  account. 100 custom domains per bucket.
- **r2.dev.** "Not intended for production", rate-limited with variable 429s, and lacks WAF and cache
  (https://developers.cloudflare.com/r2/buckets/public-buckets/; limits page).
- **Local public endpoint** for development: `/cdn-cgi/local/r2/public/<BUCKET>/<KEY>`, Wrangler ≥ 4.100.0
  (local-development page).

### C.10 Event notifications

Source: https://developers.cloudflare.com/r2/buckets/event-notifications/.

- **Events.** `object-create` (PutObject, CopyObject, CompleteMultipartUpload) and `object-delete` (DeleteObject,
  LifecycleDeletion), delivered to a Cloudflare Queue (consumer Worker or HTTP pull). There is no event for upload
  initiation, part upload or abort.
- **Rules.** Up to 100 per bucket, with prefix and suffix filters; overlapping rules are rejected. Queue throughput is
  5,000 msg/s per queue.
- **Use for us:** server-side "upload finished" confirmation that does not depend on the browser calling `complete`.

### C.11 Rate limits and consistency

- **Same key:** "1 per second" concurrent writes. Exceeding it gives `429` (`10058 TooManyRequests`, "Often caused
  by multiple concurrent requests to the same object key").
  - **UNVERIFIED** whether parallel UploadPart calls on one key count against this limit. Cloudflare's own example
  uploads parts in parallel, and release notes 2022-10-28 fixed "concurrent multipart part uploads would get
  rejected", which suggests they do not. Contract-test this.
- **Bucket management:** 50/s per bucket. **REST API:** 1,200 per 5 minutes per account. **r2.dev:** variable
  (limits page).
- **Retryable errors:** `InternalError` 500, `ServiceUnavailable` 503 ("Retry with exponential backoff"),
  `TooManyRequests` 429, `ClientDisconnect` (error codes page).
- **Consistency:** strong, global read-after-write, including listing
  (https://developers.cloudflare.com/r2/reference/consistency/).

### C.12 Pricing classes and part-size choice

Source: https://developers.cloudflare.com/r2/pricing/ (2026-10-30).

- **Standard storage:** $0.015/GB-month. Class A $4.50 per million, Class B $0.36 per million. Infrequent Access
  costs $9.00 / $0.90, with retrieval at $0.01/GB. Egress is free. The free tier is 1M Class A and 10M Class B per
  month (Standard only).
- **Class A (billed):** `PutObject`, `CreateMultipartUpload`, `UploadPart`, `UploadPartCopy`,
  `CompleteMultipartUpload`, **`ListParts`**, `ListMultipartUploads` and `ListObjects`.
- **Class B:** `HeadObject`, `GetObject`.
- **Free:** `DeleteObject`, **`AbortMultipartUpload`**.

Worked numbers (our arithmetic from those prices):

- **Per-upload cost.** A 1 GiB multipart upload costs `parts + 2` Class A operations.
  - At 8 MiB parts: 128 + 2 = 130 ops, about $0.000585.
  - At 64 MiB parts: 16 + 2 = 18 ops, about $0.000081.
  - At 100k uploads per month that is $58.50 vs $8.10.
- **Part-size choice.** Larger parts cut cost but raise retry cost and memory (`partSize × concurrency`). The equal-part
  rule means the size is locked at start.
  - Suggested default: the smallest size that keeps parts ≤ 10,000 and ≥ 5 MiB.
  - For browsers, 8–16 MiB.
  - For server streams, a size derived from a size hint.
  - Below a threshold (for example 100 MiB), use a single PUT: one Class A op.
- **Resume cost.** Resume via `ListParts` costs a Class A op per page, so client-side ETag persistence is cheaper than
  listing. Abort is free, so always abort on failure.

---

## Open items to verify with a real-R2 contract test

1. Signed `content-length` on a presigned PUT: is it enforced?
2. Presigned UploadPart URLs from a browser, with `ExposeHeaders: ["ETag"]`.
3. Presigned PUT generated by `@aws-sdk/s3-request-presigner` with default `WHEN_SUPPORTED` checksums, uploaded from a
   browser.
4. aws-chunked / `STREAMING-UNSIGNED-PAYLOAD-TRAILER` acceptance.
5. Parallel UploadPart on one key vs the 1 write/s/key limit.
6. Whether a last part larger than the others is rejected on real R2. Miniflare rejects it; the R2 docs only say
   "same size".
7. Whether RustFS and SeaweedFS accept uneven part sizes, which confirms they cannot stand in for the R2 rule.
