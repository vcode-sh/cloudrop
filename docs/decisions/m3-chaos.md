# M3 chaos decisions

Decisions of the M3 chaos work (2026-11-17): a fault-injecting HTTP proxy between cloudrop's server and RustFS, the
`test:chaos` Node lane, chaos rows in the browser lane and a nightly seeded soak, proving design spec §11.3's "a run
passes when every upload ends correct or with a clear error code". Design:
`docs/superpowers/specs/2026-11-17-chaos-design.md`. Plan: `docs/superpowers/plans/2026-11-17-m3-chaos.md`, section
"Rulings fixed by this plan". Research: `.superpowers/research/research-chaos.md` (git-ignored; the design restates
the measurements that decide something).

Numbering: `M3-K1` to `M3-K8` are the plan's rulings K1 to K8, with the same number. They answer the research's owner
questions Q1, Q2, Q3, Q5, Q6, Q7, Q8 and Q4 in that order, each with the research's recommendation, under the owner's
standing instruction of 2026-11-17 to follow the research without further questions. Execution rulings that change
behaviour or a public contract follow from `M3-K9`, each naming its source.

## Plan rulings

### M3-K1: an in-repo HTTP proxy

- **Decision:** the chaos faults come from a small zero-dependency HTTP proxy written in the repository (Node `http`
  and `net`), not from Toxiproxy and not from Chromium's tools alone. It forwards the `Host` header untouched, matches
  single requests (presigned or server call, S3 operation, part number, occurrence) and resets, closes, black-holes,
  delays, throttles, answers with a chosen status, cuts an answer after its headers or strips its CORS headers.
- **Why:** it is the only option that covers every fault §11.3 names and targets one request. SigV4 signs `host`, so
  a URL survives a proxy only when the server's endpoint already names the proxy (measured on RustFS 1.0.5: presigned
  for the proxy and sent through it, `200`; sent past it, `403 SignatureDoesNotMatch`). Toxiproxy works per TCP
  connection: it cannot answer 429, 503 or an R2 403 body, strip CORS headers or pick "part 2" when keep-alive carries
  several requests on one connection, and it adds an image. Chromium alone (`page.route`, CDP) cannot reset mid-body,
  fault the server's storage calls or run the fetch transport.
- **If wrong:** the proxy is our code with our bugs, so it has its own unit tests; it is HTTP/1.1 only and cannot
  fault TLS or HTTP/2, which no local lane reaches anyway. Live R2 cannot sit behind it (R2 routes by its hostname).
  Toxiproxy stays the candidate for a link-quality soak if the proxy's random mode proves too synthetic.
- **Status:** decided (plan Task 1).
- **Source:** chaos design §1, §2; research §3.1 to §3.5, §5 Q1.
- **Visible in:** `packages/cloudrop/src/testing/chaos-proxy.ts`, `chaos-proxy.test.ts`.

### M3-K2: a Node lane on every pull request, browser rows, a nightly soak

- **Decision:** the protocol rows run in a new Node lane, `bun run test:chaos`: RustFS in Docker behind the proxy, the
  real `createCloudrop` with `s3()` pointed at the proxy and the real client on the fetch transport, files named
  `*.chaos.integration.test.ts`. CI runs it on every pull request and push to `main` as its own job. Rows that need
  real XHR (opaque refusals, stalls, offline, pause, the progress bar) run in the existing `test:browser` lane with the
  proxy between the example's server and RustFS. A seeded random soak runs on the nightly schedule.
- **Why:** the Node lane is fast and deterministic enough for every change and proves the server's side and the fetch
  transport; the browser rows prove what only XHR shows; the soak covers mixed faults over many files without making
  each pull request wait for it.
- **If wrong:** a regression only the soak finds surfaces a day late. Running everything nightly would save CI minutes
  per pull request at that cost for every row; running only the browser lane would lose the fetch transport.
- **Status:** decided (plan Tasks 4 to 7).
- **Source:** chaos design §3; research §5 Q2.
- **Visible in:** `scripts/test-chaos.sh`, the root `package.json`, `packages/cloudrop/vitest.config.ts` (project
  `chaos`), `.github/workflows/ci.yml` (jobs `chaos` and `chaos-soak`), design spec §11.2 and §11.3.

