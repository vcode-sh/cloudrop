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
  `Record<CloudropErrorCode, string>`, must handle the new code, as the `BUCKET_BLOCKED` bullet does. As first written
  it also named `Record<ClientErrorCode, string>`, a type no entry exports (amended by `M12-R64`).
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

### M12-R40: `BUCKET_BLOCKED` only where the runtime says it is online (amends M12-E7)

- **Decision:** the fourth condition of the rule in `src/client/parts.ts` is `navigator.onLine === true`, not
  `!== false`, checked for each attempt since `M12-R60`. Every browser on the floor (Chrome 103, Firefox 100, Safari 16)
  reports it, in a page and in a worker; React Native and Node have a `navigator` without `onLine`, so there a PUT
  refused before any byte left on every attempt ends `NETWORK_ERROR`.
- **Why:** finding D1 of the review (area D). Spec 1.0 §2d says the rule runs only in a browser, but the only gate was a
  global `XMLHttpRequest`, which React Native has. A probe with React Native's `navigator` (`{ product: "ReactNative" }`)
  and every PUT failing before progress ended in `BUCKET_BLOCKED` after two PUTs: a DNS or TLS failure of the storage
  host, or a mobile network handover, would have shown a non-retryable CORS message in an app that has no CORS. The
  `onLine` test needs no new API and no origin comparison.
- **If wrong:** a browser-like runtime that has CORS but no `navigator.onLine` reports a blocked bucket as
  `NETWORK_ERROR`, as before 1.0; none is known. Since `M12-R60` both codes come after the same six attempts, so only
  the code and the message differ.
- **Status:** in force.
- **Visible in:** `src/client/parts.ts`, `src/client/bucket-blocked.test.ts`, `docs/guide/errors.md`,
  `docs/guide/client.md`, spec 1.0 §2d, base spec §6.2, `M12-E7`.

### M12-R41: a part's `/sign` that asks for a long wait stops at once (extends M12-E4)

- **Decision:** `signFailure` in `src/client/parts.ts` turns a `/sign` error that `waitsTooLong` into an outcome
  without a wait, so `nextStep` fails the part with the retryable error at once, as `withRetry` does. Bucket PUTs keep
  their capped backoff.
- **Why:** finding D2. A `/sign` inside a part's attempts went through the capped `retryDelay`, never `waitsTooLong`: a
  proxy answering `/sign` with `429` and `Retry-After: 600` was asked again every 20 s, five times (measured on the
  fake clock: `/sign` at 7, 27, 47, 67 and 87 s), while the client guide said a wait over 20 s is not waited for.
- **If wrong:** a `/sign` behind a proxy that over-states its wait fails the file where five 20-second waits might have
  passed; `retry()` keeps the ticket and the parts stored.
- **Status:** in force.
- **Visible in:** `src/client/parts.ts`, `src/client/upload-rate-limited.test.ts`, `docs/guide/client.md`,
  spec 1.0 §2a, `M12-E4`.

### M12-R42: after the long-wait stop, only `rateLimited()`'s default message names the wait

- **Decision:** no new public field. `M12-E4`'s "If wrong" and the client guide say that only the default message of
  `rateLimited(seconds)` names the wait; a proxy's `429`, storage throttling and a custom message do not, and the app
  chooses when to call `retry()`.
- **Why:** finding D3. `M12-E4` claimed "the error's message gives the wait", which a probe disproved: a proxy's `429`
  with `Retry-After: 600` gave "The upload server is busy. Try again in a moment.". The controller ruled out a
  `retryAfter` field on `CloudropError` before 1.0 freezes the surface.
- **If wrong:** an app that shows a Retry button for such an error lets a person press it too early, and the file fails
  again at once with the same retryable error. A read-only field can be added in a minor release.
- **Status:** in force.
- **Visible in:** `docs/decisions/m12-errors.md` (`M12-E4`), `docs/guide/client.md`.

### M12-R43: an HTTP-date `Retry-After` counts from the answer's `Date` header

- **Decision:** `parseRetryAfter(value, date)` in `src/retry-after.ts` reads an HTTP date against the answer's own
  `date` header when it parses, and against the local clock otherwise. The client's calls to the upload server pass it
  (`src/client/endpoints.ts`). Bucket PUTs and the server's storage driver still read against the local clock.
