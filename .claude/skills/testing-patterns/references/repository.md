# Test commands, lanes and fixtures

[SKILL.md](../SKILL.md) owns the decision rules; this file owns the commands and conventions of this repository.
Paths are relative to the repository root. If a config file below changes, reread it rather than trusting this page.

## Runner

Vitest 5.1.0 on Node, in the single package `packages/cloudrop`. Bun is only the workspace and script runner: tests
never use Bun's built-in runner. Import `describe`, `test`, `expect`, `vi`, `beforeAll`… from `vitest` explicitly.

| Command | What it runs |
| --- | --- |
| `bun run test` | Unit lane: every `*.test.ts` except `*.integration.test.ts`, on the in-process fake R2. Needs no network, Docker or credentials. |
| `bun run --cwd packages/cloudrop test src/foo.test.ts` | One file. Extra arguments reach `vitest run`. |
| `scripts/test-rustfs.sh` | Contract lane against RustFS in Docker, with guaranteed teardown. |
| `scripts/test-wrangler.sh` | Contract lane against Wrangler's local R2 endpoint, with guaranteed teardown. |
| `bun run test:live` | Contract lane against a real R2 bucket; reads credentials from the file named by `CLOUDROP_R2_ENV_FILE`. |
| `bun run check`, `bun run typecheck` | Gates. Test files are type-checked with `src`; Vitest does not type-check. |

The lane script names come from the M1 plan; if one differs in the tree, the tree wins. Argument forwarding to
`vitest run` is expected from `bun run` but unverified until the scripts exist.

## Lanes

- **The lane is chosen by filename.** The unit config includes `*.test.ts` and excludes `*.integration.test.ts`; each
  backend lane runs only `*.integration.test.ts` through its own script. See vitest.md for how the selection works.
- **A lane whose service or credentials are missing fails, never skips.** Check the prerequisite in `beforeAll` and
  throw a message that names what to set (`CLOUDROP_R2_ENV_FILE`, "start Docker", …). A throwing `beforeAll` fails the
  file and the run.
- **No retries, no coverage threshold.** Coverage is a flashlight for the package you change, not a gate.
- **Registered teardown.** The lane script starts the container or process and registers its cleanup (`trap`) before
  anything else; test files register their own cleanup when they acquire a resource. Docker containers carry the
  label `cloudrop.test`. After a SIGKILL a container can survive: `docker ps -a --filter label=cloudrop.test`, then
  `docker rm -f`. Never stop containers that do not carry the label.
- **Live R2** writes only under `live-test/cloudrop-<random hex>/` and deletes everything it creates; it never prints
  credentials or presigned URLs.

## Where tests live

- Colocated: `src/foo.ts` → `src/foo.test.ts`; the backend variant of a module sits beside it as
  `foo.integration.test.ts`. No `test/`, `tests/`, `__tests__/`, no file snapshots.
- Shared test infrastructure lives in `src/testing/`: `fake-r2.ts` and `storage-contract.ts`.

## Unit lane

Pure helpers (planner, checksums, SigV4, key and metadata validation, error mapping) are called directly. Driver
and server behaviour runs in-process against the fake R2 with `fetch` and `now` injected.

- The fake verifies real SigV4 signatures, so a signing bug fails here with the same `SignatureDoesNotMatch` or
  `ExpiredRequest` that R2 returns. Its rules are R2's: equal part sizes, no presigned POST, the 7-day expiry cap.
- A fault the fake does not model (a dropped connection, a 503) is injected through the `fetch` option, not through a
  module mock.

## Storage contract suite

`src/testing/storage-contract.ts` exports one suite that every backend runs: the fake (unit lane), RustFS, Wrangler
and live R2 (backend lanes). Add a case once and it covers all four.

- Each backend declares the capabilities it lacks. A case that needs one calls `ctx.skip(reason)` with a reason
  naming the gap ("RustFS: no ..."). A backend gap is never hidden by loosening the case.
- When a backend disagrees with the fake, the measured behaviour wins: record the deviation in `docs/research/` and fix
  the fake. Evidence for real R2: `docs/research/r2-spike-findings.md`.

## Measuring speed

```bash
bun run --cwd packages/cloudrop test --reporter=verbose
```

Prints each test's duration. Budgets are in SKILL.md. A test that waits on a real clock is a smell: inject `now` or
use fake timers.

## Maintenance

`.agents/skills/testing-patterns -> ../../.claude/skills/testing-patterns` is a relative symlink; keep it and do not
add a second copy.
