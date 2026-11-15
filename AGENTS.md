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
- `packages/cloudrop` has zero runtime dependencies and uses only web-platform APIs in `src/`. The compiler enforces
  it: `tsconfig.json` has `types: []` and excludes tests; `tsconfig.test.json` adds Node types for tests.
- Tests live next to the source (`foo.ts` beside `foo.test.ts`); there is no `test/` folder.
- The lane is chosen by filename: `*.test.ts` is the unit lane (`bun run test`); `*.integration.test.ts` runs only
  through its lane script and fails, never skips, when its service or credentials are missing.
- Public calls return `{ data, error }`. Error messages say what happened and what to do next; they never contain
  credentials, presigned URLs or raw storage responses.
- Never print, log or commit credentials, and never log a presigned URL.
- Live R2 tests write only under `live-test/cloudrop-<random>/` and delete what they create.
- Docker containers from tests carry the label `cloudrop.test` and are removed at the end of the run.
- Git: stage exact paths, conventional commits, never push unless asked. Never `git stash`, `reset`, `clean` or
  `checkout --`.
- Never clone or create worktrees in `/tmp`.

## Gates

- `bun run check` and `bun run typecheck` for every change; `bun run test` when behaviour changes.
- `scripts/test-rustfs.sh`, `scripts/test-wrangler.sh` and `bun run test:live` for storage-layer changes.
