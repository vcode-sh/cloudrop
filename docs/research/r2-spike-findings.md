# Real-R2 spike findings

Measured 2026-11-15 (14:23–14:27 UTC) against a dedicated Cloudflare R2 test bucket, with an Object Read & Write token
scoped to that bucket. Account id, bucket name and public host are redacted as `<account>`, `<bucket>` and
`<public-host>`. The spike code is in [`spikes/r2/`](../../spikes/r2/); how to re-run it is at the end.

This answers the "Open items to verify with a real-R2 contract test" in
[`r2-platform-and-test-backends.md`](r2-platform-and-test-backends.md) and the "(unverified)" markers in
[`landscape-and-packaging.md`](landscape-and-packaging.md) §3.3. Each behaviour was observed once per run. Q9's
parallel-part and burst tests ran twice. Nothing here is a guarantee from Cloudflare: it is what one bucket did on one
day.

## Method in one paragraph

Bun 1.4.4 drove all requests. Presigned URLs came from the spike's own SigV4 query presigner
([`spikes/r2/lib.ts`](../../spikes/r2/lib.ts)). That presigner signs exactly the headers given and uses
`UNSIGNED-PAYLOAD`, so `X-Amz-SignedHeaders` is fully controlled and is recorded per request. Q6/Q16 also used
`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` **3.1169.0** (latest on the day) and `aws4fetch` **1.0.20**.
Three kinds of request were used:

- **Browser-like:** plain `fetch`, body framed honestly.
- **Raw:** a TLS socket that writes the request line, headers and body exactly as given. Used to send a
  `Content-Length` that differs from the signed value, a short or long body, or chunked framing.
- **Header-signed:** `aws4fetch` with retries off, for server-side operations (Create, Complete, ListParts, HEAD,
  Copy).

The checksum code checks itself against the published `123456789` vectors (`--self-check`): CRC32C `e3069283`,
CRC64NVME `ae8b14860a799888`.

## Summary

