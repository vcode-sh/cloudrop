# Testing

This page is for contributors. It covers every test lane: what it runs, what it needs (Docker, Playwright's headless
shell, live R2 credentials), which ports it uses and how to change them, the CORS rule the live browser lane needs, and
the rules for writing tests in this repository. The binding rules for coding agents are in [AGENTS.md](../../AGENTS.md)
and the `testing-patterns` skill in `.claude/skills/testing-patterns/`.

## The lanes at a glance

| Command | What it runs | Needs |
| --- | --- | --- |
| `bun run verify` | Every gate: check (Biome, file size, complexity), typecheck, unit tests, build, the example's typecheck and package checks | Nothing beyond `bun install` |
| `bun run test` | The unit lane, on the in-process fake R2 | Nothing |
| `bun run test:rustfs` | The storage contract on RustFS | Docker |
| `bun run test:wrangler` | The storage contract on Wrangler's local R2, the store contract on its local D1 | Nothing (Wrangler is a dev dependency) |
| `bun run test:live` | The storage contract and the upload protocol on real R2 | R2 credentials |
| `bun run test:db` | The database store's contract through every adapter on Postgres 18 and SQLite, and the handler on Postgres | Docker |
| `bun run test:chaos` | The upload protocol on RustFS behind a fault-injecting proxy, stateless and with a store | Docker |
| `bun run test:chaos:soak` | The nightly seeded soak on the same setup | Docker |
| `bun run test:browser` | The example in Chromium's headless shell, uploading to RustFS, stateless and then with its store | Docker, Playwright's headless shell |
| `bun run test:browser:live` | The same browser tests on real R2 | R2 credentials, Playwright's headless shell, the bucket's CORS rule |

Which lanes a change needs:

- **Every change:** `bun run verify`.
- **Storage-layer changes:** `test:rustfs`, `test:wrangler` and `test:live`.
- **Server changes:** `test:live`, which also runs the upload protocol against real R2.
- **Client and server changes:** `test:chaos`.
- **Store and adapter changes:** `test:db`, and `test:wrangler` for the D1 paths (`d1Executor`, Drizzle over D1).
- **Client and example changes:** `test:browser`.

A lane whose service or credentials are missing **fails** with a message that names what to set. It never skips.

## Unit lane

```bash
bun run test
bun run --cwd packages/cloudrop test src/storage/xml.test.ts   # one file
```

Every `*.test.ts` file except `*.integration.test.ts`, run by Vitest on Node. It needs no network, Docker or
credentials. Driver and server behaviour runs against the in-process fake R2 (`src/testing/fake-r2.ts`), which verifies
real SigV4 signatures and applies R2's rules.

## Storage contract lanes

The storage contract suite (`src/testing/storage-contract.ts`) runs the same cases against every backend: the fake (in
the unit lane), RustFS, Wrangler and live R2.

### RustFS

```bash
bun run test:rustfs
```

Starts a RustFS container (`rustfs/rustfs:1.0.5`) on port **19000**, runs the contract, and removes the container on
success, failure and interrupt. Set `CLOUDROP_RUSTFS_PORT` to use another port; the lane stops if the port is in use.

### Wrangler

```bash
bun run test:wrangler
```

Starts `wrangler dev` with its local R2 on port **18787**, runs the contract, then stops Wrangler and deletes its state.
Set `CLOUDROP_WRANGLER_PORT` to use another port. Wrangler's local R2 lacks some features, such as `ListParts` and
checksum checks, so the cases that need them are skipped there with a reason naming the gap. That is the only kind of
skip allowed.

The same lane runs the store contract on Wrangler's local D1, through `sqlStore(d1Executor(env.DB))` and through
`drizzleStore(drizzle(env.DB))`. The fixture's `wrangler.jsonc` declares the `DB` binding, and `src/testing/db/d1.ts`
reaches it from Node through Wrangler's `getPlatformProxy`, in memory, so the contract runs in Vitest unchanged and the
executors get the binding a Worker would. D1 declares two gaps: `transaction` (no interactive transaction) and
`failureInjection` (no user functions for the one-shot trigger).

## Live R2 lane

```bash
CLOUDROP_R2_ENV_FILE=/path/to/r2.env bun run test:live
bun run test:live --reporter=verbose   # extra arguments reach Vitest
```

Runs the storage contract and the upload protocol (`src/server/handler.r2.integration.test.ts`) against a real bucket.

- **Credentials:** the file named by `CLOUDROP_R2_ENV_FILE`, or the environment, must define
  `CLOUDROP_R2_ACCOUNT_ID`, `CLOUDROP_R2_BUCKET`, `CLOUDROP_R2_ACCESS_KEY_ID` and `CLOUDROP_R2_SECRET_ACCESS_KEY`. The
  file holds literal `NAME=value` lines, never run as shell: no `export`, no spaces around `=`, no inline comments.
  `BB_R2_*` names are accepted too. Values in the file win over the environment.
