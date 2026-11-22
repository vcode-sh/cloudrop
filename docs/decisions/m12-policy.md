# M12-P: release policy, floors and guards

Rulings for what 1.0 supports and promises: the Node and TypeScript floors, the size ceilings, the stability policy, the
threat model, `llms.txt`, the API reference and the freeze guard, designed in
`docs/superpowers/specs/2026-11-22-1.0.0-design.md` §8 and the owner's rulings at its top.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-P1: every size ceiling raised for 1.0, so ceilings guard against accidents and never block work

- **Decision:** the gzip ceilings in `scripts/size-limit.config.ts` for 1.0, 0.6.0's ceiling and its measured size in
  brackets: `cloudrop` summed 60 kB (50, 46.79), `cloudrop/next` 2 kB (1.5, 0.83), `cloudrop/node` 5 kB (4.5, 2.35),
  `cloudrop/adapters/sql` summed 32 kB (18, 13.11), `cloudrop/adapters/drizzle` 34 kB (17, 14.85),
  `cloudrop/adapters/prisma` 32 kB (16, 12.59), `cloudrop/testing` 30 kB (16, 14.17), `cloudrop/plugins` 9 kB (7, 6.46),
  `cloudrop (bundled)` 40 kB (36, 34.71), `cloudrop/client` 18 kB (15, 13.48), `cloudrop/react` 4 kB (3, 2.26). Two new
  budgets come with the store entry (`M12-S`): `cloudrop/store` summed 20 kB and `cloudrop + adapters/sql (bundled)`
  50 kB. Each ceiling is about 25 % over the size the entry is expected to reach once the store's code moves behind the
  store object. The size measured is still noted beside each budget, and the release summary reports the sizes measured
  for 1.0.
- **Why:** the owner, 2026-11-22: raise the ceilings so they never block work. Since `M4-F24` a ceiling was meant as a
  guard against accidents, yet 0.4.0 and 0.6.0 each spent an owner decision on a raise (`M10-D10`, `M11-R100`,
  `M11-R220`). The store entry moves code between budgets (the adapters and `cloudrop/testing` carry the store paths,
  the bundled server loses them), so ceilings at measured plus a little would fail on a correct change.
- **If wrong:** a slow growth passes unnoticed until it is large. The sizes noted in the config and reported in the
  release summary are the check; a ceiling can be lowered in any minor, since bundle size is not covered by semver.
- **Status:** in force for the eleven budgets that exist; the two new budgets are decided and land with `M12-S`.
  Supersedes the ceilings of `M4-F24`, `M10-D10`, `M11-R100` and `M11-R220`, and `M4-F24`'s rule that a change growing
  an entry by more than 5 % says so in its commit and decision entry.
- **Source:** owner, 2026-11-22.
- **Visible in:** `scripts/size-limit.config.ts`, `docs/superpowers/plans/2026-11-22-1.0.0.md` ("Size ceilings").

### M12-P2: Node 26 is the minimum

- **Decision:** cloudrop 1.0 needs Node 26 or newer, everywhere: `engines` is `{ "node": ">=26" }` in
  `packages/cloudrop/package.json`, `scripts/check-package.sh` fails when the packed manifest says anything else, every
  `actions/setup-node` step in `ci.yml` and `release.yml` uses Node 26, `@types/node` is `^26` in the package and the
  examples, and the README, the package README, CONTRIBUTING, the command's guide, the examples' READMEs, the issue
  template, the skills and the base spec's package table say Node 26. Bun, Deno, Workers and the browser floor
  (`M4-F6`) are unchanged. The Node-only code (`src/cli.ts`, `src/cli/**`, `src/node.ts`, `scripts/*.ts`) was read for
  workarounds kept for a Node older than 26, and none was found: the bin already reads files through
  `process.getBuiltinModule` (Node 22.3), and the APIs `M8-Q5` and `M8-Q8` held back are in library and client code
  that browsers and Workers also load, where the browser floor still holds them back. Only the bin's comment changed.
  The command's `--env-file` reader still matches Node's: `node --env-file` on Node 26.13.0 reads `env-file.test.ts`'s
  multi-line case as Node 24.22 did (measured 2026-11-22).
- **Why:** the owner's floor (2026-11-22, "Node 26 is the minimum, everywhere"). Node 26 is the active LTS from October
  2026, so a 1.0 frozen under semver starts on the line that stays supported longest. One floor for CI, the release
  workflow and the types means a test or script can no longer use an API that the oldest supported Node lacks, which is
  why `M8-Q4` held `@types/node` at 24.
- **If wrong:** an app still on Node 24 gets npm's `EBADENGINE` warning at install, and the library itself would
  probably still run there, untested. Lowering the floor later is a minor change; raising it again would be a major.
- **Status:** in force. Supersedes the Node 24 floor of `M1-N3` and `M2-X4`, and `M8-Q4` for `@types/node`.
- **Source:** owner, 2026-11-22.
- **Visible in:** `packages/cloudrop/package.json`, `scripts/check-package.sh`, `.github/workflows/ci.yml`,
  `.github/workflows/release.yml`, `README.md` ("Requirements"), `packages/cloudrop/README.md`, `CONTRIBUTING.md`,
  `docs/guide/command.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`.

### M12-P3: TypeScript 7.0 is the minimum for the shipped types

- **Decision:** the `.d.ts` files cloudrop publishes are supported on TypeScript 7.0 or newer. The README's
  requirements say so (they said 5.4). A CI job type-checks the packed `.d.ts` with TypeScript 7.0.0, the floor itself,
  not the workspace's newer 7.x (spec §8; its entry lands with the job). TypeDoc, which builds the API reference, and
  api-extractor, whose report is the freeze guard, bundle the JavaScript TypeScript 6 compiler and read the `.d.ts` with
  it. They are dev dependencies that run in CI and never reach an app, so TypeScript 6 is not a supported floor; a type
  that TypeScript 6 cannot read would break the reference, not an app.
- **Why:** the owner's floor (2026-11-22). The workspace, the examples and every lane already compile with TypeScript
  7 (`typescript` `^7.0.2`), and a floor nobody checks is a guess: checking the packed types with 7.0.0 makes the
  promise true for every 7.x an app uses.
- **If wrong:** an app on TypeScript 5 or 6 may still compile against the types, untested; a report that it does not is
  answered with the floor. If TypeDoc or api-extractor cannot read a type that TypeScript 7 accepts, the type is
  written another way or the tool is replaced, and the floor stays.
- **Status:** in force for the README; the CI floor job, the reference and the freeze guard are decided and land with
  the release documentation (spec §8, plan Task 11).
- **Source:** owner, 2026-11-22.
- **Visible in:** `README.md` ("Requirements"), `packages/cloudrop/package.json` (`typescript`).
