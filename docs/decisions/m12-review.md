# M12-R: the review of every area before 1.0.0

Findings of the area-by-area review before 1.0.0 and what was done with each, designed in
`docs/superpowers/specs/2026-11-22-1.0.0-design.md` §10. A finding is proven with a failing test or a measurement before
it is fixed.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

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
