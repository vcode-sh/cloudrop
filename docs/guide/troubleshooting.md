# Troubleshooting

This page is for anyone whose uploads fail, in development or in production. It lists symptoms you may meet while
setting up or running cloudrop, the usual cause of each, and how to fix it. Each section starts with what you see. For
the meaning of every error code, see [Errors](errors.md).

## Every upload ends in NETWORK_ERROR

You see `NETWORK_ERROR` with "The file could not reach the storage service, or the storage service refused it" on every
upload, although the connection works and the calls to your server succeed.

**Check the bucket's CORS rule first.** A rule that misses the page's origin, or one of the headers cloudrop signs (or a
checksum header you add), blocks every `PUT`. The browser hides the reason from the page, so the client sees a network
failure and gives up only after its retry budget.

- The browser console names what was blocked: the origin or the header.
- `cloudrop.api.checkBucket({ origins: ["https://app.example.com"] })` checks the rule, when the credentials may read
  it. An R2 object token cannot, and reports `unknown`.
- The rule must allow `PUT` from the exact origin of the page, with `content-type`, `content-disposition`,
  `if-none-match` and `x-amz-meta-cloudrop-id`. The full rule: [Bucket setup](bucket-setup.md).

Other causes that look the same from a page: R2 answers a refused upload URL (expired, or a bad signature) without CORS
headers, so the browser cannot read that answer either. The client renews the URL once and tries again before it gives
up.

## Every request gets ORIGIN_NOT_ALLOWED

Your pages get `ORIGIN_NOT_ALLOWED` ("This site may not upload here") from your own server, and the server log shows
"refused a request from https://app.example.com, but this server sees its own origin as http://…".

**Your app runs behind a proxy that terminates TLS or rewrites `Host`.** The handler sees its own origin in the request
URL and trusts no `X-Forwarded-*` header, so your own pages look cross-origin. List the app's public origin in
`trustedOrigins`:

```ts
createCloudrop({
  // ...
  trustedOrigins: ["https://app.example.com"],
});
```

The same fix applies when the page and the API are on different origins. The handler logs that warning once per refused
origin, for up to 16 origins. Both setups: [Deployment](deployment.md).

## Every upload ends UNAUTHORIZED from another origin

Uploads work when the page and the API share an origin, but a page on another origin always gets `UNAUTHORIZED`:
`authorize` finds no session because the browser did not send the cookie.

