# Server

This page is for developers setting up cloudrop on their server. It covers everything that runs there: creating the
server with `createCloudrop`, choosing a storage driver, defining routes and who may use them, what the upload token is
and what it allows, mounting the handler in your framework, which origins may call it, and the `cloudrop.api` file
operations. For the browser side, see [Client](client.md). To keep a row per upload in your database (`onComplete` once,
quotas, revocation, cleanup), see [Database store](store.md).

## Create the server

```ts
// lib/cloudrop.ts
import { createCloudrop, r2, route, unauthorized } from "cloudrop";

export const cloudrop = createCloudrop({
  storage: r2({ bucket: "media" }),
  routes: {
    avatar: route(
      {
        accept: "image/*",
        maxSize: "5MB",
        authorize: async ({ request }) => {
          const user = await getUser(request); // your app's session lookup
          return user ? { userId: user.id } : unauthorized();
        },
      },
      { prefix: ({ userId }) => `users/${userId}/avatars` },
    ),
  },
});
```

`createCloudrop` checks every option when it is called and throws a `CloudropError` with code `INVALID_CONFIG` for the
first mistake it finds, checking the options in a fixed order. Its message names the option and the fix. A
misconfigured server fails when it starts, not on a user's first upload. Settings that come from the environment
(`CLOUDROP_SECRET` and the storage variables) are read on the first request instead, so a build needs no secrets; one
still missing then makes every request answer 500 and logs `INVALID_CONFIG` once. With `NODE_ENV=development` they are
checked when `createCloudrop` runs too, so a dev server fails as soon as the server module loads.

