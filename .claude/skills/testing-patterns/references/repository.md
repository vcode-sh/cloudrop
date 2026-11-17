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
| `bun run test:rustfs` | Contract lane against RustFS in Docker (`scripts/test-rustfs.sh`), with guaranteed teardown. |
| `bun run test:wrangler` | Contract lane against Wrangler's local R2 endpoint (`scripts/test-wrangler.sh`), with guaranteed teardown. |
| `bun run test:live` | Contract lane and upload-protocol lane (`src/server/handler.r2.integration.test.ts`) against a real R2 bucket; reads credentials from the file named by `CLOUDROP_R2_ENV_FILE`. |
| `bun run test:chaos` | Chaos lane (`scripts/test-chaos.sh`): `*.chaos.integration.test.ts` files run the real server and client on RustFS in Docker (port 19300, `CLOUDROP_RUSTFS_PORT`) behind the fault-injecting proxy `src/testing/chaos-proxy.ts`, rows stubbing `Math.random` to 0 (`M3-K3`), with guaranteed teardown. Needs Docker; fails without it. |
| `bun run test:browser` | Browser lane (`scripts/test-browser.sh`): Playwright runs `examples/next/app/*.browser.test.ts` in Chromium's headless shell against the example on a RustFS container (port 19100), with guaranteed teardown. Needs Docker and `bunx playwright install --only-shell chromium` in `examples/next`. |
| `bun run test:browser:live` | The same browser tests on a real R2 bucket (`scripts/test-browser-live.ts`), credentials as `test:live`; the bucket's CORS rule must allow `http://localhost:5173`. |
| `bun run verify` | Every gate in one command: check, typecheck, test, build and `bun run package:check` (publint, attw and size budgets on the built package). |
| `bun run check`, `bun run typecheck` | Gates; `check` also caps file size and cognitive complexity. `typecheck` runs `tsc` twice: `tsconfig.json` (library source, no Node types) and `packages/cloudrop/tsconfig.test.json` (tests, configs and Node types). Vitest does not type-check. |

If a script here differs from the tree, the tree wins. Extra arguments reach `vitest run`: `bun run --cwd
packages/cloudrop test src/storage/xml.test.ts` runs that one file, and `bun run test:live --reporter=verbose` gives the
live lane a verbose report (both checked 2026-11-15).

## Lanes

- **The lane is chosen by filename.** `packages/cloudrop/vitest.config.ts` defines three Vitest projects: `unit`
  (`src/**/*.test.ts` and the root `scripts/**/*.test.ts`, minus `*.integration.test.ts`), `integration` (only
  `*.integration.test.ts` minus `*.chaos.integration.test.ts`, longer timeouts for live services) and `chaos` (only
  `*.chaos.integration.test.ts`, so the contract lanes never run a chaos file). `bun run test` runs `vitest run
  --project unit`, without `--passWithNoTests`, so an empty lane fails; backend lane scripts select `--project
  integration`, and `scripts/test-chaos.sh` selects `--project chaos`. See vitest.md. `*.browser.test.ts` files are
  not Vitest's: they live in `examples/next/app/` and run under Playwright (`examples/next/playwright.config.ts`)
  through the browser lane scripts.
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
- Shared test infrastructure lives in `src/testing/`: `fake-r2.ts` (its modules under `fake-r2/`),
  `storage-contract.ts` (its case groups under `storage-contract/`), `server-fixture.ts` (a cloudrop server on the
  fake, called through `cloudrop.handler`) and `driver-fixture.ts` (an S3 driver over the fake or a stubbed `fetch`,
  for the driver's unit tests). Per-area setup sits beside them: `handler-fixture.ts`, `upload-fixture.ts`,
  `complete-fixture.ts` and `presets-fixture.ts` build routes, bodies and calls for the handler, `/upload`, `/complete`
  and `r2()`/`s3()` tests. They build inputs only; every expected value stays in the tests. `chaos-proxy.ts` (the
  fault-injecting proxy, Node-only, excluded from the library's `tsconfig.json`) and `chaos-fixture.ts` (a server and
  client on RustFS behind it, with the stored-bytes and no-uploads-left oracle) serve the chaos lanes.

## Unit lane

Pure helpers (planner, checksums, SigV4, key and metadata validation, error mapping) are called directly. Driver
and server behaviour runs in-process against the fake R2 with `fetch` and `now` injected.

- The fake verifies real SigV4 signatures, so a signing bug fails here with the same `SignatureDoesNotMatch` or
  `ExpiredRequest` that R2 returns. Its rules are R2's: equal part sizes, no presigned POST, the 7-day expiry cap.
- A fault the fake does not model (a dropped connection, a 503) is injected through the `fetch` option, not through a
  module mock.

## Storage contract suite

`src/testing/storage-contract.ts` exports one suite that every backend runs: the fake (unit lane), RustFS, Wrangler
and live R2 (backend lanes). Add a case once, to the group under `src/testing/storage-contract/` that matches what
it proves, and it covers all four.

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
