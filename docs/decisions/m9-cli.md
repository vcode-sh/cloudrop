# M9-C: the `cloudrop` command

Rulings for `cloudrop doctor` and `cloudrop setup`, designed in
`docs/superpowers/specs/2026-11-21-testing-and-cli-design.md` §2. Entries continue from `M9-C1`.

### M9-C1: two commands, one required option, three exit codes

- **Decision:** `cloudrop <doctor|setup> --origin <origin> [options]`. `--origin` is required by both commands and
  repeatable; it must be an exact origin (`new URL(value).origin === value`), since it is echoed in the output and
  becomes a CORS rule. Options: `--env-file <path>`, `--jurisdiction <eu|fedramp>`, and for `setup` only `--apply`,
  `--dry-run` and `--replace` (the last only with one of the other two); `--name=value` is accepted beside
  `--name value`; `-h`, `--help` and `help` print the
  usage. Exit codes: `0` nothing is wrong, `1` a problem was found or a write failed or was refused, `2` a usage error
  (including an `--env-file` that cannot be read). Findings go to stdout, one per line, as a status column (`ok`,
  `PROBLEM`, `NOT CHECKED`, `note`, `dry run`) and a sentence that says what to do; the summary is the last line.
  Usage errors go to stderr with the usage. No colour.
- **Why:** the design's flags and codes (§2). Without an origin, `doctor` cannot check the CORS rule, the setup step
  most often wrong ("Every upload ends in NETWORK_ERROR"), and `setup` has nothing to write, so it is required rather
  than reported as not checked. Plain columns stay readable in CI logs, where the command is most useful.
- **If wrong:** a user who wants only the settings checked must still pass an origin; the cost is one flag.
- **Status:** amended by `M9-H100` (a pattern is refused, the exact origin named).
- **Visible in:** `packages/cloudrop/src/cli/args.ts`, `src/cli/report.ts`, `src/cli/run.ts`, `docs/guide/command.md`.

### M9-C2: what `doctor` checks, and what counts as a problem

- **Decision:** in order: the storage settings (R2 when any `CLOUDROP_R2_*` is set, else S3 when any `CLOUDROP_S3_*`
  is, else "No storage settings found"), one finding per missing variable with what to set it to, an invalid value
  with the variable that holds it; `CLOUDROP_SECRET` present and at least 32 characters; the bucket answering
  (`M9-C5`); then `checkBucket`'s CORS and lifecycle checks for the given origins. `unknown` from `checkBucket` (an R2
  object token, Wrangler's `501`) is `NOT CHECKED` with the Wrangler or AWS CLI command that reads the setting by
  hand, and does not change the exit code. A missing `CLOUDROP_SECRET` is a problem, with "unless your code passes
  secret to createCloudrop()". The bucket checks are skipped while a storage setting is wrong, and the rule checks
  while the bucket does not answer. `checkBucket` takes only `storage`, `routes` and `store` from the server's
  configuration, so `doctor` runs it without a server; its `publicAccess` check is not shown, since it needs the app's
  routes.
- **Why:** the design: "`unknown` ... is reported as 'could not check' with how to check by hand, not as a failure".
  An app's own test token is usually an object token, and `doctor` must still pass in CI for it.
- **If wrong:** an app that passes its settings in code gets problems for variables it does not use; the guide says so.
  `doctor` writes nothing, so a read-only token passes it although it cannot upload; the guide says so too (review
  finding, 2026-11-21).
- **Status:** amended by `M9-H101` (a bucket that does not answer names the settings to check).
- **Visible in:** `src/cli/doctor.ts`, `src/cli/settings.ts`, `src/server/bucket-check.ts`.

### M9-C3: what R2 documents for the two writes, and the checksum sent

- **Decision:** both writes send the body's SHA-256 as `x-amz-checksum-sha256` and no other checksum header.
- **Why:** Cloudflare's [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) page (modified
  2026-11-10, read 2026-11-21) lists `PutBucketCors` and `PutBucketLifecycleConfiguration` as implemented, with
  `x-amz-sdk-checksum-algorithm`, `x-amz-checksum-algorithm` and `x-amz-expected-bucket-owner` unsupported; it lists
  `GetBucketCors`, `DeleteBucketCors` and `GetBucketLifecycleConfiguration` as implemented, and the older
  `PutBucketLifecycle` and `GetBucketLifecycle` as not. It says nothing of `Content-MD5` for these calls. AWS's
  [PutBucketCors](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketCors.html) says `Content-MD5` "must be
  used as a message integrity check", and both AWS pages accept an `x-amz-checksum-*` header in its place. Web crypto
  has no MD5; a CRC32C would bring its tables into every server bundle (measured: `cloudrop (bundled)` 30.16 kB, over
  its 30 kB budget), while SHA-256 is the digest the signer already computes. RustFS 1.0.5 accepts both writes with it
  (contract lane, 2026-11-21).
