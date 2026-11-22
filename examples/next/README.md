# cloudrop Next.js example

A Next.js app router application that mounts cloudrop's server and uploads from the browser straight to a bucket:

- `lib/cloudrop.ts` creates the server with one route, `files`, that only a signed-in user may use.
- `app/api/cloudrop/[...all]/route.ts` mounts it: `export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);`.
- `app/page.tsx` is an upload UI built on `useUpload` and `useResumable` from `lib/upload.ts`, which creates the
  `cloudrop/react` hooks ("Home page" below). They import only the server's type, so the server module and its secret
  never reach the browser bundle.
- `app/api/demo-sign-in/route.ts` signs the visitor in as the demo user: the page's sign-in form posts there, and it
  answers with an `HttpOnly` cookie, `demo-user=demo`, that `authorize` reads.
- `lib/store.ts` is the opt-in database store, off unless `CLOUDROP_EXAMPLE_STORE` is set ("Run with a database
  store").

Files up to 8 MiB go in one PUT; larger files go in parts of 8 MiB, so a 20 MiB file is three parts.

The demo sign-in must never ship: any visitor can set that cookie to any name and upload under that user's prefix. A
real application reads its own signed session in `authorize`.

Prerequisites: Docker (for RustFS), Bun and Node.js 26 (Next.js runs on the `node` on your `PATH`). Run every command
below from this directory unless it says otherwise.

The settings come from `.env.local` or the environment; exported variables win over `.env.local`. `next build` needs
none of them: cloudrop reads `CLOUDROP_SECRET` and the storage settings on the first request, so a build without
secrets works and only the running server needs them. A server started without them answers every upload with
`SERVER_ERROR` (HTTP 500) and logs what is missing once. `bun run dev` runs with `NODE_ENV=development`, which checks
them as soon as the server module loads.

## Run with RustFS (the default)

```sh
(cd ../.. && bun install)     # once, after cloning
CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs ../../scripts/rustfs.sh up
(cd ../.. && bun run build)   # builds the cloudrop package the example imports
bun run setup:rustfs
bun run dev
```

Open <http://localhost:5173>. Drop or choose a file before signing in: its row shows `UNAUTHORIZED: Sign in as the demo
user first.` Then select "Sign in as the demo user" (the page reloads) and upload again.

`bun run setup:rustfs` creates the bucket `cloudrop-example`, sets its CORS rule (exposing `ETag` and `Retry-After`),
checks that a browser preflight from `http://localhost:5173` is allowed, sets a lifecycle rule that aborts incomplete
multipart uploads after a day, and writes `.env.local` with a fresh `CLOUDROP_SECRET` and the RustFS settings (it
keeps an existing `.env.local`). It talks to `http://127.0.0.1:19000` unless `CLOUDROP_S3_ENDPOINT` says otherwise.
If it stops with "RustFS did not accept the CORS rule", browsers cannot upload to that bucket: check that the
container is the RustFS version `scripts/rustfs.sh` starts.

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

No CORS rule is needed: Wrangler lets any `localhost` page upload. A file above 8 MiB fails at the end with
`STORAGE_ERROR: The storage service refused the request. Contact the site owner if this keeps happening.`: Wrangler's
local R2 does not implement ListParts, which the server needs to verify a multipart upload (the server log says "The
storage service does not support this request"). The failure is not retryable, so nothing is kept for a resume: the
page keeps the failed file's ticket and parts for a retry until you reload or leave it, and then the client sends
`/abort`, which removes the parts. If a run was interrupted before that, stop Wrangler and delete
`packages/cloudrop/fixtures/wrangler/.state` to clear them.
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
    "ExposeHeaders": ["ETag", "Retry-After"],
    "MaxAgeSeconds": 3600
  }
]
```

## Run with a database store

By default the example is stateless: the upload token carries everything, and nothing is written anywhere. Set
`CLOUDROP_EXAMPLE_STORE` to keep a row per upload in SQLite through `node:sqlite` (no native build), with any of the
storage setups above:

```sh
CLOUDROP_EXAMPLE_STORE=sqlite bun run dev           # .data/cloudrop.db, git-ignored
CLOUDROP_EXAMPLE_STORE=/path/to/uploads.db bun run dev
```

`lib/store.ts` opens the file, creates cloudrop's tables from `lib/cloudrop-tables.sql` and the app's own
`example_uploads` table, and passes `sqlStore(sqliteExecutor(database))` to `createCloudrop`. A database file made
before the `request_key` column existed stops the start with "no such column: request_key": delete `.data/cloudrop.db`
(or your own file) after upgrading. With it:

- each user's uploads count toward a quota, 500 MB unless `CLOUDROP_EXAMPLE_QUOTA_MB` says otherwise; a file that does
  not fit is refused with `QUOTA_EXCEEDED` before a byte is sent;
- the route's `owner` is the demo user, and `onComplete` records the upload in `example_uploads` once, however often
  the client repeats `/complete`;
- `afterComplete` logs one line per completed upload, after its record is written;
- the lab page shows the user's storage and finished uploads from `app/api/usage/route.ts`, which calls
  `cloudrop.api.usage`.

The [store guide](../../docs/guide/store.md) explains each of these and what changes in production.

## Home page

The home page is what an app's upload UI looks like when it is built on the headless hooks. cloudrop ships no components
(decision `M4-E1`); the [React guide](../../docs/guide/react.md#build-your-upload-ui) walks through this page.

- **Stack:** shadcn on Base UI (`components.json`: style `base-luma`, icon library `tabler`), Tailwind v4 through
  `@tailwindcss/postcss`, and `@tabler/icons-react`. `components/ui/` holds the CLI's `attachment`, `button` and
  `progress` as generated: they are not edited by hand and Biome skips them. `app/globals.css` is imported by
  `app/page.tsx` alone, so Tailwind's base styles never reach `/lab`.
- **`components/upload/drop-zone.tsx`:** a label with `getDropProps()` around a hidden input with `getInputProps()`.
  Click it or drop files on it; Tab reaches the input and Enter opens the file picker.
- **`components/upload/upload-list.tsx` and `upload-row.tsx`:** a row per file as an `Attachment`, its state mapped from
  the file's status (`file-status.ts`), with its bar, bytes, speed, time left, the stored key or the error's code and
  message, and the buttons its status allows: Pause or Resume (one button, so keyboard focus stays on it), Retry and
  Cancel (which move focus to the row). Above the rows, the totals with Pause all, Resume all, Retry failed, Cancel all
  and Clear finished, each enabled only when it would act on a file. A visually hidden status line tells screen
  readers the count and the progress in steps of 10 %.
- **`components/upload/unfinished-uploads.tsx`:** after a reload, the multipart uploads this browser can continue, each
  with **Pick again**: the same file resumes and sends only the parts the bucket lacks, another file is refused and
  shows as a failed row. **Discard** on a row, and **Discard all**, call `useResumable`'s `discard()`: the server aborts
  the upload (with a store, its row ends and its reserved bytes are free again) but keeps a file whose `/complete`
  finished (without a store, any file that landed), and the browser's record is deleted, without the file. A discard that fails shows its message, and the upload stays
  listed. Focus moves to the next row's Discard, or to the drop zone when the panel empties.

## Lab page

<http://localhost:5173/lab> shows how an upload works, request by request and byte by byte. It uses the same
`cloudrop/client` as the home page; the library itself is unchanged.

- **Setup:** the demo sign-in, and which storage the server uploads to and its host, from `app/api/lab-info/route.ts`.
- **Your storage:** with a database store, the bytes used and reserved against the quota and the finished uploads with
  how many times `onComplete` ran for each (always 1); without one, a line saying how to turn it on.
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
  totals row calls `job.retry()`. A failed file keeps its ticket and the parts already stored in the bucket, so a retry sends
  only the missing parts and `/complete`; after an error the ticket cannot fix (`UPLOAD_REJECTED`, `UPLOAD_EXPIRED`,
  `INVALID_TOKEN`, `VERIFICATION_FAILED`, `NO_SUCH_UPLOAD`) or once the ticket expired, it asks `/upload` for a new ticket and a new key,
  and the file's bytes start again from 0. The retry's requests join the same table and the summary shows the files'
  latest outcomes, with the time counted from Upload.
- **Unfinished uploads:** the multipart uploads this browser saved and has not finished, from
  `client.resumable("files")`, read when the page loads and after each run and retry: name, size and when the ticket
  expires, never its token, key or metadata. Each has a file input, **Resume** with the file's name, that takes the same
  file from disk and calls `client.resume(upload, file, { signal })` as a run of its own, into the Files and Requests
  tables and the summary: its first request is `/complete`, which says which parts the bucket lacks, then one `/sign`
  for their URLs, those parts alone and `/complete` again. A resume refused before any request shows the client's
  message in the status line: another file than the one the upload started with, an upload that finished or expired, or
  one still being sent by this page or another tab of the browser. The list leaves out an upload this page still holds:
  a file being sent, or a failed one kept for **Retry** (M4-F22). **Forget unfinished uploads** calls
  `client.forget()`, what an app calls at sign-out; it deletes the records, not the uploads. The lab's clients use the
  default namespace: the demo has one user, and its sign-in cookie is `HttpOnly`, so the page cannot read who it is.
- **Faults:** fail the next bucket PUT with a network error (the client waits, renews the URL once and sends it again),
  drop the answer of the next bucket PUT (the bucket stores the bytes, the client sends the PUT again, and a single PUT
  then gets `412`, which the client counts as stored), answer the next `/upload` or `/sign` with 503 (the client backs
  off and retries), delay every bucket PUT (so a 100 MiB file shows four parts in flight, and Pause has PUTs to stop),
  and drop the answer of the next `/complete` (the client retries it, and from then on a cancel or failure keeps the
  file). Through the lab's XMLHttpRequest each network error comes after half the PUT's body was sent, as a lost
  connection does; with **Send PUTs with fetch** it comes with no progress, since fetch reports none. The network error,
  the dropped answers and the 503 untick themselves after one hit. Three more hold until unticked, to fail a file for
  Retry: every PUT of part 2 gets a network error (the client renews its URL once and makes 6 attempts, up to about 15 s
  of waits, then the file fails with `NETWORK_ERROR` and keeps its ticket); every bucket PUT is blocked before any byte
  leaves, as by a CORS rule that misses the page (the client renews the URL once and makes the same 6 attempts, then the
  file fails with `BUCKET_BLOCKED`, retryable, and keeps its ticket, or, with fetch, with `NETWORK_ERROR`); and the lab
  answers every bucket PUT with 400 in the bucket's place, sending nothing (the file fails at once with
  `UPLOAD_REJECTED`, which needs a new ticket). A fourth holds every `/complete` answer: the lab forwards the request
  and the server finishes the file, but the page hears nothing and shows the `/complete` in flight until the box is
  unticked; a reload before then drops the answer unheard and leaves the file stored, for a resume to find. Each line on
  the page names the decision behind the behaviour.
- **Requests:** one row per request in the order they started (`/upload`, `/sign`, `PUT single`, `PUT part n`,
  `/complete`, `/abort`), with its status, time, body size, a note for retries, renewals, PUTs resumed after a pause, an
  `/upload` for a new ticket, a `412` PUT whose object was already stored, a resume's first `/complete` and the `/sign`
  for its missing parts, and injected faults, and a bar on a shared timeline. A request the client stopped shows
  `cancelled` when you paused or cancelled, or the browser went offline, and `stalled` when the client gave up on it
  by itself after 30 s without progress; the client's own retry of a stalled PUT is a `retry`, of a cancelled one
  `resumed`. The log keeps only the request's kind, the bucket host, the part number, status, times and body size: never
  a URL, header or token, so no presigned URL reaches the page. Requests are recorded only while a run or a retry is
  going: an `/abort` the client has to send again after that is not in the table.
- **Summary:** total time, the files' size, the bytes of the PUTs the bucket answered, end-to-end throughput in MiB/s
  (not shown under 1 MiB, where round trips dominate, after a retry, or for a resume, which sends only the missing
  parts), PUT requests started and answered, retries, renewals, peak PUTs in flight, the job's `{ data, error }` with an
  outcome per file, and one sentence that tells the run.

Against RustFS, start the container and run `bun run setup:rustfs` and `bun run dev` as in "Run with RustFS" above, then
open `/lab`. Against R2, set the variables from "Run with R2"; the bucket's CORS rule must allow
`http://localhost:5173`, or every bucket PUT shows as a network error. Against Wrangler, only the 1 KiB and 5 MiB files
work: the 20 and 100 MiB files go in parts, and their `/complete` fails with `STORAGE_ERROR` (see "Run with Wrangler").

