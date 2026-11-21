# M11-C: the command reads an app's own variable names

Rulings for `--var` of `cloudrop doctor` and `cloudrop setup`, designed in `docs/superpowers/specs/2026-11-21-0.6.0-design.md`.
Each entry: Decision, Why, If wrong, Status, Visible in.

### M11-C1: `--var <SETTING>=<NAME>` reads a setting from the app's variable, and only from it

- **Decision:** `doctor` and `setup` take `--var <SETTING>=<NAME>`, repeatable, also as `--var=<SETTING>=<NAME>`.
  `SETTING` is one of the ten names the command reads (the R2 four, the S3 five, `CLOUDROP_SECRET`); `NAME` matches
  `[A-Za-z_][A-Za-z0-9_]*`. A setting with a pair is read from `NAME` in the environment and in `--env-file`, and never
  from its cloudrop name; a setting without one keeps its cloudrop name. Service detection (R2 when the variable of any
  R2 setting is set, else S3) and every later check work on the settings however they are named. The library is
  unchanged: `r2()`, `s3()` and `createCloudrop()` take options for other names. Inside the package,
  `storageFromVariables` gained an optional `name`, used only to name the variable in "Environment variables with an
  invalid value"; `r2()` and `s3()` do not pass it.
- **Why:** the pilot wrapped the command in a script that copied `R2_*`, `STORAGE_S3_ENDPOINT` and `UPLOAD_TOKEN_SECRET`
  to `CLOUDROP_*` names, and every finding then named a variable the app does not have. Reading both names would make
  "which value was checked" depend on what else is set, so a renamed setting has one source.
- **If wrong:** an app that names a setting two ways in two environments passes a different `--var` in each.
- **Status:** in force; amends `M9-C1` (one more option) and `M9-C2` (the settings are read from the named variables).
- **Visible in:** `packages/cloudrop/src/cli/names.ts`, `src/cli/vars.ts`, `src/cli/settings.ts`,
  `src/storage/presets.ts` (`storageFromVariables`), `src/cli/names.test.ts`, `docs/guide/command.md`.

### M11-C2: a pair that cannot work is a usage error that says what to type

- **Decision:** exit code 2, the message, then the usage, which now lists the ten settings. Refused: a pair without `=`
  or with nothing before it; a `SETTING` the command does not read, with "Did you mean ...?" for one in another case,
  without the `CLOUDROP_` prefix or at most two edits away, and with the pair written the right way round when the
  two sides are swapped (`R2_BUCKET=CLOUDROP_R2_BUCKET`); a `NAME` that is empty or not a variable name; a setting
  given twice, even with the same name; two settings read from one variable; a setting read from another setting's
  own cloudrop name. A setting given its own name (`CLOUDROP_SECRET=CLOUDROP_SECRET`) is accepted and changes nothing.
- **Why:** each refused pair makes a message ambiguous or a check silently wrong. One variable for two settings would
  leave "R2_BUCKET is not set" unable to say which setting it means, and, across services, would make the R2 check win
  whenever that variable is set. A setting read from another setting's name (`CLOUDROP_R2_BUCKET=CLOUDROP_S3_BUCKET`)
  is a slip far more often than a wish. The swapped pair is the mistake the syntax invites, so it gets the corrected
  command. A `NAME` must be a name a shell expands, because the printed commands read the bucket as `"$NAME"`; an env
  file may hold names such as `my.key`, which `--var` therefore refuses.