- **Output:** everything the tests print passes through a redactor, so no credential, account ID, bucket name or
  presigned URL reaches the terminal. The last line says how many occurrences were redacted.
- **Cleanup:** everything goes under a random `live-test/cloudrop-<hex>/` prefix, which the lane deletes. If the lane is
  stopped before its teardown, it names the prefixes left behind.

## Database lane

```bash
bun run test:db
bun run test:db src/testing/db/fixtures.db.integration.test.ts   # extra arguments reach Vitest
```

Runs the `*.db.integration.test.ts` files (Vitest project `db`) against two databases:

- **Postgres 18** (`postgres:18.6`) in Docker on port **19500**, data in a tmpfs. Set `CLOUDROP_POSTGRES_PORT` to use
  another port; the lane stops if the port is in use. Each test file gets its own schema (`cloudrop_test_<hex>`),
  dropped after the file. Files that test `tables.schema` also make a second schema, `<schema>_app`, dropped after
  the file; the store contract runs there with empty decoy tables on the search path. The lane removes the container
  on success, failure and interrupt.
- **SQLite** through `node:sqlite`, a fresh database per test: in memory, or a file under `.superpowers/test-db/` when
  a second client must open it.

Before the tests the lane generates the Prisma 7 test clients from the schema folders `src/testing/db/prisma/postgres/`
and `sqlite/` into `packages/cloudrop/.prisma-client/` (git-ignored); each folder's `cloudrop.prisma` holds the models
the store guide ships. Generation needs no network. The fixtures are in
`src/testing/db/`: the DDL (`schema.ts`), the two databases (`postgres.ts`, `sqlite.ts`), the raw reader the store
contract checks results with (`raw-reader.ts`) and the Prisma clients (`prisma.ts`). The lane fails when Docker is not
running.

## Chaos lanes

```bash
bun run test:chaos
bun run test:chaos:soak
```

The real server and client run on RustFS, port **19300**, behind a fault-injecting proxy that each test file starts. The
proxy injects resets, black holes, throttling, `429`/`503`/`500` answers, readable and opaque `403`s and cut answers.
Each row checks that the upload ends with the file's exact bytes and nothing left open, or with a documented code.

- `test:chaos` runs the `*.chaos.integration.test.ts` files (Vitest project `chaos`). `store.chaos.integration.test.ts`
  gives the server a database store (`useChaosFixture({ store: true })`: `sqlStore` over in-memory `node:sqlite`) and
  loses `/complete` answers on the way back to the client (`faultApp`): a reset, a deadline that passes while
  `onComplete` runs, a gateway `503`. It also loses an `/upload` answer to a reset, whose retry with the same
  `idempotencyKey` supersedes the lost attempt, so usage counts the file once. Its rows check that `onComplete` ran
  once and the owner's usage is exact, that a revoke stops an upload at its next call, and that the sweep after closed
  tabs leaves no orphan object or open upload.
- `test:chaos:soak` runs the nightly `*.soak.integration.test.ts` files (Vitest project `soak`): seeded random faults, a
  mid-run abort, and the real-time stall and throttle rows. To replay a run, set `CLOUDROP_CHAOS_SEED` to the seed in a
  test's title.
- Set `CLOUDROP_RUSTFS_PORT` to use another port. Extra arguments reach `vitest run`.
- The lane fails when Docker is not running.

## Browser lanes

Install Playwright's Chromium headless shell once:

```bash
cd examples/next && bunx playwright install --only-shell chromium
```

Run the lanes from the repository root:

```bash
bun run test:browser
bun run test:browser lab.browser.test.ts   # extra arguments reach Playwright
bun run test:browser:live
```

### On RustFS

