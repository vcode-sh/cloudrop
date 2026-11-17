# M2 execution rulings

Rulings made while executing the M2 plan, numbered 1 to 41 in the M2 execution ledger, which git never tracked. Rulings
1 to 6 are the owner's: M2-X1 and M2-X3 answer the plan audit's owner decision 1, M2-X4 decisions 2 and 3, M2-X5
decision 4, M2-X6 decisions 5 and 6, and M2-X2 is the owner's acceptance condition for the audit's Critical T14-1. The
rest are the controller's, many made on a review finding. Several are about process rather than code; they are kept
because later rulings and commits refer to them. `M2-P1` to `M2-P4` are rulings the ledger recorded without a number.

## Owner rulings

### M2-X1: a live token may delete its own completed object

- **Decision:** While its token is valid (24 hours), `/abort` may delete the upload's own completed object. An expired
  token never deletes a stored file; aborting an incomplete multipart upload is always allowed.
- **Why:** owner decision on audit T10-1 (audit owner decision 1); spec §5.5 requires the delete.
- **If wrong:** abort semantics and the 1.1 adapters' migration change with the product contract.
- **Status:** in force; it is the final form of M2-D20. Amended 2026-11-17 (M5-T8, M5-T28): with a database store and
  a token marked `stored`, the row decides instead of the token's age: `/abort` never deletes a completed or completing
  file, and cleans up an unfinished one even after `exp`. Tokens without the mark keep this rule. Amended 2026-11-17
  (M3-U94): `/abort { token, keep: true }` never deletes a landed object, whatever the token's age; only the client's
  `discard()` sends it.
- **Visible in:** spec §5.5, `src/server/abort.ts`, `src/server/route.ts` (`onComplete` TSDoc).

### M2-X2: the Node adapter never rejects or crashes

- **Decision:** The Node listener never rejects its promise or crashes the process, including on `TRACE`, an invalid
  URL or port, and a client that disconnects mid-body.
- **Why:** owner security acceptance (audit T14-1, Critical): one unhandled rejection can stop a server.
- **If wrong:** acceptance blocks until fixed.
- **Status:** in force.
- **Visible in:** `src/node.ts`, `src/node.test.ts`.

### M2-X3: authorize only at `/upload`

- **Decision:** Keep M2-D4. Document that an app needing revocation re-checks the session in `onComplete`.
- **Why:** owner decision (audit owner decision 1).
- **If wrong:** a revoked session completes its token's upload until expiry unless the app re-checks.
- **Status:** in force.
- **Visible in:** `src/server/route.ts` (`onComplete` TSDoc), `docs/guide/server.md` ("The upload token and what it allows").

### M2-X4: Node 24 and Biome schema 2.6.8

- **Decision:** CI and the spec target Node 24; `biome.json` declares schema 2.6.8. Both in one chore commit before M2.
- **Why:** the owner set `engines` to `>=24`, while CI still tested Node 22 (audit owner decisions 2 and 3).
- **If wrong:** the CI matrix must change if Node 22 support is required.
- **Status:** closed by `216814a`; M2-X12 and M2-X14 follow from it.
- **Visible in:** `.github/workflows/ci.yml`, `biome.json`, spec §3.

### M2-X5: server lanes on RustFS and Wrangler wait for M3

- **Decision:** The upload-protocol lane runs on the fake and on live R2 in M2. RustFS and Wrangler run only the
  storage contract until M3.
- **Why:** owner decision (audit owner decision 4). The server's backend behaviour is the driver's, which the contract
  already covers; Wrangler would need skips for its known gaps.
- **If wrong:** a server and backend interaction gap until M3. The final review named one: Wrangler's `ListParts`
  answers 501 and its completion ignores `If-None-Match: *`.
- **Status:** in force until M3.
- **Visible in:** spec §11, `docs/research/test-backends.md`.

### M2-X6: `authorize` first, plain objects, a registered refusal symbol

- **Decision:** In a route, `authorize` is written before the callbacks that use its result. `authorize` returns a plain
  object (prototype `Object.prototype` or `null`); a `Response`, `Error` or class instance fails closed with a logged
  500. `unauthorized()` is branded with `Symbol.for` and recognised only on a plain object.