- **Why:** an unconfirmed item of the review, confirmed by a probe: a proxy whose clock runs 5 minutes ahead of the
  client's answered `/upload` with `429`, `Date` and `Retry-After` 3 s later; the client read 303 s, past its 20-second
  cap, and failed the file at once instead of waiting 3 s. cloudrop's own server always sends seconds, so only a proxy
  or a bucket sends a date. A cross-origin page cannot read `Date` (it is not a CORS-safelisted header), so the
  fallback stays. Bucket PUTs never stop on a long wait and wait at most 20 s, so a skewed date there costs at most
  20 s. The server's driver is left as it is: a server's clock is usually synchronised, and its waits reach the client
  as seconds.
- **If wrong:** accepted costs: a cross-origin app server behind a proxy that sends HTTP dates, with a client clock
  minutes behind, still fails the file at once (`retry()` recovers); a server whose clock is minutes behind the
  bucket's stretches a bucket's HTTP-date wait the same way.
- **Status:** in force.
- **Visible in:** `src/retry-after.ts`, `src/client/endpoints.ts`, `src/retry-after.test.ts`,
  `src/client/upload-rate-limited.test.ts`, `docs/guide/client.md`.

### M12-R44: an XHR PUT adds its abort listener before `send()`

- **Decision:** `putWithXhr` in `src/client/transport.ts` adds the listener on the caller's signal before `open()`, so
  `settle` removes it whichever way the PUT ends, even inside `send()`.
- **Why:** an unconfirmed item of the review, confirmed by a probe: an XMLHttpRequest that calls `onerror` inside
  `send()` settled before the listener was added, which then stayed on the part's signal and aborted the finished
  request when that signal fired. Browsers report failures later; the move costs nothing.
- **If wrong:** none known.
- **Status:** in force.
- **Visible in:** `src/client/transport.ts`, `src/client/transport.test.ts`.

### M12-R50: `createUploadHooks` reads options that are not an object as a wrong option

- **Decision:** `createUploadHooks(options)` reads its argument with `optionsOf` (`src/input.ts`, M11-R245): null and
  undefined are no options (M11-R7), a plain object is the options, and anything else, such as the basePath alone or
  a function, is a wrong option. The hooks then behave as for any wrong option: `upload()`, `resumeUpload()` and
  `refresh()` resolve `INVALID_CONFIG` with "Pass createUploadHooks the client's options as an object, such as
  { basePath: "/api/cloudrop" }, or { client } to share a client.", a start's refusal reaches `startError` and
  `onError`, a pick or a drop also throws it in a task, and `close()` resolves.
- **Why:** review r13 E1. From plain JavaScript, `createUploadHooks("/api/cloudrop")` made `upload()`, a pick, a drop
  and `close()` throw `TypeError: Cannot use 'in' operator to search for 'client' in /api/cloudrop` synchronously, out
  of React's `onChange` after the start had begun; a function was read as an object with no options and ignored, so
  uploads went to the default basePath. Every other public call resolves `{ data, error }`.
- **If wrong:** an app that passed a non-object and relied on the defaults now gets `INVALID_CONFIG` at its first
  upload. The types never allowed it. `createCloudropClient("/api/cloudrop")` itself still accepts the string and
  ignores it: that is area A's (r13 E1 notes it), not changed here.
- **Status:** in force. `src/react.test.ts`, a string and a function as options: before the fix the string threw that
  `TypeError` and the function's upload answered `NETWORK_ERROR` with no `startError`.
- **Visible in:** `src/react.ts`, `src/react.test.ts`, `docs/guide/react.md` (Set up).

### M12-R51: `useUpload().upload(file, options)` hands options that are not an object to the client

- **Decision:** `upload(files, call)` reads `metadata` from `call` only when `call` is a plain object (`undefined`
  counts as `{}`). Any other value, null included, goes to `client.start` unchanged, which refuses it with
  `INVALID_INPUT` "Pass the upload options as an object, such as { metadata, signal }." (`client/arguments.ts`).
  That refusal has no file row, so it reaches `startError` and `onError` like any other refused start (M12-H2).
- **Why:** review r13 E2. `upload(file, null)` threw `TypeError: Cannot use 'in' operator to search for 'metadata' in
  null`, because the default `call = {}` covers only `undefined`. The guide says a wrong argument resolves
  `INVALID_INPUT`, and the client's own `upload()` already refuses it so. Handing the value on keeps one place, the
  client, that words the refusal.
- **If wrong:** nothing in the types allowed null; a JavaScript caller that passed it now gets `INVALID_INPUT` instead
  of a throw, and no request is sent.
- **Status:** in force. `src/react/use-upload.test.ts`, null and a string as options: both threw that `TypeError`
  before the fix.