The numbers come from one browser on one network: they show how the client behaves, not a benchmark of the storage.

## The browser tests

`app/upload.browser.test.ts` drives the home page from Chromium's headless shell: a 14-byte file picked and sent in one
`PUT`, a 20 MiB file dropped on the zone and sent in three parts, and the same 1 MiB file chosen twice, by a click and
by Tab and Enter, each row showing the key it was stored under and the object read back. A file chosen before sign-in
shows `UNAUTHORIZED` and the server's message; a file the bucket answers with 400 shows `UPLOAD_REJECTED` and its
message, and **Retry** stores it. With a 20 MiB upload's PUTs held, Enter on Pause leaves focus on Resume and back, and
Enter on **Cancel** moves focus to the row, shows Cancelled and sends `/abort`. A 20 MiB file whose parts 2 and 3 are
held is reloaded after part 1: the unfinished-uploads panel lists it, another file picked there is refused with
`INVALID_INPUT`, and the same file resumes with only parts 2 and 3 and reads back equal. Of two uploads left unfinished,
Enter on one row's **Discard** sends `/abort` (answered 200) and moves focus to the other row's Discard, and a reload
lists only the other, which still resumes. The faults come from Playwright's routing of the bucket's requests, so these
rows run on R2 too; their helpers are in `app/home-page.ts`.

