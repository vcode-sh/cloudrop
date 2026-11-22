# Bucket setup

This page is for whoever sets up the bucket and its credentials. It covers what your bucket needs before browsers can
upload to it: the CORS rule, in R2's format and in the S3 format, the lifecycle rule that cleans up abandoned uploads,
the Wrangler commands that set both on R2 and the AWS CLI commands for any S3-compatible service, which credentials and
permissions cloudrop needs, and what `checkBucket` can and cannot report about all of this.

The [cloudrop command](command.md) does most of this for you: `npx cloudrop setup --origin <origin>` prints these rules
and commands for your origins, `--apply` adds the rules to the bucket and keeps every other rule, and
`npx cloudrop doctor --origin <origin>` checks the settings, the bucket and its rules. Both read the `CLOUDROP_*`
variables; when your app names its settings otherwise, `--var CLOUDROP_R2_BUCKET=R2_BUCKET` reads one from your
variable ([Your own variable names](command.md#your-own-variable-names)).

The rule lists the origin of the **page** that uploads, not the origin of your API: the browser sends the bytes from
the page. With the page and the API on different origins, see [Deployment](deployment.md).

## What any bucket needs

| Setting | Why |
| --- | --- |
| A CORS rule allowing `PUT` from your page's origin | Browsers upload to the bucket directly, from your page's origin. Without the rule, the browser blocks every upload. |
| The four headers cloudrop signs, in the rule's allowed headers | `content-type`, `content-disposition`, `if-none-match` and `x-amz-meta-cloudrop-id`. A preflight fails if one is missing. |
| `Retry-After` in the exposed headers (recommended) | The one header of the bucket's answer the client reads. It lets the client wait as long as the bucket asks after a `429` or `503`. Uploads work without it. |
| `ETag` in the exposed headers (optional) | Nothing in cloudrop reads it from a page: the client never reads `ETag`, and the server gets part ETags from the bucket when it completes an upload. The rules below expose it all the same, see [Why the rule exposes ETag](#why-the-rule-exposes-etag). |
| That rule before any other rule that allows `PUT` from your origin without exposing `Retry-After` | The service answers with the first rule that matches, never a later one: see [When the bucket has other CORS rules](#when-the-bucket-has-other-cors-rules). |
| A lifecycle rule that aborts incomplete multipart uploads | Parts of an upload that never finished are removed instead of staying stored. |

Add your production origin and, for development, your local origin such as `http://localhost:5173`. `GET` and `HEAD`
in the examples below are for reading files back from a page; uploads need only `PUT`.

### Why expose Retry-After

A browser hides every answer header the CORS rule does not expose. With `Retry-After` exposed, a retry after a `429` or
`503` waits at least as long as the bucket asks (at most 20 s). Without it, the client cannot read the header and waits
its own backoff alone: a random wait up to 0.5 s, then 1 s, 2 s and so on. R2 answers concurrent writes to one key with
`429` and `Retry-After: 5`, which a page cannot read when the rule omits it (measured 2026-11-16,
[findings](../research/r2-spike-findings.md#bad-checksum-gone-upload-and-throttling-from-a-browser-2026-11-16)).
Uploads work without it, so `checkBucket` reports `ok` either way; it names the rule that answers uploads without
exposing it, as advice.

### Why the rule exposes ETag

To upload, a bucket needs the first two rows of the table: `PUT` allowed from your origin with the four headers.
`Retry-After` is advice. `ETag` is neither: of the bucket's answer to a `PUT`, the client reads the status, the error
body and `Retry-After`, and nothing else. The rule that `cloudrop setup` writes and the examples below still expose
`ETag`, for two reasons. The rule cloudrop 0.5.0 wrote has it, so a bucket set up then is found complete and left as
it is. And other code on your page that sends a `PUT` to the bucket and reads the answer, such as your own `fetch` or
another uploader that completes multipart uploads from the browser, needs it. `checkBucket` and `cloudrop doctor` do
not look at `ETag`: a rule without it is `ok`.

### Checksum headers

If you add a checksum header to uploads, such as `x-amz-checksum-crc32c`, add it to the allowed headers too. A rule that
misses any header a `PUT` carries blocks that `PUT`.

### When the bucket has other CORS rules

The storage service answers each request with **the first rule, in stored order, that matches all of it**, and with
that rule alone. Rules are never merged, and a later rule is never looked at. R2 does this (measured 2026-11-21,
[findings](../research/r2-spike-findings.md#which-cors-rule-answers-when-several-match-2026-11-21)) and S3 documents
the same. A rule matches when it allows:

- the page's origin, written exactly as the browser sends it, or by a pattern with one `*` (`https://*.example.com`,
  or `*` for every origin);
- the method;
- for a preflight, every header the preflight lists, by name without case or by a pattern such as `x-amz-meta-*`.

What a page sends when it uploads with cloudrop:

| Request | What the rule is matched on |
| --- | --- |
| Preflight of a single `PUT` | The origin, `PUT`, and `content-disposition`, `if-none-match`, `x-amz-meta-cloudrop-id` and `content-type`. A browser leaves `content-type` out of the list for a type a form can send, such as `text/plain`, and never lists `content-length`. |
| Preflight of a part's `PUT` | The origin and `PUT`. A part carries no header. |
| The `PUT` itself | The origin and `PUT`. The answer's exposed headers come from this rule. |

So a rule that stands before cloudrop's and allows `PUT` from your origin, such as an old rule for every origin
(`*`), answers the `PUT` in its place. Uploads still work, but the page gets that rule's exposed headers: without
`Retry-After` there, retries after a `429` come too fast, whatever cloudrop's rule says, and `checkBucket` names that
rule as advice. **Put cloudrop's rule before any rule that allows `PUT` from your origins without exposing
`Retry-After`.** A rule for another origin, or one that answers uploads in full, can stay in front.

`cloudrop setup --apply` does that: a new `cloudrop-uploads` goes last, and an existing one stays where it stands,
unless an earlier rule allows `PUT` from one of your origins without exposing `Retry-After`: then cloudrop's rule goes
just before the first such rule, and the output names that rule and says why
([the command's guide](command.md#setup)). In a file you write by hand, the order of the rules is the order they are
tried in.

cloudrop's server signs no checksum header into an upload, so none is matched here.

## Set the CORS rule on R2

Setting CORS replaces the bucket's whole policy. Read the current rules first and keep any you still need, with
cloudrop's rule [before any that allows `PUT` from your origins without exposing
`Retry-After`](#when-the-bucket-has-other-cors-rules) (or let `cloudrop setup --apply` merge them):

```bash
npx wrangler r2 bucket cors list <bucket>
```

Write the rules to `cors.json` in R2's format, a `rules` array:

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://app.example.com", "http://localhost:5173"],
        "methods": ["PUT", "GET", "HEAD"],
        "headers": ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"]
      },
      "exposeHeaders": ["ETag", "Retry-After"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

Then apply it:

```bash
npx wrangler r2 bucket cors set <bucket> --file cors.json
```

Wrangler needs to be signed in to your Cloudflare account. Pass `--jurisdiction eu` (or `fedramp`) for a bucket in a
jurisdiction. A change can take up to 30 seconds to apply, in rare cases.

## Set the CORS rule on S3 and other services

The S3 format is a list of rules. It is the shape `examples/next` and cloudrop's R2 measurements use:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com", "http://localhost:5173"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"],
    "ExposeHeaders": ["ETag", "Retry-After"],
    "MaxAgeSeconds": 3600
  }
]
```

AWS's `PutBucketCors` API and the AWS CLI wrap that list in `CORSRules`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://app.example.com"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"],
      "ExposeHeaders": ["ETag", "Retry-After"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Wrangler refuses this `CORSRules` format: convert it to the `rules` format above for `wrangler r2 bucket cors set`.
To apply it with the AWS CLI, see [the next section](#set-both-rules-with-the-aws-cli).

## Set both rules with the AWS CLI

The AWS CLI sets the CORS rule and the lifecycle rule on AWS S3 and on S3-compatible services that implement these S3
calls (checked on RustFS). For a service other than AWS, point it at the service with `--endpoint-url`. Save the
`CORSRules` document above as `cors-s3.json` (not the R2 `cors.json`, whose format differs), and this as
`lifecycle.json`:

```json
{
  "Rules": [
    {
      "ID": "cloudrop-abort-incomplete",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

The empty prefix makes the rule apply to the whole bucket, which `checkBucket` requires. Then apply both:

```bash
# AWS CLI v2 reads AWS_REGION; v1 reads only AWS_DEFAULT_REGION, so set both.
export AWS_ACCESS_KEY_ID=<access key id> AWS_SECRET_ACCESS_KEY=<secret access key>
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
ENDPOINT=http://127.0.0.1:9000   # your service's S3 endpoint; leave out --endpoint-url for AWS S3

aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://cors-s3.json --endpoint-url "$ENDPOINT"
aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
  --lifecycle-configuration file://lifecycle.json --endpoint-url "$ENDPOINT"

# Read them back
aws s3api get-bucket-cors --bucket <bucket> --endpoint-url "$ENDPOINT"
aws s3api get-bucket-lifecycle-configuration --bucket <bucket> --endpoint-url "$ENDPOINT"
```

Both commands replace the bucket's whole CORS or lifecycle configuration, so merge in any rules it already has, with
cloudrop's CORS rule [before any that allows `PUT` from your origins without exposing
`Retry-After`](#when-the-bucket-has-other-cors-rules). The credentials need permission to change bucket settings, which
upload credentials often lack. Use an admin key for this step, not the key you give cloudrop. These commands were
checked against RustFS, with `checkBucket` reporting both rules `ok` afterwards.

## Add the lifecycle rule

An upload that is never completed or aborted leaves its parts in the bucket. The client sends `/abort` when it can, but
a closed tab or a crash can leave parts behind, and so can an upload whose 24-hour token expired. A lifecycle rule that
aborts incomplete multipart uploads removes them.

On R2, new buckets get a 7-day rule by default. Check what yours has:

```bash
npx wrangler r2 bucket lifecycle list <bucket>
```

Add one if it is missing, for the whole bucket:

```bash
npx wrangler r2 bucket lifecycle add <bucket> cloudrop-abort-incomplete --abort-multipart-days 1
```

On S3 and other services, set it with [the AWS CLI](#set-both-rules-with-the-aws-cli).

`cloudrop-abort-incomplete` is the name `cloudrop setup --apply` gives the rule. The name is yours to choose:
`checkBucket` and `cloudrop doctor` accept any enabled rule that applies to the whole bucket (no prefix) and aborts
incomplete multipart uploads, whatever its name and its number of days. The example's RustFS setup uses one day.

## Credentials and permissions

The server needs credentials that can, in the bucket:

- write objects and run multipart uploads (create, upload parts, list parts, complete, abort), and sign upload URLs for
  them;
- read object metadata (`HEAD`) and objects (for `api.getUrl`);
- delete objects (rejected and aborted uploads, `api.deleteObject`, `api.deletePrefix`);
- list objects (`api.deletePrefix`).

On R2, an API token with **Object Read & Write** permission on the bucket does all of this; cloudrop's live tests run
with one. Create it in the Cloudflare dashboard under R2, then pass its access key ID and secret access key to `r2()` or
set `CLOUDROP_R2_ACCESS_KEY_ID` and `CLOUDROP_R2_SECRET_ACCESS_KEY`.

An Object Read & Write token cannot read the bucket's CORS or lifecycle settings (R2 answers `403 AccessDenied`), so
`checkBucket` reports those as `unknown`. Check them with Wrangler or in the dashboard instead.

The browser never sees any of these credentials: it gets only presigned URLs, each for one object, one method and 15
minutes.

## What checkBucket can tell you

```ts
const { data: report, error } = await cloudrop.api.checkBucket({ origins: ["https://app.example.com"] });
```

| Check | `ok` when | Reported `unknown` when |
| --- | --- | --- |
| `cors` | For every origin, a rule answers each preflight of cloudrop's `PUT`s: that is all an upload needs. Otherwise it is a `problem`, since the browser blocks every upload from that origin. | The credentials may not read CORS (R2 object tokens), the storage cannot report it (Wrangler's local R2 answers `501`), or no origin was given. |
| `lifecycle` | An enabled rule for the whole bucket aborts incomplete multipart uploads. | The credentials may not read lifecycle rules, or the storage cannot report them. Origins do not matter here. |
| `publicAccess` | No private route stores files on a bucket with a `publicUrl`. | Never: this check reads only your configuration. |

It judges the rule the service answers with, the first that matches
([When the bucket has other CORS rules](#when-the-bucket-has-other-cors-rules)), not any rule that would do. A rule
that answers uploads without exposing `Retry-After` is named as advice, by its ID or its place among the rules, with
the rule after it that would have exposed it: the check stays `ok`, since uploads work without it, its `message` ends
with the advice, and `advice` holds the advice alone. `ETag` is not looked at.

What it does not check:

- `GET` and `HEAD` from your pages;
- checksum headers you add;
- what an R2 admin read token would show: R2's answers to one have not been measured yet.

Any other storage failure fails the call with an error instead of a report.

In development (`NODE_ENV=development`, exactly), the handler's first request runs `checkBucket` once in the background
for its own origin and `trustedOrigins`, and logs a warning for each problem.

## Local development

- **RustFS:** `bun run setup:rustfs` in [`examples/next`](../../examples/next/README.md#run-with-rustfs-the-default)
  creates a bucket with the CORS rule and the lifecycle rule.
- **Wrangler's local R2:** needs no CORS rule (it lets any `localhost` page upload), and cannot complete multipart
  uploads. See [Troubleshooting](troubleshooting.md#multipart-uploads-fail-on-wranglers-local-r2).