- **If wrong:** R2 may refuse the header or the calls. The first `setup --apply` against R2 would show it as a failed
  write with the storage's message, and nothing else is affected.
- **Status:** in force. Measured on R2 on 2026-11-21 with an Admin Read & Write token, on the owner's development
  bucket at the owner's request: both writes accepted with `x-amz-checksum-sha256`, R2 keeps a CORS rule's `ID` and a
  lifecycle rule's `ID` and fields, and another rule written back from its `sourceXml` reads back unchanged
  ([findings](../research/r2-spike-findings.md#setup-writes-on-r2-2026-11-21)). The live lane still never writes.
- **Visible in:** `src/storage/s3/bucket-writes.ts`, `src/testing/fake-r2/copy.ts`.

### M9-C4: optional bucket-settings writes, kept out of app bundles, proven on RustFS only

- **Decision:** `StorageDriver` gains optional `putBucketCors(rules)` and `putBucketLifecycle(rules)`. Each replaces
  the whole configuration, as S3 does, and refuses an empty list with `INVALID_INPUT` (a lax service would read it as
  "remove every rule"); what a rule must contain is left to the service. Only the internal `createS3DriverWithWrites`
  implements them, for the command (through `storageFromVariables`) and the contract lanes' `driverWith`; `r2()`, `s3()`
  and `createS3Driver` do not, so tree-shaking keeps the writes out of every app bundle. The live lane's `driverWith`
  has no writes either. The reads keep everything a write needs: `BucketCorsRule` gains `id`
  and `maxAgeSeconds` (every field S3 documents), `BucketLifecycleRule` gains `sourceXml`, the rule's XML as the
  storage sent it, which `putBucketLifecycle` writes back unchanged. `putBucketLifecycle` also reads the bucket's
  `x-amz-transition-default-minimum-object-size` and sends it back: AWS keeps that setting beside the rules and a write
  without it resets it (none to keep on a bucket without rules, or when the read is refused or not implemented). A read
  refuses a configuration with CDATA, comments or namespace prefixes (`STORAGE_ERROR`, not retryable), which the tag
  reader would misread and a write would then spread; an empty self-closing configuration reads as no rules. The fake
  R2 implements both writes (refused without `bucketConfig`, as for an object token) and, as S3 does, refuses a body
  without a checksum or with a rule that lacks what S3 requires. The storage contract's two new cases declare the gap
  `bucketSettingsWrites`: Wrangler's local R2 answers `501 NotImplemented` to both (wrangler 4.166.0, measured
  2026-11-21), and the live lane declares it too, because writing would change the owner's test bucket (`AGENTS.md`).
- **Why:** the design (§2, "Storage layer"). A lifecycle rule has many fields cloudrop does not model (expirations,
  transitions, tag and size filters); writing it from the fields cloudrop reads would drop them, which is exactly the
  loss the merge must never cause. Keeping the rule's own XML is smaller and safer than modelling the whole schema.
- **Why the writes are kept out of the presets:** measured on the build, they cost `cloudrop (bundled)` 0.68 kB, and
  with the review's fixes put it at 30.04 kB, over its 30 kB budget, for a call only an admin command makes.
- **If wrong:** a service that reformats a rule's XML on read still round-trips it (RustFS does, and the contract case
  checks that an expiration survives two writes). An app that wants to write bucket settings from its own code cannot
  get a driver that does from the package; the methods stay optional on `StorageDriver` for a driver that implements
  them. Cost of the richer reads: `cloudrop` 39.19 → 39.49 kB summed, `cloudrop (bundled)` 29.13 → 29.36 kB (0.8 %);
  every other entry unchanged.
- **Status:** in force. New public, additive types: `StorageDriver.putBucketCors` and `putBucketLifecycle` (optional),
  `BucketCorsRule.id`, `BucketCorsRule.maxAgeSeconds`, `BucketLifecycleRule.sourceXml`.
