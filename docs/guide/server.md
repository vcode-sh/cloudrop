# Server

This page covers everything that runs on your server: creating the server with `createCloudrop`, choosing a storage
driver, defining routes and who may use them, what the upload token is and what it allows, mounting the handler in your
framework, which origins may call it, and the `cloudrop.api` file operations. For the browser side, see
[Client](client.md).

## Create the server

```ts
// lib/cloudrop.ts
import { createCloudrop, r2, route, unauthorized } from "cloudrop";

export const cloudrop = createCloudrop({
  storage: r2({ bucket: "media" }),
  routes: {
    avatar: route({
      accept: "image/*",
      maxSize: "5MB",
      authorize: async ({ request }) => {
        const user = await getUser(request); // your app's session lookup
        return user ? { userId: user.id } : unauthorized();
      },
      prefix: ({ userId }) => `users/${userId}/avatars`,
    }),
  },
});
```

`createCloudrop` checks every option at once and throws a `CloudropError` with code `INVALID_CONFIG` for a mistake. Its
message names the option and the fix. A misconfigured server fails when it starts, not on a user's first upload.

| Option | What it does | Default |
| --- | --- | --- |
| `storage` | Where files go: `r2({ ... })` or `s3({ ... })`. Required. | |
| `routes` | The upload routes, by name. At least one. A name uses letters, digits, `-` and `_`, at most 64. | |
| `secret` | The secret that signs upload tokens: text of at least 32 characters, or a list of them (see [Rotate the secret](#rotate-the-secret)). | env `CLOUDROP_SECRET` |
| `basePath` | Where the handler is mounted. A leading slash, no trailing slash, no query. | `"/api/cloudrop"` |
| `trustedOrigins` | Exact origins, such as `"https://app.example.com"`, that may call the handler from another origin (see [Origins](#origins)). Never `"*"`. | `[]` |
| `multipartThreshold` | Files larger than this go in parts. Bytes or a size such as `"64MB"`. | 64 MiB |
| `plugins` | Plugins with server hooks (see [Hooks](#hooks)). | `[]` |
| `logger` | Where failures inside the handler and configuration warnings go: any object with `error(message, error)` and `warn(message)`, such as `console` or a pino logger. | `console` |

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
| `bucket` | Required. The exact bucket name. |
| `accountId` | env `CLOUDROP_R2_ACCOUNT_ID`. 32 hexadecimal characters, from the R2 overview page in the Cloudflare dashboard. |
| `accessKeyId` | env `CLOUDROP_R2_ACCESS_KEY_ID` |
| `secretAccessKey` | env `CLOUDROP_R2_SECRET_ACCESS_KEY` |
| `jurisdiction` | `"eu"` or `"fedramp"` for a bucket in that jurisdiction. Omit it for the default location. |
| `publicUrl` | Where the bucket is served publicly: a custom domain or `r2.dev` URL, a path allowed, such as `"https://cdn.example.com/files"`. |
| `fetch` | Replaces the global `fetch`. |

When a setting is missing, `r2()` throws one `INVALID_CONFIG` error that lists everything missing at once.

### Any S3-compatible service

```ts
import { s3 } from "cloudrop";

const storage = s3({
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  bucket: "media",
  accessKeyId: process.env.S3_ACCESS_KEY_ID as string, // your own variable names
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
});
```

`s3()` reads nothing from the environment: pass `endpoint`, `region`, `bucket`, `accessKeyId` and `secretAccessKey`
yourself. `endpoint` is an `http` or `https` URL with no query or fragment; a path in it is kept as a prefix of every
request, for a service behind a proxy path. `publicUrl` and `fetch` work as for `r2()`.

Which permissions the credentials need: [Bucket setup](bucket-setup.md#credentials-and-permissions).

## Define routes

A route is one kind of upload: what files it accepts, how large, who may upload, and where the files go.

```ts
import { route, unauthorized } from "cloudrop";
import { z } from "zod"; // any Standard Schema library: zod, valibot, arktype

const photo = route({
  accept: ["image/png", "image/jpeg", "image/webp"],
  maxSize: "10MB",
  maxFiles: 20,
  metadata: z.object({ albumId: z.string() }),
  authorize: async ({ request, metadata }) => {
    const user = await getUser(request); // your app's session lookup
    if (!user) return unauthorized();
    return { userId: user.id };
  },
  prefix: ({ userId, metadata }) => `users/${userId}/albums/${metadata.albumId}`,
  onComplete: async ({ file, userId }) => {
    await savePhoto({ id: file.id, key: file.key, userId }); // your app's database write
    return { key: file.key };
  },
});
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
| `onComplete` | Runs inside `/complete` once the file is verified. What it returns reaches the client as `data.data`, as JSON. |

`prefix`, `key` and `onComplete` receive what `authorize` returned, plus `request`, `metadata` and, for `prefix` and
`key`, the `file` (`id`, `name`, `size`, `type`, `ext`). `onComplete` receives the stored `file` (`id`, `key`, `name`,
`size`, `type`, and `url`, the public URL on a public route or `null`).

### Keys

The server chooses every key; the client's file name never reaches it. The name appears only in the stored
`Content-Disposition` header. Keys from `prefix` and `key` are checked the same way: `.` and `..` segments, empty
segments, a leading `/`, control characters and keys over 1024 bytes are refused, and Unicode is normalized to NFC.

A custom `key` must be unique. A rejected or aborted upload's object is deleted by key after a `HEAD` shows the object is
this upload's, and that delete is not conditional: another file stored under the same key between the two requests
would be deleted.

### Private and public routes

A file on a public route gets a public URL in `file.url`. A private route needs a bucket without a public domain: when
the storage has a `publicUrl`, anyone who learns a key can read the file. `createCloudrop` logs a warning when a private
route uses storage with a `publicUrl`. Serve private files with `cloudrop.api.getUrl(key)`, which signs a short-lived
link.

## Authorize uploads

Every route needs `authorize`. It receives `{ request, metadata }` and returns either a plain object with the facts
later steps need, or `unauthorized()`:

```ts
authorize: async ({ request }) => {
  const user = await getUser(request); // your app's session lookup
  return user ? { userId: user.id } : unauthorized("Sign in to upload photos.");
},
```

- `unauthorized()` refuses the upload with `UNAUTHORIZED`. Its message reaches the user; the default is "Sign in to
  upload files here."
- A public route must say so: `authorize: allowAnyone`. Public uploads are never a default.
- Write `authorize` before `prefix`, `key` and `onComplete`. TypeScript types their context from its result, in the
  order the options are written.
- What `authorize` returns is signed into the upload token, which the browser can read. Return ids, never secrets.
- The client sends cookies with every call to your server (`credentials: "include"`), so `authorize` can read the
  session from `request`.

## The upload token and what it allows

`/upload` answers each accepted file with a **ticket**: the file's key, its upload URLs and an **upload token**. The
token carries everything later calls need: the route, the key, the size and type, what `authorize` returned and the
validated metadata. It is signed with your secret, so the server keeps no state and trusts nothing else a client sends.
It is signed, not encrypted: the browser can read it.

What happens in `/upload`:

1. The request is checked (body at most 64 KiB, JSON, an allowed origin).
2. The route's metadata schema validates the metadata.
3. `authorize` runs.
4. Each file's size and type are checked against the route. File names are normalized to NFC before they are counted
   (1 to 255 Unicode code points) and stored.
5. Only then is anything signed.

Then the rules that follow from a stateless token:

- **`authorize` runs only in `/upload`.** The token is the authority for that file for 24 hours. A session revoked
  mid-upload can still finish the upload, so check the session again in `onComplete` when that matters: `request`
  carries the caller's cookies and headers.
- **Upload URLs live 15 minutes.** The client renews them through `/sign`.
- **`/abort` is cleanup, not revocation.** Until the token expires, whoever holds it can get a new single-`PUT` URL,
  upload and complete, and can delete its own completed file through `/abort`. An expired token still aborts an
  unfinished upload, but never deletes a stored file.
- **A removed route.** `/abort` still cleans up, and runs `onAbort`, after a deploy removed or renamed the token's route.
  `/sign` and `/complete` refuse such a token with `UNKNOWN_ROUTE`.

What `/complete` verifies, which is the real guarantee:

- **Single `PUT`:** a `HEAD` of the object. Its size, type and upload id must match the token.
- **Multipart:** the bucket's list of parts. Every part's size must match the plan; completion uses the server's part
  list, never the client's. A missing or wrong-sized part answers `PARTS_MISSING` with its number, and the client sends
  it again.
- A wrong size or type deletes the object and answers `VERIFICATION_FAILED`. An object another upload wrote under the
  same key is never deleted: it answers `VERIFICATION_FAILED` (single `PUT`) or `ALREADY_EXISTS` (multipart).

What the upload URLs sign, so the bucket itself refuses anything else: the exact size and type, `If-None-Match: *` on a
single `PUT` (a URL can never overwrite an object), the upload id in `x-amz-meta-cloudrop-id`, and a
`Content-Disposition` that is `inline` for raster images, video and audio, and `attachment` for everything else,
including HTML, SVG and XML. That keeps an uploaded HTML or SVG file from running as a page on a public bucket domain.

Why it works this way: the M2 decisions in [docs/decisions](../decisions/README.md) and
[the design](../superpowers/specs/2026-11-15-cloudrop-design.md#7-security-and-verification).

## Hooks

### onComplete

`onComplete` is a route option. It runs inside `/complete`, after the file is verified, at least once per file. Its JSON
result reaches the client as `data.data`; without `onComplete`, `data.data` is `null`.

### Plugin hooks

Plugins add server hooks through `createCloudrop({ plugins })`. Each plugin is `{ id, server }`, and `server` takes any
of these functions:

| Hook | When it runs |
| --- | --- |
| `beforeUpload` | In `/upload`, after authorization and the size and type checks, before anything is signed. Return a `CloudropError` to refuse every file. |
| `afterVerify` | In `/complete`, after verification, before `onComplete`. Return a `CloudropError` to refuse the file: the object is deleted and the error reaches the client. |
| `onAbort` | When a file `beforeUpload` accepted is refused, cannot be started, is rejected at `/complete`, or is ended through `/abort`. Release a reservation here. |
| `extendRoute` | Once per route, in `createCloudrop`. Throw a `CloudropError` with `INVALID_CONFIG` to refuse the route. |

```ts
import { type CloudropPlugin, CloudropError } from "cloudrop";

const quota: CloudropPlugin = {
  id: "quota",
  server: {
    beforeUpload: async ({ files, auth }) => {
      const ok = await reserveQuota(auth, files); // your app's quota check
      return ok ? undefined : new CloudropError("UNAUTHORIZED", "You are out of storage. Delete some files first.");
    },
    onAbort: async ({ file }) => {
      await releaseQuota(file.id); // your app's cleanup, idempotent by file.id
    },
  },
};
```

Nothing runs when an abandoned upload's token expires, so a reservation also needs its own expiry. cloudrop's own
plugins (`contentChecks`, `limits`, `images`, `checksums`) arrive in M5.

### Make hooks idempotent

Hooks can run more than once. A retried or replayed request repeats `afterVerify` and `onComplete` (on `/complete`) and
`onAbort` (on `/abort`), and a resumed upload runs `afterVerify` and `onComplete` again. Make their side effects
idempotent by the stable `file.id`: for example, insert with `file.id` as the primary key and ignore a duplicate.

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

`next build` loads `lib/cloudrop.ts`, so `CLOUDROP_SECRET` and the storage settings must be set at build time too. A
build without them fails with `INVALID_CONFIG`. See
[the example](../../examples/next/README.md#the-build-needs-the-settings).

### Node http, http2 and Express

```ts
import http from "node:http";
import { toNodeHandler } from "cloudrop/node";
import { cloudrop } from "./lib/cloudrop";

http.createServer(toNodeHandler(cloudrop)).listen(3000);

// Express: mount it at the path, before any body parser.
app.use("/api/cloudrop", toNodeHandler(cloudrop));
```

Mount it before any body parser: a parser that reads the body first leaves nothing for cloudrop to read.

`toNodeHandler` takes the request's origin from `Host` (or HTTP/2's `:authority`) and the scheme from the connection,
never from `X-Forwarded-*` or `:scheme`. It answers `400` rather than guess an origin such as `localhost` when that host
is missing, sent twice, malformed (userinfo, a path, an invalid port) or names another origin in `host` than in
`:authority`, since the origin decides the same-origin check. It also answers `400` to a request target that is not a
path, such as the absolute form `POST http://host/api/cloudrop/upload`: browsers send that form only to proxies, and
accepting it would let the target choose the origin. A hand-built request without `rawHeaders` is read from `headers`
alone.

### Any runtime with Request and Response

Bun, Deno, Cloudflare Workers and frameworks that speak `Request` and `Response` call the handler directly:

```ts
// Cloudflare Workers
export default {
  fetch: (request: Request) => cloudrop.handler(request),
};
```

On Workers, pass `secret` and the storage credentials explicitly unless your Worker exposes `process.env` (see
[Settings from the environment](#settings-from-the-environment)). How the server's parallel storage calls fit Workers'
subrequest limits has not been measured yet.

## Origins

The handler accepts:

- requests from its own origin;
- requests from `trustedOrigins`, exact origins such as `"https://app.example.com"`, never `"*"`;
- requests without an `Origin` header, which come from servers and native apps, unless `Sec-Fetch-Site: cross-site`
  shows a browser that dropped it. `Origin: null` is refused.

Everything else gets `ORIGIN_NOT_ALLOWED`. The handler also requires `Content-Type: application/json`, so a page on
another origin must pass a CORS preflight first.

The handler sees its own origin in the request URL and trusts no `X-Forwarded-*` header. **Behind a proxy that
terminates TLS or rewrites `Host`, your own pages look cross-origin:** list the app's public origin in
`trustedOrigins`. The first time the handler refuses a request from an origin, it logs a warning naming the refused
origin and the one it sees, for up to 16 origins.

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

`getUrl` signs at the start of an `expiresIn` window and the URL stays valid for two windows, so every viewer in one
window gets the same, cacheable URL.

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

A check comes back `unknown` when the credentials may not read that setting (an R2 object token cannot), when the
storage cannot report it (Wrangler's local R2 answers `501 NotImplemented`), or when no origin was given. With an R2
admin read token, R2's answers have not been measured yet. Any other storage failure fails the call.

In development (`NODE_ENV=development`, exactly), the handler's first request runs this check once in the background
and logs a warning for each problem. More on what it can and cannot see: [Bucket setup](bucket-setup.md#what-checkbucket-can-tell-you).