- **Why:** owner decisions on audit T12-1 and T7-1 (audit owner decisions 5 and 6). TypeScript infers `authorize`'s
  result only for callbacks written after it.
- **If wrong:** routes must be reordered, and apps returning class instances must return `{ user: doc.toObject() }`.
- **Status:** in force; amends M2-D6 and M2-D29. Amended by M4-F15 (2026-11-17): the ordering rule is gone; `prefix`,
  `key` and `onComplete` take `route()`'s second argument and compile in any order. Amended by M4-F18 (2026-11-17):
  `forbidden()` carries the same brand with `code: "FORBIDDEN"`.
- **Visible in:** spec §4, `src/server/route.ts`, `src/server/upload.ts`.

## Controller rulings, before Task 1

### M2-X7: take every bounded audit Minor

- **Decision:** Implement all bounded audit Minors in M2; defer none at kickoff.
- **Why:** each improves safety or removes slop within M2's scope.
- **If wrong:** some extra code and review time.
- **Status:** closed with M2.

### M2-X8: one worktree per milestone, absolute paths

- **Decision:** Execute M2 in one dedicated worktree and give every child its absolute working directory.
- **Why:** the native hand-off chose its own path and could not honour the requested location.
- **If wrong:** commands run in the wrong checkout.
- **Status:** superseded by M2-X30 (one worktree per lane).

### M2-X9: plans are evidence

- **Decision:** The committed plan and audit stay unchanged; amendments live in the execution workspace and, in the end,
  in the code, the spec and these entries.
