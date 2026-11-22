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
  recorded wait, so `parts`, `file` and `cause` never leave the server. A `RATE_LIMITED` is always rebuilt retryable
  (coordinator's ruling, fix round 1): one built by hand without `retryable` would otherwise reach the client as a
  refusal it never retries, which contradicts the code. Any other code is logged as `cloudrop: authorize returned
  <CODE>, which /upload cannot send. Return one of …` (`a plugin's beforeUpload` for a plugin) and answered as the
  generic, non-retryable `SERVER_ERROR`. A returned refusal logs nothing. An `Error` named `CloudropError` that is not
  this copy's class throws the "Install cloudrop once" `TypeError`, worded as plugins already are, and the other
  non-plain-object `TypeError` now names a `CloudropError` among the answers. The handler's generic "cannot send" log
  stays for the other endpoints; its unit rows now refuse at `/complete`.
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
  second file would split one concept), re-exported from `route.ts`. It returns a retryable `RATE_LIMITED` with a
  recorded wait of `min(86400, max(1, ceil(seconds)))` seconds, which the handler sends as `Retry-After`: the cap is
  the header's (`M12-E3`), applied here so the message says the wait the header sends. The default message is
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
- **Status:** in force. `src/server/upload-authorize.test.ts`: `rateLimited(1e30)` answers `Retry-After: 86400` and
  "Try again in 86400 seconds." (the message said `1e+30 seconds` before the cap moved into `rateLimited`).
- **Visible in:** `src/server/refusal.ts`, `src/retry-after.ts`, `src/server/http.ts`, `src/index.ts`,
  `src/storage/presets.test.ts`, `docs/guide/server.md`.

### M12-E3: `RATE_LIMITED` is 429 from every source

- **Decision:** the status table in `src/server/http.ts` maps `RATE_LIMITED` to 429, so storage throttling at
  `/upload`, `/sign` or `/complete` answers 429 too, not 503. `errorResponse` sets `Retry-After` from the error's
  recorded wait, in whole seconds rounded up and at most 86,400 (a day), always written as a plain integer, and
  exposes it to a cross-origin page (`access-control-expose-headers: Retry-After`), as it did for the busy answer. The
  S3 transport passes a failed answer's `retry-after` header to `storageError`, which records it as the wait of a
  retryable error (429, 503, 5xx), and `storageFailure` keeps it, so a throttled `/complete` answers 429 with the
  bucket's `Retry-After`. The chaos row `a CompleteMultipartUpload the storage answers 503` expects
  `POST /complete 429`.
- **Why:** spec 1.0 §2a: one status per code, and a 503 can make a load balancer eject a healthy app server. The cap:
  without it `String()` writes a wait of 10^21 seconds or more in exponent form (`1e+21`), which is no `delay-seconds`
  value (RFC 9110 §10.2.3), and a mistaken wait could park a client for good. A day is far past the client's
  20-second cap (`M12-E4`), so no honest wait is cut short in effect.
- **If wrong:** a proxy or monitor that alerted on 503 from the upload server no longer sees storage throttling there;
  the server log still records each storage failure.
- **Status:** in force.
- **Visible in:** `src/server/http.ts`, `src/storage/storage-error.ts`, `src/storage/s3/transport.ts`,
  `src/server/upload-authorize.test.ts`, `src/storage/storage-error.test.ts`,
  `src/chaos/server-faults.chaos.integration.test.ts`, `docs/guide/errors.md`, the changelog's "Upgrading to 1.0".

### M12-E4: the client stops on a wait longer than its backoff cap

- **Decision:** `waitsTooLong(error)` in `src/client/retry.ts` holds when the error's recorded wait exceeds the
  20-second backoff cap. `withRetry` then returns the error instead of waiting, and so does the per-file re-ask in
  `launch.ts`, and so does a part's `/sign` (`M12-R41`): the file fails with the retryable error (`RATE_LIMITED` from
  `rateLimited(600)`), and the app's `retry()` asks again. Bucket PUTs keep their capped backoff.
- **Why:** spec 1.0 §2a: `rateLimited(600)` would otherwise be retried five times, 20 seconds apart, against a server
  that said ten minutes.
- **If wrong:** a page that left uploads to the client's retries alone now shows a retryable failure for a long wait.
  Only `rateLimited()`'s default message gives the wait ("Try again in 600 seconds."); a proxy's `429`, storage
  throttling and a custom message say "Try again in a moment" or what the app wrote. `error.retryAfter` carries the
  wait in seconds whenever the answer had `Retry-After`, so the app can say when `retry()` may pass (`M12-R70`, which
  supersedes `M12-R42`).