`app/lab.browser.test.ts` checks that the lab page shows a 20 MiB upload as three
parts, a dropped bucket PUT as renewed and retried, a PUT whose answer was dropped as sent again and answered `412` with
the note "already stored", a cancel during a delay as nothing sent, a paused file resumed with each part stored once,
and three files in one job, and that no signed URL reaches the page. Three rows throttle uploads to 4 MiB/s through
Chromium's DevTools protocol. Two sample a bar every 100 ms: through XMLHttpRequest it rises in small steps to the
file's size; with PUTs sent through fetch it moves a part at a time. The third sets the emulated network offline during
a 20 MiB upload: the page's `offline` event pauses the file with no PUT in flight, and back online each part is sent
again and the file completes. Two more rows upload a 20 MiB file and then a 1 KiB file with one connection and every PUT
delayed by a second: with `smallest-first` the 1 KiB file completes first, with `added` the 20 MiB file does. Two rows
retry a failed file: a 20 MiB file whose part 2 fails until the budget runs out is retried with its ticket, so the table
shows no new `/upload` and only part 2 and `/complete` sent again; a 1 KiB file refused with 400 is retried with a new
ticket, through a second `/upload`. `app/lab-reload.browser.test.ts` resumes after a reload, with a 20 MiB file of fixed
bytes written once to Playwright's output directory (`test-results/`) and chosen through the file input, so a reload
picks the same file with the same `lastModified`. With one connection and every PUT delayed by a second, the page
reloads once part 1 is stored; the upload is listed, and picking the same file sends `/complete` (answered `409`, parts
2 and 3 missing), one `/sign` for those two, their PUTs and `/complete`, and the object read back equals the file. With
`/complete` answers held, the page reloads while the object is already in the bucket, and the resume sends `/complete`
alone and gets the same key. Picking a different file shows the client's "This is not the file the upload started with"
and sends nothing, and the upload still resumes with the right file. A second page of the same browser that resumes an
upload the first page is still sending shows "This upload is being sent in this browser". After a reload leaves an
upload listed, **Forget unfinished uploads** empties the list, which stays empty after another reload; the test then
aborts that multipart upload through the example's storage, so the bucket keeps nothing. The helpers
the lab's tests share are in `app/lab-page.ts`.

