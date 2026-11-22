# M12-R: the review of every area before 1.0.0

Findings of the area-by-area review before 1.0.0 and what was done with each, designed in
`docs/superpowers/specs/2026-11-22-1.0.0-design.md` §10. A finding is proven with a failing test or a measurement before
it is fixed.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-R1: a transactional store's routes carry the store's brand, which a spread copy keeps

- **Decision:** `withRoute` gives a `transaction: true` store an enumerable property `Symbol.for("cloudrop.store-brand")`
  holding an object of its own, and its `route()` puts that object on each route under `Symbol.for("cloudrop.store")`.
  `createCloudrop` accepts a store's route when the route's brand is the store's brand, no longer when the route names
  the store object itself. `memoryStore({ transaction: true })` from `cloudrop/testing` does the same. The refusal of a
  route from another store reads `Route "<name>" was made by another store's route(), so its onComplete expects that
  store's tx. Pass that store, or a copy of it made with spread ({ ...store }), to createCloudrop, or build the route
  with route().`
- **Why:** review finding A1. The store guide's wrapper (`{ ...store, get: logged(store.get) }`) and the upgrade notes
  copy the store with spread, and the copy's `route()` branded routes with the original object, so `createCloudrop`
  refused the copy with a message whose only fix dropped the wrapper. Spread copies own enumerable symbol properties,
  so the brand survives the very copy the docs recommend.
- **If wrong:** a copy made another way (`Object.entries`, a class) loses the brand and its routes are refused at
  start, with a message that names spread; `defineStore` does not restore it. Two stores copied from one share a brand,
  so a route of one is accepted with the other: both run the same database and `tx` type.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/adapters/transactional.ts`, `src/server/route.ts`, `src/server/store-route.ts`,
  `src/server/store-config.ts`, `src/testing.ts`, `src/server/store-config.test.ts`.

### M12-R2: a CloudropError is recognised across installed copies by a registered brand

- **Decision:** the `CloudropError` constructor defines a non-enumerable property `Symbol.for("cloudrop.error")` set to
  `true`, and the internal `isCloudropError(value)` reads it (an `Error` carrying the brand). The server uses it where
  it read a refusal with `instanceof`: `authorize`'s result (`upload.ts`), a plugin hook's result (`plugins.ts`) and
  `onDelete`'s result (`store-delete.ts`). The wait `rateLimited` and the driver record for `Retry-After`
  (`retry-after.ts`, read by the refusal in `refusal.ts`) moves from a module `WeakMap` to a non-enumerable property
  `Symbol.for("cloudrop.retry-after")`, so it crosses copies too. `instanceof CloudropError` keeps working for this
  copy's errors. The store paths' version check (`M12-S2`) is unchanged. An `Error` named `CloudropError` without the
  brand (a copy older than 1.0) is still refused, and the logged messages name that cause.
- **Why:** review finding A2. A store from a second copy at the same version is accepted (`M12-S2`) and runs that
  copy's deletion code, which refused the app's own `CloudropError` from `onDelete` as "not from the same cloudrop" and
  answered `SERVER_ERROR`; a plugin package that resolves its own copy hit the same. The rule: **every check that a
  value is a CloudropError, on a path that reads an app's or a plugin's value, goes through `isCloudropError`;
  `instanceof` stays for values the same module built.** The refusal brand (`Symbol.for("cloudrop.unauthorized")`)
  already worked this way.
- **If wrong:** an object of another library that defines the same registered symbol on an `Error` passes for a
  CloudropError; the refusal is rebuilt from its `code` and `message`, and an unknown code answers the generic 500.
  A copy that changes the error's shape after 1.0 would need a version on the brand.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/errors.ts`, `src/retry-after.ts`, `src/server/upload.ts`,
  `src/server/plugins.ts`, `src/server/store-delete.ts`, `src/store/define-store.test.ts`,
  `src/server/plugins.test.ts`, `src/server/upload-authorize.test.ts`.
