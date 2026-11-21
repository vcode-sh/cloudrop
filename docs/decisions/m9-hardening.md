# M9-H: hardening before 0.3.0

Rulings from testing against the owner's development bucket and as a new user before 0.3.0 (2026-11-21). The upload
protocol numbers from `M9-H1`, the store and owner API from `M9-H50`, `cloudrop/testing` and the command from `M9-H100`.
The measurements behind the first range are in
[Upload protocol edge cases](../research/r2-spike-findings.md#upload-protocol-edge-cases-2026-11-21).

### M9-H1: a type with parameters is stored as its essence

- **Decision:** `/upload` reads a file's declared type up to its first `;`, trims it and lowercases it: the essence
  (`text/csv;charset=UTF-8` → `text/csv`). The route's `accept` policy, the extension check, the signed and stored
  `Content-Type` and the `inline`/`attachment` choice all use the essence. A type whose essence is not
  `type/subtype` is still refused as `FILE_TYPE_NOT_ALLOWED`. Whitespace around the essence is trimmed too, so
  `" image/png"` is now accepted as `image/png`. Amends `M2-D9`, which refused every type with parameters.
- **Why:** `Blob.type` keeps parameters, so a page that builds its upload with
  `new File([text], "export.csv", { type: "text/csv;charset=utf-8" })` was refused with "The file's type is not a
  valid MIME type. Pick another file.", which is false and leaves the user nothing to do (measured on R2 2026-11-21:
  both spellings refused before any request to the bucket). `M2-D9`'s reason still holds for the parameters
  themselves: signed and stored as part of the type, they would dodge the `inline`/`attachment` rule, so they are
  dropped, never kept.
- **If wrong:** a charset given by the page is not stored, so a text file served inline from the bucket is read with
  the browser's default charset. cloudrop serves every text type as an attachment (spec §7.5), where the charset
  matters less.
- **Status:** in force.
- **Visible in:** `src/server/accept.ts`.

### M9-H2: a bare `403` whose `Date` is more than 15 minutes off reports the clock

- **Decision:** The S3 transport reads the `Date` header of every refused answer and passes its distance from the
  request's signing time to `storageError`. A `403` without an S3 error code whose `Date` is more than 15 minutes from
  the signing time, either way (less one second, the precision of `Date`), gets the clock message of
  `RequestTimeTooSkewed` ("This server's clock is more than 15 minutes off …") instead of "Check the access key, its
  permissions and the bucket name". The code stays `STORAGE_DENIED`, and `storageCode` stays unset: the storage did
  not send one.
- **Why:** R2 refuses a request signed more than 15 minutes from its clock (measured 2026-11-21: 900 s ahead accepted,
  960 s refused; 600 s behind accepted, 900 s refused), and says so with `RequestTimeTooSkewed` in the body. An answer
  to `HEAD` has no body, so the same refusal reached `head()` as a bare `403`, indistinguishable from bad credentials
  except by its `Date` header. `head()` is the first storage call of a single-PUT `/complete`, of a single-PUT
  `/abort` and of `api.head`, so a server with a wrong clock was told to check its keys.
- **If wrong:** a storage service whose `Date` header is itself wrong by more than 15 minutes would get the clock
  message for a credentials problem; the code is the same either way.
- **Status:** in force. The fake R2 now sends `Date` on every answer and no body on `HEAD`, as R2 does.
- **Visible in:** `src/storage/storage-error.ts`, `src/storage/s3/transport.ts`, `src/testing/fake-r2.ts`.

### M9-H3: no URL is signed in a token's last 15 minutes

- **Decision:** Every URL that `/upload` and `/sign` sign ends at least 15 minutes before the token's deadline: its
  lifetime is the shorter of 15 minutes and the time left until `exp - 900`. Once that time is over, `/sign` answers
  `410 UPLOAD_EXPIRED` before anything is signed. `/complete` and `/abort` keep the token's own deadline. The client
  mirrors the margin by its own clock (`canSign` in `client/upload.ts`): `retry()` asks for a new ticket once a
  ticket can no longer sign parts still to send (a ticket whose parts all landed is kept: its `/complete` still
  works), and a resumed upload whose probe finds parts missing then starts over as a gone upload
  does (`M3-U74`) instead of failing on `/sign`.