| # | Question | Verdict | Design impact for cloudrop |
|---|---|---|---|
| 1 | Signed `content-length` on presigned PUT | **Enforced.** CL ±100 → `403 SignatureDoesNotMatch`, nothing stored. A short body with the signed CL got no response and stored nothing. Trailing bytes past CL are ignored (object = first N bytes). Chunked framing is measured too: a 4096-byte chunked body on a URL signed for 1024 → 403. Signed `content-type` mismatch → 403. **Unsigned** CL is not enforced (any size accepted) | **Size can be rejected at upload time**, provided the URL signs `content-length`. Keep the HEAD check at completion as defence in depth and for URLs signed without it |
| 2 | Signed `content-length` on presigned UploadPart | **Enforced** (±1 byte → 403; the part is not stored). Unsigned → any size accepted | Sign the exact planned length into every part URL. Per-part size is then fixed at upload time. Part-size *rules* are still only checked at Complete (Q4) |
| 3 | `If-None-Match: *` | Signed + sent: 1st PUT 200, 2nd → `412 PreconditionFailed`. Signed but **omitted** → 403 (the header becomes mandatory). An **unsigned** `If-None-Match: *` is also honoured (412). On Complete: fresh key 200, existing key 412, and the upload is then gone (`NoSuchUpload`) | Create-only presigned PUTs work. Signing the header makes it non-optional for the client. For multipart, send it on the server's Complete, and expect a 412 to burn the parts |
| 4 | Part-size rules | (a) equal parts + smaller last: OK. (b) last part **larger**: rejected. (c) unequal middle part: rejected. (d) non-last part < 5 MiB: rejected. **All four checks happen at Complete**; every UploadPart returned 200. Codes: (b)/(c) `400 InvalidPart` "All non-trailing parts must have the same length."; (d) `400 EntityTooSmall`. After a failed Complete the upload **survives**: re-uploading the bad part and completing again → 200 | The planner must fix one part size up front and keep the last part ≤ it. A planner bug is only detected at Complete, but it is recoverable on the same upload id |
| 5 | Checksums | CRC32C/CRC64NVME sent as a **signed header** on PUT or UploadPart: a wrong value → `400 BadDigest`, a correct one is echoed. The same value as a **query parameter** is **ignored** (wrong value → 200, not stored). Every write gets a server-computed CRC64NVME by default. Wrong checksums at Complete (part XML values, full-object header) are **not enforced**: R2 returns its own computed value. ListParts shows `ChecksumCRC32C` only for parts sent with one. `GetObjectAttributes` → `501 NotImplemented` | Integrity per part works, but only as a header, so it needs CORS `AllowedHeaders`. Verify whole-object integrity on the server by comparing the `x-amz-checksum-*` that Complete/HEAD returns with the client's value; never rely on R2 rejecting a wrong Complete |
| 6 | SDK/aws4fetch presigners | SDK 3.1169.0 `WHEN_SUPPORTED` embeds `x-amz-sdk-checksum-algorithm=CRC32&x-amz-checksum-crc32=AAAAAA==` (CRC of an empty body) in the URL. A plain browser PUT still **succeeds** on R2, because R2 ignores query checksums (Q5). `WHEN_REQUIRED` adds nothing. The SDK presigner **does not sign `content-type`** by default (Q16: `SignedHeaders=content-length;host`; a different Content-Type → 200 and is stored). `signableHeaders` fixes that. aws4fetch signs only `host` unless `allHeaders: true` | Do not depend on SDK defaults. Use an explicit signer (aws4fetch with `allHeaders`, or our own) that signs exactly `content-length`, `content-type` and any checksum/conditional headers. With the SDK, pass `signableHeaders` and use `WHEN_REQUIRED` |
| 7 | Expiry | Expired → `403 ExpiredRequest` (PUT and GET). `X-Amz-Expires=604800` accepted, `604801` → `400 InvalidArgument`. `X-Amz-Date` 30 min in the future → `403 RequestTimeTooSkewed`. CORS headers on the expired response: **BLOCKED** (no CORS rule for the test origin, so absence proves nothing); since measured: none, the browser gets an opaque failure ([Browser, 2026-11-16](#browser-2026-11-16)) | Cap expiry at 604800 s. Treat an opaque browser failure as "maybe expired, re-sign once". Keep signing clocks in sync |
| 8 | CORS | `GetBucketCors` → `403 AccessDenied` for this token, so the policy is not directly readable. Preflights show a rule allowing only `GET, HEAD` + header `range` from the public origin (MaxAge 3600). Every PUT preflight → `403` "CORS not configured for this bucket". **Browser upload questions BLOCKED.** The required JSON is below; since measured with the owner's rule: [Browser, 2026-11-16](#browser-2026-11-16) | The owner must apply a CORS rule before any browser test. The library docs must ship the exact policy (methods, allowed headers incl. checksums, `ExposeHeaders: ETag`) |
| 9 | Rate limits | 8 concurrent UploadPart on one key: all 200, twice. 5 sequential PutObject to one key in ~1 s: all 200, twice. 5 **concurrent** PutObject to one key: one `429` per run, S3 code **`ServiceUnavailable`** ("Reduce your concurrent request rate for the same object.") | Parallel parts are safe at 8. Same-key writes collide on concurrency, not on a 1/s rate. Classify 429 as retryable by status, not by `TooManyRequests` code |
| 10 | ListParts | Fields per part: `ETag`, `LastModified`, `PartNumber`, `Size`, plus `ChecksumCRC32C` when the part was sent with one. No CRC64NVME, even though UploadPart returned one. `max-parts=3` paginates with `IsTruncated`/`NextPartNumberMarker`. After Complete → `404 NoSuchUpload` | Server-verified completion via ListParts works (size per part). Pagination needs handling above 1000 parts. ListParts cannot be used to inspect a completed upload |
| 11 | Complete retry, metadata | A retried Complete after success → `404 NoSuchUpload`; Abort after Complete → 204. HEAD shows the `x-amz-meta-cloudrop-id` and Content-Type set at Create, `x-amz-mp-parts-count: 8`, ETag `"<md5-of-md5s>-8"` (matches our computation) | Complete is not idempotent: treat `NoSuchUpload` on a retried Complete as "check HEAD; if the object matches, it succeeded". Metadata set at Create is reliable |
| 12 | `content-disposition` | Signed into the URL: stored, returned by GET on the S3 endpoint and on the public custom domain (`cf-cache-status: DYNAMIC`), including an RFC 5987 `filename*`. Omitting it with a URL that signed it → 403 | Content-Disposition can be forced at upload time by signing it |
| 13 | Ranged GET, HEAD | `Range: bytes=0-4095` → 206 with `Content-Range: bytes 0-4095/<total>`, for single and multipart objects. Single ETag = MD5 hex. Multipart ETag `-N` + `x-amz-mp-parts-count`. `HEAD ?partNumber=1` → 206 with that part's range | Magic-byte sniffing with one ranged GET (Class B) is viable |
| 14 | CopyObject | Default directive keeps Content-Type, Content-Disposition and `x-amz-meta-*` (also from a multipart source). `REPLACE` drops what is not resent. Copying a multipart object **rewrites the ETag to the plain MD5 of the content** and drops `x-amz-mp-parts-count`. CopyObject is Class A ([pricing]) | Quarantine-promote works and keeps metadata, but costs one more Class A op and changes the ETag. Do not use the pre-promotion ETag as an identity after promoting |
| 18 | Unsigned `x-amz-meta-*` header on a presigned PUT | **Rejected:** `403 SignatureDoesNotMatch`, nothing stored (AWS S3 documents `AccessDenied`). Measured by the storage contract's live lane (`bun run test:live`) on 2026-11-15, twice | A presigned URL fixes the object's metadata: a client cannot add its own. The fake R2 rejects it the same way |

## Per-question details

Notation: `SH=` is the `X-Amz-SignedHeaders` value of the URL used. "Stored?" is a HEAD right after the attempt.

### Q1. Signed `content-length` on a presigned PUT

Docs: the presigned-URLs page documents enforcement for `Content-Type` only ("uploads will fail with a
`403/SignatureDoesNotMatch` error if the client sends a different `Content-Type`"). It says nothing about
Content-Length ([presigned]).

URL: `PUT /<bucket>/<key>?X-Amz-…`, `SH=content-length;content-type;host`, signed length N = 1024,
`content-type: application/octet-stream`. All sends were raw over TLS.

| Sent | Status / code | Stored? |
|---|---|---|
| CL 1024, body 1024 (control) | 200, ETag `"c14251dc…"`, `x-amz-checksum-crc64nvme` returned | yes, 1024 B |
| CL 924, body 924 | 403 `SignatureDoesNotMatch` | no (404) |
| CL 1124, body 1124 | 403 `SignatureDoesNotMatch` | no |
| CL 1024, body 924, then half-close | no HTTP response; the connection was closed | no |
| CL 1024, body 1124 (100 trailing bytes) | 200 | yes, **1024 B** (trailing bytes ignored) |
| CL 1024, `content-type: text/plain` | 403 `SignatureDoesNotMatch` | no |
| URL `SH=content-type;host` (no length), CL 4096, body 4096 | 200 | yes, 4096 B |

Chunked follow-up (Q17, `SH=content-length;host`, signed 1024):

| Sent | Result |
|---|---|
| `Transfer-Encoding: chunked`, 4096-byte body, no CL | 403 `SignatureDoesNotMatch`, not stored |
| chunked, 1024-byte body, no CL | 200, stored 1024 B (R2 derives the length from the received body) |
| chunked 4096 **and** `Content-Length: 1024` | 400 from the edge (non-S3 body), not stored |
| URL `SH=host`, chunked 4096 | 200, stored 4096 B |

Verdict: **R2 enforces a signed `content-length`**, including when the client tries chunked framing.

### Q2. Signed `content-length` on a presigned UploadPart

The spike created the upload (header-signed). It then presigned `PUT ?partNumber=n&uploadId=…` with
`SH=content-length;host` and a 64 KiB planned length, and sent each part raw.

| Part | Sent CL | Result |
|---|---|---|
| 1 | 65536 (= signed) | 200 |
| 2 | 65535 | 403 `SignatureDoesNotMatch` |
| 3 | 65537 | 403 `SignatureDoesNotMatch` |
| 4 (URL `SH=host`) | 131072 | 200 |

ListParts afterwards showed only parts `1:65536` and `4:131072`. This is also the first direct evidence that
**presigned UploadPart URLs work** at all. The docs list PUT as a supported presigned method but never mention
UploadPart ([presigned]).

### Q3. `If-None-Match: *`

Docs: the conditional-operations page describes `If-None-Match: *` on PutObject and CompleteMultipartUpload, with
"412 PreconditionFailed". A failed conditional Complete "aborts the upload", and the page says nothing about presigned
URLs ([cond]).

| Request | Result |
|---|---|
| Presigned PUT `SH=host;if-none-match`, header sent, fresh key | 200 |
| Same URL again (key exists) | 412 `PreconditionFailed` |
| Same URL, header omitted | 403 `SignatureDoesNotMatch` (a signed header is mandatory) |
| URL `SH=host`, `If-None-Match: *` sent unsigned, key exists | 412 `PreconditionFailed` (unsigned conditional honoured) |
| HEAD | still the first object's ETag `"f13f1f8d…"`, 100 B |
| Complete with `If-None-Match: *`, fresh key | 200, ETag `"…-1"` |
| Complete with `If-None-Match: *`, existing key | 412 `PreconditionFailed` |
| ListParts on that upload id | 404 `NoSuchUpload` (the upload was aborted, as documented) |

The unsigned case matters for security. A client holding a URL that signs only `host` can *add* `If-None-Match`,
which only makes its own write fail. It cannot remove a signed one. An earlier R2 spike in another of the owner's
repositories (private) measured the multipart Complete behaviour on 2026-11-04; this run agrees.

### Q4. Multipart part-size rules

Docs: "All parts except the last must be the same size" and "Minimum part size: 5 MiB (except for the last part)".
The page does not say where the rule is checked ([multipart]). The error codes page lists `10048 InvalidPart` "All
non-trailing parts must have the same size" and `10011 EntityTooSmall` ([errors]). The limits page gives a 10,000-part
maximum ([limits]).

Each part was header-signed, sent sequentially, and completed with the ETags returned.

| Case | Part sizes | UploadPart | Complete |
|---|---|---|---|
| a | 5, 5, 1 MiB | all 200 | 200, ETag `"96180819…-3"` |
| b | 5, **6** MiB (last larger) | all 200 | 400 `InvalidPart` "All non-trailing parts must have the same length." |
| c | 5, **6**, 1 MiB | all 200 | 400 `InvalidPart` (same message) |
| d | **1**, 5 MiB | all 200 | 400 `EntityTooSmall` "Your proposed upload is smaller than the minimum allowed object size." |

In cases b–d, ListParts after the failed Complete still listed every part (200). The Q15 follow-up checked whether
that upload can still be used:

- Complete with [5, 6] MiB → `InvalidPart`.
- Re-upload part 2 as 1 MiB → 200.
- Complete again on the same upload id → 200, ETag `"…-2"`.

So an `InvalidPart` from the size rule **does not abort the upload**. A failed *conditional* Complete does (Q3).

The release-notes claim that the rule is enforced at Complete (cited in the sibling doc) is confirmed. So is
Miniflare's extra "last part not larger than the others" rule. The R2 docs do not state that rule: they say only
"same size".

### Q5. Checksums

Docs: the S3 API page's "Checksum Types" table lists CRC64NVME as FULL_OBJECT only, and CRC32/CRC32C/SHA1/SHA256 as
COMPOSITE only. Its PutObject and UploadPart rows list no checksum headers ([s3api]). `BadDigest` 10037 is "Provided
checksum does not match the uploaded content", and `InvalidDigest` 10014 is "Checksum header format is malformed"
([errors]). The presigned-URLs page does not discuss checksums ([presigned]). Neither page says that R2 computes a
CRC64NVME on every write.

**PutObject (presigned, 2048 B):**

| Variant | Result |
|---|---|
| `SH=host;x-amz-checksum-crc32c`, correct value sent as header | 200, response echoes `x-amz-checksum-crc32c: jfL3PQ==` |
| same, wrong value | 400 `BadDigest` "The CRC32C checksum you specified did not match what we received. You provided … 275571e7 Actual … 8df2f73d" |
| also `x-amz-sdk-checksum-algorithm: CRC32C` signed | 200 (the algorithm header is not needed) |
| `x-amz-checksum-crc32c` + `x-amz-sdk-checksum-algorithm` as **query parameters** (signed as part of the query), correct | 200, but the response carries `x-amz-checksum-crc64nvme`, not crc32c: **ignored** |
| same, **wrong** value | **200**: not validated |

HEAD without `x-amz-checksum-mode` returns no checksum. With `x-amz-checksum-mode: ENABLED` it returns
`x-amz-checksum-crc32c: jfL3PQ==`. A PUT sent with no checksum header, HEAD'd in checksum mode, returned
`x-amz-checksum-crc64nvme: K5rKkuPwijg=`, which equals the CRC64NVME we computed locally (Q15). `GetObjectAttributes` →
`501 NotImplemented` "GetObjectAttributes not implemented". It is not listed on the compatibility page at all.

**UploadPart:**

| Variant | Result |
|---|---|
| Upload created with `x-amz-checksum-algorithm: CRC32C`, `x-amz-checksum-type: COMPOSITE`; presigned part `SH=host;x-amz-checksum-crc32c`, wrong value | 400 `BadDigest` |
| same, correct (part 1 5 MiB, part 2 1000 B) | 200, echoes `x-amz-checksum-crc32c` |
| part 3 with **no** checksum header on that CRC32C upload | 200, response returns `x-amz-checksum-crc64nvme` instead (not rejected) |
| upload created **without** an algorithm, part with a wrong `x-amz-checksum-crc32c` | 400 `BadDigest` (validated anyway) |
| wrong `x-amz-checksum-crc64nvme` on a part | 400 `BadDigest` "The CRC64NVME checksum you specified did not match …" |

**CompleteMultipartUpload:**

- **CRC32C composite.** Complete listed parts 1–2 with a **wrong** `ChecksumCRC32C` for part 1 in the XML → **200**.
  The returned `x-amz-checksum-crc32c: aleinw==-2` equals our CRC32C over the concatenated binary part CRCs plus `-2`.
  The XML values are not checked. A Complete with no checksum elements at all also → 200 (Q15). HEAD in checksum mode
  returns the composite `…==-2` and `x-amz-mp-parts-count: 2`. `HEAD ?partNumber=1` in checksum mode also returns the
  **whole-object composite**, not part 1's checksum.
- **CRC64NVME full object.** Upload created with `CRC64NVME` / `FULL_OBJECT`; parts sent with per-part
  `x-amz-checksum-crc64nvme`; Complete sent with a **wrong** top-level `x-amz-checksum-crc64nvme` → **200**. Both the
  response and HEAD report `VybHh2387Ow=`, which is the correct full-object CRC64NVME we computed locally. The wrong
  value was silently replaced.
- **Uploads with no checksum algorithm.** Every Complete still returns a full-object `x-amz-checksum-crc64nvme`.

This agrees with the earlier spike's 2026-11-04 finding (another of the owner's repositories): part checksums are
validated, and a wrong top-level CRC32C on Complete is accepted. This run extends it to CRC64NVME FULL_OBJECT and to
wrong per-part values in the Complete XML.

### Q6. Presigner default checksum behaviour

| Presigner | Query params added | `SignedHeaders` | Plain browser PUT (body only, plus Content-Type where set) |
|---|---|---|---|
| SDK `WHEN_SUPPORTED`, no options | `x-amz-sdk-checksum-algorithm=CRC32`, `x-amz-checksum-crc32=AAAAAA==`, `X-Amz-Content-Sha256`, `x-id` | `host` | 200 |
| SDK `WHEN_SUPPORTED`, `ContentType` | same | `host` | 200 |
| SDK `WHEN_SUPPORTED`, `ChecksumAlgorithm: CRC32C` | `…crc32c=AAAAAA==`, algorithm `CRC32C` | `host` | 200 |
| SDK `WHEN_REQUIRED`, no options / `ContentType` | none | `host` | 200 |
| SDK `WHEN_REQUIRED`, `ChecksumAlgorithm: CRC32C` | `…crc32c=AAAAAA==` | `host` | 200 |
| aws4fetch `signQuery`, default | none | `host` | 200 |
| aws4fetch `signQuery`, `allHeaders: true` | none | `content-type;host` | 200 |

`AAAAAA==` is the CRC of an empty body: the SDK computes a checksum it cannot know at presign time. On R2 the PUT works
only because R2 ignores query-string checksums (Q5). The same URL on AWS S3 is reported to fail (EVtivity PR #47, cited
in the landscape doc); that was not tested here.

Q16 follow-up (SDK, `WHEN_REQUIRED`, `ContentType: image/png`, `ContentLength: 64`):

| Presign option | `SignedHeaders` | PUT `text/plain`, 64 B | PUT `image/png`, 65 B |
|---|---|---|---|
| none | `content-length;host` | **200**, stored as `text/plain` | 403 |
| `signableHeaders: {content-type, content-length}` | `content-length;content-type;host` | 403 | 403 |

So with SDK 3.1169.0 defaults, **Content-Type is not enforced**, which contradicts the presigned-URLs page's
"Specify the allowed `Content-Type` in your SDK's parameters" ([presigned]). The SDK does sign `content-length` when
`ContentLength` is given. A positive control for the `signableHeaders` URL (correct type *and* length) was not sent.
The own-presigner control in Q1 covers that path.

### Q7. Expiry

Docs: "Expiry: Timeout from 1 second to 7 days (604,800 seconds)" ([presigned]). Expired URLs "return a `403`
`ExpiredRequest` response", and "R2 does not include CORS response headers on expired presigned URL responses"
([cors]).

| Request | Result |
|---|---|
| PUT signed 60 s ago, `X-Amz-Expires=1`, `Origin: http://localhost:5173` | 403 `ExpiredRequest` "Request has expired"; only `vary: Origin`, no `access-control-*` |
| GET, same | 403 `ExpiredRequest`, no `access-control-*` |
| PUT `X-Amz-Expires=604800`, with Origin | 200, also no `access-control-*` |
| PUT `X-Amz-Expires=604801` | 400 `InvalidArgument` "X-Amz-Expires must be less than a week (in seconds); that is, the given X-Amz-Expires must be less than 604800 seconds" |
| `X-Amz-Date` 30 min in the future | 403 `RequestTimeTooSkewed` |

The missing CORS headers on the expired response cannot be attributed to expiry: a *valid* PUT from the same origin
also had none, because the bucket has no rule for that origin (Q8). **BLOCKED** until CORS is configured; settled in
[Browser, 2026-11-16](#browser-2026-11-16): with a matching rule the expired 403 still has no CORS headers. The error
message says "less than 604800", but exactly 604800 was accepted.

### Q8. CORS

- `GET /<bucket>?cors` (GetBucketCors) → `403 AccessDenied` with this Object Read & Write token. The policy is
  **unknown** as a document. Its effective shape comes from preflights.
- Preflights (`OPTIONS` on an object URL on the S3 endpoint):

  | Origin | Method | Request headers | Result |
  |---|---|---|---|
  | `http://localhost:5173` | PUT | `content-type` | 403 `Unauthorized` "CORS not configured for this bucket" |
  | `http://localhost:5173` | PUT | none | 403 (same) |
  | `http://localhost:5173` | PUT | `x-amz-checksum-crc32c` | 403 (same) |
  | `http://localhost:5173` | GET | none | 403 (same) |
  | public origin | GET | `range` | **204**, `access-control-allow-origin: https://<public-host>`, `-methods: GET, HEAD`, `-headers: range`, `-max-age: 3600` |
  | public origin | PUT | `content-type` | 403 (same) |

- A presigned PUT carrying `Origin: http://localhost:5173` → 200 with no `access-control-*` headers. A browser would
  block reading it, and the preflight would fail first anyway.

The error text "CORS not configured for this bucket" is returned even though a rule exists. It means "no rule matched".

**BLOCKED:** browser presigned PUT, browser presigned UploadPart, reading `ETag` from JavaScript, CORS on expired URLs,
and whether checksum headers pass a preflight. All were measured on 2026-11-16 after the owner added a rule:
[Browser, 2026-11-16](#browser-2026-11-16) and, for checksums,
[Browser refusals and checksums](#browser-refusals-and-checksums-2026-11-16). The owner added this rule to the test
bucket; it must keep the existing public-origin GET/HEAD rule, because setting CORS replaces the whole policy. It uses
the S3 PutBucketCors JSON shape from [cors]:

```json
[
  {
    "AllowedOrigins": ["https://<public-host>"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range"],
    "MaxAgeSeconds": 3600
  },
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": [
      "content-type",
      "content-disposition",
      "if-none-match",
      "x-amz-checksum-crc32c",
      "x-amz-checksum-crc64nvme",
      "x-amz-meta-cloudrop-id"
    ],
    "ExposeHeaders": ["ETag", "x-amz-checksum-crc32c", "x-amz-checksum-crc64nvme"],
    "MaxAgeSeconds": 3600
  }
]
```

The first rule is reconstructed from the preflight. Its real `ExposeHeaders`, if any, are unknown: read it with
`wrangler r2 bucket cors list <bucket>` before replacing anything. Propagation "can, in rare cases, take up to 30
seconds" ([cors]).

### Q9. Rate limits

Docs: "Concurrent writes to the same object name (key) at a higher rate return HTTP 429" at "1 per second"
([limits]). Error `10058 TooManyRequests` 429 ([errors]).

- 8 × 5 MiB UploadPart on one key, all started together via presigned URLs signed with `content-length`: all 200 in
  ~300–520 ms. Two runs, 16 parts in total, no 429.
- 5 sequential PutObject (64 B) to one key, 150 ms apart (~1 s in total): `200,200,200,200,200` in both runs.
- 5 concurrent PutObject to one key: `200,200,200,429,200` in both runs. The 429 body is `<Code>ServiceUnavailable</Code>`
  "Reduce your concurrent request rate for the same object.", **not** `TooManyRequests`.

The 1 write/s/key limit behaves like a concurrency limit on in-flight writes to one key. Parallel *parts* do not count
against it, at least at 8.

### Q10. ListParts

- 8-part upload, `max-parts=3`: page 1 → parts 1–3, `IsTruncated=true`, `NextPartNumberMarker=3`. Page 2 → parts
  4–6. Page 3 → parts 7–8, `IsTruncated=false`.
- Each `<Part>` has `ETag`, `LastModified`, `PartNumber`, `Size`. `ChecksumCRC32C` appears only for parts sent with
  one (Q15). Parts sent without a checksum show no checksum element, although UploadPart returned a CRC64NVME.
- The result also has `Initiator`/`Owner` (the account id, redacted) and `StorageClass`.
- After Complete → `404 NoSuchUpload`. ListParts is Class A ([pricing]).

### Q11. Complete retry and metadata

Create sent `x-amz-meta-cloudrop-id: spike-0001` and `Content-Type: application/x-cloudrop-test`.

| Request | Result |
|---|---|
| Complete (8 parts) | 200, `<ETag>"68cc9ecb…-8"</ETag>`, equals MD5 of the concatenated binary part MD5s plus `-8`, as documented in [multipart] |
| Complete again, same XML | 404 `NoSuchUpload` |
| HEAD | 200, `content-length: 41943040`, `content-type: application/x-cloudrop-test`, `x-amz-meta-cloudrop-id: spike-0001`, `x-amz-mp-parts-count: 8` |
| Abort after Complete | 204 |

### Q12. `content-disposition`

`SH=content-disposition;content-type;host` with `attachment; filename="report.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`.

| Request | Result |
|---|---|
| Presigned PUT with both headers | 200 |
| Same URL without `content-disposition` | 403 `SignatureDoesNotMatch` |
| GET on the S3 endpoint | 200, `content-disposition` verbatim, `content-type: text/plain; charset=utf-8` |
| GET `https://<public-host>/<key>` (the bucket's public custom domain) | 200, same `content-disposition`, `cf-cache-status: DYNAMIC` |

### Q13. Ranged GET and HEAD

| Object | Request | Result |
|---|---|---|
| single PUT, 8 KiB, `application/pdf`, metadata | `Range: bytes=0-4095` | 206, `content-range: bytes 0-4095/8192`, `content-length: 4096`, metadata and type present |
| same | HEAD | `content-length`, `content-type`, `etag` (32-hex MD5), `last-modified` (RFC 7231 date, second precision), `x-amz-meta-*` |
| multipart 5+5+1 MiB | `Range: bytes=0-4095` | 206, `content-range: bytes 0-4095/11534336`, `x-amz-mp-parts-count: 3` |
| same | HEAD | ETag `"…-3"`, `x-amz-mp-parts-count: 3` |
| same | `HEAD ?partNumber=1` | 206, `content-range: bytes 0-5242879/11534336` |

Every successful write also returned `x-amz-version-id`, a header that R2's docs do not describe.

### Q14. CopyObject (quarantine-promote)

`PUT dst` with `x-amz-copy-source: /<bucket>/<src>`:

| Source | Directive | Result on HEAD of the copy |
|---|---|---|
| single, `image/png`, `inline; filename="a.png"`, `x-amz-meta-cloudrop-id` | default (COPY) | 200; type, disposition, metadata and ETag all identical to the source |
| same | `REPLACE` + `image/png` + `x-amz-meta-cloudrop-verified: 1` | type and new metadata only; disposition and old metadata dropped |
| multipart (`-3`, no metadata) | default | 200; ETag became a plain 32-hex value, `x-amz-mp-parts-count` gone |
| single-part multipart with `video/mp4`, `attachment`, `x-amz-meta-cloudrop-id` (Q15) | default | type, disposition and metadata kept. ETag `"3bff2cc4…"` = **MD5 of the content** (source was `"9e4b6fd4…-1"`) |

Later, the contract's live lane (2026-11-15, after the driver added a copy guard) measured
`x-amz-copy-source-if-match: "<HEAD's ETag>"`: R2 honours it on both CopyObject and UploadPartCopy. A matching ETag
copies normally; a source overwritten after the HEAD answers `412`, so a multipart copy can no longer mix two source
versions ([test-backends.md](test-backends.md)).

Cost: CopyObject and UploadPartCopy are Class A. DeleteObject and AbortMultipartUpload are free ([pricing]). A
promote is therefore one Class A + one free delete. Copy never re-transfers bytes from the client. Checksums on the
copied object were not inspected.

## Docs vs reality

| Topic | Docs say | Observed |
|---|---|---|
| Signed headers enforced | Only `Content-Type` is mentioned ([presigned]) | Every signed header is enforced: `content-length`, `content-type`, `content-disposition`, `if-none-match`, `x-amz-checksum-*` |
| SDK + Content-Type | "Specify the allowed `Content-Type` in your SDK's parameters" → 403 on mismatch ([presigned]) | With `@aws-sdk/s3-request-presigner` 3.1169.0, `ContentType` is **not** signed by default; a mismatch is accepted. Needs `signableHeaders` |
| Presigned multipart | Only "PUT" listed; UploadPart not covered ([presigned]) | Presigned UploadPart works, including signed length and checksum |
| Equal-part rule | "All parts except the last must be the same size" ([multipart]) | Also rejects a last part **larger** than the others. Enforced at Complete only. The message says "length", not "size" |
| Failed Complete | A *conditional* failure aborts the upload ([cond]) | A size-rule failure (`InvalidPart`, `EntityTooSmall`) does **not** abort; the upload can be repaired |
| 429 code | `10058 TooManyRequests` ([errors]) | S3 code `ServiceUnavailable` with HTTP 429 |
| 1 write/s/key | "1 per second" ([limits]) | 5 sequential writes in ~1 s all passed; 1 of 5 concurrent writes failed. It behaves as a concurrency limit |
| Checksums | No statement about default checksums or query-string checksums ([s3api], [presigned]) | R2 computes and returns CRC64NVME on every write. Query-string checksums are silently ignored. Complete-time checksums (XML part values, full-object header) are not validated |
| GetObjectAttributes | Not listed ([s3api]) | `501 NotImplemented` |
| `HEAD ?partNumber` + checksum mode | not documented | Returns the object's composite checksum, not the part's |
| Max expiry message | "1 second to 7 days (604,800 seconds)" ([presigned]) | 604800 accepted; the 604801 error text says "must be less than 604800" (off by one in the message only) |
| CORS error text | — | "CORS not configured for this bucket" even when a (non-matching) rule exists |
| Versioning | not documented | Writes return `x-amz-version-id` (and `x-amz-copy-source-version-id` on copy) |

## Browser, 2026-11-16

Measured 2026-11-16 (about 10:30–10:36 UTC) on the same test bucket, after the owner added the CORS rule
`cloudrop-browser-tests` (2026-11-15) and confirmed from the dashboard on 2026-11-16 that it allows `PUT` from
`http://localhost:5173` with `content-type`, `content-disposition`, `if-none-match`, `x-amz-meta-cloudrop-id` and
exposes `ETag`; an `OPTIONS` check later the same day showed it also allows the two checksum headers
([Browser refusals and checksums](#browser-refusals-and-checksums-2026-11-16)). The Object Read & Write token still
cannot read it (`GetBucketCors` → `403 AccessDenied`, as in Q8). Browser: Chromium 159.0.8154.6, headless shell,
driven by Playwright 1.65.1. Origin `http://localhost:5173`. Every object went under a
`live-test/cloudrop-<random hex>/` prefix and was deleted; the deletion's count matched what was written.

| Row | What was done | Result |
|---|---|---|
| U10: single PUT | `bun run test:browser:live`: the Next.js example on `r2()` uploads `hello.txt` (14 bytes, `text/plain`) with cloudrop's client | **Works.** One PUT without `partNumber`; HEAD size 14, type `text/plain`; the bytes read back equal. The browser's own `Content-Length` matched the signed one |
| U1: multipart from a page | The same lane uploads a 20 MiB file as parts of 8, 8 and 4 MiB (`Blob.slice`) | **Works.** Three `UploadPart` PUTs, Complete succeeds, size 20,971,520, the bytes around both part boundaries read back equal. A second test uploads the same on-disk file twice (two keys) |
| U2: CORS on an expired URL | A PUT from the page, with the headers the server signs for a single PUT, to a URL presigned with `expiresIn: 1`, sent 2 s later | **Opaque.** The preflight answers `204` with `access-control-allow-origin`; the PUT's answer carries no CORS headers, so Chromium blocks it (`corsError: MissingAllowOriginHeader`, `net::ERR_FAILED`) and `fetch` rejects with `TypeError: Failed to fetch`. Status and body are unreadable from the page. The same request outside a browser, with `Origin: http://localhost:5173`: `403 ExpiredRequest`, no `access-control-*` header, nothing stored |
| U3: `ETag` from JavaScript | A PUT from the page to a fresh URL with the same headers | **Readable:** status 200, `response.headers.get("etag")` non-null; the answer exposes `ETag, x-amz-checksum-crc32c, x-amz-checksum-crc64nvme` |

What this means for cloudrop:

- U2 matches R2's documentation ("R2 does not include CORS response headers on expired presigned URL responses",
  [cors], last updated 2026-09-23, re-read 2026-11-16) and differs from both local backends (RustFS and Wrangler answer
  an expired URL with a readable 403). On R2 the client therefore takes S10's **opaque** row: renew the URL once,
  wait, retry. Task 5's unit test "renews once after an opaque failure" covers that row; neither local backend can
  produce it.
- The lane also showed that an exported, empty `CLOUDROP_S3_ENDPOINT` wins over `.env.local` (U14): a second run with
  an `examples/next/.env.local` pointing at a dead S3 endpoint still passed on R2 and deleted 4 objects.
- Repeat U1 and U10 with `CLOUDROP_R2_ENV_FILE=<file> bun run test:browser:live`. U2 and U3 were measured once by a
  script that was deleted afterwards.

## Browser refusals and checksums, 2026-11-16

**Erratum (2026-11-17):** the Preflight column below shows Playwright's answers, not R2's: while `page.route` is
active, Playwright answers every intercepted CORS preflight itself with `204` and an echo of the requested headers. The
`fetch` and "Outside the browser" columns stand. R2's own preflights were measured from a served page in [Bad
checksum, gone upload and throttling from a browser](#bad-checksum-gone-upload-and-throttling-from-a-browser-2026-11-16).

Measured 2026-11-16 (11:44:02–11:44:35 UTC) on the same test bucket and CORS rule as
[Browser, 2026-11-16](#browser-2026-11-16). Chromium 159.0.8154.6 headless shell, driven by Playwright 1.65.1 under
Bun 1.4.4. Method as in that section: a temporary script (deleted afterwards) routed `http://localhost:5173/` to a
blank page and ran `fetch` from it with the presigned URL passed as a `page.evaluate` argument; no server and no port.
The preflight was read from Chrome DevTools Protocol `Network` events (`type: Preflight`); a CORS failure from
`Network.loadingFailed`'s `corsErrorStatus`. URLs came from `r2()`'s `presignPut` / `presignPart`, signed as the
server signs them (single PUT: `content-type`, `content-disposition`, `if-none-match: *`, `x-amz-meta-cloudrop-id`,
`content-length`; part: `content-length` only), except R4, which `presignPart` refuses to sign and was signed with
`presignUrl` directly. Bodies were `Blob`s. "Outside" is the same request from Bun's `fetch` with
`Origin: http://localhost:5173`, on its own key where the first request could have stored the object. Every object went
under one `live-test/cloudrop-<32 hex>/` prefix; the multipart upload was aborted and `deletePrefix` deleted 3 objects,
after which the prefix listed 0.

| Row | Request from the page | `fetch` | Preflight | Outside the browser |
|---|---|---|---|---|
| R1 signature mismatch | single PUT presigned for `content-type: text/plain`, sent with `image/png` | **Rejected**, `TypeError: Failed to fetch` (`MissingAllowOriginHeader`, `net::ERR_FAILED`) | `204`, allows `content-disposition,content-type,if-none-match,x-amz-meta-cloudrop-id` | `403 SignatureDoesNotMatch`, no `access-control-allow-origin`; nothing stored (HEAD: absent, both keys) |
| R2 precondition | single PUT, `if-none-match: *` signed and sent, key written first | **Resolved** `412`, body readable (`PreconditionFailed`), `ETag` null | `204` | `412 PreconditionFailed`, with `access-control-allow-origin` |
| R3a part, signed length | `UploadPart` signed for 1024 bytes, sent 1023 | **Rejected**, as R1 | `204` | `403 SignatureDoesNotMatch`, no CORS header |
| R3b part, unsigned type | `UploadPart` with `content-type: image/png` (a part URL does not sign it) | **Resolved** `200`, `ETag` readable | `204`, allows `content-type` | `200` |
| R4a part number 10001 | `UploadPart` presigned with `partNumber=10001` | **Resolved** `400`, body readable (`InvalidArgument`), `ETag` null | `204` | `400 InvalidArgument`, with CORS header |
| R4b expiry too long | `UploadPart` presigned with `X-Amz-Expires=604801` | **Rejected**, as R1 | `204` | `400 InvalidArgument`, no CORS header |
| C1 checksum, single PUT | single PUT with `x-amz-checksum-crc32c` (correct) signed by `presignPut` | **Resolved** `200`, `ETag` readable; HEAD 14 B | `204`, allows `…,x-amz-checksum-crc32c,…` | `200` |
| C2 checksum, part | `UploadPart` with `x-amz-checksum-crc32c` (correct) signed by `presignPart` | **Resolved** `200`, `ETag` readable; ListParts shows the part with `ChecksumCRC32C` | `204`, allows `x-amz-checksum-crc32c` | `200` |

R3: R2 checks the signed `content-length` of a part (R3a); a part URL signs no `content-type`, so a changed type is not
checked (R3b). The measured rows fit one pattern, which is an inference from three opaque samples (bad signature,
`X-Amz-Expires` over a week, and the expired URL of U2) and two readable ones (`412`, the out-of-range part number),
not R2's documented behaviour: a refusal **before** R2 has authenticated the URL comes without CORS headers, so the page
cannot read it, and a refusal **after** authentication carries them. Whether R2 checks the part-number range after the
signature is not observable from these answers.

The CORS rule allows more than [Browser, 2026-11-16](#browser-2026-11-16) records: a write-free control
(outside-the-browser `OPTIONS` with `Access-Control-Request-Method: PUT`) answered `204` for `x-amz-checksum-crc32c` and
`x-amz-checksum-crc64nvme`, and `403 Unauthorized` for `x-amz-checksum-sha256`, `x-amz-sdk-checksum-algorithm` and an
arbitrary `x-f1-probe`. The rule in force is therefore consistent with the Q8 JSON's `AllowedHeaders` (six header
names were probed), and U3 already saw its `ExposeHeaders`.

What this means for cloudrop:

- **Opaque refusals (R1, R3a, R4b).** `putObject` cannot read them and answers `opaque`
  ([`client/bucket.ts:59`](../../packages/cloudrop/src/client/bucket.ts)): the client renews the URL once, retries
  within its budget (6 attempts, up to about 15 s of jittered waiting, `client/retry.ts`) and ends with a retryable
  `NETWORK_ERROR`, not the non-retryable `UPLOAD_REJECTED` that `classifyAnswer` gives a readable
  `403 SignatureDoesNotMatch` ([`client/bucket.ts:33`](../../packages/cloudrop/src/client/bucket.ts)) and that the
  fake produces (`upload-failures.test.ts`, "fails a file whose bytes do not match the signature, once"). For the two
  mismatches tried (a changed `content-type` on a single PUT, a short body on a part), that test's outcome is
  unreachable on R2 from a browser. The same holds for the one pre-authentication `400` tried (R4b).
- **Readable refusals (R2, R4a).** The client classifies them as on the fake: the `412` counts as stored
  (`bucket.test.ts`, "counts a second create-only PUT as stored"), and the `400` is a non-retryable `UPLOAD_REJECTED`
  (`bucket.test.ts`, the `classifyAnswer` row "fails a corrupted body", same status). `cloudrop` never signs a part
  number above 10,000 (`partNumberProblem`), so R4a stands only for "a post-authentication 400 is readable".
- **Checksums.** With this bucket's rule, a signed `x-amz-checksum-crc32c` passes the preflight and uploads from a
  browser, on a single PUT and on a part. A bucket owner who wants browser checksums must list `x-amz-checksum-crc32c`
  (and `x-amz-checksum-crc64nvme` if used) in the rule's `AllowedHeaders`. A header missing from it fails the preflight
  with `403` (measured outside the browser by the `OPTIONS` control), which the page would see as
  `TypeError: Failed to fetch` before any byte is sent (inferred from that control and the Fetch standard; not tried
  from a page). The client sends no checksum today.

## Part size, 2026-11-16

Measured 2026-11-16, 20:31:47–20:42:50 UTC, on the same test bucket and the same machine (10 GbE LAN, Node 24.22.2,
Chromium 159.0.8154.6 headless shell driven by Playwright 1.65.1). It answers plan B task 1: should `src/plan.ts`
start large files at a part larger than 8 MiB?

**Method.** Each run uploads a fresh 256 MiB random file as a real multipart upload through the `r2` driver:
`createMultipart`, `presignPart` for every part (signed `content-length`, no checksum), the part PUTs, then
`completeMultipart` with the ETags, a `head` that checks the size, and a `delete`. The matrix is part size 8, 16 and
32 MiB × concurrency 4, 6 and 8: a pool of that many workers, each taking the next part when its PUT finishes. Every
round visits the nine combinations in a different order (forward, then two shuffles), so drift in the network spreads
over all of them. Three rounds per combination, and the whole matrix ran twice, Node first and then the browser each
time: **n = 6 per cell and runtime**. The number is MiB/s over the part PUTs alone (first PUT start to last PUT end), so
it shows what part size and parallelism change; `createMultipart`, presigning and
`completeMultipart` added 0.5–1.2 s per upload in Node, whatever the part size.

- **Node:** `fetch` (undici) with `Uint8Array` slices of one buffer.
- **Browser:** a blank page served on `http://localhost:5173`; Node creates the upload and presigns, the page PUTs
  `Blob.slice` parts with `fetch`, reads each `ETag` from the answer (the CORS rule exposes it) and times itself with
  `performance.now()`. Building the random Blob is not timed. `nextHopProtocol` is empty for these cross-origin
  requests (no `Timing-Allow-Origin`), so the HTTP version Chromium used is not known.

**Round trip the same day** (signed `HEAD` of a missing key on a warm connection, median of 7, Node): 140 and 119 ms
around the first Node matrix, 183 and 116 ms around the second.

**Node, part PUTs, MiB/s** (median of 6, min–max):

| Part | Concurrency 4 | Concurrency 6 | Concurrency 8 |
|---|---|---|---|
| 8 MiB | 60.5 (47.6–69.3) | 71.5 (21.5–100.9) | 108.0 (23.2–111.6) |
| 16 MiB | 76.3 (61.7–87.6) | 102.4 (94.8–120.3) | 122.7 (105.8–153.4) |
| 32 MiB | 75.1 (64.7–131.8) | 101.5 (22.6–126.5) | 116.5 (78.5–161.4) |

**Browser (headless Chromium), part PUTs, MiB/s** (median of 6, min–max):

| Part | Concurrency 4 | Concurrency 6 | Concurrency 8 |
|---|---|---|---|
| 8 MiB | 44.5 (21.2–63.9) | 72.0 (20.0–105.6) | 73.8 (67.8–101.9) |
| 16 MiB | 69.5 (20.6–87.6) | 99.2 (85.2–115.4) | 89.3 (68.8–105.8) |
| 32 MiB | 75.8 (66.9–91.0) | 102.8 (94.0–123.3) | 102.5 (22.8–136.8) |

Against 8 MiB parts at the same concurrency (medians):

| | Node, c4 | Node, c8 | Browser, c4 | Browser, c8 |
|---|---|---|---|---|
| 16 MiB, both matrices | +26 % | +14 % | +56 % | +21 % |
| 16 MiB, first matrix only | +28 % | +9 % | +51 % | +36 % |
| 16 MiB, second matrix only | +42 % | +17 % | +68 % | +18 % |
| 32 MiB, both matrices | +24 % | +8 % | +71 % | +39 % |
| 32 MiB, first matrix only | +8 % | +17 % | +83 % | +36 % |

What the numbers say:

- 8 MiB parts at concurrency 4 are the slowest cell in both runtimes (Node 60, browser 45 MiB/s): each part spends
  much of its life in TCP ramp-up over a ~120–180 ms round trip, as spec §5 expected from one 8 MiB PUT reaching
  ~17 MiB/s.
- **16 MiB passes the rule** (at least 15 % faster at concurrency 4 and not slower at 8, in Node and in the browser) in
  both matrices separately and together.
- 32 MiB is not better than 16 MiB: Node is level at concurrency 4 (75 vs 76) and slower at 8 (117 vs 123); the browser
  gains 9 % at 4. It also failed the rule in the first matrix alone (Node +8 % at 4), and it halves the parallelism a
  file can use and doubles what a retried part re-sends.
- More parallelism helps more than larger parts beyond 16 MiB: Node reaches 108–123 MiB/s at concurrency 8 with any
  part size. In the browser, concurrency 6 is as fast as 8 or faster for 16 and 32 MiB parts.
- **Stalls.** 9 of the 108 uploads (5 Node, 4 browser, every part size) took 11.1–12.8 s instead of 2–5 s. The browser
  half records the slowest part: in each of its four, one part took 10.4–11.2 s and then succeeded with 200. These are
  the 20–23 MiB/s minimums above. Only whole-part times were recorded, so whether those parts sent nothing or trickled
  for ten seconds is not known. A stall watchdog shorter than about 10 s would have cut them and re-sent the part.

**Recommendation: change the planner.** In `planParts` (`packages/cloudrop/src/plan.ts`), start at **16 MiB for files
of 256 MiB or more** and keep 8 MiB below:
`let partSize = Math.max(size >= 256 * MiB ? 16 * MiB : FIRST_PART_SIZE, rules.minPartSize);`. Doubling for the part
limit stays as it is (on R2 it now starts above 16 MiB × 10,000 = 156.25 GiB instead of 78.1 GiB), and so do the
64 MiB multipart threshold and equal parts. Files from 64 to 256 MiB were not measured, so they keep 8 MiB. No change to
the client's default concurrency of 4 follows from this, but concurrency 6 was 18–62 % faster than 4 for every part
size in both runtimes, which is evidence for Task 2's automatic sizing.

**Cleanup proof.** Each script registered every key and upload id before the request that could create it, aborted
every upload it had not completed, and deleted every key, also on failure and on SIGINT, SIGTERM or SIGHUP. Each
upload was deleted right after its `head`, so at most one 256 MiB object existed at a time. All four runs exited 0 with
nothing left to abort or delete, and a separate process re-listed the four prefixes afterwards (`ListObjectsV2` through
the driver and a signed `ListMultipartUploads`), 20:42:50 UTC:

```
live-test/cloudrop-54389fbd186ae09971fd09c77f17734a/: objects=0 multipart_uploads=0 truncated=false listings_ok=true   (browser, first)
live-test/cloudrop-7daf92ed9208256bdab4e067f8ffbad4/: objects=0 multipart_uploads=0 truncated=false listings_ok=true   (browser, second)
live-test/cloudrop-a687ddccb2a506d4102b645dc8bac9e2/: objects=0 multipart_uploads=0 truncated=false listings_ok=true   (Node, second)
live-test/cloudrop-f95ac80715849f69414523982edbed51/: objects=0 multipart_uploads=0 truncated=false listings_ok=true   (Node, first)
```

108 uploads, 27 GiB of part bodies in total. No bucket setting or CORS rule was read or written. The scripts were
one-off scratch code outside the repository; they printed numbers only, through `createRedactor`, and never a URL,
upload id or storage answer.

## Bad checksum, gone upload and throttling from a browser, 2026-11-16

Measured 2026-11-16, 23:54:05–23:56:35 UTC (2026-11-17 local time), on the same test bucket and CORS rule. Node
24.22.2 presigned with the `r2` driver (`presignPut`, `presignPart`; one row with `presignUrl`, see H1); Chromium
159.0.8154.6 headless shell, driven by Playwright 1.65.1, opened a blank page **served by a real HTTP server on
`http://localhost:5173`** and sent each PUT from it with `fetch` and with `XMLHttpRequest` (`Blob` bodies of 16
bytes). Recorded from the page: whether the answer was readable, the status, the S3 `<Code>` from the body and whether
`getResponseHeader`/`headers.get("retry-after")` returned a value. Chrome DevTools Protocol `Network` events added what
the page cannot see: the preflight's status and `access-control-allow-headers`, and the status and header names of a
blocked answer (`responseReceivedExtraInfo`). "Outside" is the same request from Node's `https` with
`Origin: http://localhost:5173`. Every request went under `live-test/cloudrop-<32 hex>/`; the scripts were scratch code
outside the repository and printed through `createRedactor`, never a URL, signature or upload id.

| Row | Request from the page | `fetch` | `XMLHttpRequest` | Preflight (R2's own) | Outside the browser |
|---|---|---|---|---|---|
| D1 bad checksum, single PUT | single PUT signed as the server signs it, plus `x-amz-checksum-crc32c` of other 16 bytes | **Readable** `400 BadDigest` | **Readable** `400 BadDigest` | `204`, allows `content-disposition, if-none-match, x-amz-checksum-crc32c, x-amz-meta-cloudrop-id` | `400 BadDigest` with `access-control-allow-origin`; HEAD absent on all three keys |
| D2 bad checksum, part | `UploadPart` with a wrong `x-amz-checksum-crc32c` signed by `presignPart` | **Readable** `400 BadDigest` | **Readable** `400 BadDigest` | `204`, allows `x-amz-checksum-crc32c` | `400 BadDigest` with CORS header; ListParts afterwards: 0 parts |
| N1 part of an aborted upload | parts 1–3 presigned, `abortMultipart`, then the PUTs (within 1 s) | **Readable** `404 NoSuchUpload` | **Readable** `404 NoSuchUpload` | `204` (no headers requested) | `404 NoSuchUpload` with CORS header; HEAD absent |
| H1 checksum header the rule lacks | PUT with `content-type` and a correct `x-amz-checksum-sha256`, both signed (`presignUrl`) | **Opaque**, `TypeError: Failed to fetch` | **Opaque**, `error` event, status 0 | **`403`**, no `access-control-allow-origin`; the PUT was never sent | `200` with CORS header, stored (the signed request itself is valid) |
| H2 unsigned extra header | a valid `presignPut` (`content-type`) plus `x-cloudrop-probe: 1` | **Opaque**, `TypeError: Failed to fetch` | **Opaque**, `error` event, status 0 | **`403`**, as H1 | not tried |
| T1 throttling | 10 concurrent PUTs of 16 bytes to one key with one URL (no `if-none-match`) | **Readable** `429 ServiceUnavailable`; `retry-after` **not readable** | **Readable** `429 ServiceUnavailable`; `retry-after` **not readable** | `204` ×10 | not tried |

H1 and H2 stored nothing (HEAD absent on each page key). T1 provoked a `429` in the first wave of every run, so the cap
of 300 requests was never approached: 30 burst requests in all over three runs, each run one wave of 10 within about
0.9 s. Run 1 (5 `fetch` + 5 XHR, interleaved): 2 `fetch` and 2 XHR got `429`, 6 got `200`; run 2 (the same mix): 3
`fetch` got `429`; run 3 (10 XHR): 3 got `429`. On the wire every `429` carried `access-control-allow-origin` and
`Retry-After: 5`, but the rule's `ExposeHeaders` (`ETag` and the two checksum headers) does not list `Retry-After`, so
neither API returns it to the page. The body code is `ServiceUnavailable`, as Q9 measured outside a browser.

*Update 2026-11-17:* the owner had `Retry-After` added to the rule's `ExposeHeaders` (`M3-K8`). A GET of a missing key
from both test origins now answers `access-control-expose-headers: ETag,Retry-After,x-amz-checksum-crc32c,
x-amz-checksum-crc64nvme`, so a page can read the `429`'s `Retry-After`. T1 was not re-run.

**Playwright answers preflights itself when a route is set.** A first run (23:54:05) routed `http://localhost:5173/` to
the blank page with `page.route`, as [Browser refusals and checksums](#browser-refusals-and-checksums-2026-11-16) did.
D1, D2, N1 and T1 came out exactly as above, but H1 and H2 **succeeded** (`200`, stored, readable). The reason is in
playwright-core 1.65.1 (`lib/coreBundle.js`, the Chromium network manager): with request interception on, Playwright
fulfils every intercepted CORS preflight with `204`, echoing the request's origin, method and requested headers, and R2
never sees it. So the **Preflight column of that earlier section is Playwright's echo, not R2's answer**. Its `fetch`
and outside columns stand: the actual PUT's answer comes from R2 and Chromium checks its CORS headers. Its statements
about which headers the rule allows rest on its outside `OPTIONS` control, which this run confirms from a real page
(D1, D2) and repeated at 23:54:32 with the same result: `204` with `access-control-allow-headers: content-type` for
`content-type`; `403` without CORS headers for `x-amz-checksum-sha256` (alone or with `content-type`),
`x-amz-sdk-checksum-algorithm`, `x-f1-probe` and `x-cloudrop-probe`, and for the origins `http://localhost:5174` and
`https://example.invalid`. The `204` answers say `access-control-allow-methods: PUT, GET, HEAD`. A browser test that
must see the bucket's preflight has to serve its page for real, without `page.route`.

What this means for cloudrop's client ([`client/bucket.ts`](../../packages/cloudrop/src/client/bucket.ts)):

- **D1, D2 `BadDigest`: readable.** `classifyAnswer(400, "BadDigest")` gives `rejected` with `uploadRejected(400)`, not
  retryable, through `fetch` and XHR alike. The client sends no checksum today, so it meets this only once it signs
  one. Then a `BadDigest` would mean the bytes sent differ from the bytes hashed (the file changed on disk, or the
  checksum was computed from other bytes), which is the case `signatureMismatch()` words ("Pick the file again"); the
  generic "refused the file (HTTP 400)" is accurate but less helpful.
- **N1 `NoSuchUpload`: readable.** `classifyAnswer(404, "NoSuchUpload")` gives `rejected`, `uploadRejected(404)`, not
  retryable; no renewal or retry is spent, which is right, because no new URL revives an aborted upload. Only a new
  upload does. *Update 2026-11-21:* the error is now `NO_SUCH_UPLOAD`, as the server reports it (`M9-H4`).
- **T1 `429`: readable.** `classifyAnswer(429, …)` gives `retry` with `storageBusy()` (`RATE_LIMITED`, retryable), as
  designed. `parseRetryAfter(null)` is 0, so the client retries on its own jitter (first retry within 0.5 s) instead
  of R2's 5 s. A bucket owner who wants the client to honour it must add `Retry-After` to the rule's `ExposeHeaders`
  (not tried). Same-key throttling needs concurrent writes to one key; cloudrop writes one key per file and parts of
  one upload did not throttle at 8 in parallel (Q9).
- **H1, H2, a header the rule does not allow: opaque**, through `fetch` and XHR alike, and before any byte is sent. The
  client takes the `opaque` row (renew once, retry within the budget, then the retryable `NETWORK_ERROR` of
  `bucketUnreachable()`), as that function's comment already assumed; this replaces the inference in
  [Browser refusals and checksums](#browser-refusals-and-checksums-2026-11-16) with a measurement. A missing
  `x-amz-checksum-crc32c` in a bucket's rule would therefore make every checksummed PUT fail as a network error.

**Cleanup proof.** Each run registered every key and upload id before the request that could create it, aborted every
upload and deleted every key at the end (also on error, a 10-minute watchdog, SIGINT, SIGTERM or SIGHUP), then listed
its prefix. The H1 outside control stored one object per run; T1 stored one key. A separate read-only process re-listed
the three prefixes (`ListObjectsV2` through the driver and a signed `ListMultipartUploads`), 23:56:35 UTC:

```
live-test/cloudrop-581921bae3394d918da4b3e8ab310683/: objects=0 multipart_uploads=0 truncated=false listings_ok=true   (run 1, routed)
live-test/cloudrop-a19b60d4b28d7898fdd2fa6e2011be58/: objects=0 multipart_uploads=0 truncated=false listings_ok=true   (run 2, served)
live-test/cloudrop-9a54765f1b93804dcb63a135a0c12ab3/: objects=0 multipart_uploads=0 truncated=false listings_ok=true   (run 3, XHR burst)
```

Runs 1 and 2 aborted 2 uploads and deleted 11 keys each; run 3 deleted 1. No bucket setting or CORS rule was read or
written; the `OPTIONS` control writes nothing. The page server on port 5173 and every browser were stopped at the end
of each run.

## Overlapping completions, 2026-11-17

Measured 2026-11-17, 08:27:50–08:29:50 UTC, on the same test bucket, for `M4-F12`: can a `/complete` retried while the
first `CompleteMultipartUpload` still runs get `NoSuchUpload` from ListParts or Complete before HEAD shows the object?
The server would then answer `NO_SUCH_UPLOAD` for a finished upload (`M3-U83`, "If wrong"). Bun 1.4.4 drove cloudrop's
own S3 driver (`createS3Driver`, R2 rules). Each trial created a multipart upload with `x-amz-meta-cloudrop-id`,
uploaded its 5 MiB parts through `presignPart`, then sent Complete A (with `If-None-Match: *`, as `/complete` does),
Complete B with the same part list a fixed delay after A, and ListParts plus HEAD from three pollers staggered by
35 ms until four rounds after A answered (433 HEADs and as many ListParts in all). The probe was scratch code outside
the repository; its output went through `createRedactor` and held no URL, credential or upload ID. Times are from the
start of Complete A.

| Parts (MiB) | Trials | Complete A took | Complete B 200 (B started after A) | Complete B `404 NoSuchUpload` (B started after A) |
|---|---|---|---|---|
| 4 (20) | 1 | 230 ms | 1 (0 ms) | 0 |
| 10 (50) | 16 | 215–380 ms | 6 (0–160 ms) | 10 (150–300 ms; 7 while A was still running) |
| 40 (200) | 4 | 242–304 ms | 1 (0 ms) | 3 (200, 400, 600 ms; 1 while A was still running) |
| 200 (1,000) | 2 | 589 and 357 ms | 1 (150 ms) | 1 (300 ms, while A was still running) |

- **No window in 23 trials.** HEAD saw the object before or as the first `NoSuchUpload` arrived: every HEAD that
  started after any `NoSuchUpload` answer (from ListParts or Complete B) returned the object with its `cloudrop-id`
  and size. The last HEAD that found nothing started 104–427 ms into A, at least 88 ms before A answered.
- **ListParts started during a completion answers `500 InternalError`**, in every trial (1–5 times each, 67 in all);
  once the object is visible it answers `NoSuchUpload`. `storageError` maps it to a retryable `STORAGE_ERROR`, so `/complete` answers
  retryable and the client's retry then finds the object through `completedBefore`.
- **Two overlapping completions both succeed when the second starts early** (up to 160 ms after the first here): 200
  for both, with `If-None-Match: *` on each, never `412`, so both `/complete` calls run `afterVerify` and
  `onComplete`, which `docs/guide/server.md` already asks to be idempotent by `file.id` (`M3-U84`). A later one, even while the
  first still runs, gets `NoSuchUpload`, and by then HEAD already shows the object.

Ruling (`M4-F12`): the window the audit feared was not observed, so `completedBefore` keeps answering `NO_SUCH_UPLOAD`
on the first HEAD that finds nothing. Unmeasured: completions far longer than 0.6 s (thousands of parts) and other
regions or load. Each run deleted its objects (1, 6, 10, 4 and 2) and aborted its uploads, then listed its
`live-test/cloudrop-<32 hex>/` prefix empty; no bucket setting was read or written.

## HEAD and compression, 2026-11-20

Measured 2026-11-20 on the same test bucket, after a production report from an application on cloudrop 0.1.0: the
bytes reached R2, then `/complete` answered `502 STORAGE_ERROR` because the driver's `HEAD` found no
`Content-Length`. Bun 1.4.4 drove cloudrop's own S3 driver (`createS3Driver`, R2 rules) through a
`fetch` wrapper that recorded `content-length` and `content-encoding` of each `HEAD` answer and, for the second
request, set `accept-encoding: identity` after signing. The runtime's `fetch` was told nothing else, so the first
request carried its default `accept-encoding` (gzip offered). Node 24.22.2 repeated the 56-byte rows with the same
results. Each object was put with the type shown and `a`
characters as its body: 56 bytes for the first six types, with both requests, and 1,000 bytes for the rest, with the
default request only.

| Type | Default `accept-encoding` | `accept-encoding: identity` |
|---|---|---|
| `text/plain`, `application/json`, `text/html`, `image/svg+xml` (56 bytes) | `content-encoding: gzip`, **no `content-length`** | `content-length: 56`, no encoding |
| `application/octet-stream`, `image/png` (56 bytes) | `content-length: 56`, no encoding | the same |
| `text/plain; charset=utf-8`, `text/markdown`, `application/javascript`, `application/xml`, `font/ttf`, `application/wasm` (1,000 bytes) | `content-encoding: gzip`, **no `content-length`** | not sent |
| `text/csv`, `application/pdf`, `application/x-ndjson` (1,000 bytes) | `content-length: 1000`, no encoding | not sent |

- **The threshold is 50 bytes.** A bisection on `text/plain` found 49 bytes answered with `content-length` and 50
  compressed; a 1 MiB `text/plain` object was compressed too. That is why the contract suite's 11-byte `text/plain`
  case never saw it.
- **Ranged `GET` is not compressed.** `Range: bytes=0-15` on a 1,000-byte `text/plain` object answered `206` with
  `content-length: 16` and no encoding, so the content sniff (`getRange`) was never affected.
- **Bun and Node behave alike**, so the cause is R2's answer to a request that offers gzip, not one runtime's `fetch`.
- `vary: Origin` came back on every answer of the 1,000-byte rows; R2 sent no `vary: Accept-Encoding`.

Ruling (`M7-P1`): the driver sends `accept-encoding: identity` on every `HEAD`, unsigned. The contract suite's
"reports the stored size of an object R2 would compress" case (56 bytes of `text/markdown`) failed on live R2 before
the change and passes after it; the fake R2 compresses the same way, so the unit lane catches a regression. Each probe
deleted its objects (12, 1 and 17) and listed its `live-test/cloudrop-gzipprobe-<uuid>/` prefix empty; no bucket setting
was read or written.

## Upload protocol edge cases, 2026-11-21

Measured 2026-11-21, 02:18–02:27 UTC, on a second bucket of the same account (location EEUR) with an Object Read &
Write token, for the hardening pass before 0.3.0 (`M9-H1` to `M9-H4`). Node 24.22.2 drove cloudrop's own code: the
handler (`createCloudrop` on `r2()`, threshold 8 MiB unless noted) called as a browser would, the `r2` driver for
storage-level rows, and `createCloudropClient` in Node (fetch path, `persist: false`) for the large file. Raw rows used
Node's `https` to send a body slowly. Each probe wrote under its own `live-test/cloudrop-<32 hex>/` prefix and printed
through `createRedactor`, never a URL, signature or upload ID. The probe scripts were scratch code in the worktree's
`.superpowers/r2-edge/`, not committed.

### Sizes, names and types

| Row | Measured | cloudrop |
|---|---|---|
| 0 bytes, 1 byte, threshold − 1, threshold | single `PUT`s, `200`, `/complete` `200`, HEAD size exact | as designed |
| threshold + 1 | two parts, 8 MiB and **1 byte**: both `200`, Complete `200`, the last 4 bytes read back equal | a 1-byte last part is valid on R2 |
| 2 × threshold + 1 | three parts (8, 8 MiB, 1 byte), `200` | as designed |
| parts of 5 MiB + 1 byte, and of 5 MiB − 1 + 1 byte | `200`; `400 EntityTooSmall` → `INVALID_PART`, the upload stays open (2 parts listed) | Q4 extended to the exact boundary; the planner never makes a part under 8 MiB |
| names in NFD and NFC | one stored disposition, NFC (`Am%C3%A9li%C3%A9.txt`) | the server normalizes names to NFC |
| right-to-left, quotes and backslash, `%`, `; filename=`, CR/LF, NUL, 255 ASCII, 255 emoji | all stored and verified; the fallback `filename` replaces non-ASCII, `"` and `\` with `_` (two `_` per emoji, one per UTF-16 unit), `filename*` percent-encodes the rest (`%0D%0A`, `%00`, `%22`, `%5C`, `%25`) | a 3.6 KB `Content-Disposition` (255 emoji) is accepted on the URL and at Create |
| 256 characters | `/upload` `400 INVALID_INPUT` | as designed |
| type `""`, `IMAGE/PNG`, a vendor type with capitals | stored as `application/octet-stream`, `image/png`, lower case | as designed |
| `text/plain;charset=utf-8`, `text/plain; charset=utf-8` | **refused**, `FILE_TYPE_NOT_ALLOWED` "The file's type is not a valid MIME type" | defect, fixed by `M9-H1`: stored as the essence |
| `image/svg+xml` | stored, `attachment` | as designed |
| metadata JSON 2,048 / 2,049 bytes | accepted / `INVALID_METADATA` | as designed |
| largest token: 2 KiB owner, 2 KiB metadata of `\u0001` escapes, a 255-character name of control characters, multipart | token 8,363 characters (cap 16,384); `/sign` and `/abort` `200` | an R2 upload ID is 343 characters |
| object metadata 2,048 bytes (name + value) | stored and read back exactly; 2,049 refused by the driver before any request | as designed |
| 300 MiB + 12,345 bytes through the real client in Node, concurrency `auto`, threshold 64 MiB | done in 3.4 s (87 MiB/s): one `/upload`, 19 parts of 16 MiB, one `/complete`, every answer `200`, at most **4** PUTs in flight, the SHA-256 of a full GET equal | per-file parallelism is fixed at 4 (`PARTS_IN_FLIGHT`, spec §6.1); `auto` sizes the pool across files |

**The longest `Content-Disposition`, pinned in the live lane (2026-11-21, `M11-R48`).** The 255-emoji row above is
the longest header `/upload` can sign: an astral character costs 12 bytes in `filename*` (`%F0%9F%98%80`) and two `_` in
the fallback, 14 bytes per code point against 10 for a three-byte character and 4 for an ASCII one that needs encoding,
so 255 of them with `attachment; filename="…"; filename*=UTF-8''…` come to **3,612 bytes**. R2 took that header as a
signed header of the presigned single `PUT` (`200`) and of `CreateMultipartUpload`, completed both uploads and returned
the header byte for byte on `HEAD`. `handler.r2.integration.test.ts` ("stores the longest file name, 255 emoji, …") now
runs this on every `bun run test:live`, so `/upload` neither refuses nor shortens a name.

### Keys

Keys written by the driver (header-signed `PUT`), then HEAD, `ListObjectsV2` with the key as prefix, a presigned `PUT`
and `GET`, and `copy`: space and `+`, `%`, `?`, `&`, `=`, `#`, `!$&'()*+,;=`, `-._~`, ``@:[]{}|^`<>"``, `\`, emoji, Arabic,
a trailing space, `..` inside a segment, 40 segments, and a key of exactly 1,024 bytes. **Every one round-tripped**: the
listing returned the key as written, and the presigned GET returned the bytes.

**R2 treats the NFC and NFD forms of a key as one key.** Writing `café` in NFC and then in NFD leaves one object, which
both forms read; the listing returns the form of the **last write**, also when listed with a prefix in the other form; a
`DELETE` in either form deletes it; a create-only `PUT` in the NFC form of a key written in NFD answers `412`.
cloudrop's server normalizes every key to NFC, so its own uploads never alias. A key written in NFD by other code
(`api.put` does not normalize) is listed in NFD, so a caller comparing listed keys with an NFC prefix by string sees it
outside the prefix.

### Time

| Row | Measured | cloudrop |
|---|---|---|
| presigned `PUT` and header-signed `HEAD` and Create, signing clock off by −3600, −900, −600, +300, +600, +840, +900, +960, +1200 s (URL `expiresIn` 900) | header-signed: accepted from −600 to +900 s, `403 RequestTimeTooSkewed` at −900 and from +960 s. Presigned: `ExpiredRequest` once the URL's end has passed, `RequestTimeTooSkewed` from +960 s. **R2's tolerance is 15 minutes either way**: the −900 s request reached R2 a
little more than 900 s after its signing time, the +900 s one a little less | `storageError`'s "more than 15 minutes off" is right |
| the same `HEAD`, refused | a bare `403` with **no body and no `x-amz-error-code`**; header names `cf-ray, connection, content-encoding, content-type, date, server, vary`. Only `date` (±1,200 s from the signing time) tells it from a wrong secret (`date` within 0 s) | defect, fixed by `M9-H2` |
| single `PUT` and UploadPart whose URL expires 3 s in, body sent over 8 s | **`200` and stored** (8 MiB, 5 MiB): R2 checks the expiry when the request starts | the client's 60 s renewal margin is enough for any part; see `M9-H3` |
| single `PUT` started 2.5 s after a 1-second URL | `403 ExpiredRequest` | renewed once by the client |
| a token 2 s from its deadline: `/sign`, `PUT`, `/complete` 2.5 s later | URL signed (lifetime under a second by the server's count), `PUT` `200`, `/complete` **`410 UPLOAD_EXPIRED`**, `/abort` `200` keeping the 8-byte object | defect, fixed by `M9-H3` |
| `api.getUrl(key, { expiresIn: 302400, download })` | signed 181,211 s (2.1 days) earlier at its window's start with `X-Amz-Expires=604800`: `200`, and the download name with `é`, CR/LF and `"` came back as `attachment; filename="rapport _t____x_.txt"; filename*=UTF-8''rapport%20%C3%A9t%C3%A9%0D%0A%22x%22.txt` | the windowed signing time is safe on R2 |
| presigned `GET` signed 1, 3.5 and 6.9 days ago, `expiresIn` 604800 | `200` each: R2 accepts an old `X-Amz-Date` while the URL lasts | |
| presigned `GET` signed 5, 10, 14 and 16 minutes ahead | `200`, `200`, `200`, `403 RequestTimeTooSkewed` | |

### Concurrency and replays

| Row | Measured | cloudrop |
|---|---|---|
| one create-only single-PUT URL twice in a row | `200`, `412` | as Q3 |
| the same URL 2, 5 and 10 times at once | one `200`, the rest `412`, never `429`; `/complete` `200` | the client counts `412` as stored |
| a create-only `PUT` retried 1 s into a first attempt that sends 8 MiB over 8 s | the retry `200` in about 0.3 s; the first attempt `412` when its body ends, or `ECONNRESET` when cut at 4 s; the retry's bytes are stored, both rounds of both variants | **`If-None-Match` is checked when the body ends**, so a `412` means an object is there: the client's "412 is stored" (spec §5.4) holds even when the first attempt is still sending |
| two single PUTs of two uploads to one fixed key at once (3 rounds) | one `200`, one `412`; the loser's `/complete` `422 VERIFICATION_FAILED` (another writer's id, object kept) | as designed |
| two multipart uploads to one key completed at once (3 rounds) | one `200`, one `409 ALREADY_EXISTS`, never two `200` | conditional Complete is atomic |
| 16, 32 and 64 UploadParts of 1 MiB at once on one upload | all `200`, no `429` (387–648 ms) | Q9 extended from 8 |
| **8 copies of part 1 with different bytes at once** | all `200`, 8 different ETags, and in 2 of 3 runs **ListParts listed no part 1**, also 3 s later; Complete with a returned ETag `400 InvalidPart`. In the third run copy 7 was kept | R2 can lose a part every `PUT` of which was acknowledged. `/complete` lists the parts itself (`M2-D19`), so it answers `PARTS_MISSING` and the client sends the part again. The client starts no second copy of a part while its own first copy is in flight; a copy it gave up on (stall, pause) may still be arriving, which the 2-copy rows cover |
| 2 copies of one part at once (different or same bytes, or 100 ms apart; 5 MiB and 64 KiB; 3 rounds each) | both `200`; one part is listed (the second sent, in every run) and completes | a re-send after a stalled attempt is safe |
| part 1 sent again with its URL: same bytes, then other bytes | `200`, one part listed each time; Complete keeps the last bytes | Complete uses ListParts' ETags |
| `/complete` 5 at once, single and multipart | all `200` (single: each HEAD verifies; multipart: as `M4-F12`) | onComplete runs more than once, as documented |
| `/abort` 0, 50, 150, 300 ms after `/complete` (5 parts) | 0 and 50 ms: `/complete` `410 NO_SUCH_UPLOAD`, nothing stored. 150 ms: `/complete` `200`, `/abort` **`503 RATE_LIMITED`**, object kept. 300 ms: both `200`, object deleted | the stateless `/abort` deletes this upload's object while the token lives (`M3-U94`); a store's row closes that |
| AbortMultipartUpload 0, 20, 60, 120 ms into CompleteMultipartUpload | 0 and 20 ms: Complete `404 NoSuchUpload`, nothing stored. 60 ms: Complete `200`, Abort **`429 ServiceUnavailable`**. 120 ms: both succeed, the object stays | an Abort racing a Complete is throttled like a same-key write; no partial object was ever seen |
| an upload aborted behind the server, then `/sign`, a part `PUT`, `/complete` | `/sign` `200`, `PUT` `404 NoSuchUpload`, `/complete` `410 NO_SUCH_UPLOAD` | the client called the `404` `UPLOAD_REJECTED`; fixed by `M9-H4` |

### What this means for cloudrop

- **Fixed:** `M9-H1` (a type with parameters is stored as its essence), `M9-H2` (a skewed `HEAD` reports the clock),
  `M9-H3` (every URL ends 15 minutes before its token, since R2 checks expiry at the request's start) and `M9-H4` (a
  part sent to a gone upload is `NO_SUCH_UPLOAD`). The fake R2 now sends `Date` on every answer and no body on `HEAD`.
  The live lane proves `M9-H1`, `M9-H2` and `M9-H4` on R2.
- **Relied on, now measured:** a `412` on a create-only retry means an object is stored, even while the first attempt
  still sends; a URL expiry is checked once, at the start; the clock tolerance is 15 minutes either way, which
  `storageError`'s message already said.
- **R2 behaviour cloudrop already absorbs:** a part lost among concurrent copies (ListParts at `/complete`); `429` on an
  Abort racing a Complete (retryable); the NFC/NFD key equivalence (keys are NFC).
- **Not cloudrop's to fix here, reported:** `api.deletePrefix` compares listed keys with its prefix by string, so a
  prefix with non-ASCII characters under which other code wrote an NFD key would stop as "outside the prefix"; the
  stateless `/abort` racing a finished `/complete` deletes the object (`M3-U94`, documented).

**Cleanup proof.** Each probe registered every upload ID before using it, aborted every upload and deleted every key
under its prefix in a `finally` (also on SIGINT, SIGTERM or SIGHUP), then listed the prefix with `ListObjectsV2` and
`ListMultipartUploads`. Every run ended with `objects=0 uploads=0`:

```
live-test/cloudrop-b0ac3a8ffbc5ac64c3a09140443241b5/  sizes and names   deleted 21  left objects=0 uploads=0
live-test/cloudrop-40663efbfaa7550dd1ce3394c85f3480/  time              deleted 8   left objects=0 uploads=0
live-test/cloudrop-75fbdc614342bfec91c1884a51a56736/  refused HEAD      deleted 1   left objects=0 uploads=0
live-test/cloudrop-7ffff853792d41ab985a6e9fac1c9466/  races             deleted 16  left objects=0 uploads=0
live-test/cloudrop-aa57f48f439655a7c687c449c5c29aa1/  same part         deleted 13  left objects=0 uploads=0
live-test/cloudrop-f0ed8cdca522aaab4585697ec86cf5e3/  300 MiB client    deleted 1   left objects=0 uploads=0
live-test/cloudrop-987df2bc9c0042c48c116aa6db9db4ab/  keys              deleted 43  left objects=0 uploads=0
live-test/cloudrop-97b4614299b8c6bfe82206f4d12c4519/  NFC and NFD keys  deleted 1   left objects=0 uploads=0
live-test/cloudrop-a43618d161f43970185b9c0bf08d7e1c/  in-flight 412     deleted 4   left objects=0 uploads=0
```

No bucket setting was read or written, and nothing outside these prefixes was touched.

### One key in two Unicode forms, through deletePrefix

Measured by the coordinator on the development bucket: an object put at `<prefix>Ame\u0301lie/a.txt` (NFD) was listed,
in NFD, both for the NFD prefix and for `<prefix>Am\u00e9lie/` (NFC). `api.deletePrefix` on the NFC folder then
refused the page as keys outside the prefix; with keys compared in NFC it deleted the object (`M9-H6`).

### An unknown access key

Measured the same day on the same bucket by the coordinator, with the `r2` driver signing for an access key ID of 32
zeros: `HEAD` answered a bare `401` (no body), and a `ListObjectsV2` `401` with `<Code>Unauthorized</Code>`. cloudrop
read both as a generic `STORAGE_ERROR` that pointed at the object key; it now reports `STORAGE_DENIED` with the
credentials to check (`M9-H5`).

### Non-ASCII bytes in stored headers, and a copy in parts

Measured 2026-11-21 on the test bucket for `M11-R25`, with a scratch probe (not committed) that signed raw `PUT`s with
cloudrop's signer, sent the header value as the UTF-8 bytes of `café` (`63 61 66 c3 a9`), and used the `r2` driver for
`HEAD` and `copy`, with `maxSinglePutSize` lowered to 5 MiB for the copy in parts.

| Row | Measured |
|---|---|
| `PUT` with those bytes in `x-amz-meta-note`, `content-disposition` or `content-type`, signed over the bytes | `200` each: R2 stores non-ASCII header bytes |
| the same, signed over the UTF-8 of the byte string `Headers.get()` returns (`c3 83 c2 a9`), as cloudrop's signer did | `403 SignatureDoesNotMatch` each |
| `HEAD` of the stored objects | `content-disposition` and `content-type` come back as the raw bytes (`… 63 61 66 c3 a9 …`); the metadata value comes back in ASCII as the RFC 2047 word `=?utf-8?Q?caf=C3=A9?=` |
| `copy` in parts of a 5 MiB + 1 KiB object with that disposition, before the fix | `403 SignatureDoesNotMatch` at CreateMultipartUpload, reported as `STORAGE_DENIED`; nothing left behind |
| the same after the fix (the signer hashes such a value as its bytes) | `200`; `HEAD` of the copy returns the same disposition bytes |
| a single `copy` of the same object | `200` before and after: CopyObject sends no stored header, and the disposition is kept |

Four runs, each under its own `live-test/cloudrop-<32 hex>/` prefix, each ending with `left objects=0`.

### How R2 canonicalises a header value: UTF-8 first, then white space

Measured 2026-11-21 on the test bucket for `M11-R252`, with a scratch probe (not committed) that signed raw `PUT`s
with `node:crypto`, not with cloudrop's signer. Each row sent a `content-disposition` as the bytes named and signed a
canonical request holding another form of them; `200` means R2 computed that form.

| Bytes sent in the value | Canonical form R2 accepted (`200`) | Forms it refused (`403 SignatureDoesNotMatch`) |
|---|---|---|
| `voilà`: `… c3 a0 …` | the bytes as sent | `a0` made a space |
| ends with `你`: `… e4 bd a0` | the bytes as sent | the last byte trimmed |
| two spaces, three spaces | one space | as sent |
| a tab; two tabs; space, tab, space | one space | as sent; one tab; two spaces |
| a no-break space `c2 a0`, between words | one space | as sent |
| two no-break spaces `c2 a0 c2 a0` | one space | as sent; one no-break space |
| a no-break space at the end | trimmed | as sent |
| two ideographic spaces `e3 80 80 e3 80 80` | one space | as sent |
| two U+2028 `e2 80 a8`, two U+FEFF `ef bb bf` | one space | as sent |
| two U+0085 `c2 85`, two U+200B `e2 80 8b` | the bytes as sent | one space |
| a lone `e9` (not UTF-8) | `ef bf bd` (U+FFFD); R2 also **stores** `ef bf bd` | as sent; `c3 a9` |
| two lone `a0` (not UTF-8) | not found: the U+FFFD form was not tried for this row | as sent; one space |

R2 reads the value's bytes as UTF-8, replacing what is not UTF-8 with U+FFFD, then trims and collapses exactly the
characters JavaScript's `\s` matches (U+FEFF and U+2028 are white space, U+0085 and U+200B are not), and hashes the
result as UTF-8. Every accepted row was stored with the bytes as sent, except the lone `e9`. So a stored value R2
returns is always UTF-8, and AWS's rule ("trim any leading or trailing spaces", "convert sequential spaces to a single
space") holds for the characters the bytes spell, not for the bytes. RustFS 1.0.5 passed the same signatures for the
rows it could be asked (as sent for `c3 a0`; one space for tabs and for `c2 a0`), then refused the non-ASCII
disposition itself with `400`.

A copy in parts of a 5 MiB + 1 KiB object whose disposition is `attachment; filename=voil` + `c3 a0 c2 a0 e4 bd a0`:
before the fix the raw `PUT` that stores the source answered `403` with cloudrop's signer; after it the `PUT`, the
copy and the `HEAD` of the copy succeed and the copy's disposition holds the same bytes
(`src/storage/s3/copy.r2.integration.test.ts`). Three probe runs, each under its own `live-test/cloudrop-<32 hex>/`
prefix, each deleted by its teardown.

### A completion whose parts are listed out of order

Measured 2026-11-21 on the test bucket with a scratch probe (not committed): a multipart upload of two parts (5 MiB
and 1 KiB), completed with a raw `CompleteMultipartUpload` that lists part 2 before part 1. R2 answered `200` and
stored the object. AWS S3 documents `400 InvalidPartOrder` for that request ("The list of parts was not in ascending
order", API Reference, CompleteMultipartUpload), and R2's error list
(https://developers.cloudflare.com/r2/api/error-codes/) has no such code. cloudrop's driver sorts the parts before it
sends them, so neither answer is reached through it; `storageError` maps the code to `INVALID_PART` for S3. The fake
R2 (`src/testing/fake-r2/multipart.ts`) answers `InvalidPartOrder` here, which is S3's answer, not R2's.

## Store, sweep and owner files under real latency, 2026-11-21

Measured 2026-11-21 on a second bucket (`vstack-dev`, EEUR, an object read/write token), for `M9-H50` to `M9-H52`.
Node 24.22.2 ran a real cloudrop server in-process (`createCloudrop` with the `r2()` preset) on a real store: Postgres
18.6 in Docker through `pgExecutor`, in lease mode and with `transaction: true`, and SQLite through `node:sqlite`.
Requests went through `cloudrop.handler`; every `PUT` went to R2 over HTTPS with the URL the server signed. No clock was
driven: R2 signed and checked every URL in real time. Where a probe needed a row to look older (the sweep's expire pass,
an expired lease), it moved the row's time columns back in the database and sent no `PUT` with that row's URLs
afterwards, so no URL outlived its row's recorded times. The settle rows waited for real: 31 minutes against the
minimum grace of 15. Output went through `createRedactor`; it held no URL, credential or upload ID.

| Probe (each on SQLite, Postgres lease and Postgres transaction mode unless noted) | Measured |
|---|---|
| Two replacing completions of one owner at once, 6 rounds, half with a previous file | Always both 200, one completed file, one object, usage `files: 1`, reserved 0 |
| A replacing completion racing `deleteFile` of the file it replaces, 4 rounds | Always: old object gone, new kept, `activeBytes` of the new file only |
| `eraseOwner` while `onComplete` runs | Lease: `waiting: 1`, `done: false` in 1–2 ms; transaction mode: still waiting after 5 s, until `onComplete` returned (`M9-H52`). The next run deleted the file and removed its object |
| `eraseOwner` while an `/upload` reserves mid-run | `done: false` (the new row seen as waiting); the next run revoked it |
| `eraseOwner` while the file's `PUT` is under way (4 MiB) | Revoked, `done: false`; the `PUT` landed (200); the next run removed it; `/complete` answered `410 UPLOAD_EXPIRED` |
| `revokeUploads` racing `/complete`, at 0–240 ms | At 0 ms the revoke won (`410`, usage zero, object left for the sweep); later the completion won (`revoked: 0`) |
| Two sweeps at once over 6 expired uploads | `expired` 3 + 3, nothing failed, every object removed, reserved 0 |
| A sweep racing a completion whose lease and row deadline ran out | Lease: ended `failed` and reported, completion `500`, retry `410`, object kept (`M5` sweep); transaction mode: the sweep waited for the row lock (> 3 s) and the completion won |
| Two `eraseOwner`, two `sweep({ all })` and a `deleteFile` at once | Nothing failed, every object removed, usage zeros, both runs `done: true`; each sweep counted the same 2 rows in `cleaned` (`M9-H52`) |
| 8 concurrent `/upload` of 1,000 B under a 3,000 B quota | Exactly 3 reserved |
| Quota lowered between `/upload` and `/complete`; replace under a quota; usage after `eraseOwner` | The reserved file completed; a second 600 B file under 1,000 B was refused, a 400 B one replaced it; zeros after erasure |
| `reconcile` after corrupting, then deleting, the usage row with 4 reserves racing | Repaired to the recount each time; a repeat repaired nothing |
| `api.files` with `limit: 1` over 6 files, 5 sharing `created_at`, one deleted between pages | Descending ids, no duplicates, the deleted unread file absent; `limit` 0, 1001 and 1.5 refused |
| File API with a NUL character, or a cursor time after 9999 | Postgres: every call answered a retryable `SERVER_ERROR` (fixed, `M9-H51`); SQLite answered normally |
| A Postgres connection killed while `onComplete` runs | Lease: no effect (no connection held), 200. Transaction mode: the process got two uncaught errors from node-postgres (fixed, `M9-H50`); the completion answered retryable, the row stayed `pending` and the retry completed |
| R2 `DELETE`, then `HEAD`, answering 503 under `deleteFile` and `eraseOwner` | `deleteFile` answered the error with the row already deleted; each retry checked the key again, the third removed the object; `eraseOwner` counted `failed: 1`, then removed it |
| `store.complete` failing once after `onComplete` (lease mode) | Retryable error; busy until the lease ran out; then completed (`onComplete` ran twice, as `M5` documents); with `replace`, the old file stayed until the retry recorded the new one |
| The sweep's `cleaned()` failing once after the object was removed | `failed: 1`; the next eligible sweep marked the row |
| `AbortMultipartUpload` for a completed upload, and twice for one upload | The driver answered success each time, so the sweep and `eraseOwner` converge on refused multipart files |

Late writes, in real time (both Postgres lease and SQLite; T0 is when the URLs were signed):

- A duplicate `PUT` with a still-valid URL **landed again** (200) after `deleteFile`, after `/abort`, after
  `revokeUploads`, after an `eraseOwner` run and after the file was replaced: each key was empty, so
  `If-None-Match: *` let it through.
- A `PUT` started at T0 + 14.5 min, 30 s before its URL ran out, trickled its body for 70 s and **was accepted (200) at
  T0 + 15.6 min**: R2 checks a presigned URL's expiry when the request starts, not when it ends. That is what the grace
  is for (`M8-A4`).
- A `PUT` with the same URLs at T0 + 16 min answered `403`.
- At T0 + 1 min the sweep found nothing to clean up (ended less than the grace ago); at T0 + 16 min it removed every
  late object but marked no row, `cleaned: 0`; at T0 + 31 min it marked all 7 rows, `cleaned: 7`, and `eraseOwner`
  then answered `done: true` without checking again. A replacement whose `DELETE` failed (503 injected) was finished by
  the same sweep. No object survived its row's settle time.

Not measured: R2 under load or in other regions, Prisma and Drizzle in the late-write rows (they share the SQL core),
D1 against real R2. Each probe run tore down its prefix and listed it empty (`live-test/cloudrop-<32 hex>/`); two runs
that the probe harness itself stopped early were cleared by hand from their logged ids and listed empty. One
multipart upload, left open by a probe that failed before registering it, was found by listing the bucket's open
uploads and aborted; the listing then showed none. No bucket setting was read or written.

## setup writes on R2, 2026-11-21

Measured by the coordinator on the owner's development bucket (EEUR) at the owner's request, with an R2 Admin Read &
Write token, after backing up the bucket's CORS and lifecycle rules with Wrangler. The command was the built
`dist/cli.js`.

| Row | Measured | cloudrop |
|---|---|---|
| Object tokens (the test bucket's and the development bucket's) | `GetBucketCors` and `GetBucketLifecycleConfiguration` `403` | `doctor` reports `NOT CHECKED`, as `M9-C2` says |
| Admin token: `doctor` for the bucket's two origins | CORS and lifecycle read; `ok` for both | as designed |
| `setup --apply` for `http://localhost:5173` and `http://127.0.0.1:5173` | `PutBucketCors` with `x-amz-checksum-sha256` `200`; Wrangler lists the bucket's own rule unchanged and cloudrop's beside it | `M9-C3`, `M9-C6` hold on R2 |
| The same `--apply` again | reads rule `cloudrop-uploads` back by its `ID`; writes nothing | R2 keeps CORS rule IDs |
| Lifecycle | the bucket's `Default Multipart Abort Rule` already aborts after 1 day: nothing written (`M9-C7`) | as designed |
| `PutBucketLifecycleConfiguration` with that rule (from its `sourceXml`) and a temporary prefixed rule | `200`; both read back with their IDs, prefixes and days | R2 keeps lifecycle rule IDs and fields |
| `test:browser:live` (the Next example, two passes) against this bucket | 27 + 3 passed through the rule `setup` wrote; 30 objects deleted | the written rule is enough for real browser uploads |
| Restore | the temporary rule and `cloudrop-uploads` removed through the same writes; Wrangler's listing identical to the backup | |

## The first 4 KiB of small objects, 2026-11-21

Measured for `contentChecks()` (`M10-K6`) on the test bucket with the S3 driver: one object per size written as
`text/plain`, then `getRange(key, 0, 4095)` and `getRange(key, 0, size - 1)`. The prefix was deleted and listed empty.

| Object size | `Range: bytes=0-4095` | `Range: bytes=0-<size - 1>` |
|---|---|---|
| 0 bytes | `416 InvalidRange` | `bytes=0-0`: `416 InvalidRange` |
| 1 byte | `206`, `content-range: bytes 0-0/1`, 1 byte | the same |
| 100 bytes | `206`, `bytes 0-99/100`, 100 bytes | the same |
| 4,096 bytes | `206`, `bytes 0-4095/4096` | the same |
| 5,000 bytes | `206`, `bytes 0-4095/5000`, 4,096 bytes | `bytes=0-4999`: `206`, 5,000 bytes |

No answer was compressed. The fake R2 answers the same way (`416` for a range that starts at or past the end, a range
past the end clamped), so the unit lane covers it; `contentChecks()` reads nothing of an empty file and asks for
`min(size, 4096)` bytes otherwise.

## Which CORS rule answers when several match, 2026-11-21

Measured on the test bucket with the owner's permission (an admin token, the S3 API; the bucket's own rule was kept in
place during the run and the configuration restored afterwards, read back identical). Two rules for one made-up
origin were added after the bucket's rule, in both orders, and then with the first one's origin as `*`:

- rule A: methods `GET`, `PUT`, `HEAD`, headers `*`, exposes `x-rule-a`, max age 111;
- rule B: methods `GET`, `PUT`, header `content-type`, exposes `ETag` and `x-rule-b`, max age 222.

| Stored order | Preflight `PUT` + `content-type` | Preflight `PUT` + `x-other` | Preflight `HEAD` | `GET` exposes |
| --- | --- | --- | --- | --- |
| A, B | A (max age 111) | A | A | `x-rule-a` |
| B, A | B (max age 222) | A | A | `ETag,x-rule-b` |
| A (`*`), B | A, `Allow-Origin: *` | A | A | `x-rule-a` |
| B, A (`*`) | B | A, `Allow-Origin: *` | A | `ETag,x-rule-b` |

Three preflights per configuration answered the same. **R2 answers with the first rule, in stored order, that matches
the whole request: the origin, the method and every requested header.** A rule that matches the origin but not the
method or a requested header is passed over, and the next one is tried. The headers of the answer (allowed methods,
max age, exposed headers) come from that one rule only; rules are never merged. This is what the S3 user guide
documents for S3 ("uses the first `CORSRule` rule that matches"). So an earlier rule with origin `*` that allows `PUT`
and any header, but does not expose `ETag`, answers cloudrop's uploads instead of cloudrop's own rule stored after it.
A changed configuration answered within 35 seconds.

## Missing CORS origin and bad signature from a browser, 2026-11-22

Measured 2026-11-22, 09:34:58–09:35:19 UTC, on the same test bucket and its unchanged CORS rule
`cloudrop-browser-tests` (which lists `http://localhost:5173` and `http://127.0.0.1:5173`, not port 5174), for
`M12-E7`. Chromium 159.0.8154.6 headless shell, driven by Playwright 1.65.1 under Bun. Method: a one-off script
(deleted afterwards) served a blank page, the bundled `cloudrop/client` and cloudrop's handler on `r2()` from both
`http://localhost:5174` and `http://localhost:5173`, and uploaded one `text/plain` file per case with
`client.start()` (single PUT, `persist: false`). An init script attached listeners to each PUT's XHR and its `upload`
before `send()`, recording event types, times from `send()` and `loaded`; the preflights and their CORS errors came
from Chrome DevTools Protocol `Network` events. No URL was recorded. For the bad-signature cases the init script
flipped the last hex digit of `X-Amz-Signature` in the PUT's URL. Every object went under one
`live-test/cloudrop-<32 hex>/` prefix; `deletePrefix` deleted 1 object (case C) and the prefix then listed 0.

| Case | Preflight | XHR events of each PUT (ms from `send()`) | Page ended with |
|---|---|---|---|
| A: origin `:5174` (not in the rule), 14 B | `403`, both times; the PUT failed `net::ERR_FAILED`, `PreflightMissingAllowOriginHeader` | `upload.loadstart` 0, `upload.error` at 67 and 23, `loaded` 0; no `upload.progress` | `BUCKET_BLOCKED`, not retryable, after 2 PUTs and one `/sign`, 456 ms from `start()` |
| E: origin `:5174`, 1 MiB | `403`, both times, as A | `upload.error` at 50 and 24, `loaded` 0; no `upload.progress` | `BUCKET_BLOCKED` after 2 PUTs, 154 ms |
| B: origin `:5173` (in the rule), 14 B, bad signature | `204` each time | `upload.progress` with `loaded` 14, `upload.load`, then `xhr.error`, all at 42–74 ms; the PUT failed `MissingAllowOriginHeader` | `NETWORK_ERROR`, retryable, after 6 PUTs, 9.3 s |
| D: origin `:5173`, 1 MiB, bad signature | `204` each time | `upload.progress` with `loaded` 1,048,576, `upload.load`, `xhr.error`, all at 109–131 ms | `NETWORK_ERROR` after 6 PUTs, 9.7 s |
| C: origin `:5173`, 14 B, good (control) | `204` | `upload.progress` 14 at 151 ms, `xhr.load` 200 at 259 ms | done |

What this means for cloudrop:

- **A rule that misses the origin** fails the preflight, so the body never leaves and Chromium fires no
  `upload.progress` before the error, whatever the body's size: the `M12-E7` rule fires as designed, at about two
  round trips plus one backoff wait.
- **A bad signature** (R2's pre-authentication `403` without CORS headers, as in R1 of
  [Browser refusals and checksums](#browser-refusals-and-checksums-2026-11-16)) passes the preflight and sends its
  body; Chromium reports the whole body in `upload.progress` before `onerror`, even for 14 bytes. The rule does not
  fire, and the client keeps its six attempts and `NETWORK_ERROR`. No time limit on the first failure is needed, so
  `M12-E8` was not written.
- The last PUT of each case shows no `xhr.error` in the table because the client's own `onerror` ended the job, and the
  page read the record, before the probe's later listener on the same event ran; the CDP failure confirms the error.
- Not measured: Firefox and Safari, a part of a multipart upload (the unit and browser-chaos lanes cover parts), and a
  header missing from the rule rather than the origin (the same preflight `403` by the [cors] rules, not tried here).

## Not verified

- **Checksum headers from a browser:** a correct CRC32C was measured in
  [Browser refusals and checksums](#browser-refusals-and-checksums-2026-11-16); a wrong one (`400 BadDigest`,
  readable) and a checksum header the rule does not allow (opaque) in
  [Bad checksum, gone upload and throttling](#bad-checksum-gone-upload-and-throttling-from-a-browser-2026-11-16). A
  browser PUT with `x-amz-checksum-crc64nvme` was not tried.
- **Other refusals from a browser:** `400 EntityTooSmall`/`InvalidPart` (Complete is server-side) were not tried. The
  rest are measured in the two browser-refusal sections. `Retry-After` on a `429` with `Retry-After` in the rule's
  `ExposeHeaders` was not tried (the rule was not changed).
- **R2's own preflight answers in [Browser refusals and checksums](#browser-refusals-and-checksums-2026-11-16):** that
  run used `page.route`, so its preflights were answered by Playwright (see
  [Bad checksum, gone upload and throttling](#bad-checksum-gone-upload-and-throttling-from-a-browser-2026-11-16)). Its
  R1–R4 and C1–C2 rows were not repeated with a served page.
- aws-chunked / `STREAMING-UNSIGNED-PAYLOAD-TRAILER` uploads (open item 4). Only plain `Transfer-Encoding: chunked` was
  tried (Q17).
- Bucket lifecycle rules (not read; `GetBucketLifecycleConfiguration` not attempted) and the default 7-day multipart
  abort.
- Parallelism above 8 parts, sustained load, and any limit over a longer window.
- What Complete does when a listed part lacks a checksum on a CRC32C upload (part 3 in Q5 was left out of the Complete).
- Composite checksums with more than 2 parts, SHA-1/SHA-256/CRC32 algorithms, and `Content-MD5` (the earlier spike
  measured Content-MD5 rejection on PUT and UploadPart).
- Checksums on copied objects and `cf-copy-destination-if-*` on copy. (`UploadPartCopy` with `x-amz-copy-source-range` was verified later by the contract's live lane: [test-backends.md](test-backends.md).)
- Jurisdiction endpoints, virtual-host addressing with the own presigner (the SDK runs used path style), Infrequent
  Access storage class.
- A Complete whose request is lost and retried. Inferred from Q11: the retry gets `NoSuchUpload`, which the client
  must reconcile with HEAD. A retry that overlaps the first Complete was measured in
  [Overlapping completions](#overlapping-completions-2026-11-17).
- RustFS/SeaweedFS uneven-part behaviour (open item 7). This spike touched only R2.
- `accept-encoding: identity` on a `HEAD` sent from a Cloudflare Worker to the R2 S3 endpoint
  ([HEAD and compression](#head-and-compression-2026-11-20) measured Bun and Node). The header is sent unsigned, so a
  runtime that replaced it would leave the request valid and the answer as it was before `M7-P1`.
- The `r2/reference/limits` page from the brief: the R2 limits live at `r2/platform/limits` ([limits]).

## Cleanup proof

Every key and upload id was registered before or immediately after creation. Each run then aborted every upload,
deleted every key, and listed its prefix for both objects and multipart uploads. An independent read-only script
([`verify-empty.ts`](../../spikes/r2/verify-empty.ts)) re-listed all five prefixes after the processes had exited:

```
spike/cloudrop-9488970ab3f847bef89c8cd026cc5ba8/ objects=0 multipart_uploads=0 truncated=false listings_ok=true   (smoke run, Q8)
spike/cloudrop-0cce3b4333e00ee0c1ac307bf680892a/ objects=0 multipart_uploads=0 truncated=false listings_ok=true   (full run Q1–Q14)
spike/cloudrop-0c4b4e4b8723d37a5641df9a00790d24/ objects=0 multipart_uploads=0 truncated=false listings_ok=true   (Q9–Q11 repeat, Q15)
spike/cloudrop-f01b97988c55bd217394509634e149c8/ objects=0 multipart_uploads=0 truncated=false listings_ok=true   (Q16)
spike/cloudrop-94b1019d33f3d73d5d6c7f4f4a76cfbc/ objects=0 multipart_uploads=0 truncated=false listings_ok=true   (Q17)
```

Total request-body bytes sent: 159,785,110 (about 152 MiB). No CORS, lifecycle, domain or token settings were written;
GetBucketCors was the only bucket-level read, and it was denied. This proves the five prefixes are empty, not that the
whole bucket is.

## How to re-run

```sh
cd spikes/r2
bun install --frozen-lockfile
bun run spike.ts --self-check      # CRC vectors, no network
bun run spike.ts                   # all questions (~150 MiB uploaded, about 2 minutes)
bun run spike.ts q5 q16            # selected questions only (q4 runs too when q13/q14 are selected)
bun run verify-empty.ts spike/cloudrop-<hex>/   # independent read-only emptiness check
```

Credentials are read from the file `CLOUDROP_R2_ENV_FILE` names; the scripts stop when it is not set. Only the five
literal `BB_R2_*=` lines are parsed, and the file is never sourced. Output, including the redacted evidence file
`spikes/r2/.out/evidence.json` (git-ignored), passes through a redactor that replaces the account id, bucket, public
host, access key id and secret, and strips signatures. The work budget is 15 minutes. SIGINT, SIGTERM, errors and
timeouts all trigger the same cleanup and prefix proof, and the exit code is non-zero if the prefix is not empty. The
token in use expires 2026-12-04.

## Sources

- [presigned]: https://developers.cloudflare.com/r2/api/s3/presigned-urls/ (last updated 2026-11-12)
- [s3api]: https://developers.cloudflare.com/r2/api/s3/api/ (2026-11-10)
- [cond]: https://developers.cloudflare.com/r2/api/s3/conditional-operations/ (2026-11-10)
- [multipart]: https://developers.cloudflare.com/r2/objects/multipart-objects/ (2026-07-29)
- [cors]: https://developers.cloudflare.com/r2/buckets/cors/ (2026-09-23)
- [lifecycles]: https://developers.cloudflare.com/r2/buckets/object-lifecycles/ (2026-10-26). Default rule "to expire
  multipart uploads seven days after initiation"; not exercised here
- [limits]: https://developers.cloudflare.com/r2/platform/limits/ (2026-10-30)
- [errors]: https://developers.cloudflare.com/r2/api/error-codes/ (2026-11-10)
- [pricing]: https://developers.cloudflare.com/r2/pricing/ (2026-10-30)
- Prior real-R2 evidence reused, not modified: an integrity spike, a conditional-Complete spike and an acceptance
  record in another of the owner's repositories (private).
