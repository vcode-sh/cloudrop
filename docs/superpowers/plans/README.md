# Plans: where cloudrop stands

Updated 2026-11-17 on `feat/m3-resume` after the resume plan (not merged to `main` yet; **lab rows: pending**, see
below). This file is the one place
that says what is done and what comes next. The code is the truth: an executed plan is kept as a short stub marked
done, with the commit that holds its full text (`git show <commit>:docs/superpowers/plans/<file>`); every decision is
in [`docs/decisions/`](../../decisions/README.md).

## Milestones (spec §14)

| Milestone | Scope | State |
|---|---|---|
| M0 | Real-R2 spike, spec updated | **Done** 2026-11-15 ([`r2-spike-findings.md`](../../research/r2-spike-findings.md)) |
| M1 | `storage`: SigV4 signer, `r2` and `s3` drivers, fake R2, contract suite, Wrangler and RustFS lanes | **Done** 2026-11-15 (closed at `ca28497`; plan below) |
| M2 | `server`: `createCloudrop`, routes, tokens, handler, verification, `api.*`, Next and Node adapters | **Done** 2026-11-16 (closed at `2483890`, then the hardening phase, `ca91b33`) |
| M3 | `engine` and `client`: scheduler, transports, retry, persistence, progress, chaos proxy | **In progress**: the vertical slice (`90380fb`), progress plans A and B and the resume plan are done; chaos remains (below) |
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
| [M3 resume](2026-11-16-m3-resume.md) ([audit](2026-11-16-m3-resume.audit.md)), design [`2026-11-16-resume-design.md`](../specs/2026-11-16-resume-design.md) | Done from `57144e0`, on `feat/m3-resume`; **lab rows: pending** (task 6) and the budget (task 7) | Records in IndexedDB, edge-hash fingerprint, a Web Lock per upload, `resumable()`, `resume(upload, file)`, `forget()`, the `/complete` probe, `persist` and `namespace`; R2's browser refusals measured; decisions `M3-U60`..`M3-U87` |

## State of `feat/m3-resume` after the resume plan (2026-11-17)

- **Gates:** `bun run verify` passes: 1253 unit tests, 1 skipped (a pre-existing skip), 78 files. `test:browser`
  17/17 on RustFS after resume landed (task 5). **Lab rows: pending**: the resume rows of `/lab` and their RustFS and
  live R2 runs (task 6) are not on the branch yet. `test:live`, `test:rustfs` and `test:wrangler` were not run again:
  the plan changed client and example code and moved two functions, unchanged, from `src/plan.ts` to
  `src/part-size.ts`; no server or storage code.
- **Bundle (gzip):** `cloudrop` 33.84 kB of 36 kB, `cloudrop/next` 1.01 kB of 1.1 kB, `cloudrop/node` 3.1 kB of
  3.2 kB, `cloudrop/client` 10.45 kB of the 10.5 kB ceiling (`M3-U86`; 8.35 kB before the plan). The resume plan's last
  step sets the budget from measurement, after the lab and the review fixes.
- **What works end to end:** server (`createCloudrop`, `route`, the four endpoints, verification, `api.*`), Next and
  Node adapters, `cloudrop/client` (single PUT and multipart, four parts of a file in flight, URL renewal,
  `PARTS_MISSING` repair, bounded retry, cancel with keep-or-abort; since plan A: bytes, speed and time left through
  XHR, a snapshot for `useSyncExternalStore`, one connection pool per client, several files per job with a result per
  file, pause, resume and cancel per file or job; since plan B: a pool that sizes itself, smallest-first, stalled PUTs
  given up after 30 s, pause while offline, `retry()` of a file or a job that reuses what landed, 16 MiB parts from
  256 MiB; since the resume plan: a multipart upload resumed after a reload with the file picked again, sending only
  the parts the bucket lacks), the example app and its `/lab` page, on RustFS, Wrangler (single PUT only) and live R2.
