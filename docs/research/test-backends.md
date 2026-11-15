# Test backends

How each backend behaves under the storage contract (`packages/cloudrop/src/testing/storage-contract.ts`), and where
it differs from the in-process fake R2. When a backend disagrees with the fake, the measured behaviour wins and the fake
is changed to match. One section per backend: behaviour, evidence, date.

## Real R2 (live lane)

Lane: `packages/cloudrop/src/storage/s3-driver.r2.integration.test.ts`, run by `bun run test:live`. Driver: the public
`r2()` preset, configured from the environment. Bucket: the owner's R2 test bucket, under `live-test/cloudrop-<hex>/`.

**Date:** 2026-11-15, two runs (about 30 MiB uploaded and 15 s each).

**Result:** all 22 contract cases pass, none skipped. R2 declares no gap.

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

The last row is the only difference from the fake found so far (below). Teardown deleted everything: a separate
read-only listing of `live-test/` after both runs returned 0 objects and 0 multipart uploads.

## RustFS (container lane)

Lane: `packages/cloudrop/src/storage/s3-driver.rustfs.integration.test.ts`, run by `scripts/test-rustfs.sh`
(`rustfs/rustfs:1.0.5`, one container per run named `cloudrop-test-rustfs-<pid>`, label `cloudrop.test`, removed by a
`trap`). Driver: `createS3Driver` with `S3_RULES`, region `us-east-1`, path-style bucket `contract`.

**Date:** 2026-11-15. **Result:** 19 of 22 contract cases pass, 3 skip on declared gaps. The suite takes about 1 s.

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

The contract's `NoSuchUpload` expectations after completion are R2 behaviour; AWS-style backends keep the ID, which is
why they are a declared gap, not a driver bug: the driver maps whatever the backend answers.

## In-process fake R2

`packages/cloudrop/src/testing/fake-r2.ts`, unit lane. Its rules come from `r2-spike-findings.md` and from the live lane.

- **Unsigned `x-amz-meta-*` on a presigned PUT** (2026-11-15): the fake used to store it like a signed header. It now
  answers `403 SignatureDoesNotMatch`, as real R2 does.
- It does not compute CRC64NVME, so that case skips on the fake with that reason.