| Option | What it does | Default |
| --- | --- | --- |
| `storage` | Where files go: `r2({ ... })` or `s3({ ... })`. Required. | |
| `routes` | The upload routes, by name. At least one. A name uses letters, digits, `-` and `_`, at most 64. | |
| `secret` | The secret that signs upload tokens: text of at least 32 characters, or a list of them (see [Rotate the secret](#rotate-the-secret)). | env `CLOUDROP_SECRET` |
| `basePath` | Where the handler is mounted. A leading slash, no trailing slash, no query. | `"/api/cloudrop"` |
| `trustedOrigins` | Exact origins, such as `"https://app.example.com"`, that may call the handler from another origin (see [Origins](#origins)). Never `"*"` or a pattern such as `"https://*.example.com"`. | `[]` |
| `multipartThreshold` | Files larger than this go in parts. Bytes or a size such as `"64MB"`. | 64 MiB |
| `plugins` | Plugins with server hooks (see [Hooks](#hooks)). | `[]` |
| `logger` | Where failures inside the handler and configuration warnings go: any object with `error(message, error)` and `warn(message)`, such as `console` or a pino logger. | `console` |
| `store` | A database store, such as `sqlStore(...)` from `cloudrop/adapters/sql` (see [Database store](store.md)). | none: stateless |
| `quota` | With a store: each owner's limit in bytes, or `null` for none, asked once per `/upload`. | none |
| `completionLeaseMs` | With a store and no transaction: how long a `/complete` holds its file while `onComplete` runs. Longer than your slowest `onComplete`. | 300000 |

Generate a secret with `openssl rand -base64 32`. Use a different secret for every deployment: a token verifies
wherever its secret is configured.

Sizes such as `maxSize` and `multipartThreshold` take a number of bytes or a string with a unit: `"512KB"`, `"5MB"`,
`"1.5GB"`. `KB`, `MB`, `GB` and `TB` are binary units (1 KB = 1024 bytes), the same as `KiB`, `MiB`, `GiB` and `TiB`.

### Rotate the secret

Pass a list. The first secret signs new tokens; every secret in the list verifies. Put the new secret first and keep the
old one until its tokens expire, 24 hours later:

```ts
secret: [process.env.NEW_SECRET as string, process.env.OLD_SECRET as string],
```

### Settings from the environment

The library reads the environment only through `process.env`, and only when the runtime has one. On a runtime without
`process.env`, pass `secret` and the storage credentials explicitly.

## Choose a storage driver

### R2

```ts
import { r2 } from "cloudrop";

const storage = r2({ bucket: "media" });
```

| Option | Default |
| --- | --- |
| `bucket` | env `CLOUDROP_R2_BUCKET`. The exact bucket name. |
| `accountId` | env `CLOUDROP_R2_ACCOUNT_ID`. 32 hexadecimal characters, from the R2 overview page in the Cloudflare dashboard. |
| `accessKeyId` | env `CLOUDROP_R2_ACCESS_KEY_ID` |
| `secretAccessKey` | env `CLOUDROP_R2_SECRET_ACCESS_KEY` |
| `jurisdiction` | `"eu"` or `"fedramp"` for a bucket in that jurisdiction. Omit it for the default location. |
| `publicUrl` | Where the bucket is served publicly: a custom domain or `r2.dev` URL, a path allowed, such as `"https://cdn.example.com/files"`. |
| `fetch` | Replaces the global `fetch`. |

An option that is unset or empty falls back to its variable. One `INVALID_CONFIG` error lists everything missing at
once, on the first request (when the server is created, in development). An option you pass is checked when `r2()` is
called.

With every variable set, `r2()` needs no argument at all:

```sh
CLOUDROP_R2_ACCOUNT_ID=<32 hexadecimal characters>
CLOUDROP_R2_ACCESS_KEY_ID=<access key id>
CLOUDROP_R2_SECRET_ACCESS_KEY=<secret access key>
CLOUDROP_R2_BUCKET=media
```

```ts
const storage = r2();
```

### Any S3-compatible service

```ts
import { s3 } from "cloudrop";

// Reads CLOUDROP_S3_ENDPOINT, CLOUDROP_S3_REGION, CLOUDROP_S3_BUCKET, CLOUDROP_S3_ACCESS_KEY_ID and
// CLOUDROP_S3_SECRET_ACCESS_KEY for any setting not passed.
const storage = s3({ endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1" });
```

`s3()` takes `endpoint`, `region`, `bucket`, `accessKeyId` and `secretAccessKey`, each from its option or its variable,
as `r2()` does, so with all five variables set `s3()` needs no argument. `endpoint` is an `http` or `https` URL with no
query or fragment; a path in it is kept as a prefix of every request, for a service behind a proxy path. `publicUrl` and
`fetch` work as for `r2()`.

Pass the driver to `createCloudrop` as `r2()` or `s3()` returns it. When a setting comes from the environment, the
server finds the driver's lazy check by the driver object itself, so a copy or a wrapper, such as `{ ...r2(), put }` for
logging, loses it. With a storage setting missing, every upload then fails with `STORAGE_ERROR`, and the log has
`cloudrop: a storage request failed.` with the `INVALID_CONFIG` on every request, instead of the single line saying
every request answers 500 until it is fixed. A wrapper is safe when every setting is passed as an option.

Which permissions the credentials need: [Bucket setup](bucket-setup.md#credentials-and-permissions).

## Define routes

A route is one kind of upload: what files it accepts, how large, who may upload, and where the files go.

```ts
import { route, unauthorized } from "cloudrop";
import { z } from "zod"; // any Standard Schema library: zod, valibot, arktype

const photo = route(
  {
    accept: ["image/png", "image/jpeg", "image/webp"],
    maxSize: "10MB",
    maxFiles: 20, // files per /upload call; the default is 10
    metadata: z.object({ albumId: z.string() }),
    authorize: async ({ request, metadata }) => {
      const user = await getUser(request); // your app's session lookup
      if (!user) return unauthorized();
      return { userId: user.id };
    },
  },
  {
    prefix: ({ userId, metadata }) => `users/${userId}/albums/${metadata.albumId}`,
    onComplete: async ({ file, userId }) => {
      await savePhoto({ id: file.id, key: file.key, userId }); // your app's database write
      return { key: file.key };
    },
  },
);
```

| Option | What it does |
| --- | --- |
| `accept` | MIME types in lower case, such as `"image/png"`, `"image/*"` or `"*/*"`. One string or a list. The file name's extension must agree with its type: `photo.png` sent as `image/jpeg` is refused. |
| `maxSize` | The largest file, in bytes or a size such as `"5MB"`. At most what the storage allows for one object. |
| `maxFiles` | Files per `/upload` call, 1 to 100. Default 10. |
| `metadata` | Any [Standard Schema](https://standardschema.dev) (zod, valibot, arktype). The client sends metadata with the upload; the server validates it. Its output, as JSON, must fit in 2 KiB. A route without a schema refuses metadata. |
| `authorize` | Required. Decides who may upload (see [Authorize uploads](#authorize-uploads)). |
| `prefix` | The folder for generated keys. A key is `<prefix>/<ulid><ext>`, such as `users/42/avatars/01JD5Z3K7Q2X8M4N6P9R0S1T2V.png`. |
| `key` | The whole key instead of `<prefix>/<ulid><ext>`. Pass `prefix` or `key`, not both. A custom key must be unique (see below). |
| `visibility` | `"public"` or `"private"`. `"public"` needs the storage's `publicUrl`. Default: `"public"` when the storage has a `publicUrl`, otherwise `"private"`. |
| `replace` | With a store and `owner`: one file per owner, such as an avatar. A completed file deletes the owner's previous files on the route ([One file per owner](store.md#one-file-per-owner-replace)). |
| `onComplete` | Runs inside `/complete` once the file is verified. What it returns reaches the client as `data.data`, as JSON. |
| `owner` | With a store: who the file counts against for `quota` and `api.usage`, such as a user or team id, or `null`. |
| `afterComplete` | With a store: runs once the completion is recorded, at most once and best effort; the place for emails and webhooks. |

A route that takes any type of file says so with `accept: "*/*"`. The extension check still applies to the types
cloudrop knows, so `photo.png` sent as `image/jpeg` is still refused, and a file the browser gives no type is stored as
`application/octet-stream`:

```ts
const attachment = route(
  {
    accept: "*/*",
    maxSize: "100MB",
    authorize: async ({ request }) => {
      const user = await getUser(request); // your app's session lookup
      return user ? { userId: user.id } : unauthorized();
    },
  },
  { prefix: ({ userId }) => `users/${userId}/attachments` },
);
```

`prefix`, `key` and `onComplete` receive what `authorize` returned, plus `request`, `metadata` and, for `prefix` and
`key`, the `file` (`id`, `name`, `size`, `type`, `ext`). `onComplete` receives the stored `file` (`id`, `key`, `name`,
`size`, `type`, and `url`, the public URL on a public route or `null`).

In every callback and plugin hook, `request` is for its headers and `url`:
[its body is already read](#the-requests-body-is-already-read).

### Keys

The server chooses every key; the client's file name never reaches it. The name appears only in the stored
`Content-Disposition` header. Keys from `prefix` and `key` are checked the same way: `.` and `..` segments, empty
segments, a leading `/`, control characters and keys over 1024 bytes are refused, and Unicode is normalized to NFC.
`prefix` must also return a string without a leading `/`.

A bad key is a bug in your route, not the user's mistake: the check throws, `/upload` answers `SERVER_ERROR` (HTTP 500)
and the server logs which route built the key and why it was refused.

A custom `key` must be unique. A rejected or aborted upload's object is deleted by key once a `HEAD`, or a create-only
completion, shows the object is this upload's. That delete is not conditional: another file stored under the same key
between the two requests would be deleted.

### Private and public routes

A file on a public route gets a public URL in `file.url`. A private route needs a bucket without a public domain: when
the storage has a `publicUrl`, anyone who learns a key can read the file. `createCloudrop` logs a warning when a private
route uses storage with a `publicUrl`. Serve private files with `cloudrop.api.getUrl(key)`, which signs a short-lived
link.

## Authorize uploads

Every route needs `authorize`. It receives `{ request, metadata }` and returns either a plain object with the facts
later steps need, or `unauthorized()` or `forbidden()`:

```ts
authorize: async ({ request }) => {
  const user = await getUser(request); // your app's session lookup
  return user ? { userId: user.id } : unauthorized("Sign in to upload photos.");
},
```

- `unauthorized()` refuses the upload with `UNAUTHORIZED`. Its message reaches the user; the default is "Sign in to
  upload files here."
- `forbidden()` refuses a signed-in user who may not upload (a quota, a plan, a role) with `FORBIDDEN`. The default
  message is "You are not allowed to upload files here. Ask the site owner for access if you think this is wrong."
- A public route must say so: `authorize: allowAnyone`. Public uploads are never a default.
- `prefix`, `key` and `onComplete` go in `route()`'s second argument. TypeScript types their context from what
  `authorize` returns, in whatever order the options are written.
- What `authorize` returns is signed into the upload token, which the browser can read. Return ids, never secrets.
- The client sends cookies with every call to your server (`credentials: "include"`), so `authorize` can read the
  session from `request`. A page on another site needs cookies set for that: see [Deployment](deployment.md).

Refuse a signed-out user with `unauthorized()` and a signed-in user who may not upload with `forbidden()`, so the user
is not told to sign in when they already have:

```ts
authorize: async ({ request }) => {
  const user = await getUser(request); // your app's session lookup
  if (!user) return unauthorized();
  if (user.plan === "free") return forbidden("Uploads need a paid plan. Upgrade in Settings, then try again.");
  return { userId: user.id };
},
```

### Read the session

`request` is a standard `Request`, whatever framework mounts the handler, with its body already read (see
[below](#the-requests-body-is-already-read)). With [better-auth](https://www.better-auth.com), pass its headers to
`getSession`:

```ts
import { route, unauthorized } from "cloudrop";
import { auth } from "./auth"; // your better-auth instance

const avatar = route(
  {
    accept: "image/*",
    maxSize: "5MB",
    authorize: async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers });
      return session ? { userId: session.user.id } : unauthorized();
    },
  },
  { prefix: ({ userId }) => `users/${userId}/avatars` },
);
```

With your own session cookie, read it from the `Cookie` header:

```ts
// Returns the value as sent: decodeURIComponent it if your cookie is encoded.
function readCookie(request: Request, name: string): string | undefined {
  for (const pair of request.headers.get("cookie")?.split(";") ?? []) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

// In the route's policy:
authorize: async ({ request }) => {
  const user = await findUserBySession(readCookie(request, "session")); // your app's session lookup
  return user ? { userId: user.id } : unauthorized();
},
```

An app that sends a bearer token instead of a cookie reads `request.headers.get("authorization")`; the client side is in
[Client](client.md#send-a-bearer-token).

### The request's body is already read

The handler reads and parses the body before any of your code runs, and a `Request` body can be read once. So in
`authorize`, `owner`, `prefix`, `key`, `onComplete`, `afterComplete`, the plugin hooks `beforeUpload` and `afterVerify`,
and `onDelete` (which gets a `request` only for a replacement), `request.json()`, `request.text()` and
`request.formData()` throw (on Node: `Body is unusable`). The hook fails with it: from `authorize`, the upload answers
`SERVER_ERROR` (HTTP 500).

Read these instead:

- `request.headers`: cookies, `authorization`, anything the client's [`headers` option](client.md#send-a-bearer-token)
  sends;
- `request.url`: the URL the handler was called at;
- `metadata`: what the page sent with the upload, validated by the route's schema. It is the one channel for the
  page's own data, so declare a `metadata` schema for anything `authorize` needs beyond the session;
- `file`, in `prefix`, `key`, `onComplete` and the plugin hooks.

## The upload token and what it allows

`/upload` answers each accepted file with a **ticket**: the file's key, its upload URLs and an **upload token**. The
token carries everything later calls need: the route, the key, the size and type, what `authorize` returned and the
validated metadata. It is signed with your secret, so the server keeps no state and trusts nothing else a client sends.
It is signed, not encrypted: the browser can read it.

What happens in `/upload`:

1. The handler checks the request: `POST`, an allowed origin, `Content-Type: application/json`, a body of at most
   64 KiB.
2. The body is `{ route, files, metadata, idempotencyKey }`. The route must exist (`UNKNOWN_ROUTE`), the number of
   files must be within `maxFiles` (`TOO_MANY_FILES`), and each file entry needs a name, size and type. File names are
   normalized to NFC before they are counted (1 to 255 Unicode code points) and stored. A name with a NUL character,
   which Postgres cannot store, or with a lone surrogate (text that is not valid Unicode) is refused for that file
   alone with `INVALID_INPUT`, and the request's other files go on; every other character is kept, control characters
   included, and reaches the `Content-Disposition` header percent-encoded. `idempotencyKey` is optional:
   16 to 128 letters, digits, `-` or `_` (`INVALID_INPUT` otherwise). The client sends a new one for each ask and the
   same one on every retry of it; without a store it is checked and ignored, with one a retry
   [supersedes the attempt whose answer was lost](store.md#what-changes-for-the-client). Never reuse a key for a new
   ask: a request with a key ends the pending uploads of earlier requests with the same key, route and owner. On a
   route without `owner`, or when it answers null, the key does nothing.
3. The route's metadata schema validates the metadata (`INVALID_METADATA`). Metadata nested more than 32 arrays or
   objects deep is refused before the schema sees it, and its JSON must fit in 2 KiB.
4. `authorize` runs (`UNAUTHORIZED`, `FORBIDDEN`).
5. Each file's type and size are checked against the route (`FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE`), and its key is
   built. A refused file does not stop the others.
6. With a store and `owner`, the owner is read. When the client sent an `x-cloudrop-account` header (its
   [`account` option](client.md#guard-against-a-changed-account)) and it differs from that owner, the whole request is
   refused with `ACCOUNT_CHANGED` before anything is reserved. A request without the header is not checked.
7. Plugins' `beforeUpload` hooks run.
8. Only then is anything signed.

Then the rules that follow from a stateless token:

- **`authorize` runs only in `/upload`.** The token is the authority for that file for 24 hours. A session revoked
  mid-upload can still finish the upload, so check the session again in `onComplete` when that matters: `request`
  carries the caller's cookies and headers.
- **Upload URLs live 15 minutes.** The client renews them through `/sign`. Every URL ends at least 15 minutes before
  its token, so a `PUT` started under the last one can still be completed; in a token's last 15 minutes `/sign`
  answers `UPLOAD_EXPIRED`.
- **`/abort` is cleanup, not revocation.** Until the token expires, whoever holds it can get a new single-`PUT` URL,
  upload and complete, and can delete its own completed file through `/abort`. An expired token still aborts an
  unfinished upload, but never deletes a stored file.
- **`keep` narrows `/abort` without a store.** `/abort { token, keep: true }` never deletes an object that landed, even
  with a live token: it only aborts an unfinished multipart upload, since the server cannot tell whether `onComplete`
  ran. The client's `discard()` sends it, so discarding an upload whose `/complete` may have finished keeps the file.
  With a [database store](store.md) the row decides as for any `/abort`, and `keep` changes nothing. `keep` must be a
  boolean when sent (`INVALID_INPUT` otherwise).
- **A removed route.** `/abort` still cleans up, and runs `onAbort`, after a deploy removed or renamed the token's route.
  `/sign` and `/complete` refuse such a token with `UNKNOWN_ROUTE`.

A [database store](store.md) changes the first and third rules: `api.revokeUploads` ends a user's unfinished uploads
at their next call, and `/abort` never deletes a completed file.

What `/complete` verifies, which is the real guarantee:

- **Single `PUT`:** a `HEAD` of the object. Its size, type and upload id must match the token.
- **Multipart:** the bucket's list of parts. Every part's size must match the plan; completion uses the server's part
  list, never the client's. A missing or wrong-sized part answers `PARTS_MISSING` with its number, and the client sends
  it again.
- For a single `PUT`, a wrong size or type deletes the object and answers `VERIFICATION_FAILED`. A multipart upload's
  type is set by the server when it creates the upload, so only part sizes can be wrong, and those are sent again.
- An object another upload wrote under the same key is never deleted: it answers `VERIFICATION_FAILED` (single `PUT`)
  or `ALREADY_EXISTS` (multipart).

What the server signs or sets, so the bucket itself refuses anything else:

- **A single `PUT` URL** signs the exact size and type, `If-None-Match: *` (a URL can never overwrite an object), the
  upload id in `x-amz-meta-cloudrop-id`, and the `Content-Disposition`.
- **A multipart upload** gets its type, upload id and `Content-Disposition` from the server when it is created. Each
  part URL signs only that part's exact size.

The `Content-Disposition` is `inline` for raster images, video and audio, and `attachment` for everything else,
including HTML, SVG and XML. That keeps an uploaded HTML or SVG file from running as a page on a public bucket domain.

Why it works this way: the M2 decisions in [docs/decisions](../decisions/README.md) and
[the design](../superpowers/specs/2026-11-15-cloudrop-design.md#7-security-and-verification).

## Hooks

### onComplete

`onComplete` is a route option. It runs inside `/complete`, after the file is verified, at least once per file. Its JSON
result reaches the client as `data.data`; without `onComplete`, `data.data` is `null`. With a [database store](store.md)
it runs once per file, and on a store built with `transaction: true` its writes through `tx` commit with the upload;
`owner`, `afterComplete` and `onDelete` are store callbacks, described there.

### onDelete

With a store, `onDelete({ file, owner, reason })` runs when one of the route's completed files is deleted by
`api.deleteFile`, a `replace: true` completion or `api.eraseOwner`, so an audit trail or a pointer of yours follows the
file. A throw keeps the file, as a failure; a `CloudropError` it returns keeps the file as a refusal, and the caller
answers that error. With `transaction: true` it runs inside the deletion's transaction with `tx`; otherwise before the
deletion, at least once. See [`onDelete`](store.md#ondelete).

### Plugin hooks

Plugins add server hooks through `createCloudrop({ plugins })`. Each plugin is `{ id, server }`, and `server` takes any
of these functions:

| Hook | When it runs |
| --- | --- |
| `beforeUpload` | In `/upload`, after authorization and the size and type checks, before anything is signed. Its context carries the accepted `files` and the route's `accept`. Return a `CloudropError` to refuse every file, and nothing (`undefined` or `null`) to accept them. |
| `afterVerify` | In `/complete`, after verification, before `onComplete`. Its context carries the `file`, the route's `accept` and the `storage` driver. Return a `CloudropError` to refuse the file: the object is deleted and the error reaches the client. Return nothing (`undefined` or `null`) to accept it. |
| `onAbort` | When a file `beforeUpload` accepted is refused, cannot be started, is rejected at `/complete` (a failed check, a plugin's refusal, a multipart upload the bucket no longer has), or is ended through `/abort`. Release a reservation here. |
| `extendRoute` | Once per route, in `createCloudrop`. Throw a `CloudropError` with `INVALID_CONFIG` to refuse the route. |

```ts
import { type CloudropPlugin, CloudropError } from "cloudrop";

const quota: CloudropPlugin = {
  id: "quota",
  server: {
    beforeUpload: async ({ files, auth }) => {
      const ok = await reserveQuota(auth, files); // your app's quota check
      return ok ? undefined : new CloudropError("FORBIDDEN", "You are out of storage. Delete some files first.");
    },
    onAbort: async ({ file }) => {
      await releaseQuota(file.id); // your app's cleanup, idempotent by file.id
    },
  },
};
```

A `beforeUpload` refusal refuses every file of the job with its code and message. `FORBIDDEN` says the user is signed
in but may not upload this; the message says what to do (see [Errors](errors.md#upload-endpoint-errors)).

A plugin of your own that refuses a file for its type can say what it found, as `contentChecks()` does: pass
`{ content: { declared, detected, reason } }` as the third argument of a `FILE_TYPE_NOT_ALLOWED` error (see
[What a refusal carries](plugins.md#what-a-refusal-carries)). The client is sent those three fields and nothing else
the object holds; with any other code, `content` is left out.

Nothing runs when an abandoned upload's token expires, so a reservation also needs its own expiry. A database store's
`quota` reserves and releases bytes for you, with no plugin (see [Database store](store.md#owners-and-quota)).
cloudrop's own plugins are in `cloudrop/plugins`: [`contentChecks()`](plugins.md#contentchecks) refuses a file whose
content is not the type it was sent as.

### Make hooks idempotent

Hooks can run more than once. A retried or replayed request repeats `afterVerify` and `onComplete` (on `/complete`) and
`onAbort` (on `/abort`), and a resumed upload runs `afterVerify` and `onComplete` again. `onDelete` can run twice for
one file too; with a transaction only its writes through `tx` commit once. Make their side effects
idempotent by the stable `file.id`: for example, insert with `file.id` as the primary key and ignore a duplicate. A
database store answers a finished upload's retries from its row instead (see
[what it guarantees](store.md#what-it-guarantees)).

The client also sends a slow call again. A `/complete` slower than 120 s, or an `/upload` slower than 30 s, counts as no
answer and is retried (see [Stalled requests](client.md#stalled-requests)), so keep `onComplete` and `authorize` well
under that, and `onComplete` idempotent. A retried `/upload` runs `authorize` and `beforeUpload` again: the
`idempotencyKey` it carries lets a store release what the lost attempt reserved, not plugins.

An app that must refuse a late upload after `/abort` (see [the token](#the-upload-token-and-what-it-allows)) checks its
own record in `afterVerify`, such as a released quota reservation, and refuses it there, which deletes the object.

## Mounting the handler

`cloudrop.handler(request)` takes a `Request` and always resolves to a `Response`; it never throws. It serves `POST`,
and the CORS preflight `OPTIONS`, at `<basePath>/upload`, `/sign`, `/complete` and `/abort`. With the default
`basePath`, that is `/api/cloudrop/upload` and so on.

### Next.js

```ts
// app/api/cloudrop/[...all]/route.ts
import { toNextHandler } from "cloudrop/next";
import { cloudrop } from "../../../../lib/cloudrop";

export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);
```

`next build` loads `lib/cloudrop.ts`. Settings from the environment are read on the first request, so the build needs
no secrets.

### Node http, http2 and Express

```ts
import http from "node:http";
import { toNodeHandler } from "cloudrop/node";
import { cloudrop } from "./lib/cloudrop";

http.createServer(toNodeHandler(cloudrop)).listen(3000);
```

With Express (installed separately), mount it at the path, before any body parser:

```ts
import express from "express";
import { toNodeHandler } from "cloudrop/node";
import { cloudrop } from "./lib/cloudrop";

const app = express();
app.use("/api/cloudrop", toNodeHandler(cloudrop));
app.use(express.json()); // body parsers after cloudrop
app.listen(3000);
```

A parser that reads the body first leaves nothing for cloudrop to read.

`toNodeHandler` takes the request's origin from `Host` (or HTTP/2's `:authority`) and the scheme from the connection,
never from `X-Forwarded-*` or `:scheme`, because that origin decides the same-origin check. Rather than guess an origin
such as `localhost`, it answers `400` when:

- the request has no `Host` (or `:authority`);
- `Host` is sent twice;
- the host is malformed: it carries userinfo, a path or an invalid port;
- `host` and `:authority` name different origins;
- the request target is not a path, such as the absolute form `POST http://host/api/cloudrop/upload`. Browsers send that
  form only to proxies, and accepting it would let the target choose the origin.

A hand-built request without `rawHeaders` is read from `headers` alone.

### Hono

```ts
import { Hono } from "hono";
import { cloudrop } from "./lib/cloudrop";

const app = new Hono();
app.all("/api/cloudrop/*", (c) => cloudrop.handler(c.req.raw));

export default app;
```

`c.req.raw` is the standard `Request`. The path is your `basePath` followed by `/*`.

- Use `app.all`, not `app.post`. The handler answers the CORS preflight (`OPTIONS`) itself, and answers any other
  method with `METHOD_NOT_ALLOWED`.
- Keep that path out of CORS middleware such as `hono/cors`. The handler already answers preflights from
  `trustedOrigins` and sets the CORS headers on its own answers. A middleware would apply its own rules instead: scope
  it to your other routes, for example `app.use("/api/app/*", cors())`.

### Bun

```ts
import { cloudrop } from "./lib/cloudrop";

Bun.serve({
  port: 3000,
  routes: {
    "/api/cloudrop/*": (request) => cloudrop.handler(request),
  },
  fetch: () => new Response("Not found", { status: 404 }), // your app's other requests
});
```

### Any runtime with Request and Response

Deno, Cloudflare Workers and frameworks that speak `Request` and `Response` call the handler directly:

```ts
// Cloudflare Workers
export default {
  fetch: (request: Request) => cloudrop.handler(request),
};
```

On Workers, pass `secret` and the storage credentials explicitly unless your Worker exposes `process.env` (see
[Settings from the environment](#settings-from-the-environment)); creating the server from the Worker's `env`:
[Deployment](deployment.md#cloudflare-workers). How the server's parallel storage calls fit Workers' subrequest limits
has not been measured yet.

## Origins

The handler accepts:

- requests from its own origin;
- requests from `trustedOrigins`, exact origins such as `"https://app.example.com"`, never `"*"`;
- requests without an `Origin` header, which come from servers and native apps, unless `Sec-Fetch-Site: cross-site`
  shows a browser that dropped it. `Origin: null` is refused.

Everything else gets `ORIGIN_NOT_ALLOWED`. The handler also requires `Content-Type: application/json`, so a page on
another origin must pass a CORS preflight first. The handler answers that preflight itself and allows the headers it
asks for; an `OPTIONS` from an allowed origin that is not a preflight for `POST` gets `METHOD_NOT_ALLOWED`.

### What an origin is

An entry of `trustedOrigins` is compared, character for character, with the `Origin` header the browser sends, so it
must be exactly that text. `createCloudrop` throws `INVALID_CONFIG` for anything a browser cannot send, and
`api.checkBucket({ origins })` refuses the same values:

| You write | A browser sends | So |
| --- | --- | --- |
| `"https://app.example.com/"`, `"https://app.example.com:443"`, `"https://App.Example.com"` | `https://app.example.com` | Refused; the message names the origin to use: scheme, host and a non-default port, lowercase, no path. |
| `"https://*.example.com"`, `"*"` | never a pattern | Refused. List each origin; there are no wildcards. |
| `"https://bücher.example"` | `https://xn--bcher-kva.example` | Refused; the message names the punycode form, which is what to list. |
| `"null"`, `"file://"`, `"data:..."` | `null`, which every sandboxed frame and local file shares | Refused: trusting `null` would trust them all. |
| `"ws://app.example.com"`, `"wss://..."`, `"ftp://..."` | never: no page is loaded over these | Refused. Name the origin of the page that uploads. |
| `"capacitor://localhost"`, `"tauri://localhost"`, `"chrome-extension://<id>"` | the same text | Accepted (below). |

**Webviews and extensions.** A page inside an app shell or a browser extension has an origin with the app's own
scheme, and the webview sends it as it is:

| Where the page runs | Its `Origin` |
| --- | --- |
| Capacitor on iOS | `capacitor://localhost` |
| Capacitor on Android | `https://localhost` or `http://localhost`, by `androidScheme` |
| Tauri on macOS and Linux | `tauri://localhost` |
| Tauri on Windows and Android | `http://tauri.localhost` (or `https://tauri.localhost`, by `useHttpsScheme`) |
| A Chrome extension page | `chrome-extension://<extension id>` |
| A Firefox extension page | `moz-extension://<the installation's UUID>`, different on every install |

For a scheme other than `http` and `https`, `trustedOrigins` accepts `scheme://host` or `scheme://host:port`, all in
lowercase: the scheme starts with a letter and may hold letters, digits, `+`, `-` and `.`; the host holds letters,
digits, `.` and `-`; the port is 1 to 5 digits. That is the form the Fetch standard gives the `Origin` header
([`Origin`](https://fetch.spec.whatwg.org/#origin-header)). `file:` is never accepted. Check what your shell really
sends in its network inspector before you list it: by the URL standard alone a page on such a scheme has an
[opaque origin](https://url.spec.whatwg.org/#origin) and would send `null`, and it is the webview that makes the
scheme behave like `https`. The bucket's CORS rule needs the same origin, because the bytes leave from that page too.

The handler sees its own origin in the request URL and trusts no `X-Forwarded-*` header. **Behind a proxy that
terminates TLS or rewrites `Host`, your own pages look cross-origin:** list the app's public origin in
`trustedOrigins`. The first time the handler refuses a request from an origin, it logs a warning naming the refused
origin and the one it sees, for up to 16 origins.

Same-origin versus cross-origin setups, cookies across sites and which origin the bucket's CORS rule lists:
[Deployment](deployment.md).

## File API

`cloudrop.api` works on the same storage from your server. Every call returns `{ data, error }`.

| Call | What it does |
| --- | --- |
| `getUrl(key, { expiresIn?, download? })` | A URL to read the object. With a `publicUrl` and no options: the plain public URL. Otherwise a presigned `GET`, valid for at least `expiresIn` seconds (default 3600). `download` names the saved file. |
| `head(key)` | The object's size, type, ETag, metadata and upload time, or `null` when it does not exist. |
| `put(key, body, options?)` | A small server-side upload, up to the storage's single-`PUT` limit. |
| `delete(key)` | Deletes one object. Deleting a missing key succeeds. |
| `deleteMany(keys)` | Deletes many objects; each key ends up in `deleted` or in `failed` with its own error. |
| `copy(from, to)` | Copies an object. |
| `deletePrefix(prefix)` | Empties a folder prefix ending in `/`, such as `"users/42/"`, then lists it again to prove it is empty. For erasure requests. |
| `checkBucket({ origins? })` | Reports the bucket's CORS rule, lifecycle rule and public-access conflicts (see below). |

With a store, `api` also has `file`, `files` (filtered by route, name and type, newest or oldest first), `allFiles`
(the files of every owner, in any status, for your admin tools: call it behind your own admin check), `usage`,
`revokeUploads`, `deleteFile`, `eraseOwner`, `reconcile` and `sweep` (see [Database store](store.md#file-operations)).
For an erasure request, `eraseOwner` needs no key layout and proves when nothing is left; `deletePrefix` empties a
folder you name.

`getUrl` signs at the start of an `expiresIn` window and the URL stays valid for two windows, so every viewer in one
window gets the same, cacheable URL.

**Keys are read in NFC.** `/upload` stores every key in Unicode's NFC form, and every `api` call that takes a key or a
prefix normalizes it the same way, so `"users/Zoé/"` names the same folder however the text was typed or wherever it
came from (macOS file names and some keyboards produce the decomposed form, NFD). What that means for an object
another tool wrote under a key that is not NFC: on R2 nothing, since R2 keeps both forms as one object; on S3 and
other stores that compare keys byte for byte, `api` cannot reach that object. Call the storage driver for it, which
sends a key exactly as given: `storage.head(key)`, `storage.delete(key)`, `storage.list(prefix)`.

### checkBucket

```ts
const { data: report, error } = await cloudrop.api.checkBucket({ origins: ["https://app.example.com"] });
// report.cors, report.lifecycle, report.publicAccess: each { status: "ok" | "problem" | "unknown", message }
```

It checks:

- **`cors`:** whether browsers on `origins` (default: `trustedOrigins`) may `PUT` with the headers cloudrop signs and
  read `ETag`.
- **`lifecycle`:** whether an enabled rule aborts incomplete multipart uploads across the bucket.
- **`publicAccess`:** whether a private route stores files on a bucket with a public URL.

`cors` and `lifecycle` come back `unknown` when the credentials may not read that setting (an R2 object token cannot)
or the storage cannot report it (Wrangler's local R2 answers `501 NotImplemented`). `cors` is also `unknown` when no
origin was given; `lifecycle` does not depend on origins. With an R2
admin read token, R2's answers have not been measured yet. Any other storage failure fails the call.

In development (`NODE_ENV=development`, exactly), the handler's first request runs this check once in the background
and logs a warning for each problem. More on what it can and cannot see: [Bucket setup](bucket-setup.md#what-checkbucket-can-tell-you).
