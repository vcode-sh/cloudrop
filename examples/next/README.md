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
./node_modules/.bin/wrangler dev --config fixtures/wrangler/wrangler.jsonc --ip 127.0.0.1 --port 18787 \
  --persist-to fixtures/wrangler/.state
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

## Lab page

<http://localhost:5173/lab> shows how an upload works, request by request and byte by byte. It uses the same
`cloudrop/client` as the quickstart page; the library itself is unchanged.

- **Setup:** the demo sign-in, and which storage the server uploads to and its host, from `app/api/lab-info/route.ts`.
  That route is demo-only, like the sign-in: it names no credential or bucket, but a real app has no reason to tell
  visitors where it stores files.
- **Files:** choose several with the file input, or add 1 KiB, 5 MiB, 20 MiB or 100 MiB of random bytes made in the
  browser, as often as you like. **Upload** sends the whole list as one job, `client.start("files", files, { signal })`:
  one `/upload`, then each file through the client's pool of connections.
- **Connections and order:** each run creates its client with the chosen `concurrency` and `order`. **Connections** is
  `auto` (the default: starts at 4, adds one every 2 s while the bytes sent per second rise by 10 % or more and PUTs
  wait, up to 8, and halves after a network error, a stalled PUT or a busy bucket) or a fixed 1, 2, 4, 8 or 16; a file
  never has more than 4 parts in flight. **Order** is `added` or `smallest-first`, which sends the smallest file's
  waiting PUTs first. The client does not publish its pool size, so **PUTs in flight** counts the bucket PUTs the lab's
  wrappers have started and not yet seen end, the injected delay included.
- **Transport:** for the length of a run or a retry the lab wraps `window.fetch`, recording the calls to
  `/api/cloudrop/` and passing anything else through, and `window.XMLHttpRequest`, recording the bucket PUTs, which the
  client sends with XMLHttpRequest in a browser so that the bars move while bytes leave. When it ends both are put back.
  **Send PUTs with fetch** instead passes the lab's fetch as the client's `fetch` option and wraps nothing: the client
  then sends everything through it, and a PUT's bytes count only once the bucket answers, so a bar moves a part at a
  time.
- **Progress:** a row per file from the job's snapshot (`useSyncExternalStore(job.subscribe, job.getSnapshot)`): its
  bar, bytes sent, speed, time left and status, with Pause, Resume and Cancel for that file, and a row of totals. The
  job's own **Pause**, **Resume** and **Cancel** act on every file; Cancel aborts the job's signal. When the browser
  goes offline the client pauses the files that are queued or uploading, which then show `paused`, and resumes them when
  it is back online; a job started offline pauses at once.
- **Retry:** once a run has ended, **Retry** in a failed file's row calls that handle's `retry()`, and **Retry** in the
  totals row calls `job.retry()`. A failed file keeps its ticket and the parts that landed, so a retry sends only the
  missing parts and `/complete`; after an error the ticket cannot fix (`UPLOAD_REJECTED`, `UPLOAD_EXPIRED`,
  `INVALID_TOKEN`, `VERIFICATION_FAILED`) or once the ticket expired, it asks `/upload` for a new ticket and a new key,
  and the file's bytes start again from 0. The retry's requests join the same table and the summary shows the files'
  latest outcomes, with the time counted from Upload.
- **Faults:** fail the next bucket PUT with a network error (the client waits, renews the URL once and sends it again),
  answer the next `/upload` or `/sign` with 503 (the client backs off and retries), delay every bucket PUT (so a 100 MiB
  file shows four parts in flight, and Pause has PUTs to stop), and drop the answer of the next `/complete` (the client
  retries it, and from then on a cancel or failure keeps the file). The network error, the 503 and the dropped answer
  untick themselves after one hit. Two more hold until unticked, to fail a file for Retry: every PUT of part 2 gets a
  network error (the client renews its URL once and makes 6 attempts, up to about 15 s of waits, then the file fails
  with `NETWORK_ERROR` and keeps its ticket), and the lab answers every bucket PUT with 400 in the bucket's place,
  sending nothing (the file fails at once with `UPLOAD_REJECTED`, which needs a new ticket). Each line on the page names
  the decision behind the behaviour.
- **Requests:** one row per request in the order they started (`/upload`, `/sign`, `PUT single`, `PUT part n`,
  `/complete`, `/abort`), with its status, time, body size, a note for retries, renewals, PUTs resumed after a pause, an
  `/upload` for a new ticket and injected faults, and a bar on a shared timeline. The log keeps only the request's kind,
  the bucket host, the part number, status, times and body size: never a URL, header or token, so no presigned URL
  reaches the page. Requests are recorded only while a run or a retry is going: an `/abort` the client has to send again
  after that is not in the table.
- **Summary:** total time, the files' size, the bytes of the PUTs the bucket answered, end-to-end throughput in MiB/s
  (not shown under 1 MiB, where round trips dominate, or after a retry), PUT requests started and answered, retries,
  renewals, peak PUTs in flight, the job's `{ data, error }` with an outcome per file, and one sentence that tells the
  run.

Against RustFS, start the container and run `bun run setup:rustfs` and `bun run dev` as in "Run with RustFS" above, then
open `/lab`. Against R2, set the variables from "Run with R2"; the bucket's CORS rule must allow
`http://localhost:5173`, or every bucket PUT shows as a network error. Against Wrangler, only the 1 KiB and 5 MiB files
work: the 20 and 100 MiB files go in parts, and their `/complete` fails with `STORAGE_ERROR` (see "Run with Wrangler").

The numbers come from one browser on one network: they show how the client behaves, not a benchmark of the storage.

## The browser tests

`app/upload.browser.test.ts` uploads a 14-byte file in one `PUT`, a 20 MiB file in three parts, and the same file chosen
twice, from Chromium's headless shell. `app/lab.browser.test.ts` checks that the lab page shows a 20 MiB upload as three
parts, a dropped bucket PUT as renewed and retried, a cancel during a delay as nothing sent, a paused file resumed with
each part stored once, and three files in one job, and that no signed URL reaches the page. Three rows throttle uploads
to 4 MiB/s through Chromium's DevTools protocol. Two sample a bar every 100 ms: through XMLHttpRequest it rises in small
steps to the file's size; with PUTs sent through fetch it moves a part at a time. The third sets the emulated network
offline during a 20 MiB upload: the page's `offline` event pauses the file with no PUT in flight, and back online each
part is sent again and the file completes. Two more rows upload a 20 MiB file and then a 1 KiB file with one connection
and every PUT delayed by a second: with `smallest-first` the 1 KiB file completes first, with `added` the 20 MiB file
does. Two rows retry a failed file: a 20 MiB file whose part 2 fails until the budget runs out is retried with its
ticket, so the table shows no new `/upload` and only part 2 and `/complete` sent again; a 1 KiB file refused with 400 is
retried with a new ticket, through a second `/upload`. Run them from the repository root; install the shell once from
this directory with `bunx playwright install --only-shell chromium`.

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