`test:browser` starts its own RustFS container on port **19100**, starts the chaos proxy in front of it on port
**19110**, builds cloudrop, and has Playwright build and serve [`examples/next`](../../examples/next/README.md) on port
**5173**. It runs Playwright three times: the stateless example with every row but `*.store.browser.test.ts`, then the
example with its database store (`CLOUDROP_EXAMPLE_STORE` set to a database file of the run's own, a quota of 50 MB)
with those rows alone. The third pass starts a Postgres container of the run's own, applies
[`examples/hono`](../../examples/hono/README.md)'s migrations and has Playwright start that API on port **5181** and
[`examples/vite-react`](../../examples/vite-react/README.md) on 5173, uploading straight to RustFS with a quota of 50 MB.
Extra arguments reach every pass. It removes both containers and the store's database and stops the proxy afterwards.
It needs Docker, no credentials, and leaves any `.env.local` or `.env` alone.

| Port | What | Override |
| --- | --- | --- |
| 19100 | RustFS | `CLOUDROP_RUSTFS_PORT` |
| 19110 | The chaos proxy, which the example's presigned URLs name | `CLOUDROP_CHAOS_PROXY_PORT` |
| 5173 | The example | None: the bucket's CORS rule names this origin |
| 5181 | The Hono example's API (third pass) | None: the Vite app calls this origin |
| 19610 | The third pass's Postgres | `CLOUDROP_EXAMPLE_POSTGRES_PORT` |

What the browser tests cover is described in [the Next.js example's README](../../examples/next/README.md#the-browser-tests)
and [the Vite example's README](../../examples/vite-react/README.md#the-browser-tests).

### On live R2

`test:browser:live` runs the Next example's two passes on a real bucket (the Vite pass stays on RustFS), with the
credentials `test:live` reads. It builds cloudrop, serves the example on port 5173, uploads under a random
`live-test/cloudrop-<hex>/` prefix and deletes that prefix and the store's database at the end. The chaos rows are left out: R2 routes by its own host,
so the proxy cannot stand in front of it.

The test bucket's CORS rule, `cloudrop-browser-tests`, must allow:

- **Origins:** `http://localhost:5173` and `http://127.0.0.1:5173`
- **Method:** `PUT`
- **Headers:** `content-type`, `content-disposition`, `if-none-match` and `x-amz-meta-cloudrop-id`
- **Exposed headers:** `ETag`, `Retry-After`, `x-amz-checksum-crc32c` and `x-amz-checksum-crc64nvme`

Agents never change bucket settings; the owner does.

## Ports for parallel runs

Each lane picks its own default port, so the lanes can run at the same time:

| Lane | Default port | Variable |
| --- | --- | --- |
| `test:rustfs` | 19000 | `CLOUDROP_RUSTFS_PORT` |
| `test:wrangler` | 18787 | `CLOUDROP_WRANGLER_PORT` |
| `test:browser` | 19100 (RustFS), 19110 (proxy), 5173 (example), 5181 (API), 19610 (Postgres) | `CLOUDROP_RUSTFS_PORT`, `CLOUDROP_CHAOS_PROXY_PORT`, `CLOUDROP_EXAMPLE_POSTGRES_PORT` |
| `test:chaos`, `test:chaos:soak` | 19300 | `CLOUDROP_RUSTFS_PORT` |
| `test:db` | 19500 | `CLOUDROP_POSTGRES_PORT` |

`test:browser` and `test:browser:live` both need port 5173, so only one of them can run at a time.

Containers started by tests carry the label `cloudrop.test` and are removed at the end of the run. After a hard kill one
can survive: find it with `docker ps -a --filter label=cloudrop.test` and remove it with `docker rm -f`.

## Writing tests

The full rules are in `.claude/skills/testing-patterns/SKILL.md`. In brief:

- **Every test earns its place.** It checks the code's contract, the output the code was written for, never only that
  code runs or exists. "No new test" is a valid outcome.
- **Colocated.** `src/foo.ts` sits beside `src/foo.test.ts`. There is no `test/` folder and no file snapshots.
- **The lane is chosen by filename.** `*.test.ts` is the unit lane. `*.integration.test.ts` runs only through its lane
  script. `*.browser.test.ts` lives in `examples/next/app/` and `examples/vite-react/src/` and runs under Playwright.
- **Call the real unit** through the entry point its users call. Endpoint tests run the real handler on the fake R2
  through `src/testing/server-fixture.ts`.
- **Independent expected values.** Write them as literals from an oracle (AWS SigV4 test vectors, CRC check values, R2's
  documentation, the [measured R2 behaviour](../research/r2-spike-findings.md)), never recomputed with the code's own
  logic.
- **Discriminating inputs.** Boundaries, adversarial strings, and the failing case beside the happy path.
- **Exact assertions.** `toBe`, `toEqual`, the exact `CloudropError` `code` and `retryable`. A bare `toThrow()` or
  `toBeDefined()` is a smell.
- **Doubles only at true boundaries.** Inject `fetch` and `now`, and use the fake R2. Never `vi.mock` cloudrop's own
  modules.
- **Fast.** The whole unit lane takes at most 5 s cold; one test typically at most 50 ms. A test over 250 ms says why
  in a comment.
- **No green by force.** No `retry`, no skip to pass, no loosened assertions.
- **Register teardown at startup.** A test that starts a container, process or live object registers its cleanup when
  it acquires the resource.
- **Live R2 tests** write only under `live-test/cloudrop-<random>/` and delete what they create.
