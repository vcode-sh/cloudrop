# M3 hardening decisions

Decisions of the hardening phase between M2 and the M3 slice (2026-11-16). `M3-O<n>` are the owner's answers to the
questions the M2 reviews and the M3 plan left open. `M3-H<n>` are the controller's rulings, numbered as in the phase's
ledger (H1 to H9 and H11), plus `M3-H10` and `M3-H12` for behaviour that lanes N and I built and their reviews
accepted.

## Owner decisions

### M3-O1: `cloudrop/client` exports every wire type

- **Decision:** `cloudrop/client` exports all the protocol's wire types (`UploadRequest`, `FileTicket`,
  `SignedRequest`, `ErrorBody` and the rest), not only the ten names of the M3 plan's S4.
- **Why:** M2-X38 took the wire types out of the root entry on the understanding that the client would export them; a
  third-party client or a test of the protocol needs them, and they already are the server's wire contract.
- **If wrong:** every exported type is a semver promise; removing one after the first release is breaking.
- **Status:** decided; upholds M2-X38 and overrules the plan's S4, which the plan revision rewrites.
- **Visible in:** `src/protocol/types.ts`, `docs/superpowers/plans/2026-11-16-m3-vertical-slice.md` (S4).

### M3-O2: the file id is `id` everywhere on the wire

- **Decision:** One name for the file id: `id`. The tickets of `/upload` and the answer of `/abort` change from
  `fileId` to `id`, as `UploadedFile` and `PluginFile` already say. The stored metadata `x-amz-meta-cloudrop-id` does
  not change.
- **Why:** the same value had two names (final M2 review m16), and M3-O1 turns the wire types into a public promise;
  before the first release the rename is free.
- **If wrong:** none known; the package is unpublished, and a token signed before the change fails to verify like any
  malformed token.
- **Status:** in force (`fa35fe5`); supersedes the two names left by M2 (reviews-m2.md, m16). M2-D10 points here.
- **Visible in:** `src/protocol/types.ts`, `src/server/upload.ts`.

### M3-O3: three client error codes

- **Decision:** The client adds `UPLOAD_REJECTED`, `ABORTED` (the caller's signal fired) and `NETWORK_ERROR` (no answer
  at all, retryable) to `CloudropErrorCode`. The server's status table never sends them, as the plan's S5 describes.
- **Why:** spec §6.2 names `UPLOAD_REJECTED`; a cancelled upload and a missing answer need codes a program can branch
  on.
- **If wrong:** renaming a code after the first release is breaking.
- **Status:** decided; the M3 plan's S5 and Task 2 carry it out.
- **Visible in:** `docs/superpowers/plans/2026-11-16-m3-vertical-slice.md` (S5), `src/errors.ts` once Task 2 lands.

### M3-O4: the M3 plan's other recommendations are accepted

- **Decision:** Every other item under the M3 plan's "Not settled here" (items 1 and 4 to 18) is accepted as the plan
  recommends. The plan audit and lane P's measurements may still change one; each change gets an entry here and goes
  into the owner's report.
- **Why:** the owner reviewed the recommendations and their costs and found no reason to differ.
- **If wrong:** each item names its own cost in the plan.
- **Status:** in force. Lane P's review already found S22 contradicted by measurement (Wrangler's multipart
  `/complete` answers 502, not retryable); the plan revision handles it under M3-H7.
- **Visible in:** `docs/superpowers/plans/2026-11-16-m3-vertical-slice.md` ("Decisions").

## Controller rulings

### M3-H1: the controller fixes nothing itself

- **Decision:** In this phase the controller fixes no review finding itself; an implementer fixes it and a review
  checks it.
- **Why:** the controller's own fixes in M2 introduced new defects twice, found only by re-review (one is the
  "Controller fixes re-review" row in reviews-m2.md); the owner asked for subagent-driven work.
- **If wrong:** one more dispatch per small fix.
- **Status:** in force.

### M3-H2: hardening lanes first, then plan, audit and execution

- **Decision:** Lanes L, N, U and P run in parallel from `main` on disjoint files. After their reviews, the M3 plan is
  revised with the owner's answers and the measurements, audited by a fresh agent, then executed.
- **Why:** the owner's process is spec, plan, audit, execution; the plan rested on unmeasured behaviour.
- **If wrong:** M3 code starts later.
- **Status:** in force.

### M3-H3: worktrees go only after the decisions are in git

- **Decision:** The worktrees of merged M2 lanes are removed only after the decisions are committed, and the M2 working
  notes are archived outside any worktree first.
- **Why:** removing them earlier would delete the only copy of the reasons behind M2.
- **If wrong:** a few gigabytes stay on disk a little longer.
- **Status:** in force; its condition is met (`ab0341a`).

### M3-H4: source maps stay in the package until M6

- **Decision:** The published package keeps its source maps until M6.
- **Why:** they carry their own sources, cost install size only (about 255 kB raw) and never bundle size, and they help
  users debug a 0.x library.
- **If wrong:** one line in `tsdown.config.ts` at release.
- **Status:** in force; answers the lane G finding in reviews-m2.md.
- **Visible in:** `packages/cloudrop/tsdown.config.ts`.