- **Visible in:** `src/react/use-upload.ts`, `src/react/use-upload.test.ts`, `docs/guide/react.md` (Start uploads
  yourself).

### M12-R52: `refresh()`'s `INVALID_CONFIG` is not a start refusal; the guide was wrong

- **Decision:** the code stays: `useResumable().refresh()` resolves `INVALID_CONFIG` for a wrong client option and
  sets neither `startError` nor `onError`. The guide now says the error reaches `startError` and `onError` for
  `upload()` and `resumeUpload()`, which start an upload, and that `refresh()`'s answer is the only place it shows.
- **Why:** review r13 E3. Spec 1.0 §1 defines `startError` as "the route's last start refused without a file row",
  and M12-H2 sets it from `start()` in `use-upload.ts`. `refresh()` is a read of the resumable list: `useResumable`
  has no route store (its route is optional and a list may span every route), and a read is not a start. Making it
  set `startError` would also show a list read's error on a page's upload input. A pick or a drop of the same page
  already surfaces the same wrong option there.
- **If wrong:** a page that renders only `useResumable` and no upload has to read `refresh()`'s answer, or the first
  read's result, to see the configuration error.
- **Status:** in force. `src/react/use-upload.test.ts` ("resolves INVALID_CONFIG from upload(), resume() and
  refresh()") already pins the answers; the reviewer's probe saw `startError` null and `onError` silent.
- **Visible in:** `docs/guide/react.md` (Set up).

### M12-R53: CI runs the React tests on React 18.3.1

- **Decision:** a CI job `react-18` runs `scripts/test-react-18.sh 18.3.1`: a copy of the package's `src` and
  `tsconfig.json` in `$RUNNER_TEMP/react-check` with its own install of `react` and `react-dom` 18.3.1 and the
  workspace's versions of `vitest`, `happy-dom`, `@testing-library/react` and `@testing-library/dom`, then
  `vitest run src/react.test.ts src/react/`. The copy is removed by a trap set before it is made, so the workspace's
  React 19 and `bun.lock` are never touched. The `<Activity>` row of `upload-store.test.ts` skips there with
  `ctx.skip("<Activity> needs React 19")`, a declared gap: React 18 has no `<Activity>`. The stability page's React
  row says React 18.3.1 is tested in its own job.
- **Why:** review r13 E5. `peerDependencies.react` is `>=18`, but `verify` and CI installed and tested 19.3.1 only, so
  nothing caught a React 18 regression. Run locally on 2026-11-22: 67 passed, 1 skipped (the `<Activity>` row), on
  react and react-dom 18.3.1; without the skip that row fails with "Element type is invalid ... got: undefined".
- **If wrong:** the job tests the runtime only, not the types against `@types/react` 18; the reviewer type-checked
  the source against 18.3.12 once (exit 0). A test that uses another React 19 API must skip the same way.
- **Status:** in force.
- **Visible in:** `.github/workflows/ci.yml` (`react-18`), `scripts/test-react-18.sh`,
  `src/react/upload-store.test.ts`, `docs/guide/stability.md`, `CONTRIBUTING.md`, `AGENTS.md`.

### M12-R54: a hook listens for ends from its commit, in a layout effect

- **Decision:** `useUpload` registers its `onEnd` listener in a layout effect in the browser, and in `useEffect`
  where there is no `document` (`useCommitEffect` in `src/react/use-upload.ts`). A hook that React committed hears
  every end of its route from then on. StrictMode's double effect still leaves one listener, `<Activity>` hiding
  still removes it, and the server runs neither. This amends M12-H1's "registers ... in a `useEffect`".
- **Why:** review r13 U1, confirmed by a probe on React 19.3.1 outside `act`. React runs a commit's passive effects in
  a later task; an end that lands between the commit and that task (in a browser, a network answer can) reached the
  route's other hooks but not the newly committed one: the probe's late hook heard `[]` while the keeper heard
  `INVALID_INPUT`. React 18's server renderer warns "useLayoutEffect does nothing on the server" (checked in
  `react-dom-server.node.development.js` 18.3.1), so the server keeps `useEffect`, which never runs there either.
- **If wrong:** a child's own layout effect runs before its parent's, so an end it causes synchronously is still not
  heard by a `useUpload` in the parent. `cloudrop/react` grows by a few bytes.
