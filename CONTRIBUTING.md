# Contributing

Thanks for wanting to help. cloudrop moves other people's files into other people's buckets, so the bar is "correct
under failure", not "works on my machine". This page gets you from a clone to a pull request that passes.

## Setup

```bash
git clone https://github.com/vcode-sh/cloudrop.git
cd cloudrop
bun install
bun run build
```

### Prerequisites

- **Bun 1.4.4**, the version in `package.json`'s `packageManager` and in CI. This is a Bun workspace: the library in
  `packages/cloudrop`, the examples in `examples/*`.
- **Node.js 26**, the minimum cloudrop supports. CI runs on Node 26, and the database lane's native SQLite module is
  built for the Node that runs `bun install`. If your default `node` is another version, put Node 26 first on your
  `PATH` before installing.
- **Docker**, for the RustFS, database, chaos and browser lanes. The unit lane and `bun run verify` need none.
- **Playwright's Chromium headless shell**, for the browser lanes only: run
  `bunx playwright install --only-shell chromium` once in `examples/next`.

## The gate every change passes

```bash
bun run verify
```

It runs Biome, the file-size and complexity checks, the type checks, the unit tests, the build, the examples' type
checks and the package checks (publint, Are The Types Wrong, size limits). CI runs the same steps. `bun run fix`
applies Biome's formatting and safe fixes.

`bun run check` fails a source file over 250 lines, a test file over 400, and a function over cognitive complexity 15.
Get under by splitting responsibilities, not by squeezing lines or deleting comments that explain why.

## The test lanes

Run the lanes your change touches, on top of `verify`:

| You changed | Run |
| --- | --- |
| The storage layer (driver, signer, contract suite) | `bun run test:rustfs` and `bun run test:wrangler` |
| The database store or an adapter | `bun run test:db` and `bun run test:wrangler` (D1) |
| The Drizzle adapter | also `scripts/check-drizzle-versions.sh` (drizzle-orm 0.45) |
| The client or the server's upload protocol | `bun run test:chaos` |
| The client, the hooks or an example | `bun run test:browser` |
| The hooks | also `scripts/test-react-18.sh` (React 18.3.1) |

| Lane | What it runs | Needs |
| --- | --- | --- |
| `bun run test` | Unit tests, against an in-process fake R2 | nothing |
| `bun run test:rustfs` | The storage contract on RustFS | Docker |
| `bun run test:wrangler` | The storage contract on Wrangler's local R2, the store contract on its local D1 | nothing extra |
| `bun run test:db` | The store contract and every adapter on Postgres 18 and SQLite | Docker |
| `bun run test:chaos` | The upload protocol on RustFS behind a fault-injecting proxy | Docker |
| `bun run test:browser` | The examples uploading from headless Chromium to RustFS | Docker, Playwright's shell |
| `bun run test:live`, `test:browser:live` | The same against real R2 | the maintainer's test bucket |

The live R2 lanes are the maintainer's: they need credentials for a dedicated test bucket, and CI runs `test:live` nightly
on `main` once the maintainer has enabled it. You do not need them for a pull request; say in it if your change touches R2 behaviour, and the maintainer runs
them before merging.

A lane script fails, never skips, when what it needs is missing. Containers it starts carry the label `cloudrop.test`
and are removed at the end; after a hard kill, `docker ps -a --filter label=cloudrop.test` finds a leftover. Ports and
how to move them for parallel runs: [Testing](docs/guide/testing.md#ports-for-parallel-runs).

## Writing tests

The full rules are in [Testing](docs/guide/testing.md#writing-tests). The short version:

- **Tests live next to the source:** `foo.ts` beside `foo.test.ts`. There is no `test/` folder.
- **The filename picks the lane:** `*.test.ts` is the unit lane, `*.integration.test.ts` runs through its lane script,
  `*.browser.test.ts` runs under Playwright.
- **Every test checks a contract** a caller relies on, with expected values from an independent source (test vectors,
  R2's documentation, [measured R2 behaviour](docs/research/r2-spike-findings.md)), never recomputed by the code under
  test. "No new test needed" is a valid answer.
- **Doubles only at real boundaries:** inject `fetch` and `now`, use the fake R2, never mock cloudrop's own modules.
- **No green by force:** no retries, no skips, no loosened assertions to get a pass.

## Rules the code follows

- **Zero runtime dependencies** in `packages/cloudrop`, and only web-platform APIs in `src/` (`fetch`,
  `crypto.subtle`, `URL`): no `node:` imports, no `process`, no `Buffer`. The compiler enforces it. `cloudrop/react`
  imports `react`, an optional peer dependency, and nothing else does.
- **Public calls return `{ data, error }`.** An error's `message` says what happened and what to do next, and never
  contains credentials, presigned URLs or raw storage responses.
- **The server trusts only the upload token** after `/upload`: never a key, size, type or upload ID from a request
  body.
- **Every export is a semver promise.** A new export or a changed signature is called out in the pull request.

[AGENTS.md](AGENTS.md) holds the complete rules; it is written for coding agents, and people follow it too.

## Decisions

Why the code is the way it is lives in [`docs/decisions/`](docs/decisions/README.md), cited by id (`M3-U94`,
`M5-T105`). A change to behaviour or to a public contract adds an entry there in the same pull request: what was
decided, why, what it costs if it is wrong. Read the entries for the code you touch first: many "obvious
simplifications" are there with the measurement that ruled them out.

## Commits and pull requests

1. Fork the repository and branch off `main`.
2. Make the change, with tests where they earn their place and docs where behaviour changes.
3. Run `bun run verify` and the lanes from the table above.
4. Add an entry under `## Unreleased` in [`packages/cloudrop/CHANGELOG.md`](packages/cloudrop/CHANGELOG.md) for
   anything a user of the package would notice.
5. Commit with [Conventional Commits](https://www.conventionalcommits.org/): `fix(client): ...`, `feat(server): ...`,
   `docs: ...`, `test(store): ...`.
6. Open the pull request and fill in the template. Keep one concern per pull request.

## Reporting issues

- **Bugs:** the [bug report form](https://github.com/vcode-sh/cloudrop/issues/new?template=bug_report.yml). Never paste
  credentials, presigned URLs or upload tokens; logs from cloudrop leave them out already.
- **Features:** the [feature request form](https://github.com/vcode-sh/cloudrop/issues/new?template=feature_request.yml).
- **Security:** see [SECURITY.md](SECURITY.md). Never in a public issue.

## Code of Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Short version: be decent to people.

## Releases

Releases are the maintainer's: a `v<version>` tag on `main` publishes the package to npm through trusted publishing,
with provenance. The procedure: [Releasing](docs/releasing.md).