### M3-H5: `NodeRequest` requires `rawHeaders`

- **Decision:** Accept lane N's change that makes `rawHeaders` a required field of `NodeRequest`.
- **Why:** the package is unpublished, every real `IncomingMessage` has it, and it is the only place a second Host
  header shows.
- **If wrong:** a hand-built `NodeRequest` needs one more field.
- **Status:** superseded by M3-H8.

### M3-H6: an absolute-form request target answers 400

- **Decision:** A request whose target is in absolute form (`GET http://host/path`) keeps answering 400, although RFC
  9112 §3.2.2 says a server must accept it.
- **Why:** the same section says the server then ignores Host and takes the origin from the target, which would let
  the target, not Host, decide the origin the same-origin check compares against (M2-D14). Browsers send absolute form
  only to proxies.
- **If wrong:** a client that sends absolute form straight to the app gets 400.
- **Status:** in force (`8fe9149`); lane I documents it in `README.md` and the spec.
- **Visible in:** `src/node.ts`, `src/node-url.test.ts`.

### M3-H7: lane R owns lane P's text fixes

- **Decision:** The fixes lane P's review asked for go to lane R, which revises both the measurement document and the
  M3 plan that reads it.
- **Why:** one implementer edits the two documents that must agree, and the plan audit re-reads both.
- **If wrong:** the measurement fixes get no separate review; the auditor covers them.
- **Status:** in force.
- **Visible in:** `docs/research/2026-11-16-m3-slice-measurements.md`, the M3 plan.

### M3-H8: `rawHeaders` is optional on `NodeRequest`

- **Decision:** `NodeRequest.rawHeaders` becomes optional and is read as `?? []`.
- **Why:** lane N's review showed that a required field makes a hand-built request answer 400 to everything with no
  log line, and it grows the public type; real Node requests always carry it.
- **If wrong:** a hand-built request without `rawHeaders` cannot detect a duplicated Host.
- **Status:** in force (`9da2b5b`); supersedes M3-H5.
- **Visible in:** `src/node.ts`.

### M3-H9: one lane owns `docs/decisions/`

- **Decision:** In the second hardening wave a single lane edits `docs/decisions/`. The lanes that change the server and
  the M3 plan cite the new ids (`M3-O<n>`, `M3-H<n>`) without editing the directory.
- **Why:** three lanes editing one directory at once would conflict.
- **If wrong:** a cited id might not match the entry; the final merge check resolves every id.
- **Status:** in force.

### M3-H10: the Node adapter needs one valid host

- **Decision:** `toNodeHandler` builds the request URL only from a single valid host, with no `localhost` fallback. It
  answers 400 when no host is named, when `Host` appears twice, when `Host` and HTTP/2's `:authority` name different
  hosts, or when either carries userinfo, `/`, `\`, `?`, `#`, an invalid character or an invalid port. The target must
  be a path (M3-H6). The scheme is `https` only on an encrypted socket, and no `X-Forwarded-*` header is read.
- **Why:** the same-origin check (M2-D14) trusts the URL the adapter builds. Before this, a missing or malformed Host
  became `http://localhost`, a second Host was ignored and userinfo or a path was cut away, so the URL could name an
  origin the client never sent. RFC 9112 §3.2 requires 400 for two Host lines or an invalid one; RFC 9113 §8.3.1 calls
  a differing `:authority` malformed.
- **If wrong:** an HTTP/1.0 client without Host, or a proxy that forwards two Host lines, gets 400; a path in Host is
  now 400 instead of 404.
- **Status:** in force (`8fe9149`); lane I adds it to `README.md` and the spec.
- **Visible in:** `src/node.ts`, `src/node-url.test.ts` (one table, 35 rows).

### M3-H11: the second wave's Minors go into one polish lane

- **Decision:** The Minor findings of the second wave's reviews are batched into one docs-and-polish dispatch before
  `main`, not one fix loop per lane.
- **Why:** the review skill keeps Minors out of fix loops, and they are all small text edits in few files.
- **If wrong:** one more short dispatch at the end.
- **Status:** in force.

### M3-H12: a bucket setting the storage cannot read is `unknown`

- **Decision:** `api.checkBucket` reports a CORS or lifecycle read that the storage answers with `501 Not Implemented`
  as `unknown`, as M2-D25 does for `STORAGE_DENIED`. Every other failure still fails the call: an unreachable storage,
  any other 5xx, a malformed answer.
- **Why:** Wrangler's local R2 answers both reads with `501 NotImplemented` (measured 2026-11-16, recorded in
  `docs/research/test-backends.md`). That says the read does not exist there, not what the bucket's setting is. Before
  this, the whole check failed on Wrangler and the development start-up warning said so on every first request.
- **If wrong:** a storage that answers 501 for a setting it does keep hides a missing CORS or lifecycle rule behind
  `unknown`; the message says to check the setting where the bucket is configured.
- **Status:** in force (`5fede9b`); amends M2-D25.
- **Visible in:** spec §9 (the `checkBucket` row already states it), `src/server/bucket-check.ts` (`settingCheck`),
  `src/server/bucket-check.test.ts`.