- **If wrong:** the pilot reads its bucket and keys from the same `R2_*` variables whether it runs on R2 or on another
  S3 service, and cannot say so in one command line: it passes the R2 pairs or the S3 pairs
  (`--var CLOUDROP_S3_BUCKET=R2_BUCKET`) by the service it runs on. The guide shows this.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/cli/vars.ts`, `src/cli/vars.test.ts`, `src/cli/args.ts` (`USAGE`),
  `docs/guide/command.md`.

### M11-C3: what follows `=` is echoed only when it is a variable's name

- **Decision:** a usage error never repeats a `NAME` that is not a valid variable name, nor what stands before `=`
  unless it has the shape of a name. The message says "Give the variable's name, never its value."
- **Why:** the likeliest mistake with `--var CLOUDROP_R2_BUCKET=...` is to type the value. A bucket name with a hyphen,
  or a secret from `openssl rand -base64 32`, is not a variable name, so it is refused and not printed; the command's
  rule that it never prints a setting's value holds for its own arguments. The test fixture fails any run that prints
  one.
- **If wrong:** a value that happens to be a valid name, such as a hexadecimal account ID starting with a letter, is
  taken as a name and printed in "... is not set". The command cannot tell the two apart; the person typed it on their
  own command line.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/cli/vars.ts`, `src/cli/vars.test.ts` ("a value where the variable's name
  belongs").

### M11-C4: every message and printed command names the app's variable

- **Decision:** each finding, note, hint and printed Wrangler or AWS CLI command names the variable a setting is read
  from (`R2_BUCKET is not set`, `"$R2_BUCKET"`), never the cloudrop name it stands for. A command the output tells
  the reader to run next (`Run: cloudrop setup ... --apply` from `doctor`, `cloudrop doctor ...` from `setup`) repeats
  the `--var` pairs after the origins. `R2 settings are present and valid (CLOUDROP_R2_*)` lists the service's
  variables instead once any of them is renamed, and so does "or the CLOUDROP_S3_* settings" in "No storage settings
  found". In the source, a message takes every name from `Settings.name`; the test helper `runRenamed` renames all ten
  settings and fails a run whose output contains `CLOUDROP_` anywhere but in a `--var` pair.
- **Why:** a message that names a variable the app does not have sends its reader to the wrong place, and a printed
  command that reads `"$CLOUDROP_R2_BUCKET"` expands to nothing in the app's shell. A suggested command without the
  pairs would report "No storage settings found".
- **If wrong:** the suggested commands grow long with many pairs; they stay copyable.
- **Status:** in force. The suggested commands still leave out `--env-file` and `--jurisdiction`, as before this change.
- **Visible in:** `packages/cloudrop/src/cli/settings.ts`, `src/cli/bucket-access.ts`, `src/cli/instructions.ts`,
  `src/cli/doctor.ts`, `src/cli/setup.ts`, `src/cli/args.ts` (`sameArguments`), `src/cli/command-fixture.ts`
  (`runRenamed`), `src/cli/names.test.ts`.

### M11-C5: the notes work on the names in use

- **Decision:** "set in the environment and in the file" names the variable in use. A setting's cloudrop name that is
  set while `--var` reads the setting elsewhere gets
  `note  CLOUDROP_R2_BUCKET is set, but --var reads that setting from R2_BUCKET, so it is not read.` The near-miss note
  (`M9-H103`) compares the names in use: a `CLOUDROP_*` name still counts at two edits, within its service; any other
  name counts only in another case or at one edit, as `R2_BUCKT is not a variable the command reads. Did you mean
  R2_BUCKET?`. A variable a `--var` names never gets a near-miss note, nor the "R2 needs no region" kind, whatever it
  resembles. The note for settings of both services now reads `Settings for R2 and for S3 are both set; the command
  checks R2. To check S3, unset <the R2 variables that are set>.`, with or without `--var`.
- **Why:** a stale `CLOUDROP_R2_BUCKET` left from a wrapper script would otherwise look read while the check reports
  another value. The environment holds many names that are not the app's settings, and at two edits `SSH_KEY` is a
  misspelt `S3_KEY`; one edit or a change of case is a slip. An app that reaches R2 through `s3()` may name its
  endpoint `CLOUDROP_R2_ENDPOINT`; once `--var` names it, "R2's endpoint is built from ..." would be false. The old
  both-services note named `CLOUDROP_R2_*`, which is wrong once any setting is renamed; naming the variables that are
  set is right in both cases and says exactly what to unset, so there is one wording.
- **If wrong:** a real variable one edit from an unset renamed one (`APP_KEY` beside `API_KEY`) gets a needless note;
  notes never change the exit code. Without `--var`, a name one edit from a setting but without the `CLOUDROP_` prefix
  (`CLOUDROPSECRET`) now gets a note too.
- **Status:** in force; amends `M9-H103` (the names compared, and the wording of the both-services note).
- **Visible in:** `packages/cloudrop/src/cli/misspelt.ts`, `src/cli/misspelt.test.ts`, `src/cli/settings.ts`
  (`readVariables`), `src/cli/names.test.ts`, `src/cli/doctor.test.ts`.

### M11-C6: the secret's variable is checked as one secret

- **Decision:** with `--var CLOUDROP_SECRET=<NAME>`, `doctor` checks that `NAME` is set and holds at least 32
  characters, exactly as it checks `CLOUDROP_SECRET`. It does not split the value.
- **Why:** the library reads one secret from `CLOUDROP_SECRET`; a list is passed in code (`secret: [...]`), and a list
  in one variable is out of scope for 0.6.0 (design, "Out of scope"). The pilot keeps comma-separated keys in
  `UPLOAD_TOKEN_SECRET` and splits them itself; only its code knows the separator.
- **If wrong:** a variable with several short keys passes the length check. The guide says a variable holding several
  keys is the app's to check.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/cli/settings.ts` (`secretFinding`), `docs/guide/command.md`.