### M3-K3: time in the chaos lanes

- **Decision:** the Node lane stubs `Math.random` to 0, as the unit lane does: zero jitter, while a `Retry-After` is
  still honoured. Stall rows use Playwright's clock in the browser if a spike shows it coexists with real XHR;
  otherwise one stall row runs in real time in the nightly job only. The client gets no timing seam.
- **Why:** the backoff (full jitter, ceilings 0.5 to 8 s over 6 attempts, up to 15.5 s of waits) and the 30 s stall
  are constants; in real time a few rows would cost minutes on every pull request. A timing seam would cost client
  bytes and add a contract surface for tests alone.
- **If wrong:** zero jitter hides a bug that only shows with a real wait between attempts; the soak and any real-time
  stall row keep real timing in reach. If the clock does not drive real XHR, the browser's stall is proven only
  nightly.
- **Status:** decided (plan Tasks 5 and 6; the spike's result gets its own entry).
- **Source:** chaos design §3.1; research §5 Q3.
- **Visible in:** the `*.chaos.integration.test.ts` files, `examples/next/app/chaos.browser.test.ts`; the Node
  lane's real-time stall and throttle rows run nightly in `packages/cloudrop/src/chaos/stalls.soak.integration.test.ts`
  (`M3-K10`).

### M3-K4: the server's storage faults are in scope

- **Decision:** the proxy also faults the server's own storage calls (`CreateMultipartUpload`, `ListParts`,
  `HeadObject`, `CompleteMultipartUpload`), told apart from presigned requests by their `Authorization` header.
- **Why:** §11.3 asks that every upload end correct or with a clear error code, and `/complete` is where the server
  talks to storage most. The server's endpoint is the proxy anyway (`M3-K1`), so these faults cost one match field.
- **If wrong:** rows that fault the server's calls take lane time and may record a server behaviour (an internal retry
  or a retryable error) that later changes; the row then changes with it.
- **Status:** decided (plan Task 5b, design §4 rows 13 and 14).
- **Source:** chaos design §1, §4; research §5 Q5.
- **Visible in:** `packages/cloudrop/src/chaos/server-faults.chaos.integration.test.ts`.

### M3-K5: expired URLs are synthesized 403 answers

- **Decision:** an expired URL is the proxy answering `403` with the measured bodies: R2's `ExpiredRequest` and
  RustFS's `AccessDenied`, with or without CORS headers. The server's clock is not moved to expire a URL for real.
- **Why:** the client reacts to the answer it reads, not to the URL's age; a synthesized answer targets one request
  and costs no wait. Moving the clock would also move the upload token's expiry and fault every request after it.
- **If wrong:** a real expiry that R2 answers differently from the measured body goes unseen here; the live lane and
  `docs/research/r2-spike-findings.md` hold the measured shape.
- **Status:** decided (design §4 rows 8 and 9).
- **Source:** chaos design §1, §4; research §3.2, §5 Q6.
- **Visible in:** `packages/cloudrop/src/chaos/bucket-faults.chaos.integration.test.ts`,
  `examples/next/app/chaos.browser.test.ts`.

### M3-K6: the proxy lives in `src/testing/`

- **Decision:** the proxy is `packages/cloudrop/src/testing/chaos-proxy.ts`, beside the other fixtures, excluded from
  the library's `tsconfig.json` and typed with Node through `tsconfig.test.json`, as `src/testing/page-events.ts` is.
- **Why:** the Node lane imports it in process and the browser lane's script starts it with a control endpoint; a
  fixture beside the others is where the testing skill sends a reader. The exclusion keeps `src/`'s web-platform rule
  checked by the compiler.
- **If wrong:** a forgotten exclusion fails `typecheck` on the library config, never a release; `scripts/` was the
  alternative.
- **Status:** decided (plan Task 1).
- **Source:** chaos design §2; research §3.2, §5 Q7.
- **Visible in:** `packages/cloudrop/tsconfig.json` (`exclude`), `packages/cloudrop/src/testing/chaos-proxy.ts`.

### M3-K7: the soak runs nightly in this plan