- **Status:** in force.
- **Visible in:** `src/client/retry.ts`, `src/client/launch.ts`, `src/client/parts.ts`,
  `src/client/upload-rate-limited.test.ts`, `docs/guide/client.md`.

### M12-E5: the 200 of `/upload` carries the bucket's `Retry-After`

- **Decision:** each rejected ticket keeps the wait its storage failure recorded (`rejected()` in
  `src/server/upload.ts`, through `waitAtLeast` on the ticket object), `handleUpload` records the longest of them on
  its answer, and the handler sends it on the 200 as `Retry-After`, in whole seconds rounded up and exposed
  cross-origin, through the same `retryAfterHeaders` as an error answer. Only a retryable storage failure carries a
  wait (`storageError`, M12-E3), so the longest wait is the longest among the retryable rejected tickets. There is no
  wire change and no server cap: the client already applies the header to each refused ticket
  (`client/endpoints.ts`), and M12-E4 decides whether it waits. `EndpointHandler` answers `Result<object>`, which
  every endpoint already did, so the handler can read a wait off any answer.
- **Why:** spec 1.0 §2b closes the plans README's "Chaos plan follow-ups" debt: nothing in `storage/` read the header.
  The chaos row that faults `CreateMultipartUpload` with `Retry-After: 3` proves the second `/upload` waits for it
  on RustFS. The README entry is removed in Task 12.
- **If wrong:** a throttled bucket that asks for a long wait now holds a file's re-ask that long, or fails it for
  `retry()` past 20 seconds; before, the client hammered the bucket through the server.
- **Status:** in force.
- **Visible in:** `src/server/upload.ts`, `src/server/handler.ts`, `src/server/http.ts`,
  `src/server/upload-storage.test.ts`, `src/client/upload-rate-limited.test.ts`,
  `src/chaos/server-faults.chaos.integration.test.ts`.

### M12-E6: a content refusal names its kind (amends M11-K3 and M11-K4)

