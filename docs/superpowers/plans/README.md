# Plans: where cloudrop stands

Updated 2026-11-16 at the head of `feat/m3-progress-a` (progress plan A executed; `main` once merged). This file is the
one place that says what is done and what comes next. The code is the truth: an executed plan is kept as a short stub
marked done, with the commit that holds its full text (`git show 415198a:docs/superpowers/plans/<file>`); every decision
is in [`docs/decisions/`](../../decisions/README.md).

## Milestones (spec §14)

| Milestone | Scope | State |
|---|---|---|
| M0 | Real-R2 spike, spec updated | **Done** 2026-11-15 ([`r2-spike-findings.md`](../../research/r2-spike-findings.md)) |
| M1 | `storage`: SigV4 signer, `r2` and `s3` drivers, fake R2, contract suite, Wrangler and RustFS lanes | **Done** 2026-11-15 (closed at `ca28497`; plan below) |
| M2 | `server`: `createCloudrop`, routes, tokens, handler, verification, `api.*`, Next and Node adapters | **Done** 2026-11-16 (closed at `2483890`, then the hardening phase, `ca91b33`) |
| M3 | `engine` and `client`: scheduler, transports, retry, persistence, progress, chaos proxy | **In progress**: the vertical slice (`90380fb`) and progress plan A are done; plan B, resume and chaos remain (below) |
| M4 | `cloudrop/react`, shadcn registry, examples | Not started |
| M5 | Plugins: `contentChecks`, `limits`, `images`, `checksums` | Not started |
| M6 | Docs, 0.x beta, 1.0 | Not started |
| 1.1 | Drizzle adapter | Not started |

## Plans

| Plan | State | Result |
|---|---|---|
| [M1 storage foundation](2026-11-15-m1-storage-foundation.md) | Done | Storage layer, fake R2, contract suite on fake, RustFS, Wrangler and live R2 |
| [M2 server](2026-11-15-m2-server.md) ([audit](2026-11-15-m2-server.audit.md)) | Done | Server, protocol, adapters; decisions `M2-D`, `M2-X`, `M2-P` |
| Hardening phase (no plan file; lanes U, N, L, P, I, L2, R, Z) | Done, `ca91b33` | Decisions log in git, Node URL contract, file splits, `fileId` → `id`; decisions `M3-H1`..`M3-H16` |
| [M3 vertical slice](2026-11-16-m3-vertical-slice.md) ([audit](2026-11-16-m3-vertical-slice.audit.md)) | Done, `ca91b33..90380fb` | `cloudrop/client`, `examples/next`, browser lanes; decisions `M3-S1`..`M3-S34` |
| Follow-ups after the slice (no plan file) | Done, `90380fb..dcea6c3` | R2 refusals and checksums measured from a browser, clearer `NETWORK_ERROR` message, `/lab` page, example accepts video, audio and PDF |
| [M3 progress plan A](2026-11-16-m3-progress-plan-a.md) ([audit](2026-11-16-m3-progress-plan-a.audit.md)), design [`2026-11-16-progress-scheduler-design.md`](../specs/2026-11-16-progress-scheduler-design.md) | Done, `27e9152..` the commit that adds this row (`feat/m3-progress-a`) | XHR progress, the snapshot, one connection pool per client, several files per job with a result per file, pause, resume and cancel, the lab; decisions `M3-U1`..`M3-U22` |

## State after progress plan A (`feat/m3-progress-a`, 2026-11-16)

- **Gates:** `bun run verify` passes: 1081 unit tests, 1 skipped (a pre-existing skip). `test:browser` 10/10 on
  RustFS, `test:browser:live` 10/10 on R2 (plan A task 7). `test:live` was 31/31 on R2 at `dcea6c3`; plan A changed no
  server or storage code and did not rerun it. CI on `main` was green at `dcea6c3` (`check`, `rustfs`, `wrangler`,
  `browser`; `live-r2` runs only when its secrets are set); this branch has not been pushed.
