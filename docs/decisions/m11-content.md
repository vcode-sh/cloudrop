# M11-K: a content refusal says what the file is

Rulings for the `content` field of a `contentChecks()` refusal, designed in `docs/superpowers/specs/2026-11-21-0.6.0-design.md`.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.

### M11-K1: `CloudropError.content`, typed `ContentRefusal`, only on `FILE_TYPE_NOT_ALLOWED`

- **Decision:** `CloudropError` gains the option and readonly field `content?: ContentRefusal`, with
  `ContentRefusal = { declared: string; detected?: string; reason: "mismatch" | "refused" | "not-accepted" }`. The type
  is exported from `cloudrop` and `cloudrop/client`, the two entries that export `CloudropError`; `cloudrop/react` and
  `cloudrop/plugins` export neither. The constructor keeps `content` only when the code is `FILE_TYPE_NOT_ALLOWED` and
  leaves it `undefined` for every other code, whoever built the error.
- **Why:** an app that translates its errors needs the two types and the reason as data; the message is one English
  sentence. One check in the constructor covers the plugin, an app's own plugin, the server's answer and the client's
  reading of it, so "only a type refusal carries it" holds without a second check at the wire or in the reader.
- **If wrong:** another code that needs the field is added to the constructor's check; an option silently left out is
  documented on the option.
- **Status:** in force; `src/server/handler-failures.test.ts` (another code sends none),
  `src/client/content-refusal.test.ts`.
- **Visible in:** `src/errors.ts`, `src/index.ts`, `src/client.ts`, `docs/guide/errors.md`.

### M11-K2: each refusal has one reason, and `detected` is there exactly when the bytes decided

- **Decision:** every branch of `contentChecks()` that refuses sets `content`, messages unchanged (M10-K4):

  | Hook | Branch (M10-K2) | `reason` | `detected` |
  | --- | --- | --- | --- |
  | `/upload` | a file's declared type is refused: a default refusal (M10-K3), an XML type the route does not name, or a `deny` entry | `refused` | never |
  | `/complete` | (0) the declared type is refused, for a token signed before the plugin or its lists changed | `refused` | never, whatever the bytes show |
  | `/complete` | (1) the detected type is refused: a default refusal, XML or SVG in a file not sent as an XML type the route names, or a `deny` entry | `refused` | the detected type |
  | `/complete` | (3) sent as `application/octet-stream`, and no type the content agrees with is in `accept` | `not-accepted` | the detected type |
  | `/complete` | (2) the detected type contradicts the declared one; also content `allow` lets through, sent as another type | `mismatch` | the detected type |

  `allow` adds no branch: it turns a `refused` into a pass or, when the declared type differs, into a `mismatch`.
  `detected` is the sniffer's canonical type (`image/jpeg`, `application/vnd.microsoft.portable-executable`,
  `text/x-shellscript`), never one of its aliases.
- **Why:** the spec's comment says `detected` is absent only at `/upload` and when the bytes show no type. Branch (0)
  breaks that on purpose. There the declared type is what is refused, and the bytes may show another, harmless type (a
  PNG sent as `text/html`): `{ declared: "text/html", detected: "image/png", reason: "refused" }` would not say which of
  the two is refused, and copy built from it would call a PNG a refused kind. With `detected` left out, one rule reads
  every refusal: the refused type of a `refused` is `detected ?? declared`.
- **If wrong:** an app that wants the bytes' type in branch (0) cannot have it; the branch is reached only within the
  24 hours after the plugin or its lists changed.
- **Status:** in force; `src/plugins/content-checks.test.ts` names the content of every refusing row,
  `src/plugins/content-checks-upload.test.ts` of every `/upload` row. Amended by `M11-R133`: a container (WebM, MP4,
  Ogg, a plain ZIP) is judged as each type it can be, the type it was sent as among them, so it is not refused on
  `detected` alone.
- **Visible in:** `src/plugins/content-checks.ts`, `docs/guide/plugins.md`.

### M11-K3: the wire body carries `content`, three fields copied one by one

- **Decision:** `ErrorBody` gains `content?: ContentRefusal`. `errorBody` copies `declared`, `detected` and `reason`
  from the error and nothing else the object holds, for request-level errors and per-file rejections alike (one
  function builds both). `contentChecks()` refuses a whole request at `/upload` (M10-K2), so its `content` is on the
  request-level error and `declared` is the type of the first refused file, as the message names it. Any plugin's
  `FILE_TYPE_NOT_ALLOWED` may carry `content`; the route's own `accept` refusal carries none, as the spec rules.
- **Why:** `content` is typed, but a plugin may pass a wider object (TypeScript checks excess properties only on a
  literal) or be plain JavaScript; a spread such as `{ ...file, reason }` would put a key or a name on the wire. The
  rule that only three values leave the server is kept by the server, not by each plugin. The field is not reserved
  for `contentChecks()`: `CloudropErrorOptions` is public, and a scanner or an app's own check refuses for the same
  three reasons.
