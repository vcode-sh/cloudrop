# M4a decisions: audit fixes, developer experience and React hooks

Design: [`2026-11-17-m4-dx-and-react-design.md`](../superpowers/specs/2026-11-17-m4-dx-and-react-design.md). Each
entry: decision, why, what it costs if wrong, status, source, where it is visible. `M4-F<n>` numbers follow the design's
§3 to §5; `M4-B<n>` follow §6. Execution rulings continue each series from the next free number.

## Fixes and developer experience (`M4-F`)

### Client (design §3, `M4-F1` to `M4-F9`)

<!-- Task A appends its entries above this line. -->

### Server and storage (design §4, `M4-F10` to `M4-F14`)

<!-- Task B appends its entries above this line. -->

### API, configuration and documentation (design §5, `M4-F15` to `M4-F21`)

<!-- Tasks C and E append their entries above this line. -->

## Bindings (`M4-B`)

`M4-B1` to `M4-B6` are the design's §6 as built; `M4-B7` onwards are task D's execution rulings. Fix round 1 of the
task D review amended `M4-B1` to `M4-B4`, `M4-B10` and `M4-B12` in place, before the branch merged, and added `M4-B13`
to `M4-B15`.

### M4-B1: `createUploadHooks<typeof cloudrop>(options?)`, with a lazy client

- **Decision:** a factory returns `{ useUpload, useResumable }`. It takes `createCloudropClient`'s options, or
  `{ client }` to share one. With options, the client is created at the first `upload()`, input pick, drop, `resume()`
  or `useResumable` read: in a handler or an effect, so never during a server render. A wrong option is caught there
  (`createCloudropClient` throws only its configuration error) and kept: `upload()`, `resume()` and `refresh()` resolve
  `{ data: null, error }` with that `INVALID_CONFIG`, and nothing throws from a handler or rejects unhandled from an
  effect. Fix round 1 (review M1) replaced a synchronous throw.
- **Why:** a factory lets `useUpload("documents")` infer the route's metadata and result without a second type
  argument; a client created at module load would run on the server, which loads `"use client"` modules too.
- **If wrong:** an eager option check would need the client to export its option reader; adding it is non-breaking.
- **Status:** in force (`542ae74`, `99f795a`).
- **Source:** design §6.1; task D review M1.
- **Visible in:** `src/react.ts`, `docs/guide/react.md#set-up`.

### M4-B2: `useUpload(route, options?)`

- **Decision:** as design §6.1. `files` lists the files of the hook's jobs in start order, each the client's snapshot
  plus `pause`, `resume`, `abort` and `retry` bound to its handle; `totals` sums the jobs' totals with the client's own
  rule (failed and aborted files out of the bytes; an all-empty set is finished once its counted files are done);
  `upload()` takes a `File`, an array or a `FileList` (`M4-B14`) and resolves `null` for none; `clear()` drops the jobs
  whose every file ended done or aborted, and keeps a job with a running or failed file, since the client keeps a failed
  file's ticket, parts, record and lock for `retry()` (review M2). `metadata`, `multiple` and `accept` are read from the latest committed render (assigned in
  `useInsertionEffect`), so `upload`, `pause`, `resume`, `abort`, `retry` and `clear` never change identity, while
  `getInputProps()` and `getDropProps()` are built per render.
- **Why:** design §6.1; stable functions keep an effect that lists `upload` in its dependencies from uploading again on
  every render.
- **If wrong:** per-render functions would be a breaking change for code that relies on identity.
- **Status:** in force (`542ae74`, `99f795a`).
- **Source:** design §6.1; task D review M2.
- **Visible in:** `src/react/use-upload.ts`, `src/react/upload-store.ts`, `src/react/types.ts`.

### M4-B3: `useResumable(route?)`

- **Decision:** `{ uploads, refresh }`. `uploads` is the client's `resumable()` list of the route (or of every route)
  minus every upload this page holds through the factory's hooks: one whose file, in a job those hooks started or
  resumed, is `queued`, `uploading`, `paused`, `completing`, or `failed` and kept for `retry()`. A held upload is
  matched by the record's route, name, size, type and `lastModified` against that file, because a file's snapshot does
  not carry the upload's id. So a failed file of this page is never listed (it is continued with `files[n].retry()`;
  `resume()` would be refused, since this page holds its lock), a listed upload leaves the list when its resume starts,
  and the same file uploaded anew hides an earlier unfinished upload of it until the new one ends done or aborted. The
  list is read after mount, when a job of the hooks starts, and whenever one of its files ends or starts again (its
  `done + failed + aborted` changes), in a microtask: the client queues a cancelled file's record removal right after
  its status publishes, and the store reads in order, so a deleted record is gone from the next read. `[]` on the
  server, before the first read and when the read failed. `refresh()` reads again and resolves with the listed
  `Result`, so a failure is not lost. A read that answers after a newer read started does not replace the newer list.
