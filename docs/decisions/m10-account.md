# M10-A: the account guard and error copy

Rulings for the client's `account` option, the server's check and the React guide's error copy, designed in
`docs/superpowers/specs/2026-11-21-0.4.0-design.md`. Entries continue from 1.

### M10-A1: `account`, sent with `/upload` only as `x-cloudrop-account`

- **Decision:** `ClientOptions.account` is a string or a function, possibly async, returning a string, `null` or
  `undefined`. Its value goes with every `/upload`, retries included, as the header `x-cloudrop-account`, and with no
  other request: not `/sign`, `/complete`, `/abort` or a bucket `PUT`. It is added after the `headers` option's
  headers, so it replaces an `x-cloudrop-account` among them. A string of more than 255 characters, one that is not
  well-formed Unicode, or a value that is neither a string nor a function throws `INVALID_CONFIG` when the client is
  created. The header name is `ACCOUNT_HEADER` in `src/protocol/types.ts`, shared by client and server and not exported.
- **Why:** the pilot sent the user's id by hand as `x-upload-user` and compared it in `authorize`
  (`vstack/packages/storage/src/upload-policy.ts`). `/upload` is the only request whose owner comes from the session;
  every later request carries the upload token, which names the owner `/upload` saw, so a check there would refuse
  nothing the token does not already settle, and would block the `/abort`s a sign-out sends. 255 is `owner()`'s own
  bound (`MAX_OWNER_LENGTH`).
- **If wrong:** an app whose `owner` is not the id the page knows (a tenant id, say) must pass that value instead; the
  client guide says to pass what `owner` returns.
- **Status:** in force. Contract: `src/client/endpoints-account.test.ts`.
- **Visible in:** `src/client/options.ts`, `src/client/endpoints.ts`, `src/protocol/types.ts`, `docs/guide/client.md`.

### M10-A2: the value is percent-encoded

- **Decision:** the client sends `encodeURIComponent(account)`; the server compares `decodeURIComponent(header)` with
  `owner()`'s answer. A header that does not decode differs from every owner.
- **Why:** a header value cannot carry characters above U+00FF (`fetch` throws) and loses leading and trailing spaces,
  while an owner is any string of 1 to 255 characters without NUL. Encoding makes every owner round-trip exactly; ids
  made of letters, digits and `-` go unchanged.
- **If wrong:** a hand-written client that sends the raw id is refused for an id with spaces, `%` or non-ASCII
  characters. The client guide documents the encoding.
- **Status:** in force. The unit test "the same account, percent-encoded as the client sends it" and the client's
  end-to-end row with `"Zoë 42/ü"` prove the pair agrees.
- **Visible in:** `src/client/endpoints.ts`, `src/server/upload-request.ts` (`accountChanged`).

### M10-A3: `""` is nobody; `null` and `undefined` send nothing

- **Decision:** `account: ""` sends an empty header, which no owner equals: on a route with a store and `owner`, an
  upload whose session has an owner is refused. A function's `null` or `undefined` sends no header, and the upload is
  checked as without the option.
- **Why:** the React recipe creates a client for `""` while signed out (`uploadsFor("")`), so passing the same id as
  `account` makes a signed-out page refuse an upload that a sign-in in another tab would otherwise give to the new
  user. A function that cannot tell yet (a session still loading) needs a way to opt out per request.
- **If wrong:** a page that passes `""` while its session hook is still loading refuses uploads of a signed-in user;
  its fix is to pass `undefined` until it knows.
- **Status:** in force.
- **Visible in:** `src/client/endpoints.ts` (`accountHeader`), `docs/guide/client.md`.

### M10-A4: an `account` function that fails fails its `/upload` unsent, as `NETWORK_ERROR`

- **Decision:** as `M8-L6` for `headers`: when the function throws, rejects, returns neither a valid string nor
  `null`/`undefined`, or has not settled when the request's timeout or the caller's signal fires, the `/upload` is not
  sent. A cancel answers `ABORTED`; anything else answers `NETWORK_ERROR`, retryable, with the message "The account
  option gave no account for a request to the upload server, so it was not sent. Check the function passed as account,
  then try again." and the function's error as `cause`.
- **Why:** one rule for both per-request options; a function that reads a session over the network fails the way the
  network does, and a bug fails after the retry budget with a message that names the option. Sending the `/upload`
  without the header instead would silently drop the guard.
- **If wrong:** a function that always returns a bad value costs the retry budget before the file fails.
- **Status:** in force.
- **Visible in:** `src/client/endpoints.ts`, `src/client/failures.ts` (`accountFailed`), `docs/guide/errors.md`.

### M10-A5: the server refuses the whole `/upload` with `ACCOUNT_CHANGED`, 409, not retryable