- **Status:** in force. `src/react/use-upload-callbacks.test.ts` ("calls a hook that has committed for an end before
  React runs its passive effects"): red before the fix, and red again with `useEffect` put back as a fault probe.
- **Visible in:** `src/react/use-upload.ts`, `src/react/use-upload-callbacks.test.ts`, `docs/guide/react.md` (Only
  while mounted), `docs/decisions/m12-hooks.md` (M12-H1).

### M12-R60: `BUCKET_BLOCKED` only after the whole budget, and retryable (amends M12-E7)

- **Decision:** `nextStep` in `src/client/parts.ts` decides `BUCKET_BLOCKED` only once a part or a single `PUT` has
  used its six attempts (`MAX_ATTEMPTS`), and only when every attempt ended blocked: XHR `onerror` with no upload
  progress while `navigator.onLine === true` (checked at each attempt), with at least one fresh 2xx `/sign` between
  attempts. Any attempt with progress, a readable answer, a stall, an offline page or a failed `/sign` ends the file
  as before, with the last attempt's error (`NETWORK_ERROR` for an opaque one). `BUCKET_BLOCKED` is now
  `retryable: true` and stays in `KEEPS_TICKET`, so `retry()` reuses the ticket once the rule, the network or the
  credentials are fixed. Being retryable, a multipart `BUCKET_BLOCKED` file is now given up like a network failure
  (`giveUp`, `M4-F1`): a failure of `upload()` and `pagehide` keep its resume record and send no `/abort`, where the
  non-retryable code of `M12-E7` dropped the record and sent one. Its message names the CORS rule and `npx cloudrop
  doctor --origin <origin>`, and the look-alikes: a firewall or extension, a connection that keeps dropping, and a bad
  signature (wrong credentials, or the server's clock off), which some browsers report the same way. It contains no
  URL.
- **Why:** final review, finding 1 (controller's ruling, binding). Firefox reports no upload progress for a body sent
  quickly whose answer is an error, so the progress signal cannot tell a blocked request from a sent one. Measured
  (`r2-spike-findings.md`, "Upload progress in Firefox and WebKit, 2026-11-22"): under the two-attempt rule, Firefox 157
  ended a dropped connection `BUCKET_BLOCKED`, not retryable, after 163 ms and two attempts, and a bad signature after
  346 ms, where Chromium and WebKit got six attempts and `NETWORK_ERROR`; on this branch's lane, Firefox 159 ends a
  20 MiB file whose part 2 is reset after 1 MiB `BUCKET_BLOCKED`. Waiting for the budget gives up only the fast
  detection: a transient failure in Firefox gets the same six attempts as anywhere, and a persistent one stays
  retryable, so an app that shows Retry for retryable errors keeps working.
- **If wrong:** a CORS miss is reported after up to about 15 s of waits instead of about one round trip; the code and
  the message still name the cause. In Firefox a persistent dropped connection or a bad signature ends
  `BUCKET_BLOCKED`, not `NETWORK_ERROR`; both are retryable and keep the ticket.
- **Status:** in force. `src/client/bucket-blocked.test.ts`: the Firefox pattern (the body reaches the bucket, then
  `onerror` without progress, six times) ends `BUCKET_BLOCKED`, retryable; silent failures with one attempt with
  progress between them, a readable `503` among them, a page offline at one attempt only, and a failed `/sign` end
  `NETWORK_ERROR`. Red on the old rule (six rows), green after; a fault probe that kept only the last attempt's mark
  turned four `NETWORK_ERROR` rows red. `src/client/persist.test.ts` ("pagehide gives a BUCKET_BLOCKED file up without
  an /abort"): the record stays and nothing is sent, red with `retryable: false`.
- **Visible in:** `src/client/parts.ts`, `src/client/failures.ts`, `src/client/transport.ts`,
  `src/client/retry-step.ts`, `src/testing/fake-xhr.ts` (`lose()`), `src/client/bucket-blocked.test.ts`,
  `src/client/persist.test.ts`, `docs/guide/resume.md`,
  `examples/next/app/bucket-faults.chaos.browser.test.ts`, `examples/next/app/lab-blocked.browser.test.ts`,
  `examples/next/app/lab/fault-panel.tsx`, `examples/next/README.md`, `docs/guide/errors.md`,
  `docs/guide/troubleshooting.md`, `docs/guide/react.md`, `docs/guide/client.md`, `docs/guide/bucket-setup.md`,
  `docs/guide/stability.md`, `README.md`, `packages/cloudrop/README.md`, `packages/cloudrop/CHANGELOG.md`, spec 1.0
  §2d, base spec §6.2, `M12-E7`, `M12-R40`.

### M12-R61: the browser lane runs the bucket-fault rows on Firefox and WebKit too

- **Decision:** `examples/next/playwright.config.ts` adds the projects `firefox` and `webkit` to the stateless pass,
  limited to `app/bucket-faults.chaos.browser.test.ts` and `app/lab-blocked.browser.test.ts`; a row tagged `@cdp`
  (throttled through Chrome's DevTools Protocol) runs on Chromium alone. CI's `browser` job installs Firefox and
  WebKit with `--with-deps`. Two rows state the engines' measured differences: part 2 reset six times ends
  `BUCKET_BLOCKED` in Firefox and `NETWORK_ERROR` elsewhere, and a single PUT reset twice before its answer shows one
  network error in Chromium and Firefox (each resends once by itself) and two in WebKit. The reset row no longer caps
  how many times the browser itself resent an attempt (Firefox: 13 arrivals for six attempts); the client's six
  attempts are pinned by the request rows.
- **Why:** spec 1.0 §2d's gate "Firefox and Safari, measured in the browser lane before release". The rule reads the
  engine's progress events, so the engines that differ must run its rows.
- **If wrong:** the browser job takes about two minutes longer; an engine-specific failure in another file stays
  unseen until that file joins the list.
- **Status:** in force.
- **Visible in:** `examples/next/playwright.config.ts`, `.github/workflows/ci.yml` (`browser`),
  `examples/next/app/bucket-faults.chaos.browser.test.ts`, `examples/next/README.md`, `AGENTS.md` (Gates).

### M12-R62: the `cloudrop + adapters/sql (bundled)` ceiling is 60 kB (amends M12-P1)

- **Decision:** the budget's gzip ceiling in `scripts/size-limit.config.ts` goes from 50 kB to 60 kB, and the
  changelog and the config comment give the sizes measured on this branch instead of Task 2's.
- **Why:** final review, finding 6, and the controller's ruling under the owner's standing policy that ceilings never
  block work (`M12-P1`); the owner did not set this number. The measured size grew from 33.61 kB at Task 2 to 46.4 kB at
  `b8491f4b`, 7 % under the old ceiling, against the 25 % headroom `M12-P1` meant; the published "33.61 kB instead of
  33.13 kB" was false by 13 kB.
- **If wrong:** a slow growth of the server-with-store bundle passes unnoticed longer; the release summary reports the
  measured size.
- **Status:** in force.
- **Visible in:** `scripts/size-limit.config.ts`, `packages/cloudrop/CHANGELOG.md`, `docs/decisions/m12-policy.md`
  (`M12-P1`).

### M12-R63: a route's name must not be another route's first prefix folder (amends M12-A10)

- **Decision:** the `prefix` row of `docs/guide/server.md` says that a route's name must not be the first folder of
  another route's `prefix`, with the example of routes `users` and `avatar` (prefix `users/42/avatars`), where
  `deletePrefix("users/")` empties both. `M12-A10`'s "Why" says so too. No behaviour changes.
- **Why:** final review, finding 8 (the second half of the area review's B2). `M12-R6` covered `erase.prefixes`;
  `M12-A10` still promised that a whole route can be emptied by prefix without that condition.
- **If wrong:** none; the guide matches the code.
- **Status:** in force.
- **Visible in:** `docs/guide/server.md` (route options), `docs/decisions/m12-api.md` (`M12-A10`).

### M12-R64: the guides and the upgrade notes corrected after the final review

- **Decision:** docs only, no behaviour changes:
  - `server.md` and `store.md`: an error from a cloudrop older than 1.0 is answered `500` or counted a failure; a
    second 1.x copy's is recognised (findings 2 and 3, after `M12-R2`);
  - the changelog's stale first `M12-E4` entry is deleted (finding 4);
  - the upgrade notes name `Record<CloudropErrorCode, string>`, exported by `cloudrop` and `cloudrop/client`, not the
    internal `ClientErrorCode` (finding 5; `M12-R24` is amended so);
  - "Before" of the `FileRecordStatus` note no longer names `cloudrop/store`, which 0.6.0 did not have (finding 7);
  - `store.md`: a `transaction: true` store must be copied with spread (finding 9);
  - both READMEs: "without one, uploads fail, usually with `BUCKET_BLOCKED`" (finding 10);
  - the changelog's split "Fixed" list and its 127-column line (finding 12).
- **Why:** final review of `release-1.0` at `b8491f4b`.
- **If wrong:** none; the docs match the code and the 0.6.0 API reports.
- **Status:** in force.
- **Visible in:** `docs/guide/server.md`, `docs/guide/store.md`, `README.md`, `packages/cloudrop/README.md`,
  `packages/cloudrop/CHANGELOG.md`, `M12-R24`.
