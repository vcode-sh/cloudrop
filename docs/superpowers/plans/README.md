# Plans: where cloudrop stands

Updated 2026-11-21 for 0.6.0, released that day (the pilot's four gaps, `api.allFiles`, a review of every area), and on
2026-11-22 for the debts the 1.0 design settles ([plan](2026-11-22-1.0.0.md)). This file is the one place that says what
is done and what comes next. The code is the truth: an executed plan is kept as a short stub marked done, with the
commit that holds its full text (`git show <commit>:docs/superpowers/plans/<file>`); every decision is in
[`docs/decisions/`](../../decisions/README.md).

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

- **Released in 0.6.0 (2026-11-21),** after the pilot passed every gate on the packed candidate and the owner's go: what the pilot's
  move to 0.5.0 could not do (`api.deleteFile` says what it did, `onDelete` can refuse, a content refusal says what the
  file is, the command reads an app's own variable names: `M11-D`, `M11-K`, `M11-C`), `api.allFiles` (`M11-L`), and a
  review of every area by reviewers who had to prove each finding, with every proven finding fixed (`M11-R`). Designed
  in `docs/superpowers/specs/2026-11-21-0.6.0-design.md`.

### For 0.7: what the pilot's move to 0.6.0 asked for (deferred by the owner, 2026-11-21)

Withdrawn by the 1.0 design: there is no 0.7, and the evidence does not support these three (spec 1.0, "Withdrawn
because the evidence does not support them"; the documented promise `close()` lacked is spec 1.0 §3c).

- `close()` with a timeout the app sets, so a sign-out never waits the full 40 seconds for a server that does not
  answer (`M11-R261`, `M11-R264`).
- `api.allFiles` filters: a creation date range, files stuck in `pending` past their grace, a substring of the type,
  and the owner's details beside each file. A search by the owner's name or email stays the app's own query: those
  live in the app's tables (spec 0.6.0, "Out of scope"). The pilot does not use `api.allFiles` yet for this reason.
- A value `onDelete` hands back to the caller of `api.deleteFile`: the pilot still passes a mutable slot through
  `context` to carry its audit event to the notification it sends after the commit.

### After 1.0: candidates

The 1.0 design lists them (spec 1.0, "Out of scope for 1.0"), each additive, so a later minor can ship it:

- "Attach on submit" (an upload kept pending until the form that holds it is saved) and a server-side upload with a
  row. The listing across owners that stood here shipped in 0.6.0: `api.allFiles`, with its index (`M11-L`).
- Several buckets per server, and Vue, Svelte and Solid bindings.
- Upload speed tuning, which changes no API: a bucket created with a location hint near its users (`EEUR` for Europe);
  parts for files of 64 to 256 MiB, which were not measured and keep 8 MiB (`M3-U40`); the automatic pool's start of
  4 although 6 measured faster on this machine (`M3-U41`); whether `/complete`'s three storage calls can lose one
  without weakening verification (base spec §7). The measurements are above and in `r2-spike-findings.md`.

### M6: the plugins

`contentChecks` shipped in 0.4.0. The owner cut `limits()`, `images()` and `checksums()` from 1.0, and the scan and
quarantine plugin with them: a ten-line `afterVerify` recipe in the plugins guide covers scanning (spec 1.0, "Why this
release", and §8). A storage quota is the store's `quota` (M5). Still recorded from the product-fit review of
2026-11-17: a React Native client with background transfer, per-route `Cache-Control`, batches over 100 files. Its
bucket-setup command shipped as `cloudrop setup` (`M9-C`, extended by `M11-C` and `M11-R`).

### Owner steps

- The release's one-time setup is done: the repository is public, the `npm` environment requires `vcode-sh`'s review
  and takes only `v*` tags, and `main` has an active ruleset ([`docs/releasing.md`](../../releasing.md)).
- The live bucket's rule `cloudrop-browser-tests` exposes `Retry-After` since 2026-11-17 (`M3-K8`).

### Open decisions for the owner

None. Release approval, the last one, is resolved: the repository is public and the `npm` environment has a required
reviewer, so a pushed `v*` tag publishes only after `vcode-sh` approves the run's **publish** job, or after a
repository administrator bypasses the review, which the environment allows (`can_admins_bypass: true`, GitHub's
default). Checked with `gh api` on 2026-11-22; [`docs/releasing.md`](../../releasing.md), "The approval".

`BUCKET_BLOCKED`'s rule is measured on Chromium, Firefox and WebKit, and the browser lane runs its rows on all three
(spec 1.0 §2d, `M12-R60`, `M12-R61`).

### Known costs at 1.0

Accepted, each in force in its decision:

- A job keeps the listener on the caller's `signal` after `pagehide` or a ticket's expiry, until its next run ends or
  an `abort()`: the job's memory while a long-lived signal lives (`M3-U54`).
- One PUT can still start after a part fails its file (`M3-U15`).
- A long pause may cost one extra `/sign` (`M3-U20`).
- Urgent snapshot publishes are not coalesced, a measured cost while a route allows at most 100 files (`M3-U11`).
- No unit row of its own for a pause and a pool grant in the same microtask (`M3-U21`), or for a failure that wins the
  race with a pause (`M3-U22`); both cases are guarded in the code.

### Debts settled for 1.0 (2026-11-22)

Audited against `main` (spec 1.0 §9) and removed from the lists above:

- **Fixed:** `Retry-After` on the `200` that refuses a file storage could not start (`M12-E5`); unreadable R2 refusals,
  for the CORS case that matters (`BUCKET_BLOCKED`, `M12-E7`, decided after the whole budget by `M12-R60`; a
  bad-signature `403` stays a `NETWORK_ERROR` in Chromium and WebKit, and is `BUCKET_BLOCKED` in Firefox for a body
  sent quickly); the store paths that stateless server apps paid for (`M5-T69`, fixed by `M12-S1`: the bundled
  server went from 34.71 to 29.47 kB); the resume guide's claim that Deno has no `indexedDB`, measured by the Deno
  smoke lane's `indexedDB` assertion (Task 11; spec 1.0 §8).
- **Closed:** a retry that could not reuse a lost ask's key (`M5-T101`), resolved by `M11-R92`; an expired ticket
  that could never confirm a `/complete` that may have succeeded (`M3-U30`), resolved by `M11-R81`; the unit row for
  `job.abort()` removing the caller's listener, which exists since `d399b90` (`M3-U54`); release approval, above; the
  pilot adopting 0.4.0, done (and 0.6.0 since).
- **Closed as test tooling or wording only:** exact soak replay, which needs a per-request draw key in the proxy
  (`M3-K7`); `resume.test.ts` at 398 of 400 lines, split when a row needs room; row U2's caveat in the findings, whose
  conclusion stands; the slice plan's old `NETWORK_ERROR` message, a historical plan left as written; the lab's notes
  naming a part without its file.
