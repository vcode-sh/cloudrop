# cloudrop

[![npm version](https://img.shields.io/npm/v/cloudrop)](https://www.npmjs.com/package/cloudrop)
[![CI](https://github.com/vcode-sh/cloudrop/actions/workflows/ci.yml/badge.svg)](https://github.com/vcode-sh/cloudrop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24+-339933)](https://nodejs.org/)

**Resumable file uploads from the browser straight to Cloudflare R2 or any S3-compatible bucket.**

Your server decides who may upload what, signs short-lived upload links, and checks the stored file before it accepts
it. The browser sends the bytes to the bucket itself, so they never pass through your server, and the client retries
what fails, shows progress, and picks up where it left off after a reload.

## Why cloudrop

- **Direct to the bucket.** The browser uploads with presigned URLs. Your server handles a few small JSON requests, not
  the file.
- **Resumable multipart.** Files over 64 MiB (you can change this) go in parts, several at a time. A failed part is
  sent again, an expired link is renewed, and after a reload or a closed tab only the missing parts are sent.
- **R2 first.** Built and tested against real Cloudflare R2, with what R2 actually does recorded in
  [`docs/research`](docs/research/r2-spike-findings.md). Any S3-compatible service works through `s3()`.
- **An optional database store.** A row per upload before anything is signed, `onComplete` once per file under a lease
  (exactly once for its writes through `tx` on Postgres with `transaction: true`), a quota per user that concurrent uploads cannot overshoot,
  revocation, and a sweep for abandoned uploads. Adapters for Postgres,
  SQLite, Cloudflare D1, Drizzle and Prisma.
- **Headless React hooks.** `useUpload` and `useResumable` give you state and controls, typed from your server's
  routes; you bring the UI.
- **Zero runtime dependencies.** Only web-platform APIs, so the server runs on Node.js 24+, Bun, Deno and Cloudflare
  Workers. React and drizzle-orm are optional peer dependencies.

## Install

```bash
npm i cloudrop    # or: bun add cloudrop, pnpm add cloudrop
```

## Quick start

A Next.js app with an avatar upload: the server, the route that mounts it, the hooks, a component, and the bucket's
CORS rule. `getUser` stands for your own app's session lookup.

**1. Create the server** in `lib/cloudrop.ts`:

```ts
import { createCloudrop, r2, route, unauthorized } from "cloudrop";

export const cloudrop = createCloudrop({
  storage: r2(), // reads the CLOUDROP_R2_* variables below
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

The settings come from the environment and are read on the first request, so a build needs none of them. In Next.js,
put them in `.env.local`:

```sh
CLOUDROP_SECRET=<at least 32 characters>    # generate one with: openssl rand -base64 32

CLOUDROP_R2_ACCOUNT_ID=<32 hexadecimal characters>
CLOUDROP_R2_ACCESS_KEY_ID=<access key id>
CLOUDROP_R2_SECRET_ACCESS_KEY=<secret access key>
CLOUDROP_R2_BUCKET=media

# Any S3-compatible service instead: storage: s3() with
# CLOUDROP_S3_ENDPOINT, CLOUDROP_S3_REGION, CLOUDROP_S3_BUCKET,
# CLOUDROP_S3_ACCESS_KEY_ID and CLOUDROP_S3_SECRET_ACCESS_KEY
```

What `authorize` returns is signed into the upload token, which the browser can read, so return ids, never secrets.

**2. Mount the handler** in `app/api/cloudrop/[...all]/route.ts`:

```ts
import { toNextHandler } from "cloudrop/next";
import { cloudrop } from "../../../../lib/cloudrop";

export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);
```

Node, Express, Hono, Bun and other runtimes: [Mounting the handler](docs/guide/server.md#mounting-the-handler).

**3. Create the hooks** in `lib/upload.ts`:

```ts
import { createUploadHooks } from "cloudrop/react";
// A type import: a value import would pull the server and its secret into the browser bundle.
import type { cloudrop } from "./cloudrop";

export const { useUpload, useResumable } = createUploadHooks<typeof cloudrop>();
```

**4. Upload from a component:**

```tsx
"use client";
import { useUpload } from "../lib/upload";

export function AvatarPicker() {
  const { files, getInputProps } = useUpload("avatar", { accept: "image/*" });
  const avatar = files.at(-1);
  return (
    <label>
      Avatar <input {...getInputProps()} />
      {avatar?.status === "uploading" && <progress value={avatar.progress} />}
      {avatar?.error && <p role="alert">{avatar.error.message}</p>}
      {avatar?.result && <p>Saved as {avatar.result.file.key}</p>}
    </label>
  );
}
```

Without React, the client does the same in one call:

```ts
import { createCloudropClient } from "cloudrop/client";
import type { cloudrop } from "../lib/cloudrop";

const { upload } = createCloudropClient<typeof cloudrop>();
const { data, error } = await upload("avatar", file); // never rejects for an expected failure
```

**5. Allow your page to upload to the bucket.** Without a CORS rule the browser blocks every upload, which shows as
`NETWORK_ERROR`. With credentials that may change bucket settings, the [cloudrop command](docs/guide/command.md) adds
the CORS and lifecycle rules and keeps the bucket's other rules:

```bash
npx cloudrop setup --origin http://localhost:3000 --apply
npx cloudrop doctor --origin http://localhost:3000    # checks the settings, the bucket and its rules
```

Or by hand: for R2, write `cors.json` with your page's origin:

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["http://localhost:3000"],
        "methods": ["PUT", "GET", "HEAD"],
        "headers": ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"]
      },
      "exposeHeaders": ["ETag", "Retry-After"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

```bash
wrangler r2 bucket cors list media                    # setting CORS replaces every rule: keep the ones you need
wrangler r2 bucket cors set media --file cors.json
```

Add a lifecycle rule that aborts incomplete multipart uploads too. Both rules for R2 and S3, the AWS CLI commands and
the token permissions: [Bucket setup](docs/guide/bucket-setup.md).

Each entry of `files` is one file's live state: `status`, `progress`, `error` and, once done, `result`. An expected
failure never throws: `error.code` is for your code to branch on (`UNAUTHORIZED`, `FILE_TOO_LARGE`, `NETWORK_ERROR`,
...) and `error.message` tells the user what to do next. Every code: [Errors](docs/guide/errors.md).

## How it works

```text
 Browser                         Your server (cloudrop)                Bucket (R2 or S3)
    |                                     |                                    |
    | 1. POST /upload {route, files} ---> | checks authorize, size, type       |
    | <------ tickets with signed URLs -- | signs upload URLs                  |
    |                                                                          |
    | 2. PUT the bytes, one request or in parts ---------------------------->  |
    |                                                                          |
    | 3. POST /complete {token} --------> | checks what the bucket holds ----> |
    | <------------- { file, data } ----- | runs your onComplete               |
```

1. The browser asks your server to upload a file. The server runs your `authorize` function, checks the file's size
   and type against the route, and answers with a **presigned URL**: a link that lets whoever holds it write one object
   for a few minutes, without any credentials.
2. The browser sends the bytes straight to the bucket with that URL. A large file goes as a **multipart upload**: cut
   into parts that are sent in parallel and joined by the bucket at the end.
3. The browser tells your server it is done. The server checks what the bucket holds against what was declared, then
   runs your `onComplete`. A single upload of the wrong size or type is deleted; a part of the wrong size is sent
   again.

## Entry points

| Import | What it is for |
| --- | --- |
| `cloudrop` | The server: `createCloudrop`, `route`, the `r2()` and `s3()` storage drivers, `unauthorized()`, `forbidden()`, `CloudropError` |
| `cloudrop/next` | `toNextHandler`: the handler as Next.js App Router route handlers |
| `cloudrop/node` | `toNodeHandler`: the handler for Node's `http` server, Express and other Node frameworks |
| `cloudrop/client` | `createCloudropClient`: the browser client, with `upload()`, `start()`, progress, pause, retry and resume |
| `cloudrop/react` | `createUploadHooks`: the `useUpload` and `useResumable` hooks (needs React 18 or 19) |
| `cloudrop/adapters/sql` | `sqlStore` with node-postgres, postgres.js, `node:sqlite` and Cloudflare D1 executors |
| `cloudrop/adapters/drizzle` | `drizzleStore` and the table definitions for Drizzle on Postgres and SQLite (drizzle-orm 0.45 or later) |
| `cloudrop/adapters/prisma` | `prismaStore` for Prisma 7 |
| `cloudrop/testing` | `testBucket`, `testClient` and `memoryStore`: your routes and a whole upload in your tests, with no bucket or browser |
| `cloudrop/plugins` | `contentChecks`: the server reads each file's first bytes and refuses one whose content is not what it claims |

Hono, Bun, Deno and Cloudflare Workers need no adapter: `cloudrop.handler(request)` takes a `Request` and resolves to a
`Response`.

## Keep a record of uploads

The server above is stateless: the signed token carries everything, and `onComplete` runs at least once per file. Pass
a store to keep one row per upload in your own database:

```ts
import { createCloudrop, r2, route, unauthorized } from "cloudrop";
import { pgExecutor, sqlStore } from "cloudrop/adapters/sql";
import pg from "pg";

const store = sqlStore(pgExecutor(new pg.Pool({ connectionString: process.env.DATABASE_URL })));

export const cloudrop = createCloudrop({
  storage: r2(),
  store,
  quota: () => 1024 ** 3, // bytes each owner may keep
  routes: {
    avatar: route(
      {
        accept: "image/*",
        maxSize: "5MB",
        authorize: async ({ request }) => {
          const user = await getUser(request);
          return user ? { userId: user.id } : unauthorized();
        },
      },
      { owner: ({ userId }) => userId }, // whose quota the file counts toward
    ),
  },
});
```

With a store, `onComplete` runs once per file, each owner's files count toward a quota, `api.revokeUploads` stops a
signed-out user's uploads, and `api.sweep` cleans up after abandoned ones. "Once" has exceptions: a crash, a throw or a
run longer than `completionLeaseMs` runs it again, and only writes through `tx` on Postgres with `transaction: true`
commit exactly once. Keep an email or a webhook in `onComplete` idempotent, or send it from `afterComplete`, which runs
at most once and best effort. The tables, every adapter and what each mode guarantees:
[Database store](docs/guide/store.md#what-it-guarantees).

## Examples

| Example | What it shows |
| --- | --- |
| [`examples/next`](examples/next/README.md) | A Next.js app with an upload UI on the hooks: drop zone, progress, pause, resume after reload. Uploads to RustFS, Wrangler or R2; an opt-in SQLite store |
| [`examples/hono`](examples/hono/README.md) | A Hono API on Bun with better-auth, the Drizzle store on Postgres, an oRPC router and a sweep worker |
| [`examples/vite-react`](examples/vite-react/README.md) | The web app for `examples/hono`: Vite and React on another origin, with cookies |

The [Hono guide](docs/guide/hono.md) builds the last two step by step.

## Documentation

Start at the [documentation index](docs/README.md). The guides:

| Page | What it covers |
| --- | --- |
| [Server](docs/guide/server.md) | `createCloudrop`, storage drivers, routes, the upload token, mounting, origins, `cloudrop.api` |
| [Client](docs/guide/client.md) | `createCloudropClient`, `upload()` and `start()`, progress, pause, retry, concurrency, offline |
| [React](docs/guide/react.md) | `useUpload` and `useResumable` for inputs, drop zones, progress lists and resume |
| [Bucket setup](docs/guide/bucket-setup.md) | CORS and lifecycle rules for R2 and S3, credentials, `checkBucket` |
| [The cloudrop command](docs/guide/command.md) | `cloudrop doctor` and `cloudrop setup`: check the settings and bucket, add the rules |
| [Database store](docs/guide/store.md) | Adapters, tables, `owner`, `quota`, `onComplete` once, `onDelete`, revocation, the sweep |
| [Plugins](docs/guide/plugins.md) | `contentChecks()`: refuse a file whose content is not its declared type, and web pages or programs |
| [Deployment](docs/guide/deployment.md) | Same-origin and cross-origin setups, cookies, proxies, building without secrets |
| [Resume after reload](docs/guide/resume.md) | Continuing a large upload after a reload or a closed tab |
| [Hono with better-auth and Drizzle](docs/guide/hono.md) | A Hono API and a Vite SPA on another origin, step by step |
| [Testing your app](docs/guide/testing-your-app.md) | `cloudrop/testing`: test routes, quotas, `onComplete` and uploads without a bucket |
| [Errors](docs/guide/errors.md) | Every error code, where it comes from and what to do |
| [Troubleshooting](docs/guide/troubleshooting.md) | Symptoms and their usual causes |

## Requirements

- **Server:** Node.js 24+, Bun, Deno or Cloudflare Workers.
- **Client:** a browser with `fetch` and `AbortSignal`. The browser tests run in Chromium.
- **React:** 18 or 19, only for `cloudrop/react`.
- **TypeScript:** 5.4 or newer for cloudrop's types.

## Status

cloudrop is pre-1.0. The server, the browser client, the React hooks and the database store are built and tested:
against an in-process fake R2, real R2, RustFS behind a fault-injecting proxy, and from Chromium through the examples.
Until 1.0, a minor version may change the API; every change is in the [changelog](packages/cloudrop/CHANGELOG.md).

1.0 freezes the public API under semantic versioning. 0.1.0 was the first release; 0.2.0 added what the first
production app asked for (a client-wide `close()`, headers for your API only, listing and erasing an owner's files, one
file per owner on a route); 0.3.0 added `cloudrop/testing` and the `cloudrop` command; 0.4.0 added content checks,
`onDelete`, search and sort for an owner's files, and the `account` guard. Before 1.0 come plugins for limits, images
and checksums. Where the project stands: [plans and roadmap](docs/superpowers/plans/README.md).

## Contributing

Bug reports, fixes and documentation are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup (Bun and
Node 24), the gates every change passes, the test lanes and how decisions are recorded.

## Security

Please report vulnerabilities privately, never in a public issue: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Not affiliated with Cloudflare.