- **Why:** measured on R2 2026-11-21: a URL's expiry is checked when the request starts, not when its body ends (a PUT
  and an UploadPart whose URL expired 3 s into an 8 s body both answered 200 and stored the bytes). Before this ruling a
  URL could be signed with seconds left on the token, so a PUT started in the token's last moments landed after the
  token's deadline: a token signed with 2 s left got its URL, the PUT answered 200, and `/complete` 2.5 s later answered
  `410 UPLOAD_EXPIRED`. The user waited for the whole upload and was told to start again, and on the stateless path the
  object stayed in the bucket with nothing to delete it (an expired token's `/abort` keeps a stored object, `M3-U94`).
  Fifteen minutes covers a default single PUT (64 MiB) at the 100 KiB/s the client's fetch timeout assumes, about 11
  minutes, and every 16 MiB part.
- **If wrong:** a PUT slower than that still lands after the deadline, as before; the resume window for sending bytes is
  now 23 hours 45 minutes instead of 24 hours. An upload paused across its token's last 15 minutes fails 15 minutes
  earlier than before, with the same `UPLOAD_EXPIRED`. A page whose clock is far behind the server's may still try to
  sign in that window and fail as before; one far ahead gives a ticket up a little early.
- **Status:** in force. The sweep's `MIN_GRACE_MS` (`src/server/leftovers.ts`) assumes no URL outlives its token; that
  still holds, with 15 minutes to spare.
- **Visible in:** `src/server/presign.ts`, `src/client/upload.ts`, `src/client/retry-file.ts`, spec §5.2,
  `docs/guide/server.md`, `docs/guide/resume.md`.

### M9-H4: a part sent to a gone upload fails as `NO_SUCH_UPLOAD`

- **Decision:** The client classifies a bucket's `404` with the S3 code `NoSuchUpload` as `NO_SUCH_UPLOAD`, not
  retryable, with the server's message "This upload was aborted or has expired. Start it again.". Every other `404` is
  still `UPLOAD_REJECTED`.
- **Why:** measured on R2 2026-11-21 (and from a browser on 2026-11-16, row N1): a part `PUT` to a multipart upload
  aborted behind the server's back answers a readable `404 NoSuchUpload`, and the following `/complete` answers
  `410 NO_SUCH_UPLOAD`. The client called the same condition `UPLOAD_REJECTED` with "The storage service refused the
  file (HTTP 404) … contact the site owner if it keeps failing", which sends the user to the site owner for an upload
  that was simply cancelled elsewhere or expired, and gives an application two codes to branch on for one cause. Both
  codes need a new ticket (`NEEDS_NEW_TICKET`), so `retry()` behaves as before.
- **If wrong:** a storage service that answers `NoSuchUpload` for another reason would get the "aborted or expired"
  message; its outcome, a new upload, is the same.
- **Status:** in force.
- **Visible in:** `src/client/bucket.ts`, `src/client/failures.ts`, `docs/guide/errors.md`.

### M9-H5: a `401` from the storage service is a credentials refusal

- **Decision:** `storageError` maps HTTP `401` to `STORAGE_DENIED` with "The storage service did not accept these
  credentials. Check the access key ID and the secret access key.", whatever its body.
- **Why:** R2 answers a request signed with an unknown access key with `401`: a bare one to `HEAD`, and
  `<Code>Unauthorized` to a `GET` (measured on the development bucket, 2026-11-21). It fell through to the generic
  "Check the key, size and headers you passed", which sent people to the object key (found while testing the command as
  a new user, `M9-H101`).
- **If wrong:** a `401` for another reason reads as a credentials problem; S3 documents `401` only for authentication.
- **Status:** in force.
- **Visible in:** `src/storage/storage-error.ts`.

### M9-H6: `deletePrefix` compares keys and the prefix in NFC

- **Decision:** `api.deletePrefix` checks each listed key against the prefix with both normalized to NFC, and deletes
  the key as listed.
- **Why:** R2 stores the NFC and NFD forms of a key as one object and lists it, under either form of a prefix, in the
  form last written (measured 2026-11-21: a key written in NFD came back in NFD for an NFC prefix). The byte check
  refused such a page as "keys outside the prefix", so a folder with an accented name could never be deleted, and an
  erasure built on it never finished. Reported by the upload-protocol pass, confirmed on the development bucket and
  after the fix (the NFD key deleted through the NFC prefix).
- **If wrong:** none known. A byte-exact store lists only keys that start with the prefix's bytes, so the normalized
  check refuses nothing it did not refuse before; a combining mark cannot join the prefix's final `/`.
- **Status:** in force.
- **Visible in:** `src/server/api.ts`.

### M9-H50: `pgExecutor` listens for the `error` event of the client it checks out

- **Decision:** `pgExecutor`'s transactions and batches attach a listener for the `error` event to the client they
  take from the pool, for as long as they hold it, and release a client that reported one as broken (the pool discards
  it). `PgPoolClient` gains the optional members `on` and `removeListener`, which node-postgres's `PoolClient` has.
- **Why:** node-postgres reports a connection that fails while its client is checked out but idle, between two
  statements, as an `error` event of that client, and the pool listens only while the client is idle in it. In
  transaction mode the client is idle for the whole of `onComplete`, so a database restart, a failover or a
  `pg_terminate_backend` during one completion stopped the app's process with an uncaught `error` (measured on
  Postgres 18 with pg 8.23: two uncaught errors, "terminating connection due to administrator command" and "Connection
  terminated unexpectedly", even with the app's `pool.on("error")` in place). With the listener, the next statement
  fails with that error, the transaction answers a retryable `SERVER_ERROR`, the claim is gone with the connection,
  and the retry completes on a new connection. postgres.js and Drizzle over postgres.js were measured in the same
  scenario and do not throw, nor does Drizzle over node-postgres from drizzle-orm 1.0.0-rc.5, which listens itself.
  drizzle-orm 0.45 (still in the supported range) checks the client out without a listener (`node-postgres/session.js`
  of 0.45.4), and cloudrop does not reach into Drizzle's session to add one: the guide tells apps on 0.45 with
  `transaction: true` to give every connection a listener through the pool's `connect` event, which a probe showed
  keeps the same termination from escaping. The guide also says what node-postgres asks of every app, a
  `pool.on("error")` listener for idle connections, without which a database restart stops the process whatever cloudrop
  does.
- **If wrong:** a custom pool whose clients lack `on` or `removeListener` is used as before, with the old risk.
- **Status:** in force. `src/adapters/sql-postgres.db.integration.test.ts` ("a connection that dies while onComplete
  runs …"), seen failing before the fix.
- **Visible in:** `src/adapters/sql/pg.ts`, `docs/guide/store.md` (the node-postgres and Drizzle sections).

### M9-H51: owners, file ids and cursors that no row can have are refused as `INVALID_INPUT`

- **Decision:** An owner or file id passed to the file API must be 1 to 255 characters without NUL (U+0000), and a
  route's `owner` callback that answers one with NUL is the route's bug (500, logged, nothing written), as an empty or
  over-long owner already was. A cursor of `api.files` or `api.sweep` must carry a time of at most
  253402300799999 (9999-12-31T23:59:59.999Z) and an id that is a valid id. All of these answer `INVALID_INPUT` before
  the store is called.
- **Why:** Postgres `text` cannot hold U+0000, and the store binds times as ISO strings, which Postgres reads only up
  to the year 9999. Measured on Postgres 18: every file API call with such a value (`file`, `deleteFile`, `usage`,
  `files`, `revokeUploads`, `eraseOwner`, `reconcile`, `sweep` with an edited cursor) failed in the database and
  answered a retryable `SERVER_ERROR`, inviting a caller to retry a request that can never succeed, and logged a
  database error. SQLite stored such owners, so the rule is the same on every backend: an owner one store could keep
  and another could not would make moving between them lose files.
- **If wrong:** an app whose owner ids contain NUL (none known; ids are user or team ids) must map them. On SQLite,
  rows an earlier version stored with such an owner are no longer reachable through the file API (`files`, `usage`,
  `revokeUploads`, `eraseOwner`, `reconcile({ owner })`); `reconcile()` without an owner still recounts them, the sweep
  still cleans them up, and the app reaches them with its own SQL.
- **Status:** in force. The `INVALID_INPUT` rows of `src/server/store-api.test.ts` and `src/server/sweep.test.ts`, and
  the NUL row of `src/server/store-upload.test.ts`, each seen failing before the fix.
- **Visible in:** `src/server/owner-files.ts`, `src/server/sweep.ts`, `src/server/store-upload.ts`,
  `docs/guide/store.md#owners-and-quota`.

### M9-H52: what the store, the sweep and the owner file API do under real latency (measured, no change)

- **Decision:** No code changes; the guide states three measured behaviours. In transaction mode, `eraseOwner` (at its
  first statement, the one `revokeUploads` runs) and the sweep wait for a completion of the same owner or file that is
  running `onComplete`, since the completion holds the file's row lock: `eraseOwner` was still waiting after 5 seconds
  and the sweep after 3, while a probe held `onComplete`, and both finished once it returned (in lease mode
  `eraseOwner` answered in 2 ms with `waiting: 1`). Two sweeps at once each count in `cleaned`
  the rows they marked, so a row both reached is counted by both (two sweeps over the same 2 rows answered
  `cleaned: 2` each). A late `PUT` with a URL of a deleted, aborted, revoked, erased or replaced file lands again on
  real R2, since its key is empty and the URL still valid, and is removed by the sweep or the next `eraseOwner` run;
  the row is marked cleaned only once its URLs and the grace have run out (`M8-A4`).
- **Why:** each was probed on the vstack-dev bucket with real Postgres 18 and SQLite
  (`docs/research/r2-spike-findings.md`, "Store, sweep and owner files under real latency, 2026-11-21"); the rest of
  that table matched the rulings.
- **If wrong:** a guide sentence is wrong; nothing else depends on it.
- **Status:** in force.
- **Visible in:** `docs/guide/store.md#oncomplete-with-tx`, `docs/guide/store.md#the-sweep`.

### M9-H100: an origin that is not exact names the one to use; a pattern is refused

- **Decision:** `--origin` still takes only an exact origin (`M9-C1`), but a value that is a URL with an origin, such as
  `http://localhost:3530/`, `HTTP://LOCALHOST:3530` or `https://app.example.com:443`, is refused with the origin to
  use: `Use http://localhost:3530: an origin is the scheme, host and port, with no path.` A value containing `*` is
  refused as a pattern ("Name each origin your pages upload from with its own --origin"); anything else keeps the
  generic message. Exit code 2 as before.
- **Why:** measured with the packed command on 2026-11-21: `https://*.example.com` passed the check
  (`new URL(value).origin === value` holds, since URL accepts `*` in a host), so `doctor` checked, and `setup --apply`
  would have written, an origin no browser sends. The trailing slash and upper case are the usual copy-paste mistakes,
  and the generic message did not say which part was wrong.
- **If wrong:** none known; S3's single-`*` origins can still be written by hand.
- **Status:** in force; amends `M9-C1`.
- **Visible in:** `packages/cloudrop/src/cli/args.ts`, `src/cli/run.test.ts`, `docs/guide/command.md`.

### M9-H101: a bucket that does not answer names the settings to check

- **Decision:** when the listing that proves the bucket (`M9-C5`) fails, `doctor` (and `setup`, `M9-H102`) adds the
  settings behind the failure to the storage's message. Unreachable: for R2 the endpoint is built from
  `CLOUDROP_R2_ACCOUNT_ID` (and `--jurisdiction`), for S3 it is `CLOUDROP_S3_ENDPOINT`. Refused with 401, or 403 other
  than `RequestTimeTooSkewed` and `ExpiredRequest`: "The storage service refused these credentials (HTTP n)", then the
  two key variables, the bucket variable, and for R2 the jurisdiction (a hint to pass `--jurisdiction`, or the one
  given); for S3 `CLOUDROP_S3_REGION`. For S3, `AuthorizationHeaderMalformed` and `PermanentRedirect` read "The bucket
  is in another region", naming `CLOUDROP_S3_REGION` and `CLOUDROP_S3_ENDPOINT`. Any other failure keeps the storage's
  message, such as "The bucket does not exist."
- **Why:** measured against `vstack-dev` with an object token on 2026-11-21: a wrong account ID printed "Could not reach
  the storage service. Check the endpoint and the network connection" after "R2 settings are present and valid", and R2
  has no endpoint setting; an unknown access key ID got R2's `401`, which the storage maps to "Check the key, size and
  headers you passed", advice about objects; a wrong secret, a wrong bucket and a wrong jurisdiction all read "Check the
  access key, its permissions and the bucket name" without a variable. A token scoped to one bucket gets `403`, not
  `NoSuchBucket`, for a bucket name it does not cover, so the hint keeps the bucket in the list.
- **If wrong:** the storage's own messages for `401` and `403` are the server's and driver's; the command's wording
  replaces them only in its own output. The two region codes are AWS's documented answers, not measured here; another
  service that answers a wrong region otherwise gets the storage's message.
- **Status:** in force; amends `M9-C2` and `M9-C5`. The storage's mapping of `401` to a generic `STORAGE_ERROR` is
  reported to the storage layer's owner, not changed here.
- **Visible in:** `src/cli/bucket-access.ts`, `src/cli/doctor.test.ts`, `docs/guide/command.md`.

### M9-H102: setup lists the bucket before blaming the token, and offers --replace only where it acts

- **Decision:** `setup --apply` and `--dry-run` list the bucket as `doctor` does, beside their reads of the current
  rules, and use the listing only when a read failed. A failed listing is reported as the one problem (`M9-H101`),
  since wrong keys, a wrong bucket or no network also fail the reads, and `--replace` could not help. A listing that
  succeeds after a refused read means the credentials may not read bucket settings: for R2 "these credentials may not
  read the bucket's CORS rules (R2 object tokens cannot)" with an R2 Admin Read & Write token as the way on, for S3 the
  setting's two permissions (`s3:GetBucketCORS` and `s3:PutBucketCORS`, or `s3:GetLifecycleConfiguration` and
  `s3:PutLifecycleConfiguration`), and `--replace` as the alternative. Any other failed read, a `501` included, no
  longer mentions `--replace`, and `--replace` no longer acts on a `501`: Wrangler's local R2, the one `501` measured,
  refuses the writes too (`M9-C4`), so replacing there only turned a refused read into a failed write. A failed
  listing with readable rules changes nothing: the writes need no list permission. Running it beside the reads keeps
  an unreachable endpoint at one timeout (10 s), not two (21 s measured when it ran after).
- **Why:** measured on 2026-11-21: with the object token, a wrong bucket, a wrong secret and an unroutable endpoint,
  `setup --dry-run` printed "The storage service refused the request. Check the access key ... or pass --replace to
  replace the rules with cloudrop's alone" for all four, inviting a destructive flag that could not have helped.
- **If wrong:** credentials that may read bucket settings but not list objects get the read's own message; that is the
  previous behaviour.
- **Status:** in force; amends `M9-C6`.
- **Visible in:** `src/cli/setup.ts`, `src/cli/setup.test.ts`, `docs/guide/command.md`.

### M9-H103: a near-miss setting name gets a note; so do settings for two services

- **Decision:** every `CLOUDROP_*` name in the environment or the env file that is not a setting, but is one in another
  case or at most two edits from a setting that is not set, gets
  `note  CLOUDROP_R2_BUCKT is not a cloudrop setting. Did you mean CLOUDROP_R2_BUCKET?` (names only, never values). A
  name that starts with `CLOUDROP_R2_` or `CLOUDROP_S3_` is compared with that service's settings only;
  `CLOUDROP_R2_ENDPOINT` and `CLOUDROP_R2_REGION` get "R2's endpoint is built from CLOUDROP_R2_ACCOUNT_ID." and "R2
  needs no region." instead.
  When `CLOUDROP_R2_*` and `CLOUDROP_S3_*` settings are both set, a note says R2 is checked.
- **Why:** measured on 2026-11-21: a misspelt `CLOUDROP_R2_BUCKT` gave only "CLOUDROP_R2_BUCKET is not set", and
  lower-case names gave "No storage settings found", with the right values sitting in the file. With both services
  set, `doctor` checked R2 silently while an app using `s3()` uses the others. The review found that, compared with
  every setting, `CLOUDROP_R2_ENDPOINT` was answered "Did you mean CLOUDROP_S3_ENDPOINT?", advice that changes nothing.
- **If wrong:** an app's own `CLOUDROP_*` variable two edits from a setting gets a needless note; notes never change the
  exit code.
- **Status:** in force; amends `M9-C8`.
- **Visible in:** `src/cli/settings.ts`, `src/cli/doctor.test.ts`, `docs/guide/command.md`.

### M9-H104: an unreadable --env-file says what to do per error; Node's own exit 9 is documented, not worked around

- **Decision:** the command's message for a file it cannot read adds advice by error code: `EISDIR` "Name a file, not a
  directory.", `EACCES` "Check that you may read it.", anything else "Check the path." (exit code 2, as before). Under
  Node, a missing file or a directory never reaches the command: Node scans its whole command line for `--env-file`,
  the script's arguments included, and exits 9 with `node: <path>: not found` or `invalid format`. The guide's exit-code
  table and Troubleshooting say so; the option keeps its name.
- **Why:** measured on 2026-11-21 on Node 24.0.0, 24.22.2 and 26.13.0 with a two-line script: Node checks the file and
  exits before running it, and does not load an existing file into `process.env` (no double read). Bun passes the
  argument through. Renaming the option would not help a user who types `--env-file`, which Node intercepts either
  way, and a shebang with Node flags (`env -S node --`) is not portable to npm's Windows shims.
- **If wrong:** a later Node that stops scanning script arguments makes the guide's note stale; the command's own
  message then shows instead.
- **Status:** in force; amends `M9-C8`.
- **Visible in:** `src/cli/settings.ts`, `src/cli/run.test.ts`, `docs/guide/command.md`,
  `docs/guide/troubleshooting.md`.

### M9-H105: testClient through the app's own mount is a supported use

- **Decision:** `testClient({ ...cloudrop, handler: (request) => app.fetch(request) }, options)` is documented and
  tested: a handler that calls the app's own fetch runs the mount path and the middleware in front of it, so a wrong
  mount fails the test (`SERVER_ERROR`, "The upload server sent an answer this client cannot read (HTTP 404)"). The
  signature already took any `handler`; the guide now promises it.
- **Why:** `M9-T4` lists the app's mounting among what the test client does not see, and a newcomer's first wrong
  mount passed every test. Measured with Hono 4.13 in a fresh app from the packed package on 2026-11-21: the spread
  keeps the route types, and a mount at another path fails the upload.
- **If wrong:** a `Cloudrop` that gains members `testClient` reads must keep them through a spread; it is a plain
  object today.
- **Status:** in force; amends `M9-T4`.
- **Visible in:** `src/testing.guide.test.ts`, `docs/guide/testing-your-app.md` ("Through your app's mount").

### M9-H106: cloudrop/testing under node:test and bun test, measured

- **Decision:** the guide gives the clock for each runner: `t.mock.timers.enable({ apis: ["Date"], now })` in
  `node:test` and `setSystemTime(date)` in Bun beside Vitest's, and says that faking every timer works too. It warns
  that Bun's `File` adds `;charset=utf-8` to `text/plain` and `application/json`, which the server refuses with
  `FILE_TYPE_NOT_ALLOWED`, and the guide's quota example now uses `application/pdf`, which Bun keeps.
- **Why:** measured on 2026-11-21 with the packed package: the guide's examples pass in `node:test` (Node 24.22, type
  stripping) and in Bun 1.4.4, except the quota example, whose `text/plain` files Bun turned into
  `text/plain;charset=utf-8` and the server refused as "not a valid MIME type". Upload, quota, multipart and both
  clocks passed in all three runners, `vi.useFakeTimers()` and `jest.useFakeTimers()` included.
