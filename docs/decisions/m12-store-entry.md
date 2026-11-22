# M12-S: the store's code ships with the store

Rulings for moving the store's server paths behind the store object and the `cloudrop/store` entry, so a stateless
server carries none of the store's code, designed in `docs/superpowers/specs/2026-11-22-1.0.0-design.md` §5.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-S1: the store's code travels on the store object, so a server without a store never loads it

- **Decision:** the core endpoints (`upload.ts`, `complete.ts`, `sign.ts`, `abort.ts`) and `api.ts` import no store
  module. They call `config.paths.<module>.<function>`, where `config.paths` is the `StorePaths` the store object
  carries under `STORE_PATHS = Symbol.for("cloudrop.store")` (`src/server/store-paths.ts`, types only). The modules
  themselves are imported by `src/store/paths.ts` alone, which `defineStore` attaches; `sqlStore`, which every shipped
  adapter goes through, calls it on the store before the transaction spread, and `memoryStore` calls it through the
  published `cloudrop/store` entry. `StorePaths` has one member per module the core calls: `upload`, `complete`,
  `calls` and `api`. The erasure, the sweep, the listings, deletion and leftovers need no member: only `store-api` and
  `store-complete` import them, so they are behind the paths already, and Task 9's erasure code lands behind them by
  living in those modules. The property is an ordinary enumerable one, so a store copied with spread keeps it. The
  store-less branches stay in the core: `withoutStore` in `api.ts` answers each store call `INVALID_CONFIG` as before,
  and `/upload`'s plugin `onAbort` for unstarted files moved from `store-upload.ts` to `upload.ts`, leaving
  `endUnstarted` (the rows' part) behind the paths. `scripts/check-package.sh` follows `dist/index.js`'s static imports
  and fails when any of those files holds a message of a `StorePaths` module (one per member, the erasure's for `api`);
  each message must also be in the files `dist/store.js` loads, so a reworded message fails instead of passing unseen.
  Biome's import rule for the SQL core now covers `src/store/sql/**` only, and allows `../define-store.ts`.
- **Sizes (gzip, 2026-11-22):** `cloudrop (bundled)` 34.71 kB before, 28.25 kB after; `cloudrop` summed 47.08 kB before,
  40.29 kB after; `cloudrop + adapters/sql (bundled)` 33.13 kB before, 33.61 kB after (the namespace objects, the
  indirection and the start-up log of `M12-S2` cost 0.48 kB). The store's code is a chunk of 10.6 kB that the adapters
  and `cloudrop/store` load. The bundled ceiling stays at `M12-P1`'s 40 kB, not the spec's 30 kB: the owner's later
  ruling raised every ceiling.
- **Why:** spec §5: a stateless server carried about 7.3 kB of store code it never runs, and part 4 would add more.
  Through the store object no import is added on the simple path: an app with a store already passes the object that
  brings the code. A symbol from `Symbol.for` lets a store built by a second copy of cloudrop be recognised, so it is
  refused by its version (`M12-S2`) instead of reported as carrying nothing.
- **If wrong:** a wrapper that copies a store without spread (from `Object.entries`, a class without the symbol) loses
  the code; the server then logs that at start and answers every request with a retryable 500 and every `api` call with
  `INVALID_CONFIG` (`M12-S2`). Moving back is the four imports in the endpoints and `api.ts`.
- **Status:** in force.
- **Visible in:** `src/server/store-paths.ts`, `src/store/paths.ts`, `src/store/define-store.ts`,
  `src/store/sql/store.ts`, `src/testing/memory-store.ts`, `src/server/{upload,complete,sign,abort,api}.ts`,
  `scripts/check-package.sh`, `scripts/size-limit.config.ts`, `biome.json`.

### M12-S2: `defineStore` for a store written by hand, and a version on the store's code

- **Decision:** the new entry `cloudrop/store` exports `defineStore(store)` and the store types (`CloudropStore`,
  `FileRecord`, `FileStatus`, `ClaimOutcome`, `Transition`, `Completion`, `NewFile`, `EndedStatus`, `OwnerUsage`,
  `TransactionalStore`); `cloudrop` keeps exporting the same types. `defineStore` attaches the paths to the object it is
  given and returns that object, typed as given (`<TStore extends CloudropStore<unknown>>(store: TStore) => TStore`),
  so a class instance keeps its methods and `this`. `createCloudrop` reads the paths once: a store without them makes
  every request answer the retryable 500 of a server that is not ready and every `api` call answer `INVALID_CONFIG`
  with `The store carries none of the store code the server runs. If you wrote it yourself, wrap it with defineStore
  from "cloudrop/store"; if you wrapped an adapter's store, copy it with spread ({ ...store }), which keeps that code.`
  Paths whose `version` is not 1 answer `cloudrop is installed twice: the store's adapter comes from another copy.
  Install cloudrop once.` The failure is reported through `ready`, the path a missing environment setting takes, so
  no client sees the server's configuration. The logger hears it at start, from `createCloudrop` (`logger.error`, in
  `announce`), so a server is not silent about it until its first request; then once more from the handler, on the
  first request it fails, and again only when the message changes.
- **Why:** spec §5 and the brief ask for `INVALID_CONFIG` on the requests and the `api` calls, which needs a server
  that was built; throwing from `createCloudrop`, as other option mistakes do, would leave no `api` to answer. The
  returned object is the same one because a store may be a class instance whose methods need `this` (the delete
  fixture's `inherited` row), which a spread copy would lose.
- **If wrong:** a developer could prefer the failure at start. It is one change: throw `readStorePaths`'s error from
  `readConfig` instead of handing it to `ready`. A second copy of cloudrop at the same interface version is accepted,
  and its store code then raises its own copy's `CloudropError`; only an install with one copy is supported.
- **Status:** in force.
- **Visible in:** `src/store.ts`, `src/store/define-store.ts`, `src/server/store-config.ts` (`readStorePaths`),
  `src/server/config.ts`, `package.json` (`exports["./store"]`), `tsdown.config.ts`, `docs/guide/store.md` ("A store
  you write yourself"), `CHANGELOG.md`.

### M12-S3: the store entries' summed budgets count only what they add to `cloudrop`

- **Decision:** the summed budgets of `cloudrop/adapters/sql`, `cloudrop/adapters/drizzle`, `cloudrop/adapters/prisma`
  and the new `cloudrop/store` count the entry and the chunks it loads that `dist/index.js` does not
  (`beyondCloudrop` in `scripts/size-limit.config.ts`). Measured 2026-11-22: sql 22.06 kB, drizzle 23.8 kB, prisma
  21.54 kB, store 10.64 kB, under `M12-P1`'s ceilings of 32, 34, 32 and 20 kB.
- **Why:** the store's code imports the server core the endpoints share (tokens, presigning, the completion steps),
  and the build puts that core in a chunk `index.js` loads. Counted whole, the adapters measured 35.61, 37.35 and
  35.09 kB, over ceilings that `M12-P1` sized for the adapter plus the store's code: the extra was `cloudrop`'s own
  code, which the `cloudrop` budget counts and every app with a store ships anyway. The new
  `cloudrop + adapters/sql (bundled)` budget guards the total an app with a store ships. The release summary shows the
  owner both numbers for each store entry: beyond `cloudrop`, and with every chunk it loads.
- **If wrong:** an adapter that started pulling server core into its own chunks would be counted, as it should; one
  whose growth lands in a chunk `index.js` shares is counted by the `cloudrop` budget instead.
- **Status:** in force; accepted by the controller, 2026-11-22.
- **Visible in:** `scripts/size-limit.config.ts`.
