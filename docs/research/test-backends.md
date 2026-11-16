# Test backends

How each backend behaves under the storage contract (`packages/cloudrop/src/testing/storage-contract.ts`), and where
it differs from the in-process fake R2. When a backend disagrees with the fake, the measured behaviour wins and the fake
is changed to match. One section per backend: behaviour, evidence, date.

## Real R2 (live lane)

Lanes: `packages/cloudrop/src/storage/s3-driver.r2.integration.test.ts` (the storage contract) and
`packages/cloudrop/src/server/handler.r2.integration.test.ts` (the upload protocol through `cloudrop.handler`), both run
by `bun run test:live`. Driver: the public `r2()` preset, configured from the environment. Bucket: the owner's R2 test
bucket, each lane file under its own `live-test/cloudrop-<hex>/`.

**Date:** 2026-11-15, two runs (about 30 MiB uploaded and 15 s each), then a third run after the copy guard was added
(16 s).

**Result:** all 24 contract cases pass, none skipped (22 in the first two runs; the third added the two copy-guard
cases). R2 declares no gap.

| Behaviour | Evidence (contract case) |
|---|---|
| A header-signed `PUT` with `x-amz-content-sha256: UNSIGNED-PAYLOAD` is accepted, so `put()` can stream a Blob unread | "streams a Blob body through put" |
| `UploadPartCopy` with `x-amz-copy-source-range` copies byte ranges, and the copy keeps the source's type and metadata | "copies a larger object in ranged parts with its type and metadata" (single-PUT limit lowered to one part) |
| CreateMultipartUpload signed with the canonical query `uploads=` is accepted | every multipart case |
| Real upload IDs pass the driver's upload-ID validation, and real continuation tokens pass its cursor validation | multipart cases (each part URL is presigned with the returned ID); "lists by prefix in pages…" (page 2) |
| An expired presigned URL answers `403 ExpiredRequest`, nothing stored | "rejects an expired presigned URL" |
| `HEAD` with `x-amz-checksum-mode: ENABLED` returns the server-computed CRC64NVME (`rosUhgp5mIg=` for `123456789`) | "reports the CRC64NVME the storage computed" |
| A list prefix with a space, `+` and `%` lists exactly the matching key | "handles keys and prefixes with spaces, plus signs, percent signs and Unicode" |
| **An `x-amz-meta-*` header the presigned PUT did not sign: `403 SignatureDoesNotMatch`, nothing stored** | "answers a presigned PUT carrying an unsigned metadata header…" |
| `x-amz-copy-source-if-match` with HEAD's quoted ETag is honoured on `CopyObject` and on `UploadPartCopy`: a matching ETag copies, and a source overwritten after HEAD answers `412`, which the driver reports as a retryable `STORAGE_ERROR` (third run) | "fails a single copy cleanly…", "fails a copy in ranged parts cleanly…"; the two ordinary copy cases send the same header and pass |

The unsigned-metadata row is the only difference from the fake found so far (below). Teardown deleted everything: a separate
read-only listing of `live-test/` after the first two runs returned 0 objects and 0 multipart uploads.

**M2 run, 2026-11-16** (about 17 s): 31 cases in two files, all pass, none skipped: 26 contract cases (the two
presigned-GET cases are new) and 5 server cases (three upload-protocol, two file-API). A read-only listing afterwards found 0 objects and 0 open
multipart uploads under `live-test/`.

| Behaviour | Evidence |
|---|---|
| A presigned GET carrying `response-content-disposition` serves the object with exactly that `Content-Disposition` | "serves a presigned GET with the download name signed into it"; the server lane's single-upload case |
| A presigned PUT signed by `/upload` with `content-type`, `content-disposition`, `if-none-match: *` and `x-amz-meta-cloudrop-id`, sent with exactly those headers, stores the type, the disposition (`filename*` for a Polish name) and `cloudrop-id` | server lane, "uploads a single file…" |
| `/complete` answers `PARTS_MISSING` with the absent part, `/sign` renews it, and a completion retried after R2 forgot the upload succeeds by HEAD | server lane, "resumes a multipart upload…" |
| `/abort` aborts a multipart upload: ListParts then answers `NoSuchUpload` | server lane, "aborts a multipart upload on R2" |
| An Object Read & Write token is denied `GetBucketLifecycleConfiguration` as it is `GetBucketCors`, so `checkBucket()` reports both as `unknown` | server lane, "reports bucket settings an object token may not read as unknown" |

