# cloudrop

Fast, resumable, direct-to-bucket file uploads for Cloudflare R2 and S3-compatible storage.

cloudrop lets a browser upload files straight to your bucket, so the bytes never pass through your server. Your server
decides who may upload what, signs short-lived upload links, and checks the stored file before it accepts it. The
browser client sends the bytes, retries what fails, shows progress, and picks up where it left off after a reload.

Until 0.1 is published, the version on npm (`0.0.0`) only reserves the name: to try cloudrop now, clone this repository
and run [`examples/next`](examples/next/README.md). From 0.1 on:

```bash
npm i cloudrop    # or: bun add cloudrop, pnpm add cloudrop
```

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

## Features

- **One request or many parts.** Small files go in one `PUT`; files over 64 MiB (you can change this) go in parts, up to
  four parts of a file at a time.
- **Retries that respect the storage.** Every request is tried up to 6 times with growing waits, and a bucket's
  `Retry-After` is honoured. An expired upload link is renewed. Missing parts are sent again.
- **Adaptive concurrency.** One client shares its connections between all its uploads and adds or removes connections
  as the network allows.
- **Progress you can render.** Bytes, progress, speed and time left per file and for the whole job, as a snapshot that
  works with React's `useSyncExternalStore`.
- **React hooks.** `cloudrop/react` gives you `useUpload` for inputs, drop zones and progress lists, and `useResumable`
  for uploads to continue after a reload, typed from your server's routes.
- **Control per file.** Pause, resume, cancel and retry one file or every file of a job.
- **Offline handling.** When the page goes offline, uploads pause, and they resume when it is back online.
- **Resume after a reload.** A large upload survives a reload or a closed tab: the user picks the file again, and only
  the missing parts are sent.
- **Server-side checks.** Authorization is required on every route. Size and type are checked before signing and
  verified again on the stored object.
- **An optional database store.** A row per upload before anything is signed, `onComplete` once per file, a quota per
  user that concurrent uploads cannot overshoot, uploads you can revoke, and a sweep that cleans up after abandoned
  ones. Adapters for Postgres and SQLite drivers, Cloudflare D1, Drizzle and Prisma.
- **Zero runtime dependencies.** Only web-platform APIs, so the server runs on Node.js 24+, Bun, Deno and Cloudflare
  Workers. React is an optional peer dependency, used only by `cloudrop/react`.

## Status

Pre-release: the API may change before 0.1.

- **Done:** M0 (a spike against real R2), M1 (storage: SigV4 signer, `r2` and `s3` drivers, contract suite), M2 (the
  server: routes, upload tokens, the handler, completion checks, `cloudrop.api`, the Next.js and Node adapters), M3
  (the upload engine and the browser client), M4a (fixes from a code audit, `route(policy, callbacks)`, settings
  read from the environment on the first request, `forbidden()`, and the `cloudrop/react` hooks) and M5 (the
  database store and its SQL, Drizzle and Prisma adapters).
- **Tested on:** the upload protocol runs against an in-process fake R2, real R2, and RustFS behind a fault-injecting
  proxy, and from Chromium through the example on RustFS and on real R2. Wrangler's local R2 runs the storage contract
  and single uploads only: it does not implement `ListParts`, so a multipart upload cannot complete there. The store
  runs its contract on Postgres 18, SQLite and Wrangler's local D1, through every adapter.
- **Next:** M4b (the Next example's upload UI, Hono and Vite React examples), then M6 (plugins: content checks, limits,
  images, checksums).

Where the project stands and what comes next: [docs/superpowers/plans/README.md](docs/superpowers/plans/README.md).

## Quickstart

Four files: the server, the route that mounts it, the hooks, and the component that uploads. `getUser` stands for your
own app's session lookup.

**1. Create the server** in `lib/cloudrop.ts`:

```ts
import { createCloudrop, r2, route, unauthorized } from "cloudrop";

export const cloudrop = createCloudrop({
  storage: r2(), // the CLOUDROP_R2_* variables below; the token secret comes from CLOUDROP_SECRET
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

The settings come from the environment, read on the first request, so a build needs none of them. In Next.js, put them
in `.env.local`; elsewhere, in your platform's environment:

```sh
CLOUDROP_SECRET=<at least 32 characters>    # generate one with: openssl rand -base64 32

# Cloudflare R2, read by r2()
CLOUDROP_R2_ACCOUNT_ID=<32 hexadecimal characters>
CLOUDROP_R2_ACCESS_KEY_ID=<access key id>
CLOUDROP_R2_SECRET_ACCESS_KEY=<secret access key>
CLOUDROP_R2_BUCKET=media

# Or any S3-compatible service: use storage: s3() and these instead
# CLOUDROP_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
# CLOUDROP_S3_REGION=us-east-1
# CLOUDROP_S3_BUCKET=media
# CLOUDROP_S3_ACCESS_KEY_ID=<access key id>
# CLOUDROP_S3_SECRET_ACCESS_KEY=<secret access key>
```

`route()` takes the policy first and, optionally, `prefix`, `key` and `onComplete` second: TypeScript types their
context from what `authorize` returns. That result is signed into the upload token, which the browser can read, so
return ids, never secrets.

**2. Mount the handler.** In Next.js, `app/api/cloudrop/[...all]/route.ts`:

```ts
import { toNextHandler } from "cloudrop/next";
import { cloudrop } from "../../../../lib/cloudrop";

export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);
```

Node, Express, Hono, Bun and other runtimes: [Mounting the handler](docs/guide/server.md#mounting-the-handler).

**3. Create the hooks** in `lib/upload.ts`:

```ts
import { createUploadHooks } from "cloudrop/react";
// A type import: a value import would pull the server, its storage driver and its secret into the browser bundle.
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

Before the first upload, give the bucket a CORS rule for your page's origin ([Set up your bucket](#set-up-your-bucket)):
without it the browser blocks every upload, which shows as `NETWORK_ERROR`.

Each entry of `files` is one file's live state: `status`, `progress`, `error` and, once done, `result`. Nothing throws
for an expected failure: a file's `error` carries a `code` for your code to branch on (such as `UNAUTHORIZED`,
`FORBIDDEN`, `FILE_TOO_LARGE` or `NETWORK_ERROR`) and a `message` that tells the user what to do next. Every code is
listed in [Errors](docs/guide/errors.md); everything the hooks do is in [React](docs/guide/react.md).

Without React, the client does the same in one call:

```ts
import { createCloudropClient } from "cloudrop/client";
import type { cloudrop } from "../lib/cloudrop";

const { upload } = createCloudropClient<typeof cloudrop>();
const { data, error } = await upload("avatar", file); // never rejects for an expected failure
```

A working version of these files, with a demo sign-in, runs against a local RustFS container without any
credentials: [`examples/next`](examples/next/README.md).

## Keep a record of uploads

