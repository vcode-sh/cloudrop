# cloudrop Next.js example

A Next.js app router application that mounts cloudrop's server and uploads from the browser straight to a bucket:

- `lib/cloudrop.ts` creates the server with one route, `files`, that only a signed-in user may use.
- `app/api/cloudrop/[...all]/route.ts` mounts it: `export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);`.
- `app/page.tsx` uploads with `cloudrop/client`. It imports only the server's type, so the server module and its
  secret never reach the browser bundle.
- `app/api/demo-sign-in/route.ts` signs the visitor in as the demo user: the page's sign-in form posts there, and it
  answers with an `HttpOnly` cookie, `demo-user=demo`, that `authorize` reads.

Files up to 8 MB go in one PUT; larger files go in parts of 8 MiB, so a 20 MiB file is three parts.

The demo sign-in must never ship: any visitor can set that cookie to any name and upload under that user's prefix. A
real application reads its own signed session in `authorize`.

Prerequisites: Docker (for RustFS), Bun and Node.js 24 (Next.js runs on the `node` on your `PATH`). Run every command
below from this directory unless it says otherwise.

## The build needs the settings

`next build` loads `lib/cloudrop.ts`, so `CLOUDROP_SECRET` and the storage settings must be set when building, from
`.env.local` or the environment. A build without them fails with `INVALID_CONFIG` naming what is missing. Exported
variables win over `.env.local`. A build that has no secrets (a Docker build stage with secrets only at run time) must
pass them as build secrets, or it fails with `INVALID_CONFIG`.

## Run with RustFS (the default)

```sh
(cd ../.. && bun install)     # once, after cloning
CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs ../../scripts/rustfs.sh up
(cd ../.. && bun run build)   # builds the cloudrop package the example imports
bun run setup:rustfs
bun run dev
```

Open <http://localhost:5173>. Choose a file before signing in to see the `UNAUTHORIZED` answer, then select
"Sign in as the demo user" (the page reloads) and choose a file again.

`bun run setup:rustfs` creates the bucket `cloudrop-example`, sets its CORS rule, checks that a browser preflight from
`http://localhost:5173` is allowed, sets a lifecycle rule that aborts incomplete multipart uploads after a day, and
writes `.env.local` with a fresh `CLOUDROP_SECRET` and the RustFS settings (it keeps an existing `.env.local`). It
talks to `http://127.0.0.1:19000` unless `CLOUDROP_S3_ENDPOINT` says otherwise. If it stops with "RustFS did not accept
the CORS rule", browsers cannot upload to that bucket: check that the container is the RustFS version
`scripts/rustfs.sh` starts.

When you are done:

```sh
CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs ../../scripts/rustfs.sh down
rm .env.local   # it points at the container you just removed
```

## Run with Wrangler (single uploads only)

Start Wrangler's local R2 as the Wrangler lane does, from `packages/cloudrop`:

```sh
./node_modules/.bin/wrangler dev --config fixtures/wrangler/wrangler.jsonc --ip 127.0.0.1 --port 18787 --persist-to fixtures/wrangler/.state
```

Then put these settings in `.env.local` (with your own `CLOUDROP_SECRET`, for example from
`openssl rand -base64 32`):

```sh
CLOUDROP_SECRET=<32 random bytes, base64>
CLOUDROP_S3_ENDPOINT=http://127.0.0.1:18787/cdn-cgi/local/r2/s3
CLOUDROP_S3_REGION=auto
CLOUDROP_S3_BUCKET=contract
CLOUDROP_S3_ACCESS_KEY_ID=cloudrop-local
CLOUDROP_S3_SECRET_ACCESS_KEY=cloudrop-local-secret
```

No CORS rule is needed: Wrangler lets any `localhost` page upload. A file above 8 MB fails at the end with
`STORAGE_ERROR: The storage service refused the request. Contact the site owner if this keeps happening.`: Wrangler's
local R2 does not implement ListParts, which the server needs to verify a multipart upload (the server log says "The
storage service does not support this request"). The client then sends `/abort`, which removes the parts; if a run
was interrupted before that, stop Wrangler and delete `packages/cloudrop/fixtures/wrangler/.state` to clear them.
`api.checkBucket` there reports CORS and lifecycle as unknown: Wrangler cannot report bucket settings.

Delete `.env.local` before switching back to RustFS: Bun loads it before `bun run setup:rustfs` runs, so the script
would talk to Wrangler and keep the Wrangler settings.

## Run with R2

Leave `CLOUDROP_S3_ENDPOINT` unset or empty and set `CLOUDROP_SECRET`, `CLOUDROP_R2_BUCKET`,
`CLOUDROP_R2_ACCOUNT_ID`, `CLOUDROP_R2_ACCESS_KEY_ID` and `CLOUDROP_R2_SECRET_ACCESS_KEY`. The bucket needs a CORS
rule for this example's origin, in the S3 JSON shape (setting CORS replaces the bucket's whole policy, so keep any
rule it already has):

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173", "http://127.0.0.1:5173"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## The browser tests

`app/upload.browser.test.ts` uploads a 14-byte file in one `PUT`, a 20 MiB file in three parts, and the same file
chosen twice, from Chromium's headless shell. Run it from the repository root; install the shell once from this
directory with `bunx playwright install --only-shell chromium`.

- `bun run test:browser` starts its own RustFS container (port 19100, `CLOUDROP_RUSTFS_PORT` changes it), builds and
  serves this example on port 5173, and removes the container afterwards. It needs Docker, no credentials, and leaves
  any `.env.local` alone.
- `bun run test:browser:live` runs the same tests on a real R2 bucket, with the credentials `bun run test:live` reads
  (`CLOUDROP_R2_ENV_FILE`). The bucket's CORS rule must allow `http://localhost:5173`, as above. Everything it uploads
  goes under a random `live-test/cloudrop-<hex>/` prefix, which it deletes at the end.

## What any bucket needs

- A CORS rule like the one above: your page's origin, `PUT`, and the four headers cloudrop's signed uploads carry.
- `ETag` in `ExposeHeaders`: `checkBucket` asks for it, and resumable uploads will read it.
- A lifecycle rule that aborts incomplete multipart uploads, so parts of an upload that never finished do not stay
  in the bucket.

In development the server checks the bucket once and logs a warning for each of these that is missing.