Not measured on R2: the answers to those two reads for a token that may read them, both for a configured bucket and
for one without a configuration. `checkBucket()` follows S3's documented `NoSuchCORSConfiguration` and
`NoSuchLifecycleConfiguration` codes there.

The upload protocol runs only here and on the fake. RustFS and Wrangler run the storage contract; their server lanes
are deferred to M3.

## RustFS (container lane)

Lane: `packages/cloudrop/src/storage/s3-driver.rustfs.integration.test.ts`, run by `bun run test:rustfs`, which
calls `scripts/test-rustfs.sh` (`rustfs/rustfs:1.0.5`, one container per run named `cloudrop-test-rustfs-<pid>`, label
`cloudrop.test`, removed by a `trap`). Driver: `createS3Driver` with `S3_RULES`, region `us-east-1`, path-style bucket `contract`.

**Date:** 2026-11-15, re-run 2026-11-16. **Result:** 23 of 26 contract cases pass, 3 skip on declared gaps (21 of 24
before the two presigned-GET cases, 19 of 22 before the copy-guard cases). The suite takes about 1 s. A presigned GET
with `response-content-disposition` is honoured as on R2.

| Behaviour | Measured answer |
|---|---|
| Expired presigned URL | `403 AccessDenied` ("Request has expired"), nothing stored. R2 says `ExpiredRequest` (lane field `expiredUrlCode`) |
| Unsigned `x-amz-meta-*` on a presigned PUT | `403 AccessDenied` ("There were headers present in the request which were not signed"), nothing stored. R2 says `SignatureDoesNotMatch` (`unsignedMetaCode`) |
| HEAD with `x-amz-checksum-mode: ENABLED` | Only `ETag`; no CRC64NVME. Gap `crc64nvme` |
| Last part larger than the first | Completion succeeds and the object is `size + 4` bytes: no equal-part rule. Gap `unequalParts` |
| ListParts | Returns number, size and ETag per part, and `NoSuchUpload` after an abort; no `ChecksumCRC32C` element even for a part uploaded with one. Gap `listPartChecksums` |
| CRC32C on a part | A mismatching value answers `400 BadDigest`; a matching one is stored. No gap |
| `If-None-Match: *` on completion, key exists | `412 PreconditionFailed`, the existing object survives. The upload is **kept** (ListParts still lists the part) and a second completion without the condition overwrites the key |
| Completing a finished upload again | Succeeds. Gap `finishedUploadsLinger` (R2 answers `NoSuchUpload`) |
| `If-None-Match: *` on a presigned PUT | `412 PreconditionFailed` as R2. No gap |
| `x-amz-copy-source-if-match` on `CopyObject` and `UploadPartCopy` | Honoured as R2: a changed source answers `412`. No gap |

The contract's `NoSuchUpload` expectations after completion are R2 behaviour; AWS-style backends keep the ID, which is
why they are a declared gap, not a driver bug: the driver maps whatever the backend answers.

## Wrangler local R2 (Miniflare lane)

Lane: `packages/cloudrop/src/storage/s3-driver.wrangler.integration.test.ts`, run by `bun run test:wrangler`,
which calls `scripts/test-wrangler.sh` (the pinned `wrangler@4.162.0` devDependency, worker fixture in
`packages/cloudrop/fixtures/wrangler/`, port 18787 or `CLOUDROP_WRANGLER_PORT`, state in `fixtures/wrangler/.state`, stopped and wiped by a `trap`). The endpoint is
`http://127.0.0.1:<port>/cdn-cgi/local/r2/s3` (experimental, `local_dev.experimental_s3_credentials`). Driver:
`createS3Driver` with `R2_RULES`, region `auto`, path-style bucket `contract`.