- **The page and the API are on different sites**, such as `app.example.com` and `api.example.net`. The session
  cookie must be `SameSite=None; Secure`, and some browsers still block it as a third-party cookie. Put both on one
  site, or send a bearer token with the client's `headers` option
  ([Send a bearer token](client.md#send-a-bearer-token)).
- **The cookie is set for the page's host only.** A cookie for `app.example.com` never reaches `api.example.com`. Set
  it from the API's host or with `Domain=example.com`.

DevTools' Network panel shows whether the `/upload` request carried the cookie, and why the browser left it out. More:
[Deployment](deployment.md#cross-origin-an-api-on-another-origin).

## Requests through Node get 400

`toNodeHandler` answers `400` with `INVALID_INPUT` ("The request could not be read") when the request names no single
valid host: no `Host`, two `Host` headers, a malformed one, or a `host` that disagrees with HTTP/2's `:authority`. It
also refuses a request target that is not a path, such as `POST http://host/api/cloudrop/upload`. Browsers do not send
such requests; check what a proxy in front of Node forwards.

## Requests through Express get "The request body is not valid JSON"

Mount `toNodeHandler` **before** any body parser. A parser that reads the body first leaves nothing for cloudrop to
read, so cloudrop sees an empty body and answers `INVALID_INPUT`.

```ts
app.use("/api/cloudrop", toNodeHandler(cloudrop));
app.use(express.json()); // after
```

## SERVER_ERROR: "The upload server sent an answer this client cannot read"

The client reached something that is not the cloudrop handler: a wrong `basePath`, a proxy's error page, or a server
running another cloudrop version. Check that `basePath` is the same on the server (`createCloudrop({ basePath })`) and
the client (`createCloudropClient({ basePath })`), and that the server answers at `<basePath>/upload`.

## Multipart uploads fail on Wrangler's local R2

Small files work, but a file over the multipart threshold fails at the end with `STORAGE_ERROR`: "The storage service
refused the request. Contact the site owner if this keeps happening." The server log says "The storage service does not
support this request".

**Wrangler's local R2 does not implement `ListParts`**, which the server needs to verify a multipart upload. Use RustFS
or real R2 to test multipart uploads. The failure is not retryable, so the client keeps no record to resume it:
`upload()` sends `/abort` at once, which removes the parts. A file of `start()` keeps its ticket and parts for `retry()`
until `abort()` or `pagehide`, which send `/abort`, or until the ticket expires; call `job.abort()` to remove them
sooner.
`checkBucket` there reports CORS and lifecycle as `unknown`, since Wrangler cannot report bucket settings. Details:
[`examples/next`](../../examples/next/README.md#run-with-wrangler-single-uploads-only).

## Resume does not work

`resumable()` always resolves `[]`, and `resume()` ends with `NOT_FOUND`.

- **The page is served over plain HTTP**, such as a LAN address like `http://192.168.1.20:3000`. Resuming needs a secure
  context (HTTPS, or `localhost` in development), where browsers have Web Locks.
- **`persist: false`** is set on the client.
- **A different `namespace`.** A client sees only its own namespace's records.
- **The upload was not multipart.** Files sent in one `PUT` are never kept.
- **A polyfill loaded after the client.** The client looks for `indexedDB` and Web Locks once, when it is created.

More: [Resume after reload](resume.md#when-persistence-is-off-or-unavailable).

## resume() ends with UPLOAD_IN_USE

Another tab, or this page, still holds the upload: it is running, waiting for `retry()`, or waiting for the server to
answer its `/abort`. Finish or cancel it there, then try again. See [Two tabs](resume.md#two-tabs).

## resume() ends with INVALID_INPUT

The picked file is not the one the upload started with: the name, size, `lastModified`, type or the hash of its first
and last 64 KiB differ. Ask the user to pick the same file again.

## Every request answers 500 SERVER_ERROR

Every upload fails with `SERVER_ERROR` ("The upload server is not ready. Try again in a moment."), `cloudrop.api` calls
return `INVALID_CONFIG`, and the server log has one line starting with
`cloudrop: every request answers 500 until this is fixed.` The answer is retryable: the client tries each request again
with its backoff before the file fails, and a large upload in flight keeps its resume record, so once the setting is
fixed a reload can continue it.

**A setting that comes from the environment is missing or invalid.** cloudrop reads `CLOUDROP_SECRET` and the storage
presets' variables (`CLOUDROP_R2_*`, `CLOUDROP_S3_*`) on the first request, not when the server is created, so a build
needs no secrets and the server starts without them. The log line names every missing setting with its variable, and an
invalid value with the variable that holds it. Each request reads the environment again until it is complete, so values
your app sets on `process.env` after start (a secrets loader, say) take effect without a restart. For variables your
platform sets, restart or redeploy as usual. Once they are complete they are kept until the process restarts.

With `NODE_ENV=development` the same settings are checked when the server is created, so a dev server fails as soon as
the server module loads instead (in `next dev`, on the first request to the cloudrop route).

## Text files fail at /complete with 502 STORAGE_ERROR on R2

The bytes reach the bucket, then `/complete` answers `502 STORAGE_ERROR` and the server log has
`The storage service's response had no content length.` Images and binary files upload fine. **Update to cloudrop
0.1.1 or later.** R2 compresses its answer to the `HEAD` request that verifies the stored size when the file has a
compressible type (`text/plain`, `application/json`, `text/html`, `image/svg+xml` and others) and is 50 bytes or more,
and then sends no `Content-Length`. Since 0.1.1 the driver asks for an uncompressed answer. On 0.1.0, a `fetch` option
for `r2()` or `s3()` that sets `accept-encoding: identity` on `HEAD` requests works around it.

## checkBucket reports unknown

The credentials may not read the bucket's settings (an R2 Object Read & Write token cannot), the storage cannot report
them (Wrangler's local R2), or you gave no origins. Check the settings with `wrangler r2 bucket cors list <bucket>` and
`wrangler r2 bucket lifecycle list <bucket>`, or in the dashboard. See
[What checkBucket can tell you](bucket-setup.md#what-checkbucket-can-tell-you).

## Retries after 429 come too fast

R2 answers concurrent writes to one key with `429` and `Retry-After: 5`, but the client retries sooner. **The CORS rule
does not expose `Retry-After`**, so the browser hides it and the client waits its own backoff alone. Add `Retry-After` to
the rule's exposed headers. See [Why expose Retry-After](bucket-setup.md#why-expose-retry-after).

## A dev server's first request logs bucket warnings

In development (`NODE_ENV=development`), the handler checks the bucket once and logs a warning for each missing setting:
the CORS rule for its own origin and `trustedOrigins`, the lifecycle rule, and private routes on a public bucket. Fix
what it names in [Bucket setup](bucket-setup.md).
