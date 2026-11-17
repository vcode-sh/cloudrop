# Plans: where cloudrop stands

Updated 2026-11-17 on `main` after M5 (the database store). This file is the one place
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
| M4 | `cloudrop/react`, shadcn registry, examples | **M4a done** 2026-11-17: audit fixes, `route(policy, callbacks)`, lazy env config, `cloudrop/react` hooks, docs. M4b (shadcn registry, Hono and Vite examples) not started |
| M5 | Database store and adapters (Prisma, Drizzle, SQL), [design](../specs/2026-11-17-m5-store-design.md) | **Done** 2026-11-17 (tasks C0, A–F, a whole-branch review and its fix round), merged to `main` |
| M6 | Plugins: `contentChecks`, `limits`, `images`, `checksums` | Not started |
| M7 | Docs, 0.x beta, 1.0 | Not started |

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
| M5 (no plan file: tasks A–F, C0 in the design's §9), design [`2026-11-17-m5-store-design.md`](../specs/2026-11-17-m5-store-design.md) | Done, merged to `main` 2026-11-17 | `createCloudrop({ store, quota, completionLeaseMs })`: a row before signing, `onComplete` once (exactly once for writes through `tx` on Postgres), hard quota, `QUOTA_EXCEEDED`, revocation, `/abort` that never deletes a completed file, `api.file/usage/revokeUploads/deleteFile/reconcile/sweep`; `cloudrop/adapters/sql` (node-postgres, postgres.js, `node:sqlite`, D1), `/drizzle` (drizzle-orm `>=0.45.0 <1 \|\| >=1.0.0-rc.5 <2`), `/prisma` (Prisma 7); `test:db`, D1 in `test:wrangler`, store rows in `test:chaos` and the browser lanes, the example's opt-in SQLite store, the [store guide](../../guide/store.md); decisions `M5-T16`..`M5-T98` |
| M4a (no plan file: tasks A–E in the design's §8), design [`2026-11-17-m4-dx-and-react-design.md`](../specs/2026-11-17-m4-dx-and-react-design.md) | Done, `bfbfca3..` merged to `main` 2026-11-17 | Client audit fixes (resume record kept after a network failure, cancel before a ticket, endpoint timeouts, `resumable()` leaves out held uploads), server and storage fixes (listed keys kept exactly, overlapping completions measured on R2), `route(policy, callbacks)` with options in any order, environment read on the first request, `r2()`/`s3()` env defaults, `forbidden()`, `cloudrop/react` (`createUploadHooks`, `useUpload`, `useResumable`), npm README and LICENSE, the guides; decisions `M4-F1`..`M4-F23` (no `M4-F21`), `M4-B1`..`M4-B15` |

## State of `main` after M4a (2026-11-17)

- **Gates:** `bun run verify` passes: 1418 unit tests, 1 skipped (a pre-existing skip). `test:rustfs` 24 passed and
  `test:wrangler` 18 passed (their skips are the backends' declared gaps), `test:live` 32/32 on R2, `test:chaos` 16/16,
  `test:chaos:soak` 4/4, `test:browser` 35/35 on RustFS and `test:browser:live` 22/22 on R2.
- **Bundle (gzip):** `cloudrop` 36.7 kB of 50 kB as published (22.36 kB of 30 kB bundled and minified),
  `cloudrop/next` 1.01 kB of 1.5 kB, `cloudrop/node` 3.1 kB of 4.5 kB, `cloudrop/client` 11.03 kB of 15 kB,
  `cloudrop/react` 1.96 kB of 3 kB: wide headroom by the owner's decision (`M4-F24`).
- **Since M3:** `route(policy, callbacks)` (options in any order), the environment read on the first request (`next
  build` needs no secrets), `r2()`/`s3()` read their settings from the environment, `forbidden()`, `cloudrop/react`, a
  resume record kept after a network failure, endpoint deadlines, `resumable()` leaving out uploads the page holds, keys
  with edge whitespace listed exactly, the npm README and LICENSE, and the guides (React, deployment, Hono and Bun).
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

### M4b: the shadcn registry and examples (spec §14)

M4a is done (design §7 lists what it left out). M4b: a shadcn registry (`UploadButton`, `Dropzone`, `FileList` over
`cloudrop/react`) and `examples/hono` and `examples/vite-react` (the two cold-developer apps of 2026-11-17 are a
starting point). A copy of files into the origin-private file system, so a resume needs no new pick, stays deferred to
a later opt-in (`M3-U65`).

### M6: the plugins

`contentChecks`, `limits`, `images` and `checksums` (base spec §8). `limits()` keeps rate limits and the quotas a store
does not count; a storage quota is the store's `quota` (M5). Still recorded from the product-fit review of
2026-11-17: a bucket-setup command for R2 and S3-compatible services, a React Native client with background transfer,
per-route `Cache-Control`, batches over 100 files.

### After M5 (from its tasks' concerns)

- A core-wide `tables.schema` for tables outside `public`, instead of the search path (`M5-T59`).
- An idempotency key on `/upload`, so a lost answer stops holding its reservation (M5 spec §5.7).
- The store paths behind their own entry, if the 4.7 kB they add to stateless server apps matters (`M5-T69`).

### Owner steps

- None open. The live bucket's rule `cloudrop-browser-tests` exposes `Retry-After` since 2026-11-17 (`M3-K8`).

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
- The resume guide says Deno has no `indexedDB`; not measured on this machine (no Deno installed).
- Wording: the slice plan quotes the old `NETWORK_ERROR` message (around line 551), a historical plan left as
  written.
- Plan B, parked: no unit row observes that `job.abort()` removes the listener on the caller's signal (`M3-U54`);
  that listener stays after `pagehide` or a ticket's expiry until the next run ends or an `abort()` (`M3-U54`); an
  expired ticket can never confirm a `/complete` that may have succeeded (`M3-U30`). The cost of urgent publishes for
  large jobs is now measured and left uncoalesced while a route allows at most 100 files (`M3-U11`).
- Plan A, parked: one PUT can still start after a part fails its file (`M3-U15`); no unit row for a pause and a pool
  grant in the same microtask (`M3-U21`) or for a failure that wins the race with a pause (`M3-U22`); a long pause
  may cost one extra `/sign` (`M3-U20`); the lab's notes name a part without its file.