- **Why:** design §6.1. The first version read only when `job.done` settled, once per job, and listed this page's own
  uploads, so a retried or cancelled file left a stale entry and a failed one offered a resume the client refuses
  (review I1). "Every job of the client" is read as every job the hooks started (`M4-B12`).
- **If wrong:** an exact match needs the upload id on the client's file snapshot, a client API change; exposing an
  `error` field later is non-breaking.
- **Status:** in force (`542ae74`, `99f795a`).
- **Source:** design §6.1; task D review I1 and the controller's ruling on it.
- **Visible in:** `src/react/use-resumable.ts`, `src/react/job-tracker.ts`, `docs/guide/react.md#resume-after-a-reload`.

### M4-B4: behaviour under server rendering, StrictMode and unmounting

- **Decision:** `useSyncExternalStore` with a module-level server snapshot (`EMPTY_VIEW`), which is also the browser's
  state before any upload. Uploads start only from `upload()`, the input's `onChange`, a drop and `resume()`, never in
  an effect or during render. The hook's store listens to its jobs only while React listens to it, and rebuilds its view
  when React subscribes again, so a component hidden by `<Activity>` shows what its jobs did meanwhile; unmounting
  unsubscribes and cancels nothing, so the jobs finish and their resume records stay. Tested on React 19.3; React 18.3
  passed the same tests in a one-off run (all but the `<Activity>` row, an API React 18 lacks), and the library source
  type-checks against `@types/react` 18.3.
- **Why:** design §6.1.
- **If wrong:** an opt-in cancel on unmount is a non-breaking option; the guide shows `useEffect(() => abort, [abort])`.
- **Status:** in force (`542ae74`).
- **Source:** design §6.1.
- **Visible in:** `src/react/upload-store.ts`, `src/react/hooks.test.ts`, `src/react/upload-store.test.ts`,
  `docs/guide/react.md`.

### M4-B5: a size budget of its own

- **Decision:** `cloudrop/react` has its own size-limit entry, bundled and minified without `react` and the client's
  chunk. The design's 1.5 kB is amended by `M4-B10`.
- **Why:** design §6.1.
- **If wrong:** —
- **Status:** amended by `M4-B10`.
- **Source:** design §6.1.
- **Visible in:** `scripts/size-limit.config.ts`.

### M4-B6: tests

- **Decision:** unit tests on happy-dom with React Testing Library drive the real client against the fake server
  (`src/react/*.test.ts`); the server render runs on Node with `renderToString`; type tests compile in `typecheck`. The
  example's home page uses the hooks, so the browser lane's three uploads, including picking the same file twice, prove
  them in Chromium.
- **Why:** design §6.1.
- **If wrong:** —
- **Status:** in force (`542ae74`); the browser lane runs after merge.
- **Source:** design §6.1.
- **Visible in:** `src/react/`, `examples/next/app/page.tsx`, `examples/next/lib/upload.ts`.

### M4-B7: `react` is an optional peer dependency of `cloudrop/react` only

- **Decision:** `packages/cloudrop` declares `react >=18` as an optional peer dependency; only `src/react.ts` and
  `src/react/**` import it. The AGENTS.md rule "zero runtime dependencies, web-platform APIs only" now names this one
  exception. React's types reach `src/react` through its own `import ... from "react"`: `types: []` only stops
  automatic global types, so neither tsconfig changes, and every other source file still has no React types. Biome
  turns its React rules on for a package that depends on `react`; an override in `biome.json` keeps them to
  `cloudrop/react`, since the chaos tests' `useChaosFixture()` is a Vitest fixture, not a hook.
- **Why:** the hooks need React; an app that does not import `cloudrop/react` installs and bundles nothing of it.
- **If wrong:** a separate `@cloudrop/react` package would move the entry; the import path would change.
- **Status:** in force (`542ae74`).
- **Source:** task D brief; code-quality `dependencies.md` ("optional integrations are optional peer dependencies").
- **Visible in:** `packages/cloudrop/package.json`, `AGENTS.md`, `biome.json`.

### M4-B8: a file keeps its object while its fields do

- **Decision:** a `files` entry is reused while every field of the file's new snapshot equals the last one's, compared
  per handle; it is not keyed by the snapshot object.
- **Why:** the client builds a new snapshot of every file of a job when one file changes (`snapshotOf` in
  `client/job-snapshot.ts`), so object identity would replace every row of a multi-file job on each progress tick.
- **If wrong:** if the client keeps unchanged file snapshots one day, the comparison still holds; it only does more
  work than needed.
- **Status:** in force (`542ae74`).
- **Source:** task D ruling, from reading `client/job-snapshot.ts`.
- **Visible in:** `src/react/upload-store.ts` (`isSameFile`).

### M4-B9: a hook without `multiple` takes only the first dropped file

- **Decision:** a drop on a hook whose `multiple` is false uploads the first file and ignores the rest.
- **Why:** the drop zone then behaves as the hook's input, which lets the user pick one file.
- **If wrong:** uploading every dropped file instead is a behaviour change in a minor version.
- **Status:** in force (`542ae74`).
- **Source:** task D ruling.
- **Visible in:** `src/react/use-upload.ts`, `docs/guide/react.md#drag-and-drop`.

