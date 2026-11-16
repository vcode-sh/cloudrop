# What the M2 reviews found

Every M2 task, lane and fix round had an independent review; the reports were kept outside the repository (M2-X13).
This table keeps their outcome: every Critical and Important finding, and every Minor that was parked, deferred or left
to the owner. Minors that were simply fixed in their fix round are left out. No review found a Critical defect; the plan
audit's two Criticals (T10-1, T14-1) were fixed before execution reached them (M2-X1, M2-X2).

Severity is the reviewer's. "Owner" means the decision is left to the project owner.

| Review | Finding | Severity | Outcome |
| --- | --- | --- | --- |
| Task 2 (sizes, accept) | `parseSize` rounds some fractional byte values instead of refusing them | Important | Fixed in `b524cd8` (M2-X17) |
| Task 2 | An extension refusal echoes the raw file name text, including CR/LF | Important | Fixed in `b524cd8` (M2-X17) |
| Task 2 | Browser MIME aliases (types browsers really report) are unverified | Minor | Parked for M3 browser evidence |
| Task 4 (keys, disposition) | The SVG exception serves non-canonical type text such as `image/SVG+xml` inline (stored XSS) | Important | Fixed in `f90064d` (M2-X18) |
| Task 4 | Non-string message and invalid ULID arguments are unchecked | Minor | Left: no caller can reach them |
| Task 6 (storage additions) | Credential scrubbing misses plain-object causes and chains deeper than 8 | Minor, promoted to required | Fixed in `916b152` (M2-X21) |
| Task 6 | Which 404 codes mean "no bucket settings" on R2 is unmeasured | Minor | Ruled in M2-X22 and M2-X40; an admin-token measurement is still open |
| Task 7 (routes, config) | A `CloudropError` from a second installed copy of cloudrop is refused; `extendRoute` timing and mutability are undesigned | Minor | Parked for M5; fails closed with guidance |
| Task 8/9 (upload, sign) | The `Math.ceil` URL lifetime margin has no test that fails under `Math.floor` | Minor, fix before merge | Fixed in `21e8a96` |
| Task 8/9 | The reported `expiresAt` can be up to 999 ms after the URL expires | Minor | Fixed in `4af3a8a` (final review m4) |
| Task 10 (abort) | Deleting a live completed multipart object and keeping its quota is untested; a mutant survived | Important | Fixed in `58c7470` |
| Task 10 | The completed-multipart setup is written twice in the tests | Minor | Left: test-only |
| Task 11 (complete) | A failed delete still releases the reservation and tells the client the file was discarded | Important | Fixed in `b2ed2d4` (M2-X28) |
| Task 11 fix round | After an uncertain DELETE the quota stays over-counted until `/abort` | Minor | Kept: fails safe, by M2-X28 |
| Task 12 (client types) | `Awaited` in `route()`'s return type is unproved | Important | Fixed in `3622db2` |
| Task 13 (file API) | `deletePrefix("/users/42/")` reports a verified erasure while the data stays | Important | Fixed in `73c9de7` |
| Task 13 | `FileApi.put` forwards the driver's undocumented write options | Minor (owner note) | Parked (M2-P2); options documented in `4414cc6` |
| Task 14 (adapters) | A `//host` or absolute request target replaces the Host origin, so a cross-site `Origin` passes as same-origin | Important | Fixed in `7bbd760` |
| Controller fixes re-review | A path in the Host header became a prefix of the matched path | Minor (new breakage) | Fixed in `bb44568` |
| Tasks 15+16 (protocol lanes) | The abort case duplicates two existing tests | Important | Fixed in `5964b7c` (M2-X36) |
| Tasks 15+16 | The live credential check is copied in two lane files | Minor | Parked (M2-P1) |
| Tasks 15+16 | Live lanes never print their run prefix, so an interrupted run names only a placeholder | Minor | Fixed in `d5dacc2` (final review m13) |
| Lane S (server fixes) | The "agree with planParts" property compares the functions with themselves | Important | Fixed in `fe7a1b1` (M2-X39) |
| Lane S, final m15 | `copy` computes its own part ranges | Minor | Kept: judged acceptable (M2-X41) |
| Lane T (fake R2 split) | The `ContractSuite` interface could be inferred | Minor | Parked (M2-P3) |
| Lane G (quality gates) | Source maps ship in the package tarball (about 255 kB raw) | Owner decision | Kept until M6 (M3-H4) |
| Task 17 (docs) | Spec §8 and `plugins.ts` promise `onAbort` for every file that will not complete; nothing runs at token expiry | Important | Fixed in `9d3e694` (M2-D21) |
| Task 17 | The code-quality skill still said 280 lines while `AGENTS.md` caps source at 250 | Important | Fixed in `9d3e694` |
| Final branch review | `toNodeHandler` ignores HTTP/2 `:authority`, so same-origin h2 uploads get 403 | Important | Fixed in `37a9595` |
| Final branch review | A storage 501 (Wrangler's `ListParts`) answers a retryable error | Important | Fixed in `835697c` |
| Final branch review | `/abort` is refused once a deploy removes the token's route | Important | Fixed in `2a8eff9` |
| Final branch review | m16: the file's id is `fileId` on the wire and `id` in `UploadedFile` and `PluginFile` | Minor | Owner: `id` everywhere on the wire (M3-O2); lane I changes the server |
| Final branch review | m17: the M3 client must decide retries of cloudrop's endpoints by `error.retryable`, not HTTP status | Minor | Owner: M3 contract note |
| Final fix re-review | Spec §5.3 said only a HEAD precedes a delete; a refused multipart file is deleted after its create-only completion | Minor (new breakage, docs) | Fixed in `9df61ef` |
| Final fix re-review | `extendRoute` passes through a `CloudropError` with a code other than `INVALID_CONFIG` | Minor | Parked for M5 (M2-P4) |
| Final fix wave (implementer) | `upload.ts` is 243 lines (cap 250, target 220) | Concern | Fixed by the hardening split in `0ce548b` (`upload.ts` 136 lines) |
| Final fix wave (implementer) | The application's own `logger.warn` in `createCloudrop` runs unguarded | Concern | Owner |
| Final fix wave (implementer) | A multipart upload created before a throwing custom driver's `presignParts` stays until the lifecycle rule | Concern | Owner |

## Unproven at the end of M2

The final review listed what no lane measures. Kept here because it is the starting list for M3:

1. R2 bucket-settings reads with an admin read token (object tokens get 403).
2. Cloudflare Workers subrequest limits with up to 100 parallel storage calls per `/upload`.
3. The handler on workerd, Deno or Bun; every server test runs on Node 24.
4. R2's ordering between the `If-None-Match` 412 and the part checks at completion, and two concurrent `/complete`
   calls.
5. The server protocol on RustFS and Wrangler (M2-X5), including whether a backend returns `Content-Type`
   byte-for-byte.
6. Live R2 paths outside the live lane: a retried single PUT that gets 412, a retried completed multipart, a live token
   deleting through `/abort`, collisions, and `copy` above 4.995 GiB.
7. Browser end to end (M3): bucket CORS, reading `ETag`, CORS on an expired URL's 403, real MIME types.
8. The adapters inside a running Next.js, Express and Connect.
9. Conditional delete on R2.
10. Exactly-once hooks, which are at-least-once by design until the 1.1 adapters.
11. Clock steps beyond one second between the server and a custom driver.