- **Decision:** the seeded random soak (10 to 20 files through `start()` and `retry()`, resets, 503s and latency at
  given rates, the seed printed for replay) is built in this plan and runs on the nightly schedule, not deferred to
  M6's release gate.
- **Why:** §13 makes chaos tests a 1.0 release gate; a soak running every night from M3 finds a rare failure long
  before the release instead of at it.
- **If wrong:** a flaky soak sends nightly noise. The seed in the test's title fixes the files and the fault stream,
  but requests draw from that stream in the order they reach the proxy, and parts run concurrently, so a replay gets
  the same mix of faults, not always the same fault on the same request. A red run therefore prints its own trace (each
  request's label, fault, outcome and bytes), so a flake is a bug to fix from that trace rather than a row to drop.
  Exact replay (a fault drawn per request, whatever the arrival order) is a proxy follow-up.
- **Status:** decided (plan Task 7).
- **Source:** chaos design §3, §4 row 18; research §4 row 18, §5 Q8.
- **Visible in:** `packages/cloudrop/src/chaos/uploads.soak.integration.test.ts` (its own Vitest project `soak`, so
  the `chaos` project never collects it; plan audit I3), `bun run test:chaos:soak` (`scripts/test-chaos.sh soak`),
  `.github/workflows/ci.yml` (job `chaos-soak`).

### M3-K8: `Retry-After` exposed through CORS

- **Decision:** the example's local RustFS CORS rule exposes `Retry-After`, and the README's CORS section recommends
  `Retry-After` in `ExposeHeaders` and says that without it a browser waits with jitter only. The live test bucket's
  rule is the owner's to change; agents never write bucket settings.
- **Why:** `Retry-After` is not a CORS-safelisted response header, so a cross-origin XHR reads it only when the answer
  exposes it. R2 sends it on a 429 (measured 2026-11-16: `Retry-After: 5`, unreadable from the page because the
  bucket's rule does not expose it). The client already honours it wherever it can read it.
- **If wrong:** a bucket without the rule still works and waits with jitter only, which may retry sooner than the
  bucket asked.
- **Status:** decided (plan Task 2; the live bucket waits on the owner).
- **Source:** chaos design §5; research §2.3, §5 Q4.
- **Visible in:** `examples/next/scripts/setup-rustfs.ts`, `README.md` (CORS section), `examples/next/README.md`.

## Execution rulings

`M3-K9` is reserved for the result of the `page.clock` spike (`M3-K3`).

### M3-K10: the Node lane's real-time stall and throttle rows run nightly

- **Decision:** design §4 rows 10 and 11 in the Node lane, the black-holed single PUT given up after its fetch
  allowance (64 KiB: 30 640 ms) and the part still moving after 30 s (1 MiB at 32 KiB/s: 32 s), run in the nightly
  `soak` project, not in the `chaos` lane on every pull request. Rows 12 and 17 and every other Node row stay in the
  pull-request lane.
- **Why:** each row waits out about 31 s of real time, and `M3-K3` keeps real-time stall rows out of every pull
  request. Vitest gives a 2-vCPU private-repository `ubuntu-latest` runner one worker (`availableParallelism − 1`),
  so the chaos files run one after another and the two rows alone would add about 63 s to every pull request (Task 5b
  review I1). The allowance itself is pinned on every change, exactly and without waiting: `client/transport.test.ts`
  ("gives a fetch PUT 30 s plus its size at 100 KiB/s") advances fake timers to 40 239 ms and 40 240 ms for 1 MiB.
  The nightly rows add the end-to-end proof that nothing else on the way (undici, the proxy, RustFS) cuts such a PUT.
- **If wrong:** a regression that only real sockets show, such as a request timeout below 32 s elsewhere in the path,
  surfaces a day late, in the nightly job. Row 11 runs at 32 KiB/s rather than the design's 64 KiB/s: 16 s would pass
  even if the allowance lost its size share.
- **Status:** decided (Task 5b fix round 1).
- **Source:** chaos design §3.1, §4 rows 10 and 11; plan audit C2 ("or it moves to the soak project"); Task 5b review
  I1 and M1.
- **Visible in:** `packages/cloudrop/src/chaos/stalls.soak.integration.test.ts`, `bun run test:chaos:soak`.
