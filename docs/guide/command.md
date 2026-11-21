# The cloudrop command

This page is for whoever sets up an app's storage. The package ships a `cloudrop` command with two subcommands:
`doctor` tells you in plain words what is missing in your settings and your bucket, and `setup` gives you the bucket's
CORS and lifecycle rules, or adds them to the bucket for you. It runs on Node 24 or later and on Bun.

```bash
npx cloudrop doctor --origin https://app.example.com --origin http://localhost:5173
npx cloudrop setup  --origin https://app.example.com                # prints the rules and the commands
npx cloudrop setup  --origin https://app.example.com --dry-run      # shows what --apply would change
npx cloudrop setup  --origin https://app.example.com --apply        # adds them, keeping every other rule
```

`bunx cloudrop` works the same way. `--origin` names an origin your pages upload from (the page's, not your API's) and
is required; repeat it for each origin.

## Settings

The command reads the same variables as the library: `CLOUDROP_R2_ACCOUNT_ID`, `CLOUDROP_R2_BUCKET`,
`CLOUDROP_R2_ACCESS_KEY_ID` and `CLOUDROP_R2_SECRET_ACCESS_KEY` for R2, or the `CLOUDROP_S3_*` variables for another
S3-compatible service, and `CLOUDROP_SECRET`. When any `CLOUDROP_R2_*` variable is set it checks R2, otherwise S3.

- `--env-file <path>` also reads a file of `NAME=value` lines, such as `.env.local`, the way Node's `--env-file` does:
  `export` in front of a name is allowed, a value in single quotes, double quotes or backticks is taken as written
  and may run over several lines (`\n` in double quotes is a line break), and in an unquoted value `#` starts a
  comment, so quote a value that contains one. Nothing in the file is run or expanded. A variable set in the environment
  wins over the file, as with Node, and the command says so for each cloudrop variable set in both.
- `--jurisdiction eu` (or `fedramp`) selects the endpoint of an R2 bucket in a jurisdiction, as `r2({ jurisdiction })`
  does.

The command never prints a setting's value, only its name. The commands it prints name the bucket as
`"$CLOUDROP_R2_BUCKET"` (or `"$CLOUDROP_S3_BUCKET"`), so they work in a shell that has the variable set.

## doctor

`doctor` checks, in order:

1. that every storage setting is present and valid, naming the variable to fix;
2. that `CLOUDROP_SECRET` is set and has at least 32 characters;
3. that the bucket answers and the credentials may list it (a listing, which tells a missing bucket from a missing
   object);
4. the bucket's CORS rule for each `--origin` and its lifecycle rule, as `cloudrop.api.checkBucket` does.

Each line is one finding: `ok`, `PROBLEM` with what to do, `NOT CHECKED` with how to check by hand, or a `note`. The
last line sums them up. Against an R2 bucket with an Object Read & Write token it prints:

```text
cloudrop doctor: checking R2 settings, the bucket and its rules for http://localhost:5173.
ok           R2 settings are present and valid (CLOUDROP_R2_*).
ok           CLOUDROP_SECRET is set.
ok           The bucket answers, and these credentials may list it.
NOT CHECKED  CORS: These storage credentials may not read the bucket's CORS rules (R2 object tokens cannot). Check it with an admin read token or in the dashboard. By hand: wrangler r2 bucket cors list "$CLOUDROP_R2_BUCKET"
NOT CHECKED  Lifecycle: These storage credentials may not read the bucket's lifecycle rules (R2 object tokens cannot). Check it with an admin read token or in the dashboard. By hand: wrangler r2 bucket lifecycle list "$CLOUDROP_R2_BUCKET"
No problems found. 2 checks could not run; see above.
```

An object token cannot read bucket settings, so those two checks are reported as not checked, never as a failure. Run
`doctor` with an admin token to check them too.

`doctor` writes nothing, so it does not prove that the credentials may upload: a read-only token lists the bucket as
well as a read-write one does. Give the app a token with Object Read & Write
([Credentials and permissions](bucket-setup.md#credentials-and-permissions)).

Your code may pass settings to `r2()`, `s3()` or `createCloudrop()` instead of the environment; `doctor` reads only the
environment and the env file, so it reports those settings as missing.

## setup

Without `--apply`, `setup` reaches nothing. It prints the CORS rule in R2's format (`cors.json` for Wrangler) and in the
S3 format (`cors-s3.json` for the AWS CLI), the lifecycle rule (`lifecycle.json`), and the commands that set them: the
Wrangler ones for R2, the AWS CLI ones for other services, both when no settings name the service. The rules are those
of [Bucket setup](bucket-setup.md): `PUT`, `GET` and `HEAD` from your origins with the four headers cloudrop signs,
`ETag` and `Retry-After` exposed, and an abort of incomplete multipart uploads after 1 day across the bucket.

Setting CORS with Wrangler or the AWS CLI replaces every rule the bucket has. List the current rules first and add the
ones you keep to the file, or use `--apply`.

With `--apply`, `setup` writes the rules through the S3 API (`PutBucketCors` and `PutBucketLifecycleConfiguration`):

- **It merges, it never replaces.** It reads the current rules and adds cloudrop's own rule: `cloudrop-uploads` for
  CORS, `cloudrop-abort-incomplete` for lifecycle. Every other rule is written back as it was read, a lifecycle rule's
  expirations, transitions and filters included, and so is the bucket's transition default on AWS.
- **It only adds.** When `cloudrop-uploads` exists, it gains what it lacks (an origin you pass, a method or header
  cloudrop needs) where it stands; origins, headers and the max age already on it stay. To remove an origin, edit the
  rule by hand.
- When another enabled rule already aborts incomplete multipart uploads across the bucket (R2 creates one by default),
  the lifecycle rules are left as they are. When `cloudrop-abort-incomplete` exists but no longer does that (someone
  disabled it or gave it a prefix), `setup` leaves the lifecycle rules alone, still writes the CORS rule, and reports
  the problem (exit 1): fix or delete that rule by hand.
- It writes nothing for a setting that would not change.
- It needs credentials that may read and change bucket settings, such as an R2 Admin Read & Write token. Use it for
  this step only; the app needs no more than Object Read & Write.
- When it cannot read the current rules, it writes nothing and exits 1. `--replace` (with `--apply` or `--dry-run`)
  writes cloudrop's rules alone instead, replacing what the bucket has, but only when the read was refused (`403`, or a
  service that does not support it). A read that failed for any other reason, such as a timeout, never leads to a
  write. Neither does a configuration written in XML the command does not read (CDATA, comments or namespace
  prefixes): check that bucket's rules by hand.

`--dry-run` does everything `--apply` does except the writes, and shows the result: which rule it would add or update
and which rules it would keep. R2 can take up to 30 seconds to apply a change; run `doctor` afterwards to check.

Wrangler's local R2 cannot read or write bucket settings (it answers `501`), and needs no CORS rule.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Nothing is wrong: every check passed or could not run, or `setup` printed, wrote or would write the rules. |
| `1` | `doctor` found a problem, or `setup` could not read, could not write, or found the settings incomplete. |
| `2` | A usage error: an unknown command or option, a missing `--origin`, an origin with a path, `--replace` without `--apply` or `--dry-run`, or an `--env-file` that cannot be read. |

In CI, `cloudrop doctor` fails the job on a problem and passes when it could only not check something.