`app/lab.store.browser.test.ts` runs in a second pass, with the database store on and a quota of 50 MB. A 20 MiB file
whose `/complete` answer was held is resumed after a reload: the resume's `/complete` is answered from the row, the
user's usage grows by the file's size once, and `onComplete` recorded it once. A 51 MiB file is refused with
`QUOTA_EXCEEDED` after `/upload` alone, and the usage does not change. `app/upload.store.browser.test.ts`, in the same
pass, leaves a 20 MiB upload unfinished on the home page, whose reserved bytes then show in the usage, and **Discard**
frees them: the usage equals what it was before, and focus is on the drop zone. The first pass runs every other file on
the stateless example. The same pass runs `app/bucket-faults.chaos.browser.test.ts` and
`app/lab-blocked.browser.test.ts` on Firefox and WebKit too, since how an engine reports upload progress decides between
`BUCKET_BLOCKED` and `NETWORK_ERROR` (`M12-R60`, `M12-R61`); the row that throttles through Chromium's DevTools protocol
(tagged `@cdp`) runs on Chromium alone. Run them from the repository root; install the browsers once from this directory
with `bunx playwright install --only-shell chromium` and `bunx playwright install firefox webkit`.

- `bun run test:browser` starts its own RustFS container (port 19100, `CLOUDROP_RUSTFS_PORT` changes it), builds and
  serves this example on port 5173 once per pass, and removes the container and the store pass's database afterwards.
  It needs Docker, no credentials, and leaves any `.env.local` alone. A pass that selects no tests fails the run,
  unless you named files on the command line.
- `bun run test:browser:live` runs the same tests on a real R2 bucket, with the credentials `bun run test:live` reads
  (`CLOUDROP_R2_ENV_FILE`). The bucket's CORS rule must allow `http://localhost:5173`, as above. Everything it uploads
  goes under a random `live-test/cloudrop-<hex>/` prefix, which it deletes at the end.

## What any bucket needs

- A CORS rule like the one above: your page's origin, `PUT`, and the four headers cloudrop's signed uploads carry,
  exposing `ETag` and `Retry-After`.
- A lifecycle rule that aborts incomplete multipart uploads, so parts of an upload that never finished do not stay
  in the bucket.

In development the server checks the bucket once and logs a warning when the CORS rules block the origin (no rule for
it, or one that misses a signed header), when the lifecycle rule is missing, or when a private route stores files on
a public bucket. Uploads work without the exposed headers, so it logs nothing about them; `cloudrop doctor` names a
rule that keeps `Retry-After` from the page. The exact rules for R2 (in Wrangler's format too) and S3, the commands that set them and the
token permissions: [Bucket setup](../../docs/guide/bucket-setup.md).
