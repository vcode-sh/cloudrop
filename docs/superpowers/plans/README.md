# Plans: where cloudrop stands

Updated 2026-11-21 for 0.6.0, not yet released (the pilot's four gaps, `api.allFiles`, a review of every area). This file
is the one place that says what is done and what comes next. The code is the truth: an executed plan is kept as a short
stub marked done, with the commit that holds its full text (`git show <commit>:docs/superpowers/plans/<file>`); every
decision is in [`docs/decisions/`](../../decisions/README.md).

## Milestones (spec §14)

| Milestone | Scope | State |
|---|---|---|
| M0 | Real-R2 spike, spec updated | **Done** 2026-11-15 ([`r2-spike-findings.md`](../../research/r2-spike-findings.md)) |
| M1 | `storage`: SigV4 signer, `r2` and `s3` drivers, fake R2, contract suite, Wrangler and RustFS lanes | **Done** 2026-11-15 (closed at `ca28497`; plan below) |
| M2 | `server`: `createCloudrop`, routes, tokens, handler, verification, `api.*`, Next and Node adapters | **Done** 2026-11-16 (closed at `2483890`, then the hardening phase, `ca91b33`) |
| M3 | `engine` and `client`: scheduler, transports, retry, persistence, progress, chaos proxy | **Done** 2026-11-17: the vertical slice (`90380fb`), progress plans A and B, the resume plan and the chaos plan |
| M4 | `cloudrop/react`, examples | **Done** 2026-11-17. M4a: audit fixes, `route(policy, callbacks)`, lazy env config, `cloudrop/react` hooks, docs. M4b: the Next home page as an upload UI, `examples/hono`, `examples/vite-react`, `discard(upload)`, npm trusted publishing; no shadcn registry (`M4-E1`) |
| M5 | Database store and adapters (Prisma, Drizzle, SQL), [design](../specs/2026-11-17-m5-store-design.md) | **Done** 2026-11-17 (tasks C0, A–F, a whole-branch review and its fix round), merged to `main` |
| M6 | Plugins: `contentChecks`, `limits`, `images`, `checksums` | Started: `contentChecks` in `cloudrop/plugins`, 0.4.0 (`M10-K`); the other three not started |
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
| Post-M5 follow-ups (no plan file: tasks I and S, then M4-F25) | Done, merged to `main` 2026-11-17 | `POST /upload` takes an optional `idempotencyKey`. The client sends one per ask, and with a store a retry supersedes the lost attempt's pending rows of the same owner (owner-less rows are never superseded, `M5-T105`): `reserve` gains `requestKey`, and `cloudrop_files` gains `request_key` and an index on `(route, request_key)`. `tables.schema` puts both tables in a Postgres schema for every adapter (Drizzle tables in the schema, Prisma `@@schema`) and is refused on SQLite. The build drops JSDoc from the shipped `.js` and keeps it in the `.d.ts`. Decisions `M5-T100`..`M5-T105`, `M5-T120`..`M5-T124`, `M4-F25` |
| M4b (no plan file: tasks A, B, C and D, an integration round and a final fix round) | Done, merged to `main` 2026-11-18 | The Next example's home page as an upload UI on the headless hooks with shadcn on Base UI and Tabler icons, and the React guide's "Build your upload UI"; `examples/hono` (Bun, Hono, better-auth, a Drizzle store on Postgres, oRPC, a sweep worker) and `examples/vite-react` (the web app on another origin), with the [Hono guide](../../guide/hono.md) and a third browser pass; `client.discard(upload)` and `useResumable().discard/forget`, `/abort { token, keep: true }`; Postgres time columns at `timestamptz(3)`; the workspace on drizzle-orm 1.0.0-rc.5; a release workflow that publishes to npm through trusted publishing ([`docs/releasing.md`](../../releasing.md)) and the package's `CHANGELOG.md`. Decisions `M4-E1`..`M4-E14`, `M4-E20`..`M4-E30`, `M3-U93`..`M3-U95`, `M4-B16`, `M4-B17`, `M5-T130` |
| 0.1.1 (no plan file: the first pilot's report) | Done, merged to `main` 2026-11-20 | `HEAD` sends `accept-encoding: identity`, unsigned, so R2 no longer answers a compressible file of 50 bytes or more without `content-length` (0.1.0 failed such files at `/complete` with `502`); a contract case on every backend and a fake R2 that compresses as R2 does. The React guide's "Signed-in users" recipe (a client per user, cancel every route before `forget()`), the Vite example's sign-out cancels running uploads, and the READMEs say what `onComplete` "once" means. Decisions `M7-P1`..`M7-P4` |

## State of `main` after M4b (2026-11-18)

- **Gates:** measured on the branch after its final fix round: `bun run verify` 1655 passed / 3 skipped; `test:browser`
  40, 3 (store pass) and 9 (the Vite and Hono pass); `test:chaos` 23/23; `test:live` 32/32. Measured on the merged
  tree before that round (`408455b`), which changed no storage or store code: `test:db` 594 / 12 skipped,
  `test:wrangler` 104 / 23 skipped, `test:rustfs` 24 / 3 skipped, `test:browser:live` 27 + 3.
  `scripts/check-drizzle-versions.sh` type-checks the adapter against drizzle-orm 0.45.4 (the CI job `drizzle-0-45`)
  while the workspace runs 1.0.0-rc.5. The skips are declared gaps.
- **Summed gzip:** `cloudrop` 37.09 of 50 kB, `cloudrop/next` 0.78, `cloudrop/node` 2.26, `cloudrop/adapters/sql`
  10.84, `/drizzle` 12.65, `/prisma` 10.41 kB.
- **Bundled:** `cloudrop` 27.37 of 30 kB, `cloudrop/client` 11.32, `cloudrop/react` 2.02 kB.
- **Since the post-M5 follow-ups:** an unfinished upload can be discarded one at a time (`client.discard(upload)`,
  `useResumable().discard`), and `/abort` takes `keep`; three examples, of which two are a monorepo-shaped Hono API and
  a Vite web app on another origin, which keeps each user's unfinished uploads in that user's namespace; Postgres time
  columns at millisecond precision; a release workflow, not yet run. Security reports go by email (`SECURITY.md`);
  there is no Dependabot.

## State of `main` after the post-M5 follow-ups (2026-11-17)

- **Gates:** `bun run verify` 1636 passed / 3 skipped; `test:db` 594 / 12 skipped; `test:wrangler` 104 / 23 skipped;
  `test:rustfs` 24 / 3 skipped; `test:live` 32/32; `test:chaos` 23/23; `test:browser` 35 + 2 (store pass);
  `test:browser:live` 22 + 2; the CI job then named `drizzle-1` type-checked the adapter against 1.0.0-rc.5 (since M4b
  the workspace runs 1.0.0-rc.5 and the job, `drizzle-0-45`, checks 0.45.4). The skips are declared gaps.
- **Summed gzip:** `cloudrop` 37.01 of 50 kB, `cloudrop/next` 0.78, `cloudrop/node` 2.26, `cloudrop/adapters/sql`
  10.84, `/drizzle` 12.64, `/prisma` 10.41 kB.
- **Bundled:** `cloudrop` 27.29 of 30 kB, `cloudrop/client` 11.09, `cloudrop/react` 1.95 kB.

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

### 0.2.0: what the pilot asked for, released 2026-11-20

0.1.0 was published on 2026-11-19 and 0.1.1 on 2026-11-20. The pilot (an app on Bun, Hono, better-auth and Drizzle,
built on 0.1.0 and run in production) asked for the client changes `M7-P3` and `M7-P4` and had written its own owner
file API around the store. All of it shipped in 0.2.0 (2026-11-20; `packages/cloudrop/CHANGELOG.md`):

- the client: `close()` and `close({ abort: true })`, the `headers` option for the upload server only,
  `useResumable().discarding` (`M8-L1` to `M8-L9`);
- the server: `api.files`, `api.eraseOwner`, the route option `replace: true`, `api.sweep({ all: true })`, and a new
  owner index that existing databases migrate (`M8-A1` to `M8-A8`);
- a code-quality pass over storage, scripts, tooling, the client and React, and dev dependency updates (`M8-Q`).

A copy of files into the origin-private file system, so a resume needs no new pick, stays deferred to a later opt-in
(`M3-U65`).

### After 0.2.0: what the pilot's upgrade showed (2026-11-21)

The pilot moved to 0.2.0 and replaced its own avatar replacement, deletion cleanup, sweep loop, erasure steps and
abort plumbing with `replace`, `deleteFile`, `sweep({ all })`, `eraseOwner` and `close()`. Candidates it surfaced,
each now decided:

- **Released in 0.3.0 (2026-11-21):** `cloudrop/testing` (`M9-T`), the `cloudrop doctor`/`setup` command
  (`M9-C`) and the hardening from tests on a real bucket (`M9-H`),
  designed in `docs/superpowers/specs/2026-11-21-testing-and-cli-design.md`. R2 accepts `setup --apply`'s two
  writes (measured on the development bucket with an admin token, 2026-11-21), and a real browser uploaded through the
  rule it wrote.
- **Released in 0.4.0 (2026-11-21),** designed in `docs/superpowers/specs/2026-11-21-0.4.0-design.md`:
  `contentChecks()` in `cloudrop/plugins` (`M10-K`); the `onDelete` route hook and the `api.files` filters `name`,
  `type` and `order` (`M10-D`), which cover the pilot's name search but not its join with its profile table; the
  client option `account` and `ACCOUNT_CHANGED`, replacing the pilot's own header (`M10-A`); and the React guide's
  copy for `CLIENT_CLOSED`, `ABORTED` and `ACCOUNT_CHANGED`. Every part was reviewed again before release; the fixes
  are `M10-D11` and `M10-K12`.
- A copy-paste UI stays out (`M4-E1`) unless that ruling is revisited.

- **Released in 0.5.0 (2026-11-21):** `api.deleteFile` and `api.eraseOwner` pass a `context` to `onDelete`, and a
  replacement's hook gets the replacing request (`M10-D12`): the pilot's move to 0.4.0 found its audit trail needed
  them.

- **Built for 0.6.0 (2026-11-21, waiting for the pilot's run on the candidate and the owner's go):** what the pilot's
  move to 0.5.0 could not do (`api.deleteFile` says what it did, `onDelete` can refuse, a content refusal says what the
  file is, the command reads an app's own variable names: `M11-D`, `M11-K`, `M11-C`), `api.allFiles` (`M11-L`), and a
  review of every area by reviewers who had to prove each finding, with every proven finding fixed (`M11-R`). Designed
  in `docs/superpowers/specs/2026-11-21-0.6.0-design.md`.

### After 0.4.0: candidates, none decided

- The pilot can adopt 0.4.0: `account` instead of its `x-upload-user` header, `onDelete` for its audit trail, the
  `api.files` filters for its search, and `contentChecks()`.
- The remaining plugins: `limits()`, `images()`, `checksums()`; quarantine and virus scanning.
- "Attach on submit" (an upload kept pending until the form that holds it is saved) and a server-side upload with a
  row. The listing across owners that stood here is built for 0.6.0: `api.allFiles`, with its index (`M11-L`).
- The store paths behind their own entry (`M5-T69`): the bundled server measured 34.51 kB on 2026-11-21, under a
  ceiling of 36 kB that is provisional until the owner sets it (`M10-D10`, `M11-R100`).

### M6: the plugins

`contentChecks` shipped in 0.4.0; `limits`, `images` and `checksums` remain (base spec §8). `limits()` keeps rate limits and the quotas a store
does not count; a storage quota is the store's `quota` (M5). Still recorded from the product-fit review of
2026-11-17: a React Native client with background transfer, per-route `Cache-Control`, batches over 100 files. Its
bucket-setup command shipped as `cloudrop setup` (`M9-C`, extended by `M11-C` and `M11-R`).

### After M5 (from its tasks' concerns)

- The store paths behind their own entry, if the 4.93 kB they add to stateless server apps matters (`M5-T69`).
- A retry of exactly the failed ask's files could reuse its key, so an ask whose every attempt lost its answer stops
  holding its last attempt's reservation until the sweep (`M5-T101`).

### Owner steps

- The release's one-time setup above ([`docs/releasing.md`](../../releasing.md)).
- The live bucket's rule `cloudrop-browser-tests` exposes `Retry-After` since 2026-11-17 (`M3-K8`).

### Open decisions for the owner

- **Release approval while the repository is private:** GitHub's required reviewers work only in public repositories
  on Free, Pro and Team, so a pushed `v*` tag publishes as soon as `build` passes. `npm stage publish`, approved on
  npmjs.com with two-factor authentication, is the plan-independent gate (`docs/releasing.md`, "If the repository stays
  private").

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
  - `client/job-run.ts` and `client/launch.ts` were split at 249 lines; `resume.test.ts` is at 400 of 400, so its next
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
