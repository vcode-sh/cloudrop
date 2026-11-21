# M11-D: what a deletion answers, and a hook that refuses

Rulings for `api.deleteFile`'s answer and `onDelete` refusals, designed in `docs/superpowers/specs/2026-11-21-0.6.0-design.md`.
Each entry: Decision, Why, If wrong, Status, Visible in.

### M11-D1: `api.deleteFile` answers `{ id, deleted, cleaned }`

- **Decision:** `deleteFile` answers `DeletedFile`, exported from `cloudrop`: `deleted` is true when this call moved
  the row from `completed` to `deleted` (the store's `end` answered `changed`), false when the row was `deleted`
  already, by an earlier call, a replacement or `eraseOwner`; `cleaned` is true when the row is marked cleaned, by this
  call or before, and false while the sweep still has to check the bucket again. A row cleaned before is answered with
  no storage call. `NOT_FOUND` as before.
- **Why:** the pilot could not tell whether its own call deleted the file (`{ id }` both times), so it passed a
  mutable slot through `context` and read the row again. `changed` is the store's own answer under the row's lock, so
  of two calls at once exactly one answers `deleted: true`. `cleaned` says whether a `PUT` with one of the file's URLs
  can still put the object back: within 1 hour 15 minutes of the completion it is false on every call.
- **If wrong:** a caller that needs the row reads `api.file(id)`; the two fields are derived from it.
- **Status:** in force.
- **Visible in:** `src/server/store-api.ts`, `src/index.ts`, `src/server/store-api.test.ts`,
  `docs/guide/store.md#what-deletefile-answers`.

### M11-D2: once the row is deleted, `deleteFile` succeeds whatever fails after

- **Decision:** A failure after the row is `deleted`, by this call or an earlier one, answers success with
  `cleaned: false`: a storage failure while removing the object, logged once per call as `cloudrop: could not remove
  the deleted file <id> from the bucket. The sweep removes it later.`, and also a store failure while marking the row
  cleaned, which the store call logs (`the store failed to mark file <id> cleaned`). A store failure before or in the
  deletion (the read, the transaction, `end`) still answers the retryable `SERVER_ERROR`, and the file is kept.
  `removeDeleted` now answers whether the row is marked cleaned and logs its own failure; a replacement's cleanup
  calls it with the word `replaced`, so its log line is the one it was.
- **Why:** the design names only the storage failure. An error for the failed mark would lose the same fact: the
  call that deleted the file would answer an error, and its retry `deleted: false`, so the caller could again not tell
  that its call deleted the file. The file is gone for its owner either way, and the sweep's cleanup pass finishes
  both kinds of leftover from the row (`deleted`, `cleaned_at` null).
- **If wrong:** a caller that must know the bucket is clean now reads `cleaned`, and calls again or waits for the
  sweep. One doubt stays, stated in the guide: after a store failure in `end` the deletion may have been committed, and
  the next call then answers `deleted: false`.
- **Status:** in force. One side effect: a replacement whose cleaned mark failed logged two lines, the store's and
  "could not remove the replaced file" with a database error; it now logs the store's line only.
- **Visible in:** `src/server/leftovers.ts`, `src/server/store-api.ts`, `src/server/store-complete.ts`,
  `src/server/store-api.test.ts`.

### M11-D3: `onDelete` refuses by returning a `CloudropError`; a throw and any other value are failures

- **Decision:** `onDelete` is typed `Awaitable<void | CloudropError>`. A returned `CloudropError` (`instanceof` the
  server's own class) is a refusal: the file is kept, nothing is logged, and the caller answers that error
  (`M11-D4`). A throw, a thrown `CloudropError` included, stays the failure of `M10-D7`. Any other returned value
  than `undefined` is treated as a throw: the log line names the route and the file as for a throw, and its error is a
  `TypeError`, "onDelete returned a value of type <typeof>. To keep the file, return a CloudropError from the same
  cloudrop the server uses; otherwise return nothing." `null`, a string and a `CloudropError` of a second installed
  copy of cloudrop are such values. With a transaction a refusal rolls the deletion's transaction back, so what the
  hook wrote through `tx` is undone.
- **Why:** a throw was the hook's only way to keep a file, and it reads as an outage: logged as an error, answered as
  a retryable `SERVER_ERROR`. Only a returned error refuses, because an error from a cloudrop call inside the hook that
  the hook rethrows must never pass for the app's own decision. A value that is neither is a bug the hook's author has
  to see: read as "go on" it would delete a file the hook meant to keep. The type is logged, never the value, which
  may hold anything. This is the rule plugins follow for `beforeUpload` and `afterVerify`.
- **If wrong:** up to 0.5.0 a returned value was ignored, so a JavaScript hook written as an arrow function without
  braces (`onDelete: ({ tx }) => tx.insert(...)`) now fails every deletion until it returns nothing. TypeScript
  already refused such a hook.
- **Status:** in force.
- **Visible in:** `src/server/route.ts`, `src/server/store-delete.ts`, `src/server/store-delete-refuse.test.ts`,
  `src/server/store-types.test.ts`, `docs/guide/store.md#refuse-a-deletion`.

### M11-D4: what each caller answers to a refusal

- **Decision:** `api.deleteFile` answers the hook's error as it is, the same object, with no field added.
  `api.eraseOwner` counts the file in the new `refused` counter of `EraseReport`; still completed, it also counts in
  `waiting`, so the run goes on with the next file and reports `done: false`. A replacing `/complete` answers the
  refusal through the handler's own rule for every error: its `code`, `message` and `retryable`, with the HTTP status of
  the code. The completion is not recorded and the previous file stays; with a transaction the completion rolls back,
  `onComplete`'s writes through `tx` included; under a lease the claim is handed back at once and `onComplete` has
  already run, as after a throw. A later `/complete` runs both hooks again.
- **Why:** each caller reports a kept file the way it reports everything else. A refusal by a code the server cannot
  send (a client's own, such as `ABORTED`) reaches the browser as the generic `SERVER_ERROR` and is logged by the
  handler, as for any endpoint: no second table of allowed codes. The guide advises a code such as `FORBIDDEN`, which
  the client treats as any refusal, and against `SERVER_ERROR`, which the client reads as a completion that may have
  finished, so it keeps the upload instead of cancelling it (`M3-H16`).
- **If wrong:** an app that wants a replacement refused without the upload being cancelled returns a retryable error;
  the client then tries `/complete` again, and the hooks run again.
- **Status:** in force.
- **Visible in:** `src/server/store-api.ts`, `src/server/erase.ts`, `src/server/store-delete.ts`
  (`beforeReplacing`), `src/server/store-delete-refuse.test.ts`, `docs/guide/store.md#refuse-a-deletion`,
  `docs/guide/errors.md`.

### M11-D5: a refusal is not read again when another deletion wins meanwhile

- **Decision:** A refusal is answered as the hook gave it, without reading the row again. When another call deletes
  the file while the hook refuses, `deleteFile` and a replacing `/complete` still answer the refusal, and with a
  transaction the refused call's writes roll back. `eraseOwner` counts the file in `refused`; `done` is computed as
  before, from `failed` and `waiting`, so a run whose refused file another call deleted and cleaned meanwhile reports
  `refused: 1` and `done: true`.
- **Why:** a throw is read again (`M10-D5`) because a hook may throw only for having lost the race, such as on a
  duplicate audit row. A refusal is a decision about this caller: a guest told "forbidden" must not be told "deleted"
  because an administrator's call came first, and the read could itself fail and turn a refusal into a `SERVER_ERROR`.
  `done` states what the store proves about the owner's rows; tying it to `refused` would report an owner with
  nothing left as not done.
- **If wrong:** a caller that needs the file's state after a refusal reads `api.file(id)`.
- **Status:** in force.
- **Visible in:** `src/server/store-delete.ts` (`afterThrow`), `src/server/store-delete-refuse.test.ts`.

### M11-D6: of two deletions at once, each answers its own hook

- **Decision:** When two calls delete one file at once and the hook refuses one and allows the other, the allowed
  call deletes the file and answers `deleted: true`, and the refused call answers its refusal, in either order and in
  both modes. With a transaction only the allowed call's writes through `tx` commit.
- **Why:** the hook decides per call (its `context` names who asked), and neither call's verdict is a fact about the
  other. It follows from `M11-D5` and from the transaction each deletion already has (`M10-D5`).
- **If wrong:** an app that wants one refusal to block every deletion of the file keeps that state in its own row,
  read under a lock in the hook.
- **Status:** in force.
- **Visible in:** `src/server/store-delete-refuse.test.ts`.

### M11-D7: without `tx`, a refusal undoes nothing the hook wrote

- **Decision:** A plain `route()` on a store with a transaction refuses like any other: the deletion's transaction
  rolls back and the caller answers the error. Its hook gets no `tx` (`M10-D4`), so what it wrote through its own
  connection stays, as under a lease. The guide says to refuse before writing.
- **Why:** cloudrop can roll back only its own transaction. Refusing the refusal for such routes would take the
  feature from every SQLite and D1 app.
- **If wrong:** the app moves the route to the store's own `route()`, whose `tx` rolls back with the refusal.
- **Status:** in force.
- **Visible in:** `src/server/store-delete-refuse.test.ts`, `docs/guide/store.md#refuse-a-deletion`.

### M11-D8: a lease-mode late replacement cannot refuse

- **Decision:** Under a lease, the `onDelete` of a file that completed while a replacement's hooks ran runs after the
  record (`M10-D6`). A `CloudropError` it returns is logged as an error, with the refusal: `cloudrop: onDelete for
  route "<route>" refused file <id> after it was replaced, so the file is deleted all the same.` The completion's
  answer stands.
- **Why:** the file is deleted in the same write that recorded the completion; nothing is left to keep. Silence would
  hide that the app's rule was not applied.
- **If wrong:** an app whose rule must hold for every replacement uses `transaction: true` on Postgres, where the
  completion rolls back and the retry lists the files again (`M10-D5`).
- **Status:** in force.
- **Visible in:** `src/server/store-delete.ts` (`afterReplacing`), `src/server/store-delete-refuse.test.ts`,
  `docs/guide/store.md#a-replacement-whose-files-change-meanwhile`.

### M11-D9: the two features cost 0.16 kB of the bundled server, and no ceiling moves

- **Decision:** No size ceiling changes. Measured gzip, 0.5.0 → this change: `cloudrop` bundled 31.32 → 31.48 kB
  (+0.5%) of 32 kB, `cloudrop` summed 42.47 → 42.66 kB; every other entry unchanged.
- **Why:** the refusal reuses what a throw already had (the rollback, the handed-back claim, the handler's status
  table), and `removeDeleted` now logs for both of its callers, which took the replacement's own log call away. What was
  added is the hook's verdict, the `refused` counter and two messages: the type of a wrongly returned value, and the
  late replacement's refusal.
- **If wrong:** the two messages are the only part that could be shortened further; each says what to do or what
  happened to the file.
- **Status:** in force.
- **Visible in:** `scripts/size-limit.config.ts` (unchanged), `bun run package:check`.
