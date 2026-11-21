# M9-H: hardening before 0.3.0

Rulings from testing against the owner's development bucket and as a new user before 0.3.0 (2026-11-21). The upload
protocol numbers from `M9-H1`, the store and owner API from `M9-H50`, `cloudrop/testing` and the command from `M9-H100`.
The measurements behind the first range are in
[Upload protocol edge cases](../research/r2-spike-findings.md#upload-protocol-edge-cases-2026-11-21).

### M9-H1: a type with parameters is stored as its essence

- **Decision:** `/upload` reads a file's declared type up to its first `;`, trims it and lowercases it: the essence
  (`text/csv;charset=UTF-8` → `text/csv`). The route's `accept` policy, the extension check, the signed and stored
  `Content-Type` and the `inline`/`attachment` choice all use the essence. A type whose essence is not
  `type/subtype` is still refused as `FILE_TYPE_NOT_ALLOWED`. Amends `M2-D9`, which refused every type with
  parameters.
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
- **Status:** in force.
- **Visible in:** `docs/guide/testing-your-app.md`, `docs/guide/troubleshooting.md`, `src/testing.guide.test.ts`.
