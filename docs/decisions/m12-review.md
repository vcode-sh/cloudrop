# M12-R: the review of every area before 1.0.0

Findings of the area-by-area review before 1.0.0 and what was done with each, designed in
`docs/superpowers/specs/2026-11-22-1.0.0-design.md` §10. A finding is proven with a failing test or a measurement before
it is fixed.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

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