- **Decision:** in `handleUpload`, right after `owner()` is read and before any plugin's `beforeUpload`, the quota,
  the reservation or a storage call: when the route has a store and `owner`, `owner()` answered a string, and the
  request carries the header, a different decoded value refuses the whole request with `ACCOUNT_CHANGED` (HTTP 409,
  not retryable): "The account signed in on this site changed since this page was loaded, so the upload was not
  started. Reload the page, then upload the file again." Without the header, on a route without `owner`, on a server
  without a store, or when `owner()` answers `null`, the header is ignored and the upload is checked as before.
- **Why:** a refusal of the whole request leaves no file of the page's batch to land on the other account, and it
  comes before anything is reserved, so nothing needs releasing. Ignoring a missing header keeps an older page working
  during a deploy (design §4). The comparison needs an owner a store records; without one the server has no notion of
  whose file it is. `owner()` is read only when at least one file passed the route's policy, so a request whose every
  file was refused is answered with those refusals; nothing of it could land anywhere. Not retryable: a retry sends
  the same account and is refused again; only a reload, which shows the account signed in now, helps. 409, as the
  request conflicts with the server's state, not with the user's rights (403 would read as `FORBIDDEN`).
- **If wrong:** an app whose `owner()` answers differently for the same person over time (a tenant switch inside one
  session) refuses uploads after the switch until a reload; that is the guard's purpose.
- **Status:** in force. Contract: `src/server/upload-account.test.ts`; in a real browser, the `examples/vite-react`
  row "after a sign-in as someone else in another tab…".
- **Visible in:** `src/server/upload.ts`, `src/server/upload-request.ts`, `src/server/http.ts`, `src/errors.ts`,
  `docs/guide/errors.md`.

### M10-A6: the handler's preflight already allows the header; no CORS change

- **Decision:** the handler's preflight echoes the headers a trusted origin asks for (`preflight` in
  `src/server/http.ts`), so `x-cloudrop-account` is allowed without a change. The CORS unit test asks for it beside
  `authorization`. An app whose framework answers preflights itself must allow it; the client guide says so.
- **Why:** an allow list in the handler would have to name every header an app adds through `headers`; the handler
  echoes them only to trusted origins, and refuses every other preflight.
- **If wrong:** a proxy that strips unknown request headers drops the guard silently: the request then counts as an
  older page's.
- **Status:** in force. Contract: `src/server/handler-cors.test.ts`; the browser pass of `examples/vite-react`, whose
  page is on another origin than its API, sends the header through the real preflight.
- **Visible in:** `src/server/http.ts`, `docs/guide/client.md`.

### M10-A7: no React code; the recipe passes `account`

- **Decision:** `createUploadHooks()` takes `ClientOptions`, so `account` passes through unchanged and needs no code.
  The React guide's [Signed-in users](../guide/react.md#signed-in-users) recipe creates each user's client with
  `{ namespace: userId, account: userId }`, and `examples/vite-react` does the same against the Hono API, whose routes
  return the user's id as `owner`. The client does not close itself on `ACCOUNT_CHANGED`.
- **Why:** the per-user client already knows its user; one more option there replaces the pilot's hand-written header
  and authorize check. Closing on the first refusal would hide the message the person needs, and `useCloseOtherUsers`
  closes the client once the page's session hook sees the change.
- **If wrong:** an app with one client for everyone must pass a function that returns the user this page shows.
- **Status:** in force.
- **Visible in:** `docs/guide/react.md`, `examples/vite-react/src/lib/upload.ts`.

### M10-A8: what the React guide tells an app to show for `ABORTED`, `CLIENT_CLOSED` and `ACCOUNT_CHANGED`

- **Decision:** the React guide's [Errors to show](../guide/react.md#errors-to-show) says: show a failed file's
  message whole; for `ABORTED` nothing more (the row's `aborted` status already says Cancelled); for `CLIENT_CLOSED`
  no error and no Retry (no row exists; the page is about to show the next user); for `ACCOUNT_CHANGED` the message
  with a Reload button instead of Retry. `examples/vite-react`'s row shows Reload in place of Retry for that code.
- **Why:** the pilot found that reporting a cancel as an error, and a closed client's refusal as a failure, misled
  people at sign-out (`vstack/apps/web/src/lib/use-upload-error.ts`), and it had to map its own `FORBIDDEN` to an
  account message, which `ACCOUNT_CHANGED` now carries.
- **If wrong:** nothing breaks; an app that shows every error still shows correct messages.
- **Status:** in force.
- **Visible in:** `docs/guide/react.md`, `examples/vite-react/src/components/upload-row.tsx`.