The server above is stateless: the signed token carries everything, and `onComplete` runs at least once per file. Pass
a store to keep one row per upload in your own database, in two tables you create once:

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
          const user = await getUser(request); // your app's session lookup
          return user ? { userId: user.id } : unauthorized();
        },
      },
      { owner: ({ userId }) => userId },
    ),
  },
});
```

With a store, `onComplete` runs once per file (exactly once for its database writes through `tx` on Postgres, with
`{ transaction: true }`), each owner's files count toward a quota, `api.revokeUploads` stops a signed-out user's
uploads, and `api.sweep` cleans up after abandoned ones. The adapters are subpaths of the same package:
`cloudrop/adapters/sql` (node-postgres, postgres.js, `node:sqlite`, Cloudflare D1), `cloudrop/adapters/drizzle`
(`drizzle-orm` 0.45 or later, including 1.x from 1.0.0-rc.5, an optional peer) and `cloudrop/adapters/prisma`
(Prisma 7); install only the driver you already use. Setup, the tables and what each mode guarantees:
[Database store](docs/guide/store.md).

## Set up your bucket

Browsers upload to the bucket directly, so the bucket must allow it:

- **A CORS rule** that allows `PUT` from your page's origin (the page's, not your API's) with the headers cloudrop signs
  (`content-type`, `content-disposition`, `if-none-match`, `x-amz-meta-cloudrop-id`) and exposes `ETag` and
  `Retry-After`.
- **A lifecycle rule** that aborts incomplete multipart uploads, so parts of an upload that never finished do not stay
  in the bucket.

The exact rules for R2 and S3, the Wrangler and AWS CLI commands and the token permissions:
[Bucket setup](docs/guide/bucket-setup.md).
In development, the server checks the bucket on its first request and logs what is missing; that check does not
cover `Retry-After`.

## Documentation

| Page | What it covers |
| --- | --- |
| [Server](docs/guide/server.md) | `createCloudrop`, storage drivers, routes, the upload token, mounting, origins, `cloudrop.api` |
| [Database store](docs/guide/store.md) | The optional store: adapters, tables, `owner`, `quota`, `onComplete` once, revocation, the sweep |
| [Client](docs/guide/client.md) | `createCloudropClient`, `upload()` and `start()`, progress, pause, retry, concurrency, offline |
| [React](docs/guide/react.md) | `cloudrop/react`: `useUpload` and `useResumable` for inputs, drop zones, progress lists and resume |
| [Deployment](docs/guide/deployment.md) | Same-origin and cross-origin setups, cookies across sites, proxies, building without secrets |
| [Resume after reload](docs/guide/resume.md) | Continuing a large upload after a reload or a closed tab |
| [Bucket setup](docs/guide/bucket-setup.md) | CORS and lifecycle rules for R2 and S3, credentials, `checkBucket` |
| [Errors](docs/guide/errors.md) | Every error code, where it comes from and what to do |
| [Troubleshooting](docs/guide/troubleshooting.md) | Symptoms and their usual causes |
| [Testing](docs/guide/testing.md) | For contributors: every test lane and what it needs |
| [`examples/next`](examples/next/README.md) | A Next.js app that uploads to RustFS, Wrangler or R2, with a lab page and an opt-in SQLite store |
| [`docs/decisions`](docs/decisions/README.md) | Why the code is the way it is |
| [`docs/research`](docs/research) | Measured R2 and backend behaviour ([test backends](docs/research/test-backends.md)) |

## Requirements

- **Server:** Node.js 24+, Bun, Deno or Cloudflare Workers.
- **Client:** a browser with `fetch` and `AbortSignal`. The browser test lane runs Chromium only.
- **React:** 18 or 19, only for `cloudrop/react`; `react` is an optional peer dependency.
- **TypeScript:** 5.4 or newer for cloudrop's types (`route()`'s return type uses `NoInfer`).

## Development

```bash
bun install
bun run verify             # check, typecheck, test, build, the example's typecheck and package checks
bun run test:rustfs        # storage contract on RustFS in Docker
bun run test:wrangler      # storage contract on Wrangler's local R2, store contract on its local D1
bun run test:db            # store contract and adapters on Postgres 18 in Docker and SQLite
bun run test:live          # storage contract and upload protocol on real R2 (credentials: CLOUDROP_R2_ENV_FILE)
bun run test:chaos         # upload protocol on RustFS behind a fault-injecting proxy (needs Docker)
bun run test:chaos:soak    # the nightly seeded soak on the same setup
bun run test:browser       # the example in Chromium's headless shell, uploading to RustFS in Docker
bun run test:browser:live  # the same on real R2 (credentials as test:live; CORS must allow localhost:5173)
```

What each lane needs, its ports and how to write tests: [Testing](docs/guide/testing.md). Rules for coding agents:
[AGENTS.md](AGENTS.md).

Not affiliated with Cloudflare.

## License

[MIT](LICENSE)