- **Why:** keeps the audit's evidence intact and avoids many repeated plan edits.
- **If wrong:** readers must follow the final spec and these entries, not the plan's samples.
- **Status:** in force; this index follows it (see [README.md](README.md#authority)).

### M2-X10: one `RequestHandler` type

- **Decision:** Task 1 declares `RequestHandler` once in the protocol types; Task 14's adapters import it.
- **Why:** audit X-3 found it declared twice; the producer had to exist before its consumers.
- **If wrong:** one type-only declaration earlier than the plan.
- **Status:** in force.
- **Visible in:** `src/protocol/types.ts`, `src/next.ts`, `src/node.ts`.

### M2-X11: one owner for `invalidInput`

- **Decision:** `invalidInput` (and later `isPlainObject`) stay in `storage/validate.ts`; server tasks import them from
  there.
- **Why:** audit T8-4 found a duplicate; cross-task fixes had to be carried explicitly.
- **If wrong:** small import coordination.
- **Status:** in force; M2-X35 defers moving them to M3.
- **Visible in:** `src/storage/validate.ts`.

### M2-X12: measure; do not copy historical counts

- **Decision:** Test counts and timings in the plan are historical; reports state measured results. All later gates
  run on Node 24.
- **Why:** audit X-4; the local default runtime was Node 26, so a Node 24 claim needed Node 24 actually selected.
- **If wrong:** none.
- **Status:** in force (updated once in the ledger after Node 24 was installed and verified).

### M2-X13: reviewers do not write to the worktree

- **Decision:** Reviews are written outside the worktree and archived by the controller.
- **Why:** the owner forbids reviewers mutating the worktree.
- **If wrong:** an extra copy step.
- **Status:** in force. Their outcomes are summarised in [reviews-m2.md](reviews-m2.md).

## Controller rulings, during Tasks 0 to 14

### M2-X14: align the active skills with Node 24

- **Decision:** Task 17 changes the two active skill sentences that said Node 22 to Node 24; historical plans and
  research stay as written.
- **Why:** current instructions must match the runtime requirement (M2-X4).
- **If wrong:** two lines to revert.
- **Status:** closed in the docs lane (merge `2483890`).
- **Visible in:** `.claude/skills/code-quality/SKILL.md`.

### M2-X15: 36 MIME mappings, not 37

- **Decision:** Keep the plan's 36 MIME-to-extension mappings and correct the stated count, rather than invent a 37th.
- **Why:** no missing mapping was named; unknown types already use MIME-only matching.
- **If wrong:** one type later needs a mapping.
- **Status:** in force; amends M2-D9.
- **Visible in:** `src/server/accept.ts`.

### M2-X16: `Jsonified` is documented as an approximation

- **Decision:** Describe `Jsonified` as a JSON-shaped approximation and state its limits (undefined in arrays, required
  `T | undefined` keys, non-enumerable fields) instead of growing the public conditional type.
- **Why:** exact own-enumerability is not expressible for arbitrary TypeScript types.
- **If wrong:** consumers of exotic shapes need a later type fix; no runtime guard is relaxed.
- **Status:** in force.
- **Visible in:** `src/protocol/types.ts` (TSDoc).

### M2-X17: exact size arithmetic, safe extension echo

- **Decision:** Parse size strings with exact decimal BigInt arithmetic, and echo a file extension in a refusal only
  when it matches the plain safe pattern.
- **Why:** M2-D8 forbids rounding and the constraints forbid unchecked client text; the plan's floating-point code
  rounded some inputs and echoed CR/LF (Task 2 review, I-1 and I-2).
- **If wrong:** a few more operations at configuration time.
- **Status:** closed by `b524cd8`; in force.
- **Visible in:** `src/server/size.ts`, `src/server/accept.ts`.

### M2-X18: fail closed on malformed token expiry and MIME text

- **Decision:** A token whose `exp` is not a safe integer is invalid. `contentDisposition` gives `attachment` for any
  non-canonical type text. Extension checks ignore terminal dots in the file name.
- **Why:** expiry and download safety must not depend on malformed text or on a caller's precondition (Task 4 review
  I1: `image/SVG+xml` was served inline).
- **If wrong:** some ambiguous name and type combinations are refused.
- **Status:** closed by `f90064d`; in force.
- **Visible in:** `src/server/token.ts`, `src/server/key.ts`, `src/server/accept.ts`.

### M2-X19: log-safe schema messages; unencodable output is a bug

- **Decision:** Schema diagnostics replace Unicode line separators and bidi controls as well as control characters. A
  schema output with no JSON form is a server bug (`undefined` stays allowed).
- **Why:** logs must stay readable, and validated metadata must survive the token's JSON.
- **If wrong:** a misbehaving schema gives a generic 500 instead of silently losing metadata.
- **Status:** in force (Task 7, `04b1b13`); amends M2-D28.
- **Visible in:** `src/server/schema.ts`.

### M2-X20: an absolute prefix is an application bug

- **Decision:** A configured prefix starting with `/` fails as a server bug (500, reason in the log) before key
  building trims slashes; `/` must never become the bucket root. Empty and relative prefixes keep working.
- **Why:** spec §7.4's tenant folder and M2-D10's invalid-key refusal forbid losing the folder.
- **If wrong:** apps passing absolute prefixes must use relative ones.
- **Status:** in force (Task 8, `e3d78e1`).
- **Visible in:** `src/server/key.ts`, `src/server/upload.ts`.

### M2-X21: no credentials in causes; usable signing results

- **Decision:** Drop a cause chain that is too deep, cannot be inspected or quotes credentials. Refuse a parsed empty
  ETag. Refuse presign signing or expiry times outside AWS's four-digit-year range.
- **Why:** public error causes must never carry credentials (Task 6 review Minor 2, promoted to required: plain-object
  causes and chains deeper than 8 leaked `Credential=`).
- **If wrong:** extreme dates are refused and some diagnostic detail is lost.
- **Status:** closed by `916b152` and `5800d37`; in force.
- **Visible in:** `src/storage/s3/transport.ts`, `src/storage/s3/responses.ts`, `src/storage/s3/presign.ts`.

### M2-X22: unmeasured bucket-settings codes fail closed

- **Decision:** For bucket-settings reads, only the explicit missing-configuration codes the fake represents mean "no
  rules". Any other 404 is a storage error (built retryable; M2-X40 made it non-retryable). Lifecycle tag filters are
  documented, not modelled.
- **Why:** R2's codes for a bucket without settings are unmeasured (object tokens get 403), so they must fail closed
  rather than be read as "missing".
- **If wrong:** a real R2 empty-settings code gives an actionable error until measured.
- **Status:** amended by M2-X40, which replaces only its retry flag.
- **Visible in:** `src/storage/s3/bucket-settings.ts`.

### M2-X23: configuration checks before effects

- **Decision:** Validate global configuration before plugin and warning effects; refuse `basePath` dot segments that
  URL parsing changes; keep `undefined` in the completion metadata type of optional schemas.
- **Why:** construction failures must precede side effects, routes must be mountable, and types must describe runtime
  (Task 7 review minors).
- **If wrong:** previously useless paths fail early; consumers of optional metadata check `undefined`.
- **Status:** in force.
- **Visible in:** `src/server/config.ts`, `src/server/route.ts`.

### M2-X24: arrange the abort test through the driver

- **Decision:** Task 10's completed-multipart abort test completes the upload through the storage driver, then calls
  the real `/abort`, because `/complete` did not exist yet.
- **Why:** the audit's literal sequence could not go green before Task 11.
- **If wrong:** Task 10 does not prove `/complete` itself; later tasks do.
- **Status:** closed (`e690771`, `58c7470`).
- **Visible in:** `src/server/abort.test.ts`.

### M2-X25: one checked snapshot of `authorize`'s JSON

- **Decision:** Serialise `authorize`'s result once, require a top-level plain object, cap and sign that snapshot;
  `prefix` and `key` callbacks keep the live result. Metadata follows the same rule.
- **Why:** the 2 KiB cap and the signed owner must cover the same value, not two `toJSON` results.
- **If wrong:** custom serialisers returning primitives or arrays now fail with 500.
- **Status:** in force (`e63aea0`); amends M2-D3.
- **Visible in:** `src/server/upload.ts`.

### M2-X26: safe answers at the edges

- **Decision:** An unknown plain-JS error code never answers HTTP 200. A branded refusal with a malformed message stays
  a denial with the default message. Every response, including the preflight, is `no-store`. A deadline crossed during
  async signing answers `UPLOAD_EXPIRED`, not a storage failure.
- **Why:** the wire and expiry contracts hold even for malformed input and last-second requests.
- **If wrong:** rare inputs get a safer classification.
- **Status:** in force (`e63aea0`); amends M2-D16 and M2-D32.
- **Visible in:** `src/server/http.ts`, `src/server/sign.ts`.

### M2-X27: `/abort` is cleanup, not revocation

- **Decision:** The token stays a stateless 24-hour authority. After `/abort`, a single-PUT URL stays valid for up to
  900 s and a live token may call `/sign` again until `exp`; the core cannot tell a cancelled reservation without
  state. Document the whole token window and idempotent quota callbacks; `afterVerify` refusing a released reservation
  is M2's enforcement hook.
- **Why:** M2-D4 and the stateless design bind; durable revocation belongs to M5 limits and the 1.1 adapters.
- **If wrong:** an aborted upload can land and complete again unless an app's `afterVerify` refuses it.
- **Status:** in force. The docs lane found the "sign again" part holds for single PUT only (an aborted multipart
  upload is gone). Amended 2026-11-17 (M5-T6, M5-T7): with a database store, an ended row refuses `/sign` and
  `/complete` with `UPLOAD_EXPIRED`, so `/abort` and `api.revokeUploads` revoke; a URL signed before stays usable for
  its 15 minutes, and the sweep's cleanup pass removes what it uploads.
- **Visible in:** spec §5.5 and §8, `docs/guide/server.md` ("The upload token and what it allows").

### M2-X28: a failed cleanup keeps the reservation; an own-object 412 is a retry

- **Decision:** When `/complete` cannot delete a rejected object, it returns the storage failure and keeps the
  reservation. A 412 whose object HEAD shows this upload's id and size is an idempotent retry, not another writer.
- **Why:** quota follows the bytes actually kept, and the upload's own object must survive any race order (Task 11
  review I1 and M2).