- **If wrong:** the server's refusal of a type with parameters is the server's; it is reported to its owner. Once the
  server accepts `text/plain;charset=utf-8`, the guide's Bun note and the Troubleshooting entry go.
- **Status:** amended by `M9-H1`: the server now reads a type by its essence, so the guide's Bun note says the file is
  accepted as `text/plain`, and the Troubleshooting entry is gone. The quota example keeps `application/pdf`.
- **Visible in:** `docs/guide/testing-your-app.md`, `src/testing.guide.test.ts`.

### M9-H107: a dry run says to write with `--apply`

- **Decision:** `setup --dry-run` ends with "Dry run: nothing was written. To write, run it with --apply and without
  --dry-run."
- **Why:** it said "Run the same command without --dry-run to write", but `setup --dry-run` without `--apply` then only
  prints the rules (seen while measuring the writes on R2, 2026-11-21).
- **If wrong:** none known.
- **Status:** in force.
- **Visible in:** `src/cli/setup.ts`.

### M9-H108: the user guides ship inside the package

- **Decision:** the package's `build` runs `scripts/package-docs.ts`, which copies `docs/guide/*.md` (all but the
  contributors' `testing.md`) flat into `packages/cloudrop/docs/` with an index made from the "Guides" part of
  `docs/README.md`, and `files` publishes that folder. A link between two shipped guides stays relative; every other
  relative link becomes its GitHub URL; a relative link to a missing file fails the build. `check-package.sh` requires
  `docs/README.md` and `docs/server.md` in the tarball.
- **Why:** the owner asked for the docs to be the package's documentation: an app's editor and coding agent read
  `node_modules/cloudrop/docs/` offline, for the installed version, while GitHub's `main` may already describe the next
  one.
- **If wrong:** about 70 kB more in the tarball; nothing is added to any bundle.
- **Status:** in force from 0.3.0.
- **Visible in:** `scripts/package-docs.ts`, `packages/cloudrop/package.json`, `scripts/check-package.sh`,
  `packages/cloudrop/README.md`.
