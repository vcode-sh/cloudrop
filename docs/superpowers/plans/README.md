# Plans: where cloudrop stands

Updated 2026-11-17 on `main` after the chaos plan, which closes M3. This file is the one place
that says what is done and what comes next. The code is the truth: an executed plan is kept as a short stub marked
done, with the commit that holds its full text (`git show <commit>:docs/superpowers/plans/<file>`); every decision is
in [`docs/decisions/`](../../decisions/README.md).

## Milestones (spec §14)

| Milestone | Scope | State |
|---|---|---|
| M0 | Real-R2 spike, spec updated | **Done** 2026-11-15 ([`r2-spike-findings.md`](../../research/r2-spike-findings.md)) |
| M1 | `storage`: SigV4 signer, `r2` and `s3` drivers, fake R2, contract suite, Wrangler and RustFS lanes | **Done** 2026-11-15 (closed at `ca28497`; plan below) |
| M2 | `server`: `createCloudrop`, routes, tokens, handler, verification, `api.*`, Next and Node adapters | **Done** 2026-11-16 (closed at `2483890`, then the hardening phase, `ca91b33`) |
| M3 | `engine` and `client`: scheduler, transports, retry, persistence, progress, chaos proxy | **Done** 2026-11-17: the vertical slice (`90380fb`), progress plans A and B, the resume plan and the chaos plan |
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
| [M3 resume](2026-11-16-m3-resume.md) ([audit](2026-11-16-m3-resume.audit.md)), design [`2026-11-16-resume-design.md`](../specs/2026-11-16-resume-design.md) | Done, `57144e0..11eb34d` | Records in IndexedDB, edge-hash fingerprint, a Web Lock per upload, `resumable()`, `resume(upload, file)`, `forget()`, the `/complete` probe, `persist` and `namespace`; R2's browser refusals measured; the lab's resume rows; decisions `M3-U60`..`M3-U91` |
| [M3 chaos](2026-11-17-m3-chaos.md) ([audit](2026-11-17-m3-chaos.audit.md)), design [`2026-11-17-chaos-design.md`](../specs/2026-11-17-chaos-design.md) | Done, from `11eb34d`, merged to `main` 2026-11-17 | A fault-injecting proxy in front of RustFS; `test:chaos` on every pull request (Node rows 1–8, 12–14, 17), the browser rows through the proxy in `test:browser` (stall under Playwright's clock), a nightly `test:chaos:soak` (seeded random faults, a mid-run abort, the real-time stall and throttle rows); the lab shows a stall as a stall; one client fix the soak found (`M3-U92`: a retryable refusal at `/upload` is asked again within the attempt budget); decisions `M3-K1`..`M3-K11`, `M3-U92` |

## State of `main` after the chaos plan (2026-11-17)

- **Gates:** `bun run verify` passes: 1325 unit tests, 1 skipped (a pre-existing skip). `test:chaos` 16/16 (Node,
  RustFS behind the proxy), `test:chaos:soak` 4/4 (seeded soak and the real-time rows), `test:browser` 35/35 on RustFS
  (the lab's rows and the browser chaos rows) and `test:browser:live` 22/22 on R2 (chaos rows left out: R2 routes by its
  own host). `test:live`, `test:rustfs` and `test:wrangler` were not run again: the plan changed client, example and
  test-only code, no server or storage code.
- **Bundle (gzip):** `cloudrop` 33.84 kB of 36 kB, `cloudrop/next` 1.01 kB of 1.1 kB, `cloudrop/node` 3.1 kB of
  3.2 kB, `cloudrop/client` 10.85 kB of the 11 kB ceiling (`M3-U91`; 10.58 kB before the chaos plan's `M3-U92`): about
  0.15 kB of room for M4 under the ceiling.
- **What works end to end:** server (`createCloudrop`, `route`, the four endpoints, verification, `api.*`), Next and
  Node adapters, `cloudrop/client` (single PUT and multipart, four parts of a file in flight, URL renewal,
  `PARTS_MISSING` repair, bounded retry, cancel with keep-or-abort; since plan A: bytes, speed and time left through
  XHR, a snapshot for `useSyncExternalStore`, one connection pool per client, several files per job with a result per
  file, pause, resume and cancel per file or job; since plan B: a pool that sizes itself, smallest-first, stalled PUTs
  given up after 30 s, pause while offline, `retry()` of a file or a job that reuses what landed, 16 MiB parts from
  256 MiB; since the resume plan: a multipart upload resumed after a reload with the file picked again, sending only
  the parts the bucket lacks; since the chaos plan: a file the server could not start in storage asked again within
  the attempt budget), the example app and its `/lab` page, on RustFS, Wrangler (single PUT only) and live R2. Every
  upload under injected resets, black holes, throttles, 429/503/500, readable and opaque 403s, cut answers and faults
  in the server's own storage calls ends with the file's exact bytes and nothing left open, or with a documented code.
- **Measured speed to R2 from the dev machine (2026-11-16):** about 130 ms per R2 API round trip. For a 256 MiB file,
  16 MiB parts beat 8 MiB by 14 to 56 % and 6 connections beat 4 by 18 to 62 % (`docs/research/r2-spike-findings.md`,
  "Part size, 2026-11-16"; `M3-U40`, `M3-U41`). The server adds about 0.7 s per file (`/upload` one storage call,
  `/complete` three).

## What comes next

### M4: `cloudrop/react`, the shadcn registry, examples (spec §14)

M3 is done. M4 starts from a client at 10.85 kB of its 11 kB ceiling, which decides how much of the React bindings fit
(see "client plus React" below). A copy of files into the origin-private file system, so a resume needs no new pick,
stays deferred to a later opt-in (`M3-U65`).

### Owner steps

- **Live bucket CORS:** add `Retry-After` to the `ExposeHeaders` of the test bucket's rule `cloudrop-browser-tests`, so
  a page can honour R2's `Retry-After: 5` on a 429 (`M3-K8`). Agents never write bucket settings; until then the client
  follows its own backoff there. The README's CORS section already recommends it to users.

### Open decisions for the owner

- **Faster uploads to R2** (measured above, none decided):
  - bucket location: a bucket created with a location hint near its users (`EEUR` for Europe) cuts the round trip
    and with it the server's per-file cost and each connection's ramp-up; an infrastructure choice, no code;
  - part size: decided by measurement (`M3-U40`); files from 64 to 256 MiB were not measured and keep 8 MiB parts;
  - the automatic pool still starts at 4 although 6 measured faster on this machine (`M3-U41`); revisit with data
    from other links;
  - `/complete` makes three storage calls (ListParts, CompleteMultipart, HEAD); whether one can go without weakening
    verification (spec §7) needs analysis.
- **The "client plus React" target:** spec §1 keeps about 12 kB while the client's ceiling is now 11 kB, which
  leaves M4's bindings about 1 kB at the ceiling (`M3-U91`); M4 decides whether the target moves.
- **Unreadable R2 refusals:** a bad-signature `403` reaches the page as a network error, so the client retries for
  about 15 s and answers a retryable `NETWORK_ERROR`. Option: stop at the second unreadable answer on a fresh URL when
  `/sign` succeeded, with a non-retryable code (findings in `r2-spike-findings.md`, "Browser refusals and checksums,
  2026-11-16"). Not decided; the message was reworded instead.

### Small debts

- Chaos plan follow-ups:
  - The server sends no `Retry-After` on the `200` that refuses a file it could not start in storage, so the client's
    re-ask (`M3-U92`) waits only its own backoff. The fix needs no wire change: the storage driver keeps the bucket's
    `Retry-After` on its error, and `handleUpload` sets the `200`'s `Retry-After` to the largest among its rejected
    tickets, which the client already honours.
  - A soak seed replays the files and the fault stream, not which request draws which fault (requests draw in arrival
    order, `M3-K7`); exact replay needs a per-request draw key in the proxy.
  - `client/job-run.ts` and `client/launch.ts` were split at 249 lines; `resume.test.ts` is at 398 of 400, so its next
    row needs a split first.

- The findings' "Browser, 2026-11-16" row U2 was measured the same way as the section with the erratum (a routed
  page), so its preflight `204` may be Playwright's too; its conclusion (the expired URL's answer is opaque) stands.
- The README says Deno has no `indexedDB`; not measured on this machine (no Deno installed).
- Wording: the slice plan quotes the old `NETWORK_ERROR` message (around line 551), a historical plan left as
  written.
- Plan B, parked: no unit row observes that `job.abort()` removes the listener on the caller's signal (`M3-U54`);
  that listener stays after `pagehide` or a ticket's expiry until the next run ends or an `abort()` (`M3-U54`); an
  expired ticket can never confirm a `/complete` that may have succeeded (`M3-U30`). The cost of urgent publishes for
  large jobs is now measured and left uncoalesced while a route allows at most 100 files (`M3-U11`).
- Plan A, parked: one PUT can still start after a part fails its file (`M3-U15`); no unit row for a pause and a pool
  grant in the same microtask (`M3-U21`) or for a failure that wins the race with a pause (`M3-U22`); a long pause
  may cost one extra `/sign` (`M3-U20`); the lab's notes name a part without its file.
