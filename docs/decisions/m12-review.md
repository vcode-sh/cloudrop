# M12-R: the review of every area before 1.0.0

Findings of the area-by-area review before 1.0.0 and what was done with each, designed in
`docs/superpowers/specs/2026-11-22-1.0.0-design.md` §10. A finding is proven with a failing test or a measurement before
it is fixed.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M12-R40: `BUCKET_BLOCKED` only where the runtime says it is online (amends M12-E7)

- **Decision:** the fourth condition of the rule in `nextStep` (`src/client/parts.ts`) is `navigator.onLine === true`,
  not `!== false`. Every browser on the floor (Chrome 103, Firefox 100, Safari 16) reports it, in a page and in a
  worker; React Native and Node have a `navigator` without `onLine`, so there a PUT refused twice before any byte left
  keeps the six attempts and ends `NETWORK_ERROR`.
- **Why:** finding D1 of the review (area D). Spec 1.0 §2d says the rule runs only in a browser, but the only gate was a
  global `XMLHttpRequest`, which React Native has. A probe with React Native's `navigator` (`{ product: "ReactNative" }`)
  and every PUT failing before progress ended in `BUCKET_BLOCKED` after two PUTs: a DNS or TLS failure of the storage
  host, or a mobile network handover, would have shown a non-retryable CORS message in an app that has no CORS. The
  `onLine` test needs no new API and no origin comparison.
- **If wrong:** a browser-like runtime that has CORS but no `navigator.onLine` reports a blocked bucket as
  `NETWORK_ERROR` after about 15 s, as before 1.0; none is known.
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
