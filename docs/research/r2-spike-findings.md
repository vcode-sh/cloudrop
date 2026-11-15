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
| 7 | Expiry | Expired → `403 ExpiredRequest` (PUT and GET). `X-Amz-Expires=604800` accepted, `604801` → `400 InvalidArgument`. `X-Amz-Date` 30 min in the future → `403 RequestTimeTooSkewed`. CORS headers on the expired response: **BLOCKED** (no CORS rule for the test origin, so absence proves nothing) | Cap expiry at 604800 s. Treat an opaque browser failure as "maybe expired, re-sign once". Keep signing clocks in sync |
| 8 | CORS | `GetBucketCors` → `403 AccessDenied` for this token, so the policy is not directly readable. Preflights show a rule allowing only `GET, HEAD` + header `range` from the public origin (MaxAge 3600). Every PUT preflight → `403` "CORS not configured for this bucket". **Browser upload questions BLOCKED.** The required JSON is below | The owner must apply a CORS rule before any browser test. The library docs must ship the exact policy (methods, allowed headers incl. checksums, `ExposeHeaders: ETag`) |
| 9 | Rate limits | 8 concurrent UploadPart on one key: all 200, twice. 5 sequential PutObject to one key in ~1 s: all 200, twice. 5 **concurrent** PutObject to one key: one `429` per run, S3 code **`ServiceUnavailable`** ("Reduce your concurrent request rate for the same object.") | Parallel parts are safe at 8. Same-key writes collide on concurrency, not on a 1/s rate. Classify 429 as retryable by status, not by `TooManyRequests` code |
| 10 | ListParts | Fields per part: `ETag`, `LastModified`, `PartNumber`, `Size`, plus `ChecksumCRC32C` when the part was sent with one. No CRC64NVME, even though UploadPart returned one. `max-parts=3` paginates with `IsTruncated`/`NextPartNumberMarker`. After Complete → `404 NoSuchUpload` | Server-verified completion via ListParts works (size per part). Pagination needs handling above 1000 parts. ListParts cannot be used to inspect a completed upload |
| 11 | Complete retry, metadata | A retried Complete after success → `404 NoSuchUpload`; Abort after Complete → 204. HEAD shows the `x-amz-meta-cloudrop-id` and Content-Type set at Create, `x-amz-mp-parts-count: 8`, ETag `"<md5-of-md5s>-8"` (matches our computation) | Complete is not idempotent: treat `NoSuchUpload` on a retried Complete as "check HEAD; if the object matches, it succeeded". Metadata set at Create is reliable |
| 12 | `content-disposition` | Signed into the URL: stored, returned by GET on the S3 endpoint and on the public custom domain (`cf-cache-status: DYNAMIC`), including an RFC 5987 `filename*`. Omitting it with a URL that signed it → 403 | Content-Disposition can be forced at upload time by signing it |
| 13 | Ranged GET, HEAD | `Range: bytes=0-4095` → 206 with `Content-Range: bytes 0-4095/<total>`, for single and multipart objects. Single ETag = MD5 hex. Multipart ETag `-N` + `x-amz-mp-parts-count`. `HEAD ?partNumber=1` → 206 with that part's range | Magic-byte sniffing with one ranged GET (Class B) is viable |
| 14 | CopyObject | Default directive keeps Content-Type, Content-Disposition and `x-amz-meta-*` (also from a multipart source). `REPLACE` drops what is not resent. Copying a multipart object **rewrites the ETag to the plain MD5 of the content** and drops `x-amz-mp-parts-count`. CopyObject is Class A ([pricing]) | Quarantine-promote works and keeps metadata, but costs one more Class A op and changes the ETag. Do not use the pre-promotion ETag as an identity after promoting |

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
which only makes its own write fail. It cannot remove a signed one. app-d measured the multipart Complete
behaviour on 2026-11-04 (`docs/spikes/r2-conditional-complete.md` in that repo); this run agrees.

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

This agrees with app-d's 2026-11-04 finding (`docs/spikes/r2-integrity.md` in that repo): part checksums are
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
also had none, because the bucket has no rule for that origin (Q8). **BLOCKED** until CORS is configured. The error
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
and whether checksum headers pass a preflight. The owner would need to add this rule to the test bucket and **keep the
existing public-origin GET/HEAD rule**, because setting CORS replaces the whole policy. It uses the S3 PutBucketCors
JSON shape from [cors]:

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

## Not verified

- **Anything in a real browser.** No browser was driven: the bucket has no CORS rule for a test origin (Q8 BLOCKED).
  This includes reading `ETag` from JS, preflights for checksum headers, CORS on expired responses, and whether the
  browser's own `Content-Length` and `fetch` framing match a signed length. Fetch forbids setting Content-Length, so it
  should match.
- aws-chunked / `STREAMING-UNSIGNED-PAYLOAD-TRAILER` uploads (open item 4). Only plain `Transfer-Encoding: chunked` was
  tried (Q17).
- Bucket lifecycle rules (not read; `GetBucketLifecycleConfiguration` not attempted) and the default 7-day multipart
  abort.
- Parallelism above 8 parts, sustained load, and any limit over a longer window.
- What Complete does when a listed part lacks a checksum on a CRC32C upload (part 3 in Q5 was left out of the Complete).
- Composite checksums with more than 2 parts, SHA-1/SHA-256/CRC32 algorithms, and `Content-MD5` (app-d measured
  Content-MD5 rejection on PUT and UploadPart).
- Checksums on copied objects, `UploadPartCopy`, `cf-copy-destination-if-*` on copy.
- Jurisdiction endpoints, virtual-host addressing with the own presigner (the SDK runs used path style), Infrequent
  Access storage class.
- A Complete whose request is lost and retried. Inferred from Q11: the retry gets `NoSuchUpload`, which the client
  must reconcile with HEAD.
- RustFS/SeaweedFS uneven-part behaviour (open item 7). This spike touched only R2.
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

Credentials are read from `CLOUDROP_R2_ENV_FILE`, which defaults to the app-d `.env.local`. Only the five
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
- Prior real-R2 evidence reused (app-d repo, not modified): `docs/spikes/r2-integrity.md`,
  `docs/spikes/r2-conditional-complete.md`, `docs/acceptance/m1.md`
