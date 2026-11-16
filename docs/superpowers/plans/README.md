# Plans: where cloudrop stands

Updated 2026-11-16 on `feat/m3-progress-b` after progress plan B (not merged to `main` yet). This file is the one place
that says what is done and what comes next. The code is the truth: an executed plan is kept as a short stub marked
done, with the commit that holds its full text (`git show <commit>:docs/superpowers/plans/<file>`); every decision is
in [`docs/decisions/`](../../decisions/README.md).

## Milestones (spec §14)

| Milestone | Scope | State |
|---|---|---|
| M0 | Real-R2 spike, spec updated | **Done** 2026-11-15 ([`r2-spike-findings.md`](../../research/r2-spike-findings.md)) |
| M1 | `storage`: SigV4 signer, `r2` and `s3` drivers, fake R2, contract suite, Wrangler and RustFS lanes | **Done** 2026-11-15 (closed at `ca28497`; plan below) |
| M2 | `server`: `createCloudrop`, routes, tokens, handler, verification, `api.*`, Next and Node adapters | **Done** 2026-11-16 (closed at `2483890`, then the hardening phase, `ca91b33`) |
| M3 | `engine` and `client`: scheduler, transports, retry, persistence, progress, chaos proxy | **In progress**: the vertical slice (`90380fb`) and progress plans A and B are done; resume and chaos remain (below) |
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
| [M3 progress plan A](2026-11-16-m3-progress-plan-a.md) ([audit](2026-11-16-m3-progress-plan-a.audit.md)), design [`2026-11-16-progress-scheduler-design.md`](../specs/2026-11-16-progress-scheduler-design.md) | Done, `27e9152..a003cdb` | XHR progress, the snapshot, one connection pool per client, several files per job with a result per file, pause, resume and cancel, the lab; decisions `M3-U1`..`M3-U22` |
| [M3 progress plan B](2026-11-16-m3-progress-plan-b.md) ([audit](2026-11-16-m3-progress-plan-b.audit.md)) | Done, `fbc5c15..220332c` | `concurrency: "auto"`, `order: "smallest-first"`, stalled PUTs, offline and online, `retry()` with the failed-file rule and `pagehide`, 16 MiB parts from 256 MiB, the lab's controls; decisions `M3-U23`..`M3-U59` |

## State of `main` after progress plan B (2026-11-16)

- **Gates:** `bun run verify` passes: 1145 unit tests, 1 skipped (a pre-existing skip). `test:browser` 15/15 on
  RustFS and `test:browser:live` 15/15 on R2 (the lab's retry and order rows). `test:live` was 31/31 on R2 and
  `test:rustfs` and `test:wrangler` green after the part-size change (plan B task 6, `8f50795`); the rest of plan B
  changed only client and example code.
- **Bundle (gzip):** `cloudrop` 33.99 kB of 36 kB, `cloudrop/next` 1.01 kB of 1.1 kB, `cloudrop/node` 3.1 kB of
  3.2 kB, `cloudrop/client` 8.35 kB of 9 kB: the budget is the owner's ceiling for the rest of M3 (`M3-U43`,
  `M3-U58`), with about 0.65 kB left for the resume plan.
- **What works end to end:** server (`createCloudrop`, `route`, the four endpoints, verification, `api.*`), Next and
  Node adapters, `cloudrop/client` (single PUT and multipart, four parts of a file in flight, URL renewal,
  `PARTS_MISSING` repair, bounded retry, cancel with keep-or-abort; since plan A: bytes, speed and time left through
  XHR, a snapshot for `useSyncExternalStore`, one connection pool per client, several files per job with a result per
  file, pause, resume and cancel per file or job; since plan B: a pool that sizes itself, smallest-first, stalled PUTs
  given up after 30 s, pause while offline, `retry()` of a file or a job that reuses what landed, 16 MiB parts from
  256 MiB), the example app and its `/lab` page, on RustFS, Wrangler (single PUT only) and live R2.
- **Measured speed to R2 from the dev machine (2026-11-16):** about 130 ms per R2 API round trip. For a 256 MiB file,
  16 MiB parts beat 8 MiB by 14 to 56 % and 6 connections beat 4 by 18 to 62 % (`docs/research/r2-spike-findings.md`,
  "Part size, 2026-11-16"; `M3-U40`, `M3-U41`). The server adds about 0.7 s per file (`/upload` one storage call,
  `/complete` three).

## What comes next

### M3: the remaining client plans (spec §6)

The progress and scheduler design (`2026-11-16-progress-scheduler-design.md`) merged the progress and scheduler plans
into plans A and B. Both are done. Next, in order:

1. **M3 resume plan** (not written yet): persistence, fingerprints, `resumable()`, OPFS, resume after a reload (parent
   spec §6.3). It has about 0.65 kB of gzip under the 9 kB ceiling (`M3-U58`).
2. **M3 chaos plan:** the chaos proxy (§11.3), to test the above under loss, delay and resets.

### Open decisions for the owner

- **Faster uploads to R2** (measured above, none decided):
  - bucket location: a bucket created with a location hint near its users (`EEUR` for Europe) cuts the round trip
    and with it the server's per-file cost and each connection's ramp-up; an infrastructure choice, no code;
  - part size: decided by measurement (`M3-U40`); files from 64 to 256 MiB were not measured and keep 8 MiB parts;
  - the automatic pool still starts at 4 although 6 measured faster on this machine (`M3-U41`); revisit with data
    from other links;
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
- Plan B, parked: no unit row observes that `job.abort()` removes the listener on the caller's signal (`M3-U54`);
  that listener stays after `pagehide` or a ticket's expiry until the next run ends or an `abort()` (`M3-U54`); an
  expired ticket can never confirm a `/complete` that may have succeeded (`M3-U30`); `M3-U11`'s note that plan B
  would measure the cost of urgent publishes for large jobs was not acted on.
- Plan A, parked: one PUT can still start after a part fails its file (`M3-U15`); no unit row for a pause and a pool
  grant in the same microtask (`M3-U21`) or for a failure that wins the race with a pause (`M3-U22`); a long pause
  may cost one extra `/sign` (`M3-U20`); the lab's notes name a part without its file.