- **Decision:** `ContentRefusal` gains `kind?: RefusedKind`, `"web-page" | "program" | "installer" | "script" | "svg" |
  "xml" | "denied"`, exported from `cloudrop` and `cloudrop/client`. `contentChecks()` sets it only with
  `reason: "refused"`, at its three refusal sites, from `kindOf` over the lists `content-checks.ts` already holds: web
  pages (HTML's names, the unknown types, `multipart/x-mixed-replace`), programs (Windows, Linux, macOS), installers,
  scripts (JavaScript, shell, VBScript, and the sniffer's script names), then `image/svg+xml` as `svg`, any other XML
  type as `xml`, and `denied` for the rest. A kind wins over `denied`, so `deny: ["text/html"]` still says `web-page`.
  At `/complete` the kind is the first judged type that was refused, so an untyped WebM file refused by
  `deny: ["video/*"]` says `denied`. `REFUSED` is built from the same lists, unchanged in members. The server's
  `errorBody` and the client's `readContent` copy `kind` only when it is in the closed set (`isRefusedKind`, in
  `src/protocol/types.ts`, a record so a new kind that is not listed fails to compile) and the reason is "refused";
  otherwise the kind alone is dropped and the rest of `content` kept. This amends M11-K3 (the wire carries a fourth
  field) and M11-K4 (the client reads it by the same rule).
- **Why:** spec 1.0 §2c: the pilot re-derived "program", "script" and "web page" from MIME types with a copy of the
  plugin's private lists, which had already drifted.
- **If wrong:** a new refused category needs a new member, a minor change for the type; until a client knows it, the
  client drops it and the page falls back to `message`, as an older client does with the whole field.
- **Status:** in force.
- **Visible in:** `src/errors.ts`, `src/protocol/types.ts`, `src/plugins/content-checks.ts`, `src/server/http.ts`,
  `src/client/answers.ts`, `src/index.ts`, `src/client.ts`, `src/plugins/content-checks*.test.ts`,
  `src/server/handler-failures.test.ts`, `src/client/content-refusal.test.ts`, `docs/guide/plugins.md`,
  `docs/guide/errors.md`.

### M12-E7: `BUCKET_BLOCKED` when the browser sends no byte to the bucket while the upload server answers

- **Decision (amended by `M12-R60`):** a part, or a single `PUT`, that has used its six attempts fails with the client
  code `BUCKET_BLOCKED`, retryable, when every attempt of it ended in XHR `onerror` with no upload progress
  (`loaded > 0` never seen) while `navigator.onLine` was `true`, which a browser reports and React Native does not
  (`M12-R40`), and a `/sign` of that part answered 2xx between two attempts (a later attempt used a URL the server had
  just signed). As first decided, two such attempts in a row ended the file at once, not retryable; Firefox made that
  unsafe (`M12-R60`). Only on the XHR path: with a `fetch` option, or where there is no XMLHttpRequest, nothing
  changes. cloudrop's own stall abort and `ontimeout` are never counted, nor is an XHR whose `open()` or `send()`
  throws, nor an empty body: a 0-byte file has no byte to report, so a bad signature or an expired URL on it would look
  blocked, and it keeps the six attempts and `NETWORK_ERROR`. The code is in `ClientErrorCode`, so the server's status
  table cannot hold it, and in `KEEPS_TICKET`: `retry()` after the rule is fixed sends only what had not landed. The
  message names the CORS rule and `npx cloudrop doctor --origin <origin>`, and says that a firewall or extension, a
  connection that keeps dropping and a bad signature look the same in some browsers.
- **Why:** spec 1.0 §2d. A missing or wrong CORS rule is the most common newcomer mistake, and it showed as a
  retryable `NETWORK_ERROR` after about 15 s. A rule that misses the origin or a signed header fails the preflight, so
  the body never leaves. Measured on R2 from Chromium 159 (`r2-spike-findings.md`, "Missing CORS origin and bad
  signature from a browser, 2026-11-22"): a page on an origin the rule does not list got `403` on each preflight, no
  upload progress event, and ended `BUCKET_BLOCKED` in 154 ms (1 MiB) and 456 ms (14 B); a bad signature on a
  14-byte body reported `upload.progress` of 14 before its `onerror`, so it keeps the old six attempts and
  `NETWORK_ERROR`. No condition on the time to the first failure is needed, so there is no `M12-E8`.
- **False positives:** a firewall, proxy or extension that blocks only the storage host fires the rule, correctly:
  retrying cannot help, and the message names that cause. Since `M12-R60` the rule fires only after the six attempts,
  each blocked, so a transient failure gets the whole budget as anywhere, and the code is retryable with the ticket
  kept. What still fires it, while a later retry might pass, is a failure every attempt reports without progress: a
  bucket host that refuses connections outright, and in Firefox, which reports no upload progress for a body sent
  quickly whose answer is an error, a connection that keeps dropping or a bad signature. The browser lane measured it
  (`r2-spike-findings.md`, "Upload progress in Firefox and WebKit, 2026-11-22"): part 2 of a 20 MiB file, reset after
  1 MiB of its 8 MiB body on every attempt, ends `BUCKET_BLOCKED` in Firefox and `NETWORK_ERROR` in Chromium and
  WebKit, which report the first MiB; the lab's network-error faults report half the body as sent before the error, so
  they keep `NETWORK_ERROR` everywhere. A separate held fault, "Block every bucket PUT as a CORS rule that misses this
  page would", sends no byte and ends in `BUCKET_BLOCKED` after the six attempts (coordinator's ruling, fix round 1;
  `M12-R60`).
- **If wrong:** a page whose bucket is reachable but flaky in that way gets `BUCKET_BLOCKED` where `NETWORK_ERROR` was
  meant; since `M12-R60` it has had the same six attempts and stays retryable, with the same ticket. Measured on
  Firefox and WebKit on 2026-11-22 (`r2-spike-findings.md`, "Upload progress in Firefox and WebKit, 2026-11-22"):
  Firefox reports no progress for a body sent quickly whose answer is an error, which `M12-R60` answers.
- **Status:** in force, amended by `M12-R40` and `M12-R60`. Closes the plans README's open decision "Unreadable R2
  refusals" for the CORS case; a bad-signature `403` stays a `NETWORK_ERROR` in Chromium and WebKit.
- **Visible in:** `src/client/transport.ts`, `src/client/bucket.ts`, `src/client/parts.ts`, `src/client/failures.ts`,
  `src/client/retry-step.ts`, `src/errors.ts`, `src/client/bucket-blocked.test.ts`,
  `examples/next/app/bucket-faults.chaos.browser.test.ts`, `examples/next/app/lab-blocked.browser.test.ts`,
  `examples/next/app/lab/lab-xhr.ts`, `examples/next/app/lab/lab-fetch.ts`, `examples/next/app/lab/fault-panel.tsx`,
  `docs/guide/errors.md`, `docs/guide/troubleshooting.md`, `docs/guide/client.md`, base spec §6.2.
