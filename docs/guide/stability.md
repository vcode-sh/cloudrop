# Stability and versioning

cloudrop follows [semantic versioning](https://semver.org) from 1.0.0. This page says what a version number promises:
what may change in a patch, a minor and a major release, what never counts as a change, and which runtimes each release
supports.

## What semver covers

A change to any of these is a major release, unless the next section allows it in a minor:

- **The entries and their exports:** `cloudrop`, `cloudrop/client`, `cloudrop/react`, `cloudrop/next`,
  `cloudrop/node`, `cloudrop/store`, `cloudrop/plugins`, `cloudrop/testing`, `cloudrop/adapters/sql`,
  `cloudrop/adapters/drizzle` and `cloudrop/adapters/prisma`, and every function, class and type each one exports.
- **Documented behaviour:** what the guides and the doc comments say a call does, answers or refuses.
- **Error codes and their HTTP statuses:** `error.code`, the status the handler answers it with, and whether it is
  `retryable`. [Errors](errors.md) lists them.
- **The wire protocol:** the four endpoints (`/upload`, `/sign`, `/complete`, `/abort`), their request and response
  bodies and the headers the client and server exchange, including what a client may receive from an error
  (`code`, `message`, `retryable`, `parts` and `content`).
- **The upload token's format** (`v: 1`) and **the format of the records the browser keeps in IndexedDB** for resuming
  after a reload.
- **The guaranteed columns** of `cloudrop_files` and `cloudrop_usage`, with their meaning per status, as the
  [database store guide](store.md) lists them. Columns it calls internal, and the index names, are not covered.
- **The `cloudrop` command's flags and exit codes** ([the command](command.md)).

## What semver does not cover

- **Message text:** `error.message`, log lines and the command's output may be reworded in any release. Branch on
  `error.code`, never on the message.
- **Bundle size.** The release notes give the sizes measured.
- **Anything undocumented:** a field, export path or behaviour no guide or doc comment describes, such as the files
  under `dist/`.
- **The name of a type no entry exports,** such as the base every `FileRecord` status builds on. You cannot import it,
  so it may be renamed; its shape is covered through the exported signatures that use it.
- **The plugin API** (below), which is experimental.

## What a minor release may add

A minor release adds; it never removes or renames. It may add:

- **New error codes and new members of a union**, such as a new `CloudropErrorCode`, `RefusedKind`, `DeleteReason`,
  `FileRecordStatus` or a file `status`. Keep a `default` branch in every `switch` over one: a new code must reach
  your generic handling, not fall through silently.
- **New options**, always optional, whose default keeps today's behaviour.
- **New fields** in what a call answers, such as one more count in a report.
- **New exports and entries.**
- **Additive database migrations**, such as a new column or index. The changelog gives the SQL for Postgres, SQLite and
  D1 and what Drizzle and Prisma need, and until the migration runs, the store's first call answers `INVALID_CONFIG`
  with that SQL.
- **A more precise error classification**, such as a failure that used to answer a generic code now answering a more
  specific one, when the old code's advice was wrong for it.

A patch release fixes bugs, and changes behaviour only to match what the documentation already says.

## Three tiers

What semver promises depends on who writes the code on each side of a type.

- **Types an app calls, which is most of the API:** covered as above.
- **Interfaces an app implements:** `StorageDriver`, `CloudropStore` and `SqlExecutor`. A minor release may add an
  optional member to one of them, never a required one. A required member waits for a major release. A store you wrote
  yourself and wrapped with `defineStore` keeps compiling and working across minor releases.
- **The plugin API:** `CloudropPlugin`, `ServerHooks` with its contexts (`BeforeUploadContext`, `AfterVerifyContext`,
  `AbortContext`, `PluginFile`) and `extendRoute` are marked `@beta` and experimental in their doc comments, and are **outside semver**: a minor
  release may change them. The API has one user, and the plugins it was designed for were cut before 1.0. Using a
  plugin cloudrop ships, such as `contentChecks()` from `cloudrop/plugins`, is covered like any other call; writing
  your own plugin is what may need a change on upgrade. The changelog says when it does.

The wire types `cloudrop/client` exports (`UploadRequest`, `UploadResponse`, `FileTicket`, `SingleTicket`,
`MultipartTicket`, `RejectedFile`, `FileDescriptor`, `SignRequest`, `SignResponse`, `SignedRequest`, `SignedPart`,
`CompleteRequest`, `CompleteResponse`, `UploadedFile`, `AbortRequest`, `AbortResponse`, `ErrorBody`, `ErrorResponse`,
`Endpoint` and `ContentRefusal`) change only with the protocol, under the rules of the next section.

## Client and server of different versions

Any client and any server of one major version work together, in both directions. A page can run a cached bundle of an
older or newer client during a rolling deploy, and an upload started before a deploy finishes after it, with a token
of up to 24 hours. A client ignores fields it does not know; a server ignores request fields it does not know.

A major release that changes the token format still accepts the previous version's tokens for their 24-hour lifetime,
so uploads in flight during the upgrade finish.

## Deprecation

Before anything covered here is removed in a major release, it is deprecated in a minor one:

- the doc comment gets `@deprecated` with what to use instead, so your editor strikes it through;
- on the server, one warning goes to your `logger` the first time the deprecated thing is used;
- the changelog says what to change, with the exact before and after.

In the browser (`cloudrop/client`, `cloudrop/react`) cloudrop has no logger, so a deprecated client API logs nothing:
`@deprecated` and the changelog are the notice.

A deprecated API stays for at least one minor release and at least six months before the major release that removes
it.

## Supported runtimes

| Runtime | Supported | Checked in CI by |
| --- | --- | --- |
| Node.js | 26 or newer | every job runs on Node 26 |
| Bun | 1.4 or newer | the built command's checks, and the Hono example's API in the browser lane |
| Deno | 2, with `--allow-env` for `NODE_ENV` and `CLOUDROP_*` | a smoke job: the packed package uploads a file to a fake bucket |
| Cloudflare Workers | current | the store on Wrangler's local D1 and the storage driver on its local R2 |
| Browsers | Chrome 103, Firefox 100, Safari 16 or newer | headless Chromium uploads the examples; client code uses no web API newer than these |
| React | 18 and 19 | the hooks' tests and the examples, on React 19 |
| TypeScript | 7.0 or newer, for the shipped types | a job type-checks the packed `.d.ts` with TypeScript 7.0.2, the oldest 7.0 release npm published |

Raising a floor in this table is a major release; supporting an older version is a minor one. On Deno, cloudrop reads
`NODE_ENV` and its own `CLOUDROP_*` settings through `process.env`, so without that access `r2()` throws Deno's
`NotCapable`.

## How the API is kept frozen

Every release is checked against a reviewed copy of its public API. `api-extractor` reads the packed `.d.ts` of each
entry and writes what it exports, with every type a signature uses, to `packages/cloudrop/etc/*.api.md` in the
repository; CI fails when the build's API differs from those files. A pull request that changes the API runs
`bun run api:report`, and the diff of those files is what the review reads, with the changelog line and the decision
entry the change needs. The API reference is built from the same `.d.ts` with TypeDoc (`bun run docs:reference` in
the repository), and those `.d.ts`, with their doc comments, are what your editor shows.