- **If wrong:** a conservative quota hold during storage failures and one extra HEAD on a rare 412. R2's real ordering
  of the 412 is unmeasured.
- **Status:** closed by `b2ed2d4`; in force.
- **Visible in:** `src/server/complete.ts`.

### M2-X29: adapters validate `{ handler }`

- **Decision:** Adapter constructors check `{ handler }` and throw `INVALID_CONFIG` through the shared `configError`,
  still importing no server code.
- **Why:** a plain-JS configuration mistake must be `INVALID_CONFIG`, not a `TypeError`; this overrides the plan's
  import-only-protocol shortcut.
- **If wrong:** a few bundle bytes (measured in Task 14).
- **Status:** in force; amends M2-D27.
- **Visible in:** `src/next.ts`, `src/node.ts`.

## Controller rulings, second session (Tasks 13 to 17 and the hardening lanes)

### M2-X30: parallel lanes in their own worktrees

- **Decision:** Lanes run in parallel, each child in its own prepared worktree that starts from the milestone branch;
  lanes own disjoint files and the controller merges them.
- **Why:** the owner asked for parallel agents, which overrides the one-implementer rule.
- **If wrong:** merge conflicts.
- **Status:** in force for later sessions; supersedes M2-X8.

### M2-X31: no injected clock in the server

