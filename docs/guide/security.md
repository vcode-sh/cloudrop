# Security model

What cloudrop protects, from whom, how, and what it leaves to your app. To report a vulnerability, follow
[SECURITY.md](../../SECURITY.md): email, never a public issue.

## What is protected

- **Your bucket and its credentials.** The access key and secret stay on the server. A browser never sees them, only
  URLs signed for one object, one method and a short time.
- **Your users' files.** Nobody can write, overwrite or delete a file except through an upload your `authorize`
  allowed, or through your own server code.
- **The upload token's secret.** The `secret` you give `createCloudrop` signs every token. Whoever has it can mint
  uploads for any route and owner.
- **The records of your database store,** when you use one: the rows, the quota and the erase marks.

## Who is involved

- **A signed-in user:** may upload what your routes allow them, and nothing else.
- **An anonymous visitor:** may call the handler, and is refused by every route whose `authorize` refuses.
- **Another site the user visits:** may make the user's browser send requests to your handler, with cookies.
- **Someone who holds a token or a URL** that leaked from a log, a shared screen or a browser profile.
- **Another user of the same browser profile,** after the first one signed out.
- **Not in scope:** whoever controls your server, your bucket account or your database, and a script running inside
  your page (an XSS in your app), which can do anything the page can.

## Trust boundaries

```
browser ── JSON ──▶ your server (cloudrop.handler) ── signed requests ──▶ bucket
   │                                                                       ▲
   └──────────── bytes, with URLs the server signed ───────────────────────┘
```

- **Browser to server.** Nothing the browser sends is trusted beyond `/upload`'s request, which `authorize` and the
  route's policy judge. After that, the server reads only the upload token: never a key, size, type or upload id
  from a request body.
- **Browser to bucket.** The bucket checks every signature. What the server signed into a URL is what the bucket
  accepts, so the browser can upload only the bytes the server planned.
- **Server to bucket.** The server holds the credentials. Errors from storage go to your logger, never to the client.

## The controls

**Authorization.** Every route needs an `authorize` function; a public route says so with `allowAnyone`. It runs in
`/upload`, before anything is signed, and its result goes into the token and to `onComplete`.

**Origins and CSRF.** The handler accepts requests from its own origin and from the origins `trustedOrigins` lists,
exactly; `"*"` is refused. It requires `Content-Type: application/json`, so a cross-origin call must pass a CORS
preflight, and it checks `Origin`. A request without `Origin` is taken for a server or native app, unless
`Sec-Fetch-Site: cross-site` shows a browser that dropped it; `Origin: null` is refused. No `X-Forwarded-*` header is
trusted: behind a proxy that terminates TLS, list your public origin in `trustedOrigins`
([Deployment](deployment.md)).

**Input bounds.** A body is at most 64 KiB, a request has at most `maxFiles` files (10 by default, 100 at most), a
file name 1 to 255 characters, and metadata is validated by the route's schema and at most 2 KiB of JSON.

**Policy before signing.** Each file's size and type are checked against the route's `maxSize` and `accept` before
its URL is signed, and the type must agree with the file's extension.

**Signed headers.** A single-`PUT` URL signs the exact size, type and `Content-Disposition`, `If-None-Match: *` so it
can never overwrite an object, and the upload's id. Each multipart part URL signs that part's exact size. HTML, SVG,
XML and every other non-media type are stored as `attachment`, so they never run as a page on a public bucket domain.

**Verified completion.** `/complete` reads the stored object back: a `HEAD` for a single `PUT`, the bucket's part list
for multipart. A wrong size or type deletes the object and answers `VERIFICATION_FAILED`; a multipart completion uses
the server's part list, never the client's. An object another upload wrote under the same key is never deleted.

**The upload token.** Signed with HMAC-SHA-256, valid for 24 hours, readable by the browser and carrying no secret.
`secret` may be a list: the first signs, every one verifies, so you can rotate it
([Server](server.md#rotate-the-secret)). Upload URLs live 15 minutes and are renewed through `/sign`.

**Errors that leak nothing.** A client receives an error's `code`, `message`, `retryable`, part numbers and a type
refusal's `content`, nothing else. Messages never contain credentials, presigned URLs or raw storage responses;
everything else goes to your `logger`, and no log line cloudrop writes carries a credential or a presigned URL.

**Private routes.** `visibility: "private"` leaves `file.url` null; serve the file through `api.getUrl(key)`, which
signs a short-lived download link.

**The persisted token.** To resume after a reload, the browser keeps each unfinished multipart upload's token in
IndexedDB. The record is deleted the moment its file ends, so it never outlives its upload; expired records are never
used; `namespace` keeps one user's records apart from another's; `client.forget()` at sign-out deletes them
([Resume after reload](resume.md)).

**A database store** closes the gaps a stateless server leaves: `api.revokeUploads(owner)` ends a user's unfinished
uploads at their next call, the file's row refuses `/sign` and `/complete` once it ended, and `/abort` never deletes a
completed file. `eraseOwner` refuses every later upload of the owner it erases.

**The package.** Zero runtime dependencies, and npm releases with provenance, built by a workflow that holds no npm
token.

## What your app must do

cloudrop leaves these to you, on purpose:

- **Rate limiting.** Put a limit in front of the handler, or refuse in `authorize` with `rateLimited(seconds)`.
  cloudrop counts nothing between requests.
- **Malware scanning.** cloudrop checks size and type, and `contentChecks()` checks that the bytes are the type they
  claim, but nothing reads a file for malware. Scan in an `afterVerify` plugin ([Plugins](plugins.md)), with
  `visibility: "private"` so nobody reads a file before the scan passed.
- **Decompression bombs.** cloudrop never unpacks or decodes a file. If your app unzips archives or decodes images,
  bound the output size there.
- **Integrity beyond size and type.** The server checks the stored size and type, not a hash of the content. Compute
  one yourself in `onComplete` when you need it.
- **Session security.** Your `authorize` reads your session; how sessions are issued, stored and revoked is your
  app's. Never return a secret from `authorize`: its result is signed into a token the browser can read.
- **The bucket's own settings.** A narrow CORS rule, the abort-incomplete-multipart lifecycle rule and a token
  limited to one bucket ([Bucket setup](bucket-setup.md)). A bucket with public access serves every key to anyone who
  learns it.

## Residual risks

What stays true even with every control in place:

- **A token outlives a revoked session by up to 24 hours.** `authorize` runs only in `/upload`, so an upload started
  before a sign-out or a ban can still finish. Check the session again in `onComplete`, whose `request` carries the
  caller's cookies, or use a store and call `api.revokeUploads(owner)` at sign-out.
- **Without a store, `/abort` can delete a completed file.** While its token is valid, whoever holds it can delete the
  file it uploaded, even after `/complete`, and a single-`PUT` token can get a new URL and upload again. A store's
  row closes both.
- **A private route only warns.** When the storage has a `publicUrl`, `createCloudrop` logs a warning for a private
  route, and anyone who learns a key can read the file. Use a bucket without a public domain for private files.
- **A persisted token sits in IndexedDB** until its upload ends or `forget()` runs. Another user of the same browser
  profile, or anyone with the disk, can use it within its 24 hours: to finish that upload, or to abort it. Call
  `client.forget()` at sign-out, or turn persistence off with `persist: false`.

## Report a vulnerability

[SECURITY.md](../../SECURITY.md) has the address, what to include, the response times and what is in scope.