### M4-B10: the `cloudrop/react` ceiling is 2.3 kB, not 1.5 kB

- **Decision:** the budget is 2.3 kB gzip: the 2.07 kB size-limit measured after fix round 1, plus about 10%, the rule
  `size-limit.config.ts` states. Like the client's chunk, the client's errors chunk (`CloudropError`) is left out: an
  app that uses the hooks ships both with the client.
- **Why:** with every promise of §6.1 kept (the per-file identity cache, the latest-options handlers, drag counting,
  the stale-read guard), the hooks measured 1.66 kB; the review's fixes added the resumable list's tracking of held
  uploads (`M4-B3`), configuration errors as results (`M4-B1`) and file-drag checks (`M4-B13`), for 2.07 kB. The
  controller accepted the raised ceiling with about 10% headroom.
- **If wrong:** the owner may hold 1.5 kB; then a promise of §6.1 has to go, or the code be minified by hand.
- **Status:** in force (`542ae74`, `99f795a`); accepted by the controller, for owner confirmation.
- **Source:** task D measurement (`bun run package:check`, 2026-11-17).
- **Visible in:** `scripts/size-limit.config.ts`.

### M4-B11: a paused file is not uploading

- **Decision:** `isUploading` is true while a file of the hook is `queued`, `uploading` or `completing`; `paused`,
  `done`, `failed` and `aborted` are not.
- **Why:** a spinner or a "leave page?" prompt should not run for files the user stopped; the network's offline pause
  also shows `paused`.
- **If wrong:** counting `paused` in is a behaviour change in a minor version.
- **Status:** in force (`542ae74`).
- **Source:** task D ruling.
- **Visible in:** `src/react/upload-store.ts` (`UPLOADING`).

### M4-B12: `useResumable` follows the jobs the hooks start

- **Decision:** `useResumable` follows the jobs started or resumed through the same factory's `useUpload`: it reads
  again when one starts and when one of its files ends or starts again, and leaves out the uploads they hold
  (`M4-B3`). A job started on a shared client directly (`client.start()`) is neither followed nor left out; `refresh()`
  reads again after it.
- **Why:** the client offers no event for every job it runs, and task D does not change `src/client/**`.
- **If wrong:** a client-wide settle event would need a client API; the hook would then use it.
- **Status:** in force (`542ae74`, `99f795a`).
- **Source:** task D ruling; amended by review I1.
- **Visible in:** `src/react/job-tracker.ts`, `docs/guide/react.md#resume-after-a-reload`.

### M4-B13: drop zones take only drags that carry files

- **Decision:** the drop handlers count, and cancel the default of, only events whose `dataTransfer.types` includes
  `"Files"`. A drag of text or a link leaves `isDragOver` false and keeps the browser's behaviour.
- **Why:** cancelling every drag broke dropping text into an input inside the zone and lit the zone for drags it could
  not upload (review M3).
- **If wrong:** a zone that wants other drags would need an option; adding one is non-breaking.
- **Status:** in force (`d3c3a82`).
- **Source:** task D review M3.
- **Visible in:** `src/react/drop.ts`, `docs/guide/react.md#drag-and-drop`.

### M4-B14: `upload()` takes what the client takes

- **Decision:** `upload()` resolves `null` for `null` or an empty list; otherwise it passes a list (an array, a
  `FileList`, anything with a numeric `length`) or one value to `client.start()`, which checks every item is a `File`
  (`readFiles` in `client/arguments.ts`). A `File` of another realm, such as an iframe's, resolves `INVALID_INPUT`.
- **Why:** the first version tested `instanceof File` itself and turned anything else into an empty list, so a foreign
  `File` resolved `null` silently (review M4). The client's check is the one the rest of the library uses.
- **If wrong:** if the client ever accepts a foreign `File`, the hooks follow it unchanged.
- **Status:** in force (`99f795a`).
- **Source:** task D review M4 and the controller's ruling on it.
- **Visible in:** `src/react/use-upload.ts`.

### M4-B15: `{ client }` must be created for the same server's routes

- **Decision:** the `client` option is typed `CloudropClient<T> & { resumable(route?: RouteName<T>): unknown }`. The
  added, non-generic member makes a client of another server's routes a type error.
- **Why:** `CloudropClient`'s methods are generic over the route name, and TypeScript compares generic methods by their
  constraints, so any `CloudropClient` was assignable to any other (review M6). A client whose route names include
  `T`'s still passes; results with the same route names are not compared.
- **If wrong:** a phantom type member on `CloudropClient` would make the check exact; that is a client API change.
- **Status:** in force (`d85022a`).
- **Source:** task D review M6.
- **Visible in:** `src/react/types.ts` (`UploadHooksOptions`), `src/react/types.test.ts`.

<!-- Task D appends its entries above this line. -->