- **Decision:** Drop audit item 7 (inject a clock into the server).
- **Why:** fake timers already drive the server and the driver through one mechanism; a public option cannot be taken
  back.
- **If wrong:** M3 engine tests that want one clock for client and server add the seam then.
- **Status:** in force.

### M2-X32: file-size and complexity caps, enforced

- **Decision:** Source files aim at 200 to 220 lines, with hard caps of 250 (source) and 400 (tests) and cognitive
  complexity at most 15, enforced by the check.
- **Why:** the owner asked for files near 200 to 220 lines; a cap without a gate rots.
- **If wrong:** the caps are numbers in one script.
- **Status:** in force (`784fbe8`, `f1aa84a`).
- **Visible in:** `AGENTS.md`, `scripts/check-file-size.ts`, `biome.json`.

### M2-X33: a log hint for proxies, not forwarded-header trust

- **Decision:** A same-origin refusal behind a TLS-terminating proxy gets a bounded log hint naming the origin to add to
  `trustedOrigins`; no forwarded header is trusted and no option is added.
- **Why:** the refusal is correct and secure by default; an option cannot be taken back.
- **If wrong:** operators behind proxies still list their public origin, now told so by the log.
- **Status:** in force; amends M2-D14.
- **Visible in:** `src/server/handler.ts`.

### M2-X34: a stale part ETag at completion is retryable

- **Decision:** `INVALID_PART` at completion answers a retryable error instead of "contact the site owner".
- **Why:** the server completes with its own part list, so the only cause is a part replaced between `ListParts` and
  completion, which a retry resolves.
- **If wrong:** a client retries a completion that cannot succeed until its retry budget ends.
- **Status:** in force (`0400df3`).
- **Visible in:** `src/server/complete.ts`.

### M2-X35: move the shared input helpers in M3

- **Decision:** Moving `invalidInput`, `isPlainObject` and `formatBytes` out of `storage/validate.ts` waits for M3.
- **Why:** nothing needs a neutral module until a client exists, and the M3 plan knows which helpers the client shares.
- **If wrong:** eight server imports change later instead of now.
- **Status:** in force; the M3 plan (Task 1, S6) moves `invalidInput` and `isPlainObject` to `src/input.ts` and keeps
  `formatBytes` where it is.
- **Visible in:** `src/storage/validate.ts`, `docs/superpowers/plans/2026-11-16-m3-vertical-slice.md`.

### M2-X36: delete the duplicated abort case

- **Decision:** Delete the plan-mandated abort case from `protocol.test.ts`.
- **Why:** the testing rule against duplicated contracts at one level outranks the plan sample; `abort.test.ts` and
  `complete.test.ts` assert more (Tasks 15+16 review I1).
- **If wrong:** one end-to-end abort row to restore.
- **Status:** closed by `5964b7c`.

### M2-X37: M3 ends at a plan this session

- **Decision:** M3 in the second M2 session ends at a vertical-slice plan, with no client code.
- **Why:** the owner's process is spec, plan, audit, execution, and the client API holds decisions only the owner can
  make.