- **Measured speed to R2 from the dev machine (2026-11-16):** about 130 ms per R2 API round trip. For a 256 MiB file,
  16 MiB parts beat 8 MiB by 14 to 56 % and 6 connections beat 4 by 18 to 62 % (`docs/research/r2-spike-findings.md`,
  "Part size, 2026-11-16"; `M3-U40`, `M3-U41`). The server adds about 0.7 s per file (`/upload` one storage call,
  `/complete` three).

## What comes next

### M3: the remaining client plans (spec §6)

The progress and scheduler design (`2026-11-16-progress-scheduler-design.md`) merged the progress and scheduler plans
into plans A and B; the resume design (`2026-11-16-resume-design.md`) gave the resume plan. All three are done (the
resume plan's lab rows pending). Next:

1. **M3 chaos plan:** the chaos proxy (§11.3), to test the above under loss, delay and resets. A copy of files into the
   origin-private file system, so a resume needs no new pick, is deferred to a later opt-in (`M3-U65`).

### Open decisions for the owner

- **Faster uploads to R2** (measured above, none decided):
  - bucket location: a bucket created with a location hint near its users (`EEUR` for Europe) cuts the round trip
    and with it the server's per-file cost and each connection's ramp-up; an infrastructure choice, no code;
  - part size: decided by measurement (`M3-U40`); files from 64 to 256 MiB were not measured and keep 8 MiB parts;
  - the automatic pool still starts at 4 although 6 measured faster on this machine (`M3-U41`); revisit with data
    from other links;
  - `/complete` makes three storage calls (ListParts, CompleteMultipart, HEAD); whether one can go without weakening
    verification (spec §7) needs analysis.
- **The "client plus React" target:** spec §1 keeps about 12 kB while the client's ceiling is now 10.5 kB, which
  leaves M4's bindings about 1.5 kB at the ceiling (`M3-U86`); M4 decides whether the target moves.
- **Unreadable R2 refusals:** a bad-signature `403` reaches the page as a network error, so the client retries for
  about 15 s and answers a retryable `NETWORK_ERROR`. Option: stop at the second unreadable answer on a fresh URL when
  `/sign` succeeded, with a non-retryable code (findings in `r2-spike-findings.md`, "Browser refusals and checksums,
  2026-11-16"). Not decided; the message was reworded instead.

### Small debts

- R2's `429` carries `Retry-After: 5`, which a page cannot read unless the bucket's CORS rule exposes it, so the
  client follows its own backoff; the README's troubleshooting does not say so yet ("Bad checksum, gone upload and
  throttling from a browser, 2026-11-16" in the findings, which measured `BadDigest`, `NoSuchUpload` on a part, `429`
  and a header the rule does not allow).
- The findings' "Browser, 2026-11-16" row U2 was measured the same way as the section with the erratum (a routed
  page), so its preflight `204` may be Playwright's too; its conclusion (the expired URL's answer is opaque) stands.
- The README says Deno has no `indexedDB`; not measured on this machine (no Deno installed).
- One unit test, `api.deletePrefix`, takes about 268 ms without a stated reason (testing-patterns asks for one over
  250 ms).
- The `/lab` page's "already stored" note (a `412` PUT) and its per-part `/sign` label have no browser test; no lab
  fault triggers them (the resume plan's task 6 takes them; pending).
- Wording: the slice plan quotes the old `NETWORK_ERROR` message (around line 551), a historical plan left as
  written.
- Plan B, parked: no unit row observes that `job.abort()` removes the listener on the caller's signal (`M3-U54`);
  that listener stays after `pagehide` or a ticket's expiry until the next run ends or an `abort()` (`M3-U54`); an
  expired ticket can never confirm a `/complete` that may have succeeded (`M3-U30`). The cost of urgent publishes for
  large jobs is now measured and left uncoalesced while a route allows at most 100 files (`M3-U11`).
- Plan A, parked: one PUT can still start after a part fails its file (`M3-U15`); no unit row for a pause and a pool
  grant in the same microtask (`M3-U21`) or for a failure that wins the race with a pause (`M3-U22`); a long pause
  may cost one extra `/sign` (`M3-U20`); the lab's notes name a part without its file.