- **Visible in:** `src/storage/driver.ts`, `src/storage/s3-driver.ts`, `src/storage/presets.ts`,
  `src/storage/s3/bucket-settings.ts`, `src/storage/s3/bucket-writes.ts`, `src/testing/storage-contract/bucket-settings.ts`,
  the four lane files.

### M9-C5: the bucket is proven by a listing, not a HEAD

- **Decision:** `doctor` lists one key under `cloudrop-doctor/` to prove the bucket answers, instead of the design's
  `HEAD` of a key that does not exist.
- **Why:** a `HEAD` answer has no body, so S3's `NoSuchBucket` and `NoSuchKey` both arrive as a bare `404` and the
  driver reads both as "no such object": a misspelt bucket would pass. A `ListObjectsV2` answer carries the code
  (`The bucket does not exist. Check the bucket name in your configuration.`), and an R2 Object Read & Write token may
  list. Its test runs `doctor` against a bucket name the fake does not hold.
- **If wrong:** credentials that may read objects but not list them would be reported as refused; cloudrop's
  `deletePrefix` needs listing anyway (`bucket-setup.md`).
- **Status:** amended by `M9-H101` and `M9-H102` (setup lists the bucket too).
- **Visible in:** `src/cli/doctor.ts`.

### M9-C6: `setup --apply` merges by rule ID and never writes over rules it could not read

- **Decision:** `setup --apply` reads both configurations first. cloudrop's rules are `cloudrop-uploads` (CORS) and
  `cloudrop-abort-incomplete` (lifecycle); a rule is cloudrop's only by that ID. The merge appends cloudrop's rule, or
  grows it where it stands, and writes every other rule back as read; it writes nothing for a setting whose result
  would not change. Growing only adds: the given origins, and the methods, headers and exposed headers cloudrop needs
  (methods and headers compared without case); origins, headers and a max age already on the rule stay, and copies of
  it are folded into the first. A CORS rule without an ID that already allows everything cloudrop's would counts as
  cloudrop's, so a service that drops IDs does not get a copy per run. When either read fails, nothing is
  written and the exit code is 1; `--replace` writes cloudrop's rules alone instead, but only when the read was refused
  (`STORAGE_DENIED` or `501`), never after a failure that may pass, such as a timeout. `--dry-run` reads and merges and
  prints what it would add, update and keep, writing nothing; with `--apply` or alone it means the same. Writes run one
  after the other, CORS first.
- **Why:** the design: "It merges, never replaces ... refuses to write when it cannot read the current rules, unless
  `--replace` says replacing them is intended." A timeout says nothing about whether rules exist, so replacing on it
  would drop rules the user never meant to lose. The first version set `cloudrop-uploads` to exactly the given origins
  and headers; the review found that a run with fewer origins, or a header the user had added (a checksum header, as
  `bucket-setup.md` advises), was silently removed, so the rule now only grows.
- **If wrong:** the rules can change between the read and the write; S3 has no conditional write for them. R2's answer
  to a reader allowed to see the rules is unmeasured, including whether it keeps IDs.
- **Status:** amended by `M9-H102` (a refused read is diagnosed by a listing; `--replace` is offered, and acts, only
  after a `403`, no longer after a `501`).
- **Visible in:** `src/cli/rules.ts`, `src/cli/setup.ts`, `docs/guide/command.md`.

### M9-C7: cloudrop's rules, and no second abort rule