- **If wrong:** the slice starts one session later.
- **Status:** closed by `0010b94`.
- **Visible in:** `docs/superpowers/plans/2026-11-16-m3-vertical-slice.md`.

### M2-X38: trim the root entry before first publish

- **Decision:** The root entry drops the 18 wire types, `Jsonified`, `RouteTypes`, `StandardIssue` and
  `StandardResult`.
- **Why:** every export is a semver promise and no server developer needs them; `cloudrop/client` was to export the
  wire types.
- **If wrong:** re-adding an export is not breaking.
- **Status:** closed by `d1b2c26`. Its second half holds: the owner decided on 2026-11-16 that `cloudrop/client`
  exports all protocol wire types, overruling the M3 plan's ten-name S4 (M3-O1).
- **Visible in:** `src/index.ts`.

### M2-X39: delete a property that cannot fail

- **Decision:** Delete the brief-mandated "agree with planParts" property in `plan.test.ts`.
- **Why:** after the part arithmetic moved into `plan.ts`, it compared the functions with themselves; the
  constructed-from-its-answer property is the independent oracle (lane S review I1).
- **If wrong:** none measurable.
- **Status:** closed by `fe7a1b1`.

### M2-X40: an unexplained bucket-settings 404 is not retryable

- **Decision:** An unexplained 404 on a bucket-settings read is a non-retryable storage error. Only the retry flag of
  M2-X22 changes.
- **Why:** a wrong endpoint path does not heal by retrying, and the message already says to check the endpoint (final
  review m14).
- **If wrong:** a transient proxy 404 is reported once instead of retried.
- **Status:** in force (`4af3a8a`); amends M2-X22.
- **Visible in:** `src/storage/s3/bucket-settings.ts`, `src/storage/s3/bucket-settings.test.ts`, spec §12.

### M2-X41: one fix wave for the final review

- **Decision:** Fix the final review's I1 to I3 and the cheap minors (m1 to m10, m12 to m14, m11 as documentation) in
  one wave before merge. Leave m15, m16, m17 and the source maps in the tarball to the owner.
- **Why:** the owner asked for all fixes in this session, and each fix was small with a named trigger.
- **If wrong:** one more implementer and one scoped re-review.
- **Status:** closed (`37a9595` to `9df61ef`). The items left to the owner are listed in
  [reviews-m2.md](reviews-m2.md); m16 is decided by M3-O2 and the source maps by M3-H4.

## Unnumbered rulings

### M2-P1: the live credential check stays in two files

- **Decision:** Keep the credential check copied in the two live lane files.
- **Why:** two callers do not justify a shared helper (Tasks 15+16 review M5).
- **If wrong:** one message to edit twice.
- **Status:** in force.
- **Visible in:** `src/server/handler.r2.integration.test.ts`, `src/storage/s3-driver.r2.integration.test.ts`.

### M2-P2: `FileApi.put` passes the driver's write options

- **Decision:** Leave `put` forwarding the driver's options; the type, `ObjectOptions`, is the contract.
- **Why:** owner note in the Task 13 review (M4); no change requested.
- **If wrong:** an undocumented option works at run time.
- **Status:** in force; the options are documented since `4414cc6` (final review m12).
- **Visible in:** `src/server/api.ts`, spec §9.

### M2-P3: the contract suite keeps its explicit interface

- **Decision:** Keep the explicit `ContractSuite` interface.
- **Why:** optional per the lane T review (Minor 2); it documents what a case group receives.
- **If wrong:** about 20 lines.
- **Status:** in force.
- **Visible in:** `src/testing/storage-contract/suite.ts`.

### M2-P4: `extendRoute`'s error contract belongs to M5

- **Decision:** `createCloudrop` passes a `CloudropError` thrown by `extendRoute` through unchanged, even with a code
  other than `INVALID_CONFIG`.
- **Why:** M5 owns `extendRoute`'s design, and the hook's contract says to throw `INVALID_CONFIG` (final fix
  re-review N2).
- **If wrong:** a misbehaving plugin makes `createCloudrop` throw another code.
- **Status:** in force until M5.
- **Visible in:** `src/server/config.ts`.