**Date:** 2026-11-15, re-run 2026-11-16. **Result:** 17 of 26 contract cases pass, 9 skip on declared gaps (16 of 24
and 8 skips before the presigned-GET cases, 16 of 22 and 6 skips before the copy guard). The suite takes under 1 s.

| Behaviour | Measured answer |
|---|---|
| Endpoint with a path prefix | The signature covers the prefix, so the driver keeps it in every URL. `x-amz-copy-source` stays `/bucket/key` without it; `s3-driver.test.ts` pins both |
| Expired presigned URL | `403 ExpiredRequest`, as R2. No gap |
| Unsigned `x-amz-meta-*` on a presigned PUT | `200`, the header is **stored** as object metadata (R2: `403 SignatureDoesNotMatch`). Lane field `unsignedMetaOnPresignedPut: "stored"` |
| Last part larger than the first | Refused, but as `404 NoSuchUpload`, not `InvalidPart`; the upload survives and completes once the part is replaced. Lane field `unequalPartsCode: "NO_SUCH_UPLOAD"`. Real R2 and the fake enforce the same rule; Wrangler's `NoSuchUpload` makes it a weaker oracle for the error code, though the repair-and-complete half of the case still holds |
| ListParts | `501 NotImplemented`, also after an abort. Gap `listParts` |
| Part with a wrong CRC32C | Accepted with `200`: `x-amz-checksum-*` is ignored. Gap `checksums` |
| HEAD checksum | No `x-amz-checksum-crc64nvme`. Gap `crc64nvme` |
| `If-None-Match: *` on completion, key exists | Ignored: the completion succeeds and overwrites the key (R2 and RustFS: `412`). Gap `conditionalCompletion` |
| `If-None-Match: *` on a presigned PUT | `412 PreconditionFailed` as R2. No gap |
| Completing a finished upload again | `404 NoSuchUpload` as R2. No gap |
| `x-amz-copy-source-if-match` | Honoured on `CopyObject` (a changed source answers `412`). An `UploadPartCopy` carrying it answers `501 NotImplemented`; the same request without the header succeeds (measured by sending the parts without it). Gap `copyPartPrecondition`: both multipart-copy cases skip |
| Presigned GET with `response-content-disposition` | `200` with the body but **no** `Content-Disposition`: the override is ignored (R2 and RustFS apply it). Gap `responseOverrides` |

Wrangler is therefore a check of the equal-part rule and presigned SigV4 only; resume by ListParts, checksums and
multipart copy are covered by RustFS and real R2.

## In-process fake R2

`packages/cloudrop/src/testing/fake-r2.ts`, unit lane. Its rules come from `r2-spike-findings.md` and from the live lane.

- **Unsigned `x-amz-meta-*` on a presigned PUT** (2026-11-15): the fake used to store it like a signed header. It now
  answers `403 SignatureDoesNotMatch`, as real R2 does.
- It does not compute CRC64NVME, so that case skips on the fake with that reason.
- `x-amz-copy-source-if-match` on `CopyObject` and `UploadPartCopy`: a value that does not match the source's ETag
  (quotes ignored) answers `412 PreconditionFailed`. Modelled on S3's documentation, then confirmed on real R2 by the
  live lane.

Rules the fake models on S3's documented behaviour that were **not measured on R2**, so a lane that disagrees wins:

- Aborting with an upload ID that belongs to another key answers `204` and leaves the upload open.
- An `x-amz-copy-source-range` that is malformed, reversed or past the source's end answers `400 InvalidArgument`.
- A reversed range on GET (`bytes=5-2`) answers `416 InvalidRange`.
- A query sent with `+` where `%20` was signed (or the reverse) fails the signature: S3 reads `+` as a literal plus.

Bucket settings (2026-11-15): without the `bucketConfig` option the fake answers `GetBucketCors` and
`GetBucketLifecycleConfiguration` with `403 AccessDenied`, as R2 does for an object token (measured for both by the live
lane). With it, the fake serves the given XML, or `404 NoSuchCORSConfiguration` / `NoSuchLifecycleConfiguration` for a
missing entry, as S3 documents. `response-content-disposition` on a GET is applied, as on R2 and RustFS.
