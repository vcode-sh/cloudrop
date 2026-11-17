# Chaos proxy: design

Status: decided 2026-11-17 under the owner's standing instruction to follow the research's recommendations without
further questions. Parent spec: [`2026-11-15-cloudrop-design.md`](2026-11-15-cloudrop-design.md) §11.3 ("a
fault-injecting proxy (dropped connections, 429, 503, latency, truncated responses, expired URLs). A run passes when
every upload ends correct or with a clear error code") and §13 (chaos tests are a 1.0 release gate). Research:
`.superpowers/research/research-chaos.md` (git-ignored); its measurements are restated here where they decide something.
Decisions go to a new series `M3-K` in `docs/decisions/m3-chaos.md`.

## 1. Goal

Prove, against a real S3 implementation (RustFS) and the real client and server, that every upload under injected
faults ends with exactly the file's bytes stored and nothing left behind, or with a clear `CloudropError` code that
§6.2 and the decision logs promise. The unit lane already proves every classifier row in-process; the chaos lanes prove
the same contracts over real sockets, real XHR and a real storage server, with faults a page or a fake cannot produce:
a connection reset mid-body, a request that is never answered, an answer cut after the bucket stored the bytes, a real
429/503 with and without a readable `Retry-After`, refusals with and without CORS headers, and faults in the server's
own storage calls.

Out of scope: live R2 behind the proxy (R2 routes by its hostname and a URL signed for the proxy cannot reach it;
research §3.1), HTTP/2 and TLS faults (every local lane is HTTP/1.1), Toxiproxy (TCP-only, cannot target one request
or answer with a status; revisit for a link-quality soak only if needed).

## 2. The proxy

A test-only, zero-dependency HTTP proxy in `packages/cloudrop/src/testing/chaos-proxy.ts` (Node `http` and `net`, typed
through `tsconfig.test.json`, excluded from the library's `tsconfig.json` as `page-events.ts` is). It sits between the
server's `s3()` storage and RustFS: the server's S3 endpoint **is** the proxy, so presigned URLs name the proxy's host
and SigV4 stays valid; the proxy forwards the `Host` header untouched (measured on RustFS 1.0.5: a URL presigned for the
proxy's port and sent through it is accepted; sent past it, `SignatureDoesNotMatch`).

- **Matching:** each rule matches by method, kind (a presigned request carries `X-Amz-Signature` in its query; a
  server call carries an `Authorization` header), S3 operation or part number, and occurrence (`nth`, 1-based among the
  rule's matches, or every match). `OPTIONS` preflights are forwarded and never match a PUT rule.
- **Faults:** reset after N request-body bytes; close without answering; black hole (read the body, never answer, until
  released or the proxy stops); delay before forwarding or before answering; throttle the request body to N bytes/s;
  answer with a status, headers and body (with or without CORS headers, with or without
  `Access-Control-Expose-Headers: Retry-After`); forward then cut the answer after its headers; forward and strip the
  CORS headers from the answer. A seeded random mode applies resets, 503s and latency at given rates, for the soak.
- **Log:** one entry per request: a label (`PUT part 2`, `PUT object`, `OPTIONS`, or the server's S3 operation such as
  `CompleteMultipartUpload`, `ListParts`, `HeadObject`), the fault applied, the outcome (status, `reset`, `closed`,
  `held`), request bytes received, start and end time, and PUTs in flight when it started. Never a query string, header
  or body: they carry signatures (AGENTS.md).
- **Control:** in process (`set(rules)`, `clear()`, `log()`, `stop()`), and for the browser lane through a small
  control endpoint on a separate loopback port, so Playwright tests set rules for the Next server's proxy.
- It has its own unit tests against a local `node:http` target, no Docker.

## 3. Lanes

- **`bun run test:chaos` (new):** `scripts/test-chaos.sh` starts a labelled RustFS container on its own port (trap
  first, removed at the end), and Vitest runs `*.chaos.integration.test.ts` files: a real `createCloudrop` with
  `s3({ endpoint: proxy })`, the real client with the `fetch` option (the fetch transport), a bucket prefix per run. It
  fails, never skips, without Docker. Runs on every pull request as a CI job.
- **Browser lane (existing `test:browser`):** the proxy starts with the lane, between the example's server and RustFS;
  new rows use real XHR through it.
- **Soak (nightly):** a seeded random run of 10–20 files through `start()` and `retry()`; the seed is printed for
  replay. A CI job on the existing nightly schedule.

### 3.1 Time

The client's backoff (full jitter, ceilings 0.5–8 s over 6 attempts) and the 30 s stall are constants. The Node lane
stubs `Math.random` to 0 (zero jitter; `Retry-After` still honoured), as the unit lane does. Stall rows: the browser
lane uses Playwright's clock when a spike shows it coexists with real XHR; otherwise one stall row runs in real time in
the nightly job only. No timing seam is added to the client.

## 4. Scenarios and the oracle

Oracle for every file that ends `done`: the object read back through the server's storage equals the generated file
(SHA-256), and no multipart upload is left under the run's prefix. For every row: the proxy log holds no query string;
a failed file's error is a `CloudropError` code from §6.2, M3-O3 or the decision logs, with its documented `retryable`;
the request sequence is read from the proxy log (what reached the bucket) and, in the browser, from the lab's table.

| # | Lane | Fault | Expected (decision) |
|---|---|---|---|
| 1 | Node, browser | reset `PUT part 2` after 1 MiB, once | renewal of part 2 through `/sign`, retry, done (S10, S11); browser: bytes never decrease (M3-U11) |
| 2 | Node | reset every attempt of `PUT part 2`, through `upload()` | 6 attempts, `NETWORK_ERROR` retryable; no new parts start (M3-U18); background `/abort` leaves nothing (S15) |
| 3 | Node, browser | as 2 through `start()`, then faults off and `file.retry()` | ticket kept (§4.7); retry sends only part 2 and `/complete`, same key (M3-U30, U31) |
| 4 | Node, browser | `429` + `ServiceUnavailable` + `Retry-After: 2` on `PUT part 1`, once; browser in two variants (exposed / not) | `RATE_LIMITED`, no renewal; waits ≥ 2 s when readable; jitter only when not (M3-U25) |
| 5 | Node | `503` on the single PUT, once | one retry, done (a create-only retry may answer 412, counted stored, §5.4) |
| 6 | Node | `500` on every attempt of the single PUT | `STORAGE_ERROR` retryable after 6 attempts; nothing stored |
| 7 | Node, browser | readable `403 SignatureDoesNotMatch` on `PUT part 1` | `UPLOAD_REJECTED`, one attempt; `retry()` asks a new ticket (M3-U31) |
| 8 | Node, browser | readable `403 ExpiredRequest` (R2 body), and RustFS `AccessDenied`, once | renew once, retry at once (S11) |
| 9 | browser | `403` without CORS headers on `PUT part 1`, once | opaque: renew, wait, retry (S10) |
| 10 | browser (and Node fetch allowance) | black hole on `PUT part 1`, once | stall after 30 s without progress (M3-U27, U47), retry, done |
| 11 | Node, browser | throttle `PUT part 1` to 64 KiB/s | no stall: progress keeps the watchdog alive; fetch allowance not exceeded |
| 12 | Node, browser | forward the single PUT, cut the answer | retry with `If-None-Match: *` → 412 counted stored (§5.4); object stored once |
| 13 | Node | server's `CompleteMultipartUpload` answered 503, once | the client retries `/complete`; done (S9) |
| 14 | Node | reset the server's `ListParts` / `HeadObject` in `/complete`, once | a retryable server error and a retry, or a documented code; never storage text in a message (§7) |
| 15 | browser | offline (CDP) while a part is mid-body behind a throttle; online after 2 s | paused, the in-flight part re-sent once, done (M3-U28) |
| 16 | browser | pause while a part is mid-body (throttle), then resume | the interrupted part sent twice, others once; bar never decreases |
| 17 | Node | throttle all PUTs + 429 on 2 of 4 concurrent PUTs, `concurrency: "auto"` | the pool halves once per window (M3-U24, U25), seen through the proxy's in-flight count |
| 18 | nightly | seeded random soak over `start()` and `retry()` | every file done with exact bytes or failed with a listed code; nothing left after aborts |

## 5. `Retry-After` in browsers

`Retry-After` is not a CORS-safelisted response header, and R2 sends it on a 429 (measured 2026-11-16: `Retry-After:
5`, unreadable from the page because the bucket's rule does not expose it). The client already honours it wherever it
can read it. Changes: the example's local RustFS CORS rule (`examples/next/scripts/setup-rustfs.ts`) exposes
`Retry-After`; the README's CORS section recommends `Retry-After` in `ExposeHeaders` and says what happens without it
(jitter-only waits). The live test bucket's rule is the owner's to change (agents never write bucket settings); the
decision entry and the plans README say so.

## 6. Size and docs

No client code changes are expected; if a scenario exposes a client bug, its fix follows the usual rules (a RED row
first, a decision entry when behaviour changes). Docs: `docs/decisions/m3-chaos.md` (series `M3-K`, registered in the
decisions README and AGENTS.md), AGENTS.md "Gates" gains `test:chaos`, the testing skill's repository reference gains
the lane, spec §11.2/§11.3 say what runs where, the plans README marks M3 done.