- **Decision:** the CORS rule is the one in `docs/guide/bucket-setup.md`: `PUT`, `GET`, `HEAD` from the given origins,
  the headers `content-type`, `content-disposition`, `if-none-match`, `x-amz-meta-cloudrop-id`, exposing `ETag` and
  `Retry-After`, max age 3600. The lifecycle rule aborts incomplete multipart uploads after 1 day across the bucket
  (`Filter` with an empty `Prefix`). When any enabled rule already aborts them across the bucket (R2's default 7-day
  rule, or cloudrop's own), the lifecycle configuration is left alone. When `cloudrop-abort-incomplete` exists but no
  longer does that, `setup` leaves the lifecycle rules alone and reports a `PROBLEM` (exit 1): someone edited it, and
  rewriting it from fields would drop what they added. The CORS rule is still written: only an unreadable
  configuration stops both.
- **Why:** one rule set, documented once, which `checkBucket` accepts. A second abort rule would change nothing
  `checkBucket` checks, and every write of bucket settings is a risk worth avoiding. One day matches the guide; an
  upload token lasts 24 hours, so no upload can be completed later anyway.
- **If wrong:** a bucket that wants a shorter abort than its existing rule must change that rule by hand.
- **Status:** in force.
- **Visible in:** `src/cli/rules.ts`, `src/cli/instructions.ts`.

### M9-C8: settings from the environment and an env file, and no value ever printed

- **Decision:** variables are read from the environment and, with `--env-file`, from a file of `NAME=value` lines
  parsed by the command as Node's `--env-file` reads them: optional `export`; single quotes, double quotes or backticks
  taken as written and running over several lines up to the closing quote, with `\n` in double quotes a line break; a
  quote never closed kept as written; `#` starting a comment in an unquoted value; nothing expanded or run (the
  multi-line and open-quote cases measured against `node --env-file` on Node 24.22, 2026-11-21, after the second
  review found that the first parser refused a file Node reads, such as one with a PEM key). A variable set in the
  environment wins over the file, as with Node's `--env-file`, and a `note` names each
  cloudrop variable set in both. A file that cannot be read is reported by its path and error code only. The command
  prints names, never values, the bucket name included: printed commands use `"$CLOUDROP_R2_BUCKET"` and
  `"$CLOUDROP_S3_ENDPOINT"`. The storage driver is built by the presets' own code from those variables
  (`storageFromVariables`), so a bad value fails the same check as in an app and is named by its variable; the process
  environment is never read behind the injected one.
- **Why:** the design: "Never print a secret, a key or a presigned URL; name a variable, never its value." The live
  lane already treats the bucket name and account ID as values to redact. Every test of the command checks that no
  setting's value reached its output, including values that came from an env file. A rule ID read from the bucket is
  printed with its control characters escaped, so it cannot drive the terminal or split a finding.
- **If wrong:** a shell without the variables set needs the bucket name typed into the printed command by hand.
- **Status:** "no value ever printed" is superseded by `M11-R110` and `M11-R177`: the command never prints a secret
  (the access key ID, the secret access key, the upload token secret), the R2 account ID or the S3 region, and it does
  print the bucket's name and the S3 endpoint as words of the Wrangler and AWS CLI commands it suggests, in place of
  `"$CLOUDROP_R2_BUCKET"` and `"$CLOUDROP_S3_ENDPOINT"`. The rest stands, amended by `M9-H103` (notes for near-miss
  names), `M9-H104` (advice for an unreadable file; Node's exit 9) and `M11-R115` (the path of an unreadable file). The
  live check of 2026-11-21 (no value of the env file in `doctor`'s or `setup --dry-run`'s output) predates `M11-R110`:
  `doctor` with a token that reads no rules now prints the bucket's name twice.
- **Visible in:** `src/cli/settings.ts`, `src/cli/env-file.ts`, `src/storage/presets.ts`, `src/cli/command-fixture.ts`.

### M9-C9: a separately built bin on `process`, described by hand

- **Decision:** `src/cli.ts` is the bin (`"bin": { "cloudrop": "./dist/cli.js" }`), built by its own `tsdown` config
  (ESM, neutral platform, no types, no chunks) so the library entries keep their files and sizes. It uses only web
  APIs and `process`, described by hand as `src/node.ts` describes Node's objects: `argv`, `env`, `stdout`, `stderr`,
  `exitCode`, and `getBuiltinModule("node:fs")` to read `--env-file`, which Node 24 and Bun 1.4 both provide. No
  library entry imports `src/cli`. `src/cli.test.ts` runs the source bin under Node and Bun; the rest of the command's
  tests call `runCommand` with an injected environment, file reader, output streams and the fake R2's `fetch`.
- **Why:** the design: "Node 24+ and Bun ... no library entry imports it. It may use `process` ... and nothing else
  outside the web platform." Sharing the library's build would move the code both use into new chunks and change the
  entries' summed sizes.
- **If wrong:** a runtime without `process.getBuiltinModule` can run the command but not read `--env-file`; it would
  report the file as unreadable with exit code 2.
- **Status:** in force. The bin is not size-budgeted; it ships in no app bundle.
- **Visible in:** `src/cli.ts`, `tsdown.config.ts`, `packages/cloudrop/package.json`.
