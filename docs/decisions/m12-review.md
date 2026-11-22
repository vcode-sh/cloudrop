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

### M12-R3: the sweep's erase pass never sets a mark

- **Decision:** the sweep carries an erasure on through `continueErasure`, not through `eraseOwner`'s run. For each
  owner of its page it reads the owner's mark with `store.usage(owner)` instead of calling `store.markErasure`: no mark
  (the app reopened the owner after the page was read) and the owner is skipped, not counted in `erasing`, and still
  one owner of the page's `limit`; a mark and the run goes on with that mark's `requestedAt`, which `erased` finishes
  only while it is still the owner's mark. A mark already finished answers done, as before. `eraseOwner` alone marks.
  The store calls per owner are unchanged (`usage` replaces `markErasure`).
- **Why:** review finding F1. `markErasure` is an upsert, so a sweep that reached an owner the app had reopened while
  it erased an earlier owner of the page set a new mark, deleted the owner's files and recorded that new erasure as
  finished: the owner ended erased for good, against `reopenOwner`'s promise that the sweep stops erasing them.
- **If wrong:** a reopen that lands after the pass read the mark, while that owner's own run is under way, still lets
  the run delete what it reads, as a run of `eraseOwner` does; `erased` then records nothing, as the guide says.
- **Status:** in force. `src/server/sweep-erase.test.ts`: the probe's sweep, with `reopenOwner("u2")` called while u1
  runs, answers `erasing: 1, erased: 1` and leaves u2 without a mark; before the fix it answered `erasing: 2,
  erased: 2` and u2's mark was `{ requestedAt: T+1h, erasedAt: T+1h }`. Amends `M12-O4`.
- **Visible in:** `packages/cloudrop/src/server/erase.ts`, `src/server/sweep.ts`, `docs/guide/store.md#erasing-an-owner`.

### M12-R4: `defineStore` refuses what it cannot wrap with `INVALID_CONFIG`

- **Decision:** `defineStore(store)` throws `INVALID_CONFIG` for a value that is not an object, `defineStore takes the
  store object, with the CloudropStore methods, such as defineStore(myStore).`, and for an object that is not
  extensible, `defineStore cannot attach the store code to a frozen or sealed store. Pass the store before freezing it,
  or a copy made with spread ({ ...store }).` Its JSDoc no longer says a spread copy keeps a class instance's methods.
- **Why:** review findings A5 and A4. `defineStore(undefined)` threw a raw `TypeError`, a string came back wrapped as
  a `String` object, and a frozen store threw `object is not extensible`; every other construction-time mistake names
  its fix. A spread copy of a class instance loses the prototype's methods.