- **If wrong:** a plugin that sets a value outside the three reasons sends it, and the client drops the field (M11-K4).
  AGENTS.md still says a client is sent "only the error's code, message, `retryable` and part numbers"; that sentence
  must name `content`.
- **Status:** in force; `src/server/handler-failures.test.ts` (extra fields of a plugin's object are not sent). Amended
  by `M11-R137`: `content` is checked before it is sent, and left out whole when it is not a refusal's ("a plugin that
  sets a value outside the three reasons sends it" no longer holds).
- **Visible in:** `src/protocol/types.ts`, `src/server/http.ts`, `docs/guide/errors.md`, `docs/guide/server.md`.

### M11-K4: the client reads `content` by shape and drops any other shape

- **Decision:** the client keeps `content` when it is a plain object whose `declared` is a string, whose `detected`
  is a string or absent and whose `reason` is one of the three; it rebuilds the object from those fields, without a
  `detected` key when the answer had none. Any other shape, a reason this client does not know among them, leaves
  `content` undefined and the error as it was: its code, message and `retryable` are read first and never depend on
  `content`. It is read from a non-2xx answer and from a rejected file of `/upload`, by the reader both share.
- **Why:** the answer may come from a proxy or another cloudrop version (S16). The type promises one of three
  reasons, and an app's `switch` over them has no branch for a fourth, so an unknown one is dropped rather than passed
  through as an unknown `code` is: `message` still explains the refusal. The two types are not checked as MIME types:
  like `message` they are text the page shows, and a wrong one misleads no more than a wrong message.
- **If wrong:** a newer server's fourth reason reaches an older client as no `content` at all; the app shows the
  message.
- **Status:** in force; `src/client/content-refusal.test.ts` (kept, absent, eight malformed shapes).
- **Visible in:** `src/client/answers.ts`.

### M11-K5: where the page reads it, and what retry and resume do with it

- **Decision:** `content` is on every `CloudropError` the client gives for the refusal. A refusal at `/complete`: the
  file's error (with `file`), the job's `error`, the file's snapshot and outcome. A refusal at `/upload` of the job's
  own request: the one job error, which every file of the job fails with (no `file`). When a retry asked for some of
  the job's files, each file's own copy (`withFile` copies `content` with the error's other fields). `cloudrop/react`
  passes these errors on unchanged, in `files[n].error` and in `upload()`'s result. A retry clears the file's error
  when it queues the file again, so `content` goes with it and the next answer brings its own. Nothing of an error is
  kept in the browser's records, so a resumed upload has no earlier `content`. With a store, a `/complete` sent again
  after a refusal answers `UPLOAD_EXPIRED` from the `rejected` row, without `content`: the row keeps no reason.
- **Why:** `content` describes one answer about one file's bytes; an error from a later request is about that request.
  A column for the reason would be a migration of every store for an answer the client already had.
- **If wrong:** a client that lost the refusal's answer (the connection dropped after the server refused) retries
  `/complete` and learns only that the upload ended; it never sees `content`. Measured while testing this, and not
  changed here: after a refusal at `/complete`, `retry()` of a `start()` job's file sends `/complete` again with the
  same ticket, which answers `NOT_UPLOADED` on a server without a store; M10-K4's "asks `/upload` for a new ticket on
  `retry()`" holds for `upload()` only.
- **Status:** in force; `src/client/content-refusal.test.ts`, `src/react/upload-store.test.ts`.
- **Visible in:** `src/client/failures.ts`, `docs/guide/client.md`, `docs/guide/react.md`.

### M11-K6: compatibility, `cloudrop/testing`, and what it costs

- **Decision:** no version negotiation. A 0.5.0 client reads the four fields it knows from an error body and ignores
  `content`; a 0.6.0 client on an older server finds none and leaves it undefined. `cloudrop/testing`'s `testClient`
  is the real client on the real handler, so an app's test reads `error.content` as its page does.
- **Why:** the reader takes named fields from the body and never rejects one it does not know; the tests that feed it
  a body with `content`, and with a field of another name, passed on 0.5.0's reader before it was changed. Sizes,
  gzip, before and after: `cloudrop` (bundled) 31.32 to 31.39 kB of 32; `cloudrop/plugins` 5.06 to 5.17 kB of 6;
  `cloudrop/client` 12.57 to 12.69 kB of 15; `cloudrop` (summed) 42.47 to 42.57 kB; `cloudrop/react` and
  `cloudrop/testing` unchanged. No ceiling moved.
- **If wrong:** none known.
- **Status:** in force; `src/client/content-refusal.test.ts`, `src/testing.test.ts`,
  `src/plugins/content-checks.r2.integration.test.ts` (live R2).
- **Visible in:** `src/client/answers.ts`, `docs/guide/plugins.md`.
