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
  `M11-R220`). The store entry moves code between budgets (the adapters and `cloudrop/store` carry the store paths,
  the bundled server loses them; `cloudrop/testing` imports them from `cloudrop/store`, `M12-S1`), so ceilings at
  measured plus a little would fail on a correct change.
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
  `docs/guide/command.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `examples/next/package.json`,
  `examples/vite-react/package.json`, `examples/next/README.md`, `examples/hono/README.md`,
  `docs/superpowers/specs/2026-11-15-cloudrop-design.md` (§3, the package table).

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
- **Status:** in force. The CI floor job checks 7.0.2, the oldest 7.0 release npm has (`M12-P5`); the reference and
  the freeze guard are `M12-P10` and `M12-P6`.
- **Source:** owner, 2026-11-22.
- **Visible in:** `README.md` ("Requirements"), `packages/cloudrop/package.json` (`typescript`).

### M12-P5: three CI lanes, the TypeScript floor on 7.0.2, and Deno with env access

- **Decision:** `ci.yml` gains three jobs, each after `check`, on Node 26 and with actions pinned by SHA:
  - **`ts-floor`** runs `scripts/check-ts-floor.sh`: it packs the tarball, installs it into a fresh project outside the
    checkout (`$RUNNER_TEMP`, locally `CLOUDROP_TS_FLOOR_DIR`; the script refuses a path inside the repository) with
    `typescript` **7.0.2** exactly, `@types/react` and `drizzle-orm` at the workspace's versions, and runs `tsc` over
    two consumer files. `app.ts` imports every entry but the Drizzle adapter and uses `createCloudrop`, `route`,
    `createCloudropClient`, `createUploadHooks`, `sqlStore` and `defineStore`, with `skipLibCheck: false`, so the
    compiler reads cloudrop's own `.d.ts`; two `@ts-expect-error` lines prove the types are not `any` (an unknown route
    name, and a listed file's `completedAt` read as `null`). `drizzle.ts` uses `drizzleStore` with `store.route` and
    `cloudropPgTables` with `skipLibCheck: true`.
  - **`deno`** installs Deno 2.9.8 with `denoland/setup-deno` and runs `scripts/check-deno.sh`: the unpacked tarball is
    a project's `node_modules/cloudrop` (`deno.json`: `nodeModulesDir: "manual"`), and `scripts/deno-smoke.ts`
    imports `npm:cloudrop` and `npm:cloudrop/testing`, answers an `/upload` on the test bucket through
    `cloudrop.handler` (200, one single-`PUT` ticket), `PUT`s the bytes and completes them (200, the object stored).
    It runs with `--no-remote --cached-only` and `--allow-env=NODE_ENV,CLOUDROP_*`, and nothing else.
  - **`api-report`** runs `bun run api:check` (`M12-P6`), then `bun run docs:reference` and keeps `docs/reference/` as
    the artifact `api-reference` for 30 days (`M12-P10`).
- **Why:** spec 1.0 §8 and §10 ask for a TypeScript 7.0 floor job and a Deno smoke lane. npm has no TypeScript 7.0.0 or
  7.0.1: the 7 line was published as `7.0.1-rc`, then `7.0.2` (`npm view typescript versions`, 2026-11-22), so 7.0.2 is
  the oldest release of the floor. It is also the workspace's version today; the job still adds what the workspace
  cannot see, an install of the packed tarball with `skipLibCheck` off, and it stays on 7.0.2 when the workspace moves
  on. drizzle-orm's own `.d.ts` fail with `skipLibCheck` off unless `@types/node` and `mysql2` are installed (measured:
  41 errors in `node_modules/drizzle-orm`, none in cloudrop's), so the Drizzle entry is checked in a second program.
  Deno grants no env access by default, and cloudrop reads `process.env.NODE_ENV` when `r2()` is built (and `CLOUDROP_*`
  when a setting is left out): without `--allow-env` the first run failed with Deno's `NotCapable`, "Requires env access
  to "NODE_ENV"". An app on Deno grants the same access.
- **The fixture's other types float:** only `typescript`, `@types/react` and `drizzle-orm` are pinned; what they
  depend on (`csstype` for `@types/react`, for one) resolves to the newest matching version at each run. They are types
  only, so a new release can fail the job but never reaches an app; the ruling keeps them floating (coordinator,
  fix round 1).
- **Deno and IndexedDB:** the smoke test also asserts `typeof indexedDB === "undefined"`, which the resume guide
  states for Deno; it passed on Deno 2.9.8.
- **Local runs, 2026-11-22:** `CLOUDROP_TS_FLOOR_DIR=~/projects/.worktrees/cloudrop/ts-floor
  scripts/check-ts-floor.sh` passed, "The packed types of every entry type-check with TypeScript 7.0.2."; with a line
  `export declare const probeBroken: NotAType;` appended to `dist/index.d.ts` it failed with TS2304 in
  `node_modules/cloudrop/dist/index.d.ts`. `CLOUDROP_DENO_DIR=~/projects/.worktrees/cloudrop/deno-smoke
  scripts/check-deno.sh` on Deno 2.9.8 (installed under `~/.deno`) passed: "Deno/2.9.8: /upload answered one ticket,
  and /complete stored notes/01M81DPDJ7T5M3Y6KQEPR7VND8.txt."; without `--allow-env` it failed as above. Both projects
  were removed by the scripts' traps.
- **If wrong:** a TypeScript 7.0.x patch older than the one checked does not exist, so the floor is exact until 7.0 has
  no users. A Deno that resolves `npm:` from `node_modules` differently fails the lane, not an app; the fix is in the
  script. If cloudrop should run on Deno without env access, `fromEnv` (`src/env.ts`) catches the refusal and reads it
  as unset: a behaviour change for a later entry, not made here.
- **Status:** in force. Amends `M12-P3`, which named 7.0.0.
- **Visible in:** `.github/workflows/ci.yml` (`ts-floor`, `deno`, `api-report`), `scripts/check-ts-floor.sh`,
  `scripts/check-deno.sh`, `scripts/deno-smoke.ts`, `docs/guide/stability.md` ("Supported runtimes").

### M12-P6: the freeze guard is one api-extractor report per entry, with every type a signature uses

- **Decision:** `scripts/api-report.ts` runs api-extractor 7.60 (`api-extractor.json`) over each entry's built `.d.ts`,
  in `package.json`'s `exports` order, and writes `packages/cloudrop/etc/<entry>.api.md` (`cloudrop.api.md`,
  `cloudrop-client.api.md`, ..., `cloudrop-adapters-prisma.api.md`), reviewed and under git. `bun run api:report`
  rewrites them; `bun run api:check` (CI's `api-report` job) writes each report to a scratch folder under
  `node_modules/.api-extractor/` and fails when one differs from `etc/`, or when `etc/` holds a report for an entry the
  exports map no longer has (`api:report` deletes it), naming the files and what to do. `bun run verify` runs
  `api:check` after the build, so a local gate catches drift before CI. The reports
  set `includeForgottenExports`: a type a public signature uses but no entry exports (`DeleteBase`, `ContextOption`,
  `RecordBase`, `StoreErasure` and the rest) is written out in full, unexported, so a change to its shape fails the
  guard too. A type another entry exports appears in each entry's report that uses it. The warnings api-extractor
  cannot attach to a declaration name a built chunk's line, such as `dist/store-DylAfRVk.d.ts:292:3`; the script drops
  that place and keeps the warning, so a doc-comment edit that moves a line or renames a chunk changes nothing.
  Release tags and TSDoc syntax are not checked (`ae-missing-release-tag` and TSDoc messages are off): the report is a
  diff of the API, not a lint. api-extractor runs on the TypeScript 6.0.3 it depends on, which reads the `.d.ts` only
  (`M12-P3`).
- **Why:** spec 1.0 §8: CI fails on any unreviewed change to the public API. api-extractor reads one entry point per
  run, and the package has eleven. Without `includeForgottenExports` the report names `DeleteBase` and `StoreErasure`
  without their members, so a required member added to the store contract, a major change in the tier apps implement
  (`M12-A12`), would pass unseen.
- **Fault probes, 2026-11-22:** `export function probeExport(): void {}` added to `src/index.ts`, then build and
  `bun run api:check`: exit 1, "The public API differs from its reviewed report in etc/cloudrop.api.md."; a member
  `probe: string` added to `DeleteBase` in the built chunk: exit 1, naming seven reports; a doc comment reworded in
  `src/server/store-config.ts`: exit 0.
- **If wrong:** the reports grow with the API (7,300 lines over eleven files at 1.0), and a change to a shared type
  rewrites several of them at once; `api:report` writes all of them in one run. If the duplication hides a change in
  review, the reports can be merged into one over a synthetic entry later, which changes no API.
- **Status:** in force.
- **Visible in:** `api-extractor.json`, `scripts/api-report.ts`, `packages/cloudrop/etc/`, `package.json`
  (`api:report`, `api:check`), `.github/workflows/ci.yml` (`api-report`), `docs/guide/stability.md` ("How the API is
  kept frozen").

### M12-P7: the helper types stay unexported at 1.0

- **Decision:** the five helper types the earlier tasks left unexported stay unexported: `AuthOf` (the union of the
  routes' authorize results, which plugins are checked against), `DeletedOf` and `ErasedOf` (the intersection of the
  routes' delete contexts, which `api.deleteFile`, `api.eraseOwner` and `api.sweep` take), `DeleteBase` (the `file` and
  `owner` every `DeleteContext` has) and `ContextOption` (the `{ context }` that is optional or required by the type).
  So do the rest of the reviewed list: `Jsonified`, `RecordBase`, `ListQuery`, `RecordPage`, `StoreErasure`,
  `EraseRunOptions`, `SweepSettings`, `ReservedName`, `AuthResult`, `Awaitable`, `CompleteData`, `RouteTypes`,
  `RouteTypeMap`, `RoutesOf`, `SchemaInput`, `SchemaOutput`, `StandardResult`, `StandardIssue`, `NoExtra`, `WithExtra`
  and `ContextOf` from `cloudrop`; `Account`, `ServerHeaders`, `ClientFetch` and `TicketFields` from `cloudrop/client`;
  `UseUploadArguments` and `ResumableOf` from `cloudrop/react`. Their shapes are frozen through the report (`M12-P6`).
  The plugin API's types (`CloudropPlugin`, `ServerHooks`, `BeforeUploadContext`, `AfterVerifyContext`,
  `AbortContext`, `PluginFile` and `extendRoute`) are marked experimental in their doc comments, as `M12-A12` rules,
  with the tag `@beta`, the release tag api-extractor knows, so the reports show the tier (TypeDoc refuses `@beta`
  beside `@experimental` as two release stages, so the word stays in the prose); the `plugins` option of
  `CloudropOptions` carries api-extractor's warning that a public signature uses a beta type, which is the case.
- **Why:** every export is a semver promise (`M2-X38`), and adding one later is not breaking. None of the five is a
  type an app needs to write:
  - an app annotates `onDelete`'s parameter with `DeleteContext<FileDeleter, undefined>`, not with `DeleteBase`;
  - a wrapper around `deleteFile` takes `DeleteFileOptions<FileDeleter>`, which is `ContextOption` by its public name,
    and `EraseOptions` and `SweepOptions` do the same for the others;
  - a plugin is typed for the shape it reads, `CloudropPlugin<{ userId: string }>`, and the plugin API is outside
    semver anyway;
  - the opt-in store view writes the context types it declared, `StoreFileApi<RouteName<typeof cloudrop>, FileDeleter,
    undefined>`, or takes `Cloudrop<typeof routes, CloudropStore>["api"]`, instead of `DeletedOf<typeof routes>`.

  The client's option types are reached as `ClientOptions["account"]` and `ClientOptions["headers"]`; the store
  helpers are contextually typed inside `defineStore({ ... })`, so a hand-written store names none of them.
  An app's `.d.ts` that prints a type through one of these aliases keeps the public alias (`DeleteContext<...>`,
  `Route<...>`), so no app declaration hits "cannot be named".
- **If wrong:** an app that wants one writes it from the public types (`Parameters<StoreFileApi["deleteFile"]>[1]`),
  and a minor release exports it, which is additive.
- **Status:** in force. Settles the controller's deferred ruling on `AuthOf`, `DeletedOf`, `ErasedOf`, `DeleteBase` and
  `ContextOption`.
- **Visible in:** `packages/cloudrop/etc/*.api.md` (each as an unexported declaration with its warning),
  `src/server/plugins.ts` (`@beta`).

### M12-P8: the stability policy as written for 1.0

- **Decision:** `docs/guide/stability.md` states what semver covers (the eleven entries and their exports, documented
  behaviour, error codes with their statuses and `retryable`, the wire protocol, the token format `v: 1` and the
  IndexedDB records, the guaranteed columns, the command's flags and exit codes) and what it does not (message text,
  log lines, bundle size, anything undocumented, the plugin API). A minor release may add error codes and union
  members, optional options, **fields in what a call answers**, exports and entries, additive migrations with their SQL
  in the changelog, and a more precise error classification. The three tiers of `M12-A12`, with the plugin hooks'
  contexts in the experimental tier beside `CloudropPlugin`, `ServerHooks` and `extendRoute`. Client and server of one
  major work together in both directions; a major accepts the previous token version for 24 hours. Deprecation is
  `@deprecated`, one logger warning, and at least one minor and six months. Runtimes: Node 26+, Bun 1.4+, Deno 2,
  Cloudflare Workers, Chrome 103, Firefox 100, Safari 16, React 18 and 19, TypeScript 7.0+, each with what CI checks
  it by. Raising a floor is a major release.
- **Why:** spec 1.0 §8, with three readings made explicit. New answer fields: the wire rule that a client ignores what
  it does not know already allows them (the server reads only named request fields, `readRequest` in
  `src/server/upload-request.ts`), and `EraseReport` and `SweepReport` grew that way before 1.0. The hook contexts: a
  hook's signature cannot change without its context, so freezing the contexts alone would freeze nothing. The runtime
  table says what each lane checks, because "each in CI" is not equally true: React 18 is not run (the tests and
  examples use React 19), Workers run the store on D1 and the driver on Wrangler's R2 but not the handler itself.
- **If wrong:** a promise the page makes that a release breaks is a bug in the release, fixed in a patch; a promise the
  page should not make is withdrawn in the next major, with a changelog line.
- **Status:** in force.
- **Visible in:** `docs/guide/stability.md`, `docs/README.md` ("Before you ship").

### M12-P9: the threat model page

- **Decision:** `docs/guide/security.md` names what is protected (the bucket and its credentials, users' files, the
  token secret, the store's records), who is involved (signed-in users, anonymous visitors, other sites, holders of a
  leaked token or URL, another user of the browser profile; the server's operator and a script inside the page are out
  of scope), the trust boundaries, each control of base spec §7, what the app must do (rate limiting, malware scanning,
  decompression bombs, integrity beyond size and type, session security, the bucket's own settings) and the four
  residual risks of spec 1.0 §8. It links `SECURITY.md` for reports.
- **Why:** spec 1.0 §8 and base spec §13. `SECURITY.md` says how to report and what is in scope; this page says what a
  developer must know before shipping, which `SECURITY.md` does not.
- **If wrong:** a control the page describes that the code does not have is a bug in one of them; the page follows the
  code, as every guide does.
- **Status:** in force.
- **Visible in:** `docs/guide/security.md`, `docs/README.md` ("Before you ship").

### M12-P10: llms.txt, the reference, and doc comments without decision ids

- **Decision:**
  - `scripts/package-docs.ts` writes `llms.txt` and `llms-full.txt` at the package root (`scripts/llms.ts`), shipped
    through `files`. `llms.txt` holds the summary, rules for coding agents (`import type` the server, mount before body
    parsers, no secret from `authorize`, `trustedOrigins` behind a proxy, `{ data, error }` with a `default` branch,
    `deleteFile` with a store), every shipped guide in `docs/README.md`'s reading order with its index line, the `.d.ts`
    of each entry as the reference, the examples and the changelog. `llms-full.txt` is the same header with every guide
    in full. Their links are relative to the package root. `check-package.sh` fails when the tarball lacks either file,
    when `llms.txt` does not link a shipped guide, or when `llms-full.txt` does not carry it.
  - `bun run docs:reference` (`scripts/api-reference.ts`, run by Node) builds the TypeDoc 0.28 reference from the built
    `.d.ts` of every entry in the exports map into `docs/reference/` (git-ignored), names each module as an app imports
    it (`cloudrop/adapters/sql`), and fails on any TypeDoc warning. TypeDoc gets TypeScript 6.0.3 through the dev
    dependency alias `typescript-6@npm:typescript@6.0.3` and a `module.registerHooks` resolve hook, in that process
    only.
  - The doc comments the build ships carry no decision id or spec section: 36 lines in the built `.d.ts` cited one (34
    found by `grep -nE "M[0-9]+-[A-Z][0-9]+|spec §"` over `dist/`, where the plan counted 16; two more cited a series,
    `M10-A` and `M11-L`), and each was rewritten in plain words in its source's doc comment. `check-package.sh` fails
    when one comes back, or when any `§` does. `//` comments keep their ids.
- **Why:** spec 1.0 §8. An agent with the package installed reads `node_modules/cloudrop/llms.txt` with no network, so
  the links point into the package. TypeDoc peers on TypeScript 6.0 at most, and TypeScript 7's package has no
  JavaScript API (its main export is `lib/version.cjs`): without the hook TypeDoc stops with "Cannot read properties of
  undefined (reading 'PropertyDeclaration')". An app reads the doc comments in its editor and cannot look up an id. The
  built `.d.ts` keep no `@module` comment on an entry that only re-exports (tried on all eleven, kept on six), so the
  module names are set in the script.
- **Fault probes, 2026-11-22:** a line for `docs/security.md` deleted from the built `llms.txt`: `package:check` exit 1,
  "llms.txt does not link docs/security.md."; `(M12-O3)` put back into `EraseSettings`' doc comment: exit 1, naming
  `dist/index.d.ts:601`.
- **If wrong:** the reference is an artifact of each CI run, not a hosted site, so it has no public URL; `llms.txt`
  points at the `.d.ts` instead. Hosting it is a later change.
- **Status:** in force.
- **Visible in:** `scripts/package-docs.ts`, `scripts/llms.ts`, `scripts/api-reference.ts`, `typedoc.json`,
  `scripts/check-package.sh`, `packages/cloudrop/package.json` (`files`, devDependencies), `.gitignore`.