- **Bundle (gzip):** `cloudrop` 33.96 kB of 36 kB, `cloudrop/next` 1.01 kB of 1.1 kB, `cloudrop/node` 3.1 kB of
  3.2 kB, `cloudrop/client` 6.71 kB of 7.4 kB (owner's ceiling 7.5 kB, `M3-U13`).
- **What works end to end:** server (`createCloudrop`, `route`, the four endpoints, verification, `api.*`), Next and
  Node adapters, `cloudrop/client` (single PUT and multipart, four parts in flight, URL renewal, `PARTS_MISSING`
  repair, bounded retry, cancel with keep-or-abort, background `/abort` after a failure; since plan A: bytes, speed and
  time left through XHR, a snapshot for `useSyncExternalStore`, one connection pool per client, several files per job
  with a result per file, pause, resume and cancel per file or job), the example app and its `/lab` page (a row per
  file with progress and buttons), on RustFS, Wrangler (single PUT only) and live R2.
- **Measured speed to R2 from the dev machine (2026-11-16):** about 130 ms per R2 API round trip; one 8 MiB PUT about
  17 MiB/s, four at once about 60 MiB/s, the link tops out near 70 MiB/s. In the lab a 100 MiB upload took 2.5 s
  (39.6 MiB/s end to end); the server adds about 0.7 s per file (`/upload` one storage call, `/complete` three). The
  client loses no throughput against a raw `fetch`; the latency is the network and the bucket's location.

## What comes next

### M3: the remaining client plans (spec §6)

The progress and scheduler design (`2026-11-16-progress-scheduler-design.md`) merged the progress and scheduler plans
into plans A and B. Plan A is done. Next, in order:

1. **M3 progress plan B** (design §8, not written yet): the part-size measurement on live R2 and its decision (§5),
   `concurrency: "auto"`, `order: "smallest-first"`, stall detection and the `fetch` timeout, `offline`/`online` pause,
   and `retry()` with the failed-file rule that amends `M3-S15` (§4.7). The client has about 0.8 kB of gzip left
   under the owner's 7.5 kB ceiling (`M3-U13`).
2. **M3 resume plan:** persistence, fingerprints, `resumable()`, OPFS, resume after a reload (§6.3).
3. **M3 chaos plan:** the chaos proxy (§11.3), to test the above under loss, delay and resets.

### Open decisions for the owner

- **Faster uploads to R2** (measured above, none decided):
  - bucket location: a bucket created with a location hint near its users (`EEUR` for Europe) cuts the round trip
    and with it the server's per-file cost and each connection's ramp-up; an infrastructure choice, no code;
  - part size: one 64 MiB stream reached 37 MiB/s against 17 MiB/s for 8 MiB, so larger parts for large files may
    help; plan B measures part size × parallelism on live R2 first and changes the planner only if larger parts win;
  - `/complete` makes three storage calls (ListParts, CompleteMultipart, HEAD); whether one can go without weakening
    verification (spec §7) needs analysis.
- **Unreadable R2 refusals:** a bad-signature `403` reaches the page as a network error, so the client retries for
  about 15 s and answers a retryable `NETWORK_ERROR`. Option: stop at the second unreadable answer on a fresh URL when
  `/sign` succeeded, with a non-retryable code (findings in `r2-spike-findings.md`, "Browser refusals and checksums,
  2026-11-16"). Not decided; the message was reworded instead.

### Small debts

- Not measured from a browser on R2: a wrong checksum (`BadDigest`), `NoSuchUpload` on a part, a `429`; a checksum
  header missing from the CORS rule (inferred from an `OPTIONS` check only). See "Not verified" in the findings.
- One unit test, `api.deletePrefix`, takes about 268 ms without a stated reason (testing-patterns asks for one over
  250 ms).
- The `/lab` page's "already stored" note (a `412` PUT) and its per-part `/sign` label have no browser test; no lab
  fault triggers them.
- Wording: the slice plan quotes the old `NETWORK_ERROR` message (around line 551), a historical plan left as
  written.
- Plan A, parked: one PUT can still start after a part fails its file (`M3-U15`); no unit row for a pause and a pool
  grant in the same microtask (`M3-U21`) or for a failure that wins the race with a pause (`M3-U22`); a long pause
  may cost one extra `/sign` (`M3-U20`); the lab's notes name a part without its file. The plan A text is not yet
  reduced to a stub.
