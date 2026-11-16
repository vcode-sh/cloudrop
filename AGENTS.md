# cloudrop: rules for coding agents

cloudrop is an MIT TypeScript library for direct-to-bucket uploads to Cloudflare R2 and S3-compatible storage.
Design: `docs/superpowers/specs/2026-11-15-cloudrop-design.md`. Plans: `docs/superpowers/plans/`.
Real-R2 evidence: `docs/research/r2-spike-findings.md`. Work strictly from Cloudflare's R2 documentation and that
evidence; when they disagree, the measured behaviour wins and the docs page is cited.

## Skills

Load the matching skill from `.claude/skills/` before the work:

- `testing-patterns`: before writing, reviewing or pruning any test.
- `code-quality`: after writing code and before any review or commit.

## Rules

- Write everything in English.
- Decisions live in `docs/decisions/`, cited by series id: `M1-R`, `M1-C`, `M1-N`, `M2-D`, `M2-X`, `M2-P`, `M3-O`,
  `M3-H`, `M3-S` plus a number (`M2-X38`). A ruling that changes behaviour or a public contract gets an entry there in
  the same change; a new series is `M<milestone>-<unused letter>` with a row in its README and in this list.
- `packages/cloudrop` has zero runtime dependencies and uses only web-platform APIs in `src/`. The compiler enforces
  it: `tsconfig.json` has `types: []` and excludes tests; `tsconfig.test.json` adds Node types for tests.
  `src/node.ts` describes Node's request and response by hand for the same reason; `src/node.test.ts` proves real Node
  objects fit them.
- Source files aim at about 200 to 220 lines. `bun run check` fails a source file over 250 lines, a `*.test.ts` file
  over 400, and a function over cognitive complexity 15. Get under by separating responsibilities, keeping Biome's
  layout and every comment that explains why.
- Tests live next to the source (`foo.ts` beside `foo.test.ts`); there is no `test/` folder. Endpoint tests run the real
  handler on the fake R2 through `src/testing/server-fixture.ts`.
- The lane is chosen by filename: `*.test.ts` is the unit lane (`bun run test`); `*.integration.test.ts` runs only
  through its lane script and fails, never skips, when its service or credentials are missing; `*.browser.test.ts` runs
  through `bun run test:browser`, which needs Docker and Playwright's Chromium headless shell.
- Public calls return `{ data, error }`. Error messages say what happened and what to do next; they never contain
  credentials, presigned URLs or raw storage responses. The handler answers every request, never throws, and sends a
  client only the error's code, message, `retryable` and part numbers; everything else goes to the logger.
- The server trusts only the upload token after `/upload`: never a key, size, type or upload ID from a request body.
- Never print, log or commit credentials, and never log a presigned URL.
- Live R2 tests write only under `live-test/cloudrop-<random>/` and delete what they create.
- Docker containers from tests carry the label `cloudrop.test` and are removed at the end of the run.
- Git: stage exact paths, conventional commits, never push unless asked. Never `git stash`, `reset`, `clean` or
  `checkout --`.
- Never clone or create worktrees in `/tmp`.

## Gates

- `bun run verify` for every change: check (Biome, file size, complexity), typecheck, test, build and package checks.
- `bun run test:rustfs`, `bun run test:wrangler` and `bun run test:live` for storage-layer changes.
- `bun run test:live` for server changes too: it also runs the upload protocol against real R2.
- `bun run test:browser` for client and example changes: the example uploads from headless Chromium to RustFS on port
  19100 (install the shell once with `bunx playwright install --only-shell chromium` in `examples/next`).
  `bun run test:browser:live` runs the same tests on live R2; the test bucket's CORS rule `cloudrop-browser-tests`
  allows `http://localhost:5173` (owner-confirmed 2026-11-16).