- **If wrong:** a frozen store that already carries the store code (a frozen spread copy of an adapter's store) is
  refused by `defineStore` although `createCloudrop` accepts it as it is; the message says to pass it unfrozen.
- **Status:** in force. `src/store/define-store.test.ts`: undefined, null, a string and a frozen store each answer
  their message (all four failed before the fix).
- **Visible in:** `packages/cloudrop/src/store/define-store.ts`, `docs/guide/store.md`.

### M12-R5: the sweep warns once per owner whose erasure run fails, and the guide documents the starvation

- **Decision:** when an owner's run in the sweep's erase pass answers an error, or a report with files or folders in
  `failed`, the sweep logs one `logger.warn` for that owner: `cloudrop: the sweep could not finish erasing <owner>
  (<why>). The next sweep tries again, and until one succeeds this owner takes one row of each sweep's limit ahead of
  the owners after it: fix the cause, or continue each sweep from the cursor the last one answered.` `<why>` is the
  error's message, or `<n> of its files or folders failed, as logged`. It replaces the `logger.error` the error case
  logged; the store's own failure stays logged with its cause by the store call. The store guide's Erase pass and D1
  sections say that without a cursor each sweep starts the pass at the first marked owner, so owners that keep failing
  or cannot finish yet hold rows ahead of the owners after them. The pass's order is unchanged.
- **Why:** review finding F3, under the controller's ruling: no re-architecture. With `limit` such owners at the front
  of byte order, a sweep without a cursor (the guide's own D1 recipe) never reaches later owners; the app had no sign of
  it.
- **If wrong:** an owner whose erasure only waits (a refused `onDelete`, a file inside the grace) holds its row
  without a warning, since nothing failed; its report counts it in `waiting`.
- **Status:** in force. `src/server/sweep-erase.test.ts`: owner `a` whose `revoke` throws and owner `b` with no files,
  three `sweep({ limit: 1 })`: `b` stays unerased and exactly three warnings name `a` (fault probe: the warning
  removed, seen failing).
- **Visible in:** `packages/cloudrop/src/server/sweep.ts`, `docs/guide/store.md#the-sweep`.

### M12-R6: `erase.prefixes` refuses a folder in the folder of a route without its own `prefix`

- **Decision:** a prefix whose first path segment, in NFC, is the name of a route that has no `prefix` of its own
  answers `INVALID_CONFIG` before the owner is marked: `erase.prefixes answered "docs/". Its first folder is that of
  route "docs", which has no prefix and keeps every owner's files under its name. Start each prefix with a folder no
  such route uses, such as "exports/<owner>/", or give route "docs" a prefix.` The prefix checks move from `erase.ts` to
  `erase-prefixes.ts`.
- **Why:** review finding B2. `M12-A10` puts a route without `prefix` under its name, so `(owner) => [owner + "/"]`
  passed the segment rule for an owner named like a route and emptied every owner's files of that route, leaving their
  rows `completed`.
- **If wrong:** a route without `prefix` whose `key` function writes elsewhere still reserves its name: a prefix under
  that folder is refused although it holds none of the route's files. Rename the folder or give the route a `prefix`.
- **Status:** in force. `src/server/erase-mark.test.ts`: route `docs` with Alice's completed file, `eraseOwner("docs")`
  answers the message and Alice's object stays (before the fix: `prefixed: 1`, `done: true`, the object gone).
- **Visible in:** `packages/cloudrop/src/server/erase-prefixes.ts`, `src/server/store-config.ts`,
  `docs/guide/store.md#folders-no-row-tracks-eraseprefixes`, `docs/guide/errors.md`.

### M12-R7: the raw-owner prefix is safe only for owner ids without `/`

- **Decision:** the rule's message, `EraseSettings.prefixes`' JSDoc and the store guide say that when owner ids can
  contain `/`, the prefix uses `encodeURIComponent(owner)`, because `exports/acme/` also holds an owner `acme/alice`'s
  `exports/acme/alice/`. The message now ends `so that no prefix reaches every owner's files. If owner ids can contain
  "/", use encodeURIComponent(owner), or one owner's folder holds another's.` The check itself is unchanged.
- **Why:** review finding F4. The rule compares one segment and cannot see other owners' ids, so its claim that "no
  prefix reaches another owner's files" was false for nested ids; refusing the raw form outright would break every app
  whose ids have no `/`.
- **If wrong:** an app with nested ids that keeps the raw form still empties nested owners' folders; only the docs
  warn it.
- **Status:** in force. `src/server/erase-mark.test.ts` asserts the new message for each refused prefix.
- **Visible in:** `packages/cloudrop/src/server/erase-prefixes.ts`, `src/server/store-config.ts`,
  `docs/guide/store.md#folders-no-row-tracks-eraseprefixes`.

### M12-R20: a JSON property that may be undefined is optional

- **Decision:** `Jsonified` maps a property whose type admits `undefined` to an optional property of the JSON form
  of the rest: `{ teamId: string | undefined }` becomes `{ teamId?: string }`, and `{ a: unknown }` becomes
  `{ a?: unknown }`. Keys that are always present stay required; a key whose value can only be undefined, a function
  or a symbol still vanishes. The two groups are built as two mapped types and flattened back into one object type by
  an internal `Flattened` helper, which shows in the API reports as a forgotten export like `Jsonified` itself. This
  reaches every user of `Jsonified`: plugin `auth` in `beforeUpload`, `afterVerify` and `onAbort`, `onComplete` and
  `afterComplete` contexts, and the client's `data` type.
- **Why:** `JSON.stringify` leaves out a key whose value is undefined, and every hook reads the token's JSON snapshot
  (`M12-T5`). The old map dropped `undefined` from the union but kept the key required, so `auth.teamId.length`
  compiled and threw at runtime (review R13 B1).
- **If wrong:** code that read such a field as always present now gets a compile error and must check it; the
  changelog says so. Undefined and function elements in arrays, and NaN and Infinity, still become null at runtime
  while the type says otherwise; the JSDoc names those gaps. Inlining the flattening as `extends infer O` instead of the
  helper made `memoryStore`'s `route()` exceed TypeScript's instantiation depth, so the helper stays.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/protocol/types.ts`, `packages/cloudrop/src/protocol/types.test.ts`,
  `packages/cloudrop/src/server/plugins.test.ts` ("has no key for a value authorize gave as undefined"),
  `packages/cloudrop/etc/*.api.md`, `docs/guide/server.md` (plugins), `packages/cloudrop/CHANGELOG.md`.

### M12-R21: the reserved-name rule does not reach an index signature, and the docs say so

- **Decision:** `AuthResult` stays as `M12-A8` made it. The route-context JSDoc, `M12-A8`'s status, the server guide
  and the changelog say that a result typed with an index signature (`Record<string, string>`, a JWT payload) compiles
  and may carry `tx`, `route` or another reserved name at runtime, and they show returning a plain object of the named
  claims instead.
- **Why:** a mapped `?: never` constraint checks only declared keys; `{ [claim: string]: unknown }` satisfies it
  (review R13 B3). Refusing every `string extends keyof TAuth` result would break apps that return a verified token's
  payload or a `Record` as is, which compiles today; the controller ruled for documenting the limit.
- **If wrong:** an app that returns raw claims still risks a claim shadowing a context field added later; refusing
  index-signature results remains possible before the freeze.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/server/route-context.ts`, `docs/decisions/m12-api.md` (`M12-A8`),
  `docs/guide/server.md`, `packages/cloudrop/CHANGELOG.md`.

### M12-R22: the `prefix` doc comment states its default

- **Decision:** the JSDoc of `RouteCallbacks.prefix` says that the default is the route's name (`avatar/<ulid><ext>`)
  and that `() => ""` writes at the bucket root (`M12-A10`).
- **Why:** editors show the `.d.ts` text, not the guide, and the frozen comment described only the key's shape
  (review R13 B4).
- **If wrong:** nothing depends on the text.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/server/route.ts`.

### M12-R23: `M12-A9` names the first refusal in development correctly

- **Decision:** `M12-A9`'s text says that with nothing passed the first refusal is the missing routes outside
  development, and the missing R2 settings with `NODE_ENV=development`. The order of the readers is unchanged.
- **Why:** `readConfig` reads `storage` before `routes`, and in development `r2()` reads its variables at
  construction, so "Missing R2 settings" comes first there (review R13 B5). Reading routes first would change which
  mistake an app hears about first for no gain the review named.
- **If wrong:** nothing depends on the text.
- **Status:** in force.
- **Visible in:** `docs/decisions/m12-api.md` (`M12-A9`), `packages/cloudrop/src/server/config.ts`.

### M12-R24: the `BROWSER_STORAGE_ERROR` upgrade entry warns about exhaustive maps

- **Decision:** the changelog's `BROWSER_STORAGE_ERROR` bullet says that an exhaustive `switch`, or a
  `Record<CloudropErrorCode, string>` or `Record<ClientErrorCode, string>`, must handle the new code, as the
  `BUCKET_BLOCKED` bullet does.
- **Why:** the code is a new member of both unions and breaks such a map at compile time (review R13 B6).
- **If wrong:** nothing depends on the text.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/CHANGELOG.md`.

### M12-R30: a retryable `afterVerify` error keeps the object

- **Decision:** an error a plugin's `afterVerify` returns with `retryable: true` (after the rebuild of `M12-R31`, so
  any `RATE_LIMITED` too) is answered as it is, with its `Retry-After`, and handled as a throw in `afterVerify` is: the
  object stays, no `onAbort` runs, and with a store the row stays `pending` (the claim is taken only after
  `afterVerify`, so there is none to release). Only a refusal that is not retryable rejects the upload and deletes the
  object. The `afterVerify` JSDoc, server.md's hook table and plugins.md's scanning section say so.
- **Why:** review R13-C1. `rateLimited(5)` from a throttled scanner deleted the object and answered 429 with
  `Retry-After: 5`; the client's retry after the wait then got `NOT_UPLOADED` (`UPLOAD_EXPIRED` with a store), which
  is untrue for the user. A retryable answer promises that the same request may succeed, so nothing it needs may be
  removed. Controller's ruling.
- **If wrong:** a plugin that meant "refuse and delete" with a retryable code keeps an unwanted object until its own
  later answer or the sweep; it returns the error without `retryable` instead.
- **Status:** in force.
- **Visible in:** `src/server/complete-steps.ts`, `src/server/plugins.ts`, `src/server/complete.test.ts`,
  `src/server/store-complete-refuse.test.ts`, `docs/guide/server.md`, `docs/guide/plugins.md`, `docs/guide/errors.md`.

### M12-R31: refusals at `/complete` are rebuilt from an allowed list, as at `/upload`

- **Decision:** a refusal from a plugin's `afterVerify`, and from a replacing completion's `onDelete`, goes through
  `completeRefusal` (`src/server/refusal.ts`), which shares `uploadRefusal`'s rebuild: code, message, `retryable`
  (always `true` for `RATE_LIMITED`), a type refusal's `content` and the recorded wait, never `parts`, `file` or
  `cause`. `/complete` may refuse with `UNAUTHORIZED`, `FORBIDDEN`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `FILE_TOO_LARGE`,
  `FILE_TYPE_NOT_ALLOWED` (the code `contentChecks()` refuses with), `INVALID_METADATA`, `VERIFICATION_FAILED` and
  `SERVER_ERROR`. Any other code is logged as `cloudrop: <source> returned <CODE>, which /complete cannot send. Return
  one of …` (`a plugin's afterVerify`, or `onDelete for route "<name>"`) and answered as the generic, non-retryable
  `SERVER_ERROR`. Such an `afterVerify` answer keeps the object and runs no `onAbort`, as a throw does: a code the
  server cannot send is the plugin's bug, not a verdict on the file, and the object is there for `retry()` once the
  plugin is fixed. `errorBody` also sends `parts` only with `PARTS_MISSING`, and only safe positive integers.
  `TOO_MANY_FILES` and `INVALID_INPUT` are left out: no hook at `/complete` judges a request's file count or its body.
- **Why:** review R13-C2. `if (read.error) return read.error;` in an `afterVerify` sent the browser `STORAGE_DENIED`
  with the operator's advice, against errors.md's "A browser never sees `STORAGE_DENIED`", and `errorBody` copied
  `parts` of any element type with any code, so a plain-JavaScript plugin could send a presigned URL there. One
  rebuild for both endpoints keeps every hook refusal equal. Controller's ruling.
- **If wrong:** an app that needs another code at `/complete` gets a 500 with a log naming the list; widening it is
  additive.
- **Status:** in force.
- **Visible in:** `src/server/refusal.ts`, `src/server/complete-steps.ts`, `src/server/store-delete.ts`,
  `src/server/http.ts`, `src/server/http.test.ts`, `src/server/handler-failures.test.ts`,
  `src/server/store-delete-refuse.test.ts`, `docs/guide/errors.md`, `docs/guide/store.md`, `docs/guide/plugins.md`.

### M12-R32: `Retry-After` comes only from `rateLimited()` or a storage wait

- **Decision:** errors.md's `RATE_LIMITED` row says that `rateLimited(seconds)`, from `authorize` or a plugin, is sent
  with `Retry-After`, and that a `CloudropError` built by hand with that code is sent without one. No behaviour
  changes.
- **Why:** review R13-C3. The row promised `Retry-After` for any plugin refusal with this code; a hand-built one has
  no recorded wait. server.md already said "when it came from `rateLimited()`". Controller's ruling.
- **If wrong:** none; the docs match the code.
- **Status:** in force.
- **Visible in:** `docs/guide/errors.md`.

### M12-R33: `rateLimited()` names a non-number it was given

- **Decision:** the `TypeError` for a bad `seconds` says `It got the string "30".` for a string, `It got a value of
  type undefined.` (or the other type) for any other non-number, and the number itself, as before, for a number.
- **Why:** review R13-C4. From plain JavaScript, `rateLimited("30")` said "It got 30.", which reads as though 30 had
  been fine.
- **If wrong:** only the log's wording changes.
- **Status:** in force.
- **Visible in:** `src/server/refusal.ts`, `src/server/upload-authorize.test.ts`.

### M12-R34: `retryable` is sent as a boolean

- **Decision:** `errorBody` sends `retryable: error.retryable === true`, and the refusal rebuild reads it the same way:
  only `true` is retryable.
- **Why:** review R13-C5. `{ retryable: 1 }` from plain JavaScript was sent as `"retryable":1`, which the client's
  `readErrorBody` rejects, so the app's message was lost. Controller's ruling: coerce when the body is built.
- **If wrong:** a plain-JavaScript app that passed a truthy non-boolean gets a refusal the client does not retry; it
  passes `true`.
- **Status:** in force.
- **Visible in:** `src/server/http.ts`, `src/server/refusal.ts`, `src/server/upload-authorize.test.ts`.

### M12-R35: what the `svg` and `xml` kinds mean

- **Decision:** `RefusedKind`'s JSDoc drops "the route does not name" from the `svg` and `xml` kinds and says a kind
  wins over `"denied"`; plugins.md's kind section shows `deny: ["image/svg+xml"]` giving `"svg"` on a route that names
  that type. No behaviour changes.
- **Why:** review R13-C6. A type in `deny` that is also an SVG or XML type is that kind, whatever the route names, as
  the rule "a kind wins over denied" says.
- **If wrong:** none; the docs match the code.
- **Status:** in force.
- **Visible in:** `src/errors.ts`, `docs/guide/plugins.md`.
