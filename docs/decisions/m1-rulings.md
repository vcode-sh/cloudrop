# M1 rulings

Rulings made while building the storage layer (M1). The M1 ledger was not kept; these are the rulings the M2 planning
brief restated as "decided, do not reopen", with its wording made explicit. Where the brief grouped several numbers
under one rule without saying which number is which, the entry keeps them together. The brief also restated rulings
without a number; they are `M1-N1` to `M1-N3` at the end. Numbers not listed here are not recoverable (see
[README.md](README.md#gaps)).

### M1-R1 and M1-R2: the filename picks the test lane

- **Decision:** Tests are colocated, with no `test/` folders. `*.test.ts` is the unit project (`bun run test`);
  `*.integration.test.ts` is the integration project, run only by a lane script. A lane whose service or credentials are
  missing fails in `beforeAll` with a message naming what to set, never `describe.skip`. A capability skip is allowed
  only for a measured backend gap, with its reason.
- **Why:** a skipped lane looks green. A lane that fails says exactly what is missing.
- **If wrong:** a contributor without credentials sees failures instead of skips when running a lane script directly.
- **Status:** in force.
- **Visible in:** `AGENTS.md` (Rules), `packages/cloudrop/vitest.config.ts`, `docs/research/test-backends.md`.

### M1-R5: library source has no Node types

- **Decision:** Library source compiles with `types: []`: no `node:` imports, no `process`, no `Buffer`. Tests and
  scripts use `tsconfig.test.json`. The only environment access is a guarded `globalThis.process?.env` read.
- **Why:** cloudrop runs on Workers, Deno, Bun and browsers as well as Node; the compiler, not review, keeps Node out.
- **If wrong:** a Node-only API would have to be described by hand, as `cloudrop/node` does.
- **Status:** in force. M2-D26 applied it to `cloudrop/node`; the env read moved to `src/env.ts` (`fromEnv`) in M2.
- **Visible in:** `packages/cloudrop/tsconfig.json`, `src/env.ts`, `src/node.ts`, `AGENTS.md`.

### M1-R9, M1-R15, M1-R16, M1-R18 and M1-R21: driver behaviour already built

- **Decision:** The S3 driver keeps four behaviours, which the brief listed together under these five numbers:
  - every request has an internal timeout (`AbortSignal.timeout`);
  - `put(Blob)` is signed as `UNSIGNED-PAYLOAD`, so a Blob is streamed unread;
  - the endpoint may carry a path prefix, which goes before the bucket name;
  - `copy` sends `x-amz-copy-source-if-match`, so a source replaced mid-copy fails instead of copying the new bytes.
- **Why:** each was measured or required on R2 during M1 (`docs/research/r2-spike-findings.md`).
- **If wrong:** the matching contract case in `src/testing/storage-contract/` fails on the backend that disagrees.
- **Status:** in force.
- **Visible in:** `src/storage/s3/transport.ts`, `src/storage/s3/context.ts`, `src/storage/s3/copy.ts`,
  `src/storage/driver.ts`.

### M1-R11: focused test commands

- **Decision:** Plans write a focused test run as `cd packages/cloudrop && bunx vitest run --project unit <file>`.
- **Why:** one form in every plan step, so implementers run the same project the gate runs.
- **If wrong:** none beyond a longer command.
- **Status:** amended. The testing skill now gives `bun run --cwd packages/cloudrop test <file>`, which runs the same
  project; both forms work.
- **Visible in:** `.claude/skills/testing-patterns/references/repository.md`.

### M1-R14: NFC belongs to the server's key builder

- **Decision:** Unicode NFC normalisation and key sanitising (spec §5.3) happen in the server's key builder. The storage
  validator never rewrites its input; it only refuses.
- **Why:** a storage call must store the key it was given, or an object cannot be found again under the caller's key.
- **If wrong:** a caller of `cloudrop.api` that passes a non-NFC key stores it as given.
- **Status:** in force.
- **Visible in:** `src/server/key.ts`, `src/server/upload.ts` (file names in NFC), `src/storage/validate.ts`.

### M1-R17: deletes run one request per key

- **Decision:** `deleteMany` sends one `DeleteObject` per key, 16 at a time, with no cap on the number of keys.
  `api.deletePrefix` lists and deletes page by page with a bounded, tested page loop that guards against keys that
  reappear.
- **Why:** `DeleteObjects` needs a `Content-MD5`, which WebCrypto cannot compute; single deletes are free on R2 and give
  a result per key. M1 had an unbounded teardown loop.
- **If wrong:** large prefix deletes on Workers may meet subrequest limits (unmeasured, see reviews-m2.md).
- **Status:** in force. M2-D24 defines `deletePrefix`.
- **Visible in:** `src/storage/s3/objects.ts` (`DELETE_CONCURRENCY`), `src/server/api.ts`.

### M1-R20: `StorageDriver` may change before 1.0

- **Decision:** `StorageDriver` is public but implemented by cloudrop's presets; its methods may change before 1.0.
- **Why:** M2 and M3 need new driver reads, and an interface frozen before its consumers exist would block them.
- **If wrong:** a third-party driver written against 0.x breaks on upgrade.
- **Status:** in force. M2-D25 added `getBucketCors` and `getBucketLifecycle` under it.
- **Visible in:** `src/storage/driver.ts` (TSDoc on `StorageDriver`).

### M1-C7: every stored metadata header is signed

- **Decision:** Every `x-amz-meta-*` header the server wants stored is signed into the presigned URL, and the client
  sends exactly the signed headers. The idempotency id `x-amz-meta-cloudrop-id` (spec §5.4) is one of them.
- **Why:** R2 refuses an unsigned `x-amz-meta-*` header on a presigned PUT with 403 `SignatureDoesNotMatch` (spike row
  18).
- **If wrong:** uploads fail with 403 on R2.
- **Status:** in force.
- **Visible in:** `src/server/presign.ts`, `src/protocol/types.ts`, `docs/research/r2-spike-findings.md`.

### M1-C12: the client never sets Content-Length

- **Decision:** `presignPut` returns only the headers to send. `Content-Length` is signed, but the platform sets it from
  the body; the protocol types say so.
- **Why:** browsers forbid setting `Content-Length`, and a signed value the client cannot send would break every upload.
- **If wrong:** none known; the value is still enforced by the signature.
- **Status:** in force.
- **Visible in:** `src/storage/s3/presign.ts`, `src/protocol/types.ts`.

## Unnumbered rulings

### M1-N1: public calls never throw

- **Decision:** Public calls return `{ data, error }` for expected failures and never throw. A configuration mistake
  throws `CloudropError` with `INVALID_CONFIG` at construction. The handler answers every request with a stable code and
  a human message, never a stack, a raw storage body, a credential or a presigned URL, and `error.cause` never carries a
  secret. Every public boundary has tests with adversarial input (null, wrong types, non-object metadata).
- **Why:** M1 found many input holes that plain JavaScript reaches past the types; a library that throws on them turns
  a caller's mistake into a crash.
- **If wrong:** none known; it is the library's error contract.
- **Status:** in force. M2-X21 hardens the scrub of `cause`; M2-D16 applies the contract to the wire.
- **Visible in:** `AGENTS.md` (Rules), `src/errors.ts`, `src/server/http.ts`.

### M1-N2: Standard Schema without a dependency

- **Decision:** Route schemas are read through the Standard Schema v1 interface, typed in cloudrop's own code.
  `packages/cloudrop` keeps zero runtime dependencies.
- **Why:** zod, valibot and arktype values all satisfy the interface, so typing it by hand supports them all without
  tying the library to one schema package or its releases.
- **If wrong:** a future Standard Schema version needs its types copied in by hand.
- **Status:** in force.
- **Visible in:** `src/server/schema.ts`, `AGENTS.md` (Rules).

### M1-N3: Node 24 and caret ranges for dev dependencies

- **Decision:** `engines` requires Node `>=24`. Dev dependencies use caret ranges, and a new one is added at a version
  released at least two weeks earlier.
- **Why:** the owner made both changes after M1 (`dcae90e`). A version two weeks old has had time for a bad release to
  be found and pulled.
- **If wrong:** a fix that ships in a newer release waits up to two weeks.
- **Status:** in force for Node 24 and for the dev dependencies of `dcae90e`. Contradicted since: the code-quality
  skill says to pin dev dependencies exactly, and the package-check tools added in `e8cd2dc` (`@arethetypeswrong/cli`,
  `publint`, `size-limit`, `@size-limit/file`) and the root's `@biomejs/biome` are exact pins. Left to the owner: one
  of the two rules goes.
- **Visible in:** `packages/cloudrop/package.json`, `.claude/skills/code-quality/references/dependencies.md`.
