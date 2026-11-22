# M12-E: server refusals

Rulings for how the server refuses and what a client can read from a refusal: a `CloudropError` returned from
`authorize`, `rateLimited(seconds)`, `Retry-After` on the 200 that refuses a file, `kind` on a content refusal, and
`BUCKET_BLOCKED` for a bucket the browser cannot reach, designed in `docs/superpowers/specs/2026-11-22-1.0.0-design.md`
§2.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-E1: `authorize` may refuse with a `CloudropError` of the codes `/upload` may send

- **Decision:** `RoutePolicy.authorize` returns `TAuth | Refusal | CloudropError`. A returned `CloudropError`, and a
  plugin's `beforeUpload` refusal, go through `uploadRefusal` (`src/server/refusal.ts`): a code among `UNAUTHORIZED`,
  `FORBIDDEN`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`, `TOO_MANY_FILES`,
  `INVALID_METADATA`, `INVALID_INPUT` and `SERVER_ERROR` is rebuilt from its code, message, `retryable`, `content` and
  recorded wait, so `parts`, `file` and `cause` never leave the server; any other code is logged as
  `cloudrop: authorize returned <CODE>, which /upload cannot send. Return one of …` (`a plugin's beforeUpload` for a
  plugin) and answered as the generic, non-retryable `SERVER_ERROR`. A returned refusal logs nothing. An `Error` named
  `CloudropError` that is not this copy's class throws the "Install cloudrop once" `TypeError`, worded as plugins
  already are, and the other non-plain-object `TypeError` now names a `CloudropError` among the answers. The handler's
  generic "cannot send" log stays for the other endpoints; its unit rows now refuse at `/complete`.
- **Why:** spec 1.0 §2a: the pilot smuggled `retryInSeconds` through the signed auth object and turned it into an error
  in a plugin. One table for `authorize` and `beforeUpload` keeps the two refusal points equal; rebuilding the error
  is the only way to keep `QUOTA_EXCEEDED` with `parts` from sending them, since `errorBody` copies `parts` from any
  code.
- **If wrong:** an app that needs another code at `/upload` gets a 500 with a log naming the allowed list; widening
  the list is additive.
- **Status:** in force.
- **Visible in:** `src/server/refusal.ts`, `src/server/upload.ts`, `src/server/route.ts`,
  `src/server/upload-authorize.test.ts`, `src/server/handler-failures.test.ts`, `src/server/types.test.ts`,
  `docs/guide/server.md`, `docs/guide/errors.md`.

### M12-E2: `rateLimited(seconds, message?)`

- **Decision:** a new export of `cloudrop`, beside `unauthorized` and `forbidden` in `src/server/refusal.ts` (the
  plan's `src/server/refusals.ts` was not created: an earlier 1.0 task moved those helpers to `refusal.ts`, and a
  second file would split one concept), re-exported from `route.ts`. It returns a retryable `RATE_LIMITED` with a recorded wait of
  `max(1, ceil(seconds))` seconds, which the handler sends as `Retry-After`. The default message is
  `Too many upload requests. Try again in N seconds.`, with "1 second" for a wait of one. A negative or non-finite
  `seconds` throws `TypeError: rateLimited(seconds) takes a number of seconds of 0 or more, such as 30. It got -1.`,
  which the handler logs and answers as a 500.
- **Why:** spec 1.0 §2a. A `Retry-After` must be a whole number of seconds (RFC 9110 §10.2.3), and 0 would tell a
  client to hammer the server. The wait travels on the error in a module the server and the client share
  (`src/retry-after.ts`: `waitAtLeast`, `retryAfterOf`, `parseRetryAfter`), which replaces the `BUSY` set of
  `http.ts`. Unlike the plan's sketch, `retryAfterOf` answers 0 and `parseRetryAfter` answers 0 for "no wait", as they
  did in `client/retry.ts`: `waitAtLeast` records nothing of 0 or less, so 0 and "none" are one state, and the
  client's callers kept their types.
- **If wrong:** an app that wants fractional waits sees them rounded up; a wait shorter than a second is not a use
  case `Retry-After` can express.
- **Status:** in force.
- **Visible in:** `src/server/refusal.ts`, `src/retry-after.ts`, `src/server/http.ts`, `src/index.ts`,
  `src/storage/presets.test.ts`, `docs/guide/server.md`.

### M12-E3: `RATE_LIMITED` is 429 from every source

- **Decision:** the status table in `src/server/http.ts` maps `RATE_LIMITED` to 429, so storage throttling at
  `/upload`, `/sign` or `/complete` answers 429 too, not 503. `errorResponse` sets `Retry-After` from the error's
  recorded wait, in whole seconds rounded up, and exposes it to a cross-origin page
  (`access-control-expose-headers: Retry-After`), as it did for the busy answer. The S3 transport passes a failed answer's
  `retry-after` header to `storageError`, which records it as the wait of a retryable error (429, 503, 5xx), and
  `storageFailure` keeps it, so a throttled `/complete` answers 429 with the bucket's `Retry-After`. The chaos row `a CompleteMultipartUpload the storage answers 503` expects `POST /complete 429`.
- **Why:** spec 1.0 §2a: one status per code, and a 503 can make a load balancer eject a healthy app server.
- **If wrong:** a proxy or monitor that alerted on 503 from the upload server no longer sees storage throttling there;
  the server log still records each storage failure.
- **Status:** in force.
- **Visible in:** `src/server/http.ts`, `src/storage/storage-error.ts`, `src/storage/s3/transport.ts`,
  `src/server/upload-authorize.test.ts`, `src/storage/storage-error.test.ts`,
  `src/chaos/server-faults.chaos.integration.test.ts`, `docs/guide/errors.md`, the changelog's "Upgrading to 1.0".

### M12-E4: the client stops on a wait longer than its backoff cap

- **Decision:** `waitsTooLong(error)` in `src/client/retry.ts` holds when the error's recorded wait exceeds the
  20-second backoff cap. `withRetry` then returns the error instead of waiting, and so does the per-file re-ask in
  `launch.ts`: the file fails with the retryable error (`RATE_LIMITED` from `rateLimited(600)`), and the app's
  `retry()` asks again. Bucket PUTs keep their capped backoff, as the spec names only these two.
- **Why:** spec 1.0 §2a: `rateLimited(600)` would otherwise be retried five times, 20 seconds apart, against a server
  that said ten minutes.
- **If wrong:** a page that left uploads to the client's retries alone now shows a retryable failure for a long wait;
  the error's message gives the wait.
- **Status:** in force.
- **Visible in:** `src/client/retry.ts`, `src/client/launch.ts`, `src/client/upload-rate-limited.test.ts`.
