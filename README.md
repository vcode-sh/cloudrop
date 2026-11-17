# cloudrop

Fast, resumable, direct-to-bucket file uploads for Cloudflare R2 and S3-compatible storage.

cloudrop lets a browser upload files straight to your bucket, so the bytes never pass through your server. Your server
decides who may upload what, signs short-lived upload links, and checks the stored file before it accepts it. The
browser client sends the bytes, retries what fails, shows progress, and picks up where it left off after a reload.

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
3. The browser tells your server it is done. The server checks the stored object's size and type against what was
   declared, deletes a file that does not match, and runs your `onComplete`.

## Features

- **One request or many parts.** Small files go in one `PUT`; files over 64 MiB (you can change this) go in parts, up to
  four parts of a file at a time.
- **Retries that respect the storage.** Every request is tried up to 6 times with growing waits, and a bucket's
  `Retry-After` is honoured. An expired upload link is renewed. Missing parts are sent again.
- **Adaptive concurrency.** One client shares its connections between all its uploads and adds or removes connections
  as the network allows.
- **Progress you can render.** Bytes, progress, speed and time left per file and for the whole job, as a snapshot that
  works with React's `useSyncExternalStore`.
- **Control per file.** Pause, resume, cancel and retry one file or every file of a job.
- **Offline handling.** When the page goes offline, uploads pause, and they resume when it is back online.
- **Resume after a reload.** A large upload survives a reload or a closed tab: the user picks the file again, and only
  the missing parts are sent.
- **Server-side checks.** Authorization is required on every route. Size and type are checked before signing and
  verified again on the stored object.
- **Zero runtime dependencies.** Only web-platform APIs, so the server runs on Node.js 24+, Bun, Deno and Cloudflare
  Workers.

## Status

cloudrop is pre-release. Nothing usable is published yet: `cloudrop@0.0.0` on npm only reserves the name. To try it,
clone this repository and run [`examples/next`](examples/next/README.md).

- **Done:** M0 (a spike against real R2), M1 (storage: SigV4 signer, `r2` and `s3` drivers, contract suite), M2 (the
  server: routes, upload tokens, the handler, completion checks, `cloudrop.api`, the Next.js and Node adapters) and M3
  (the upload engine and the browser client).
- **Tested on:** the upload protocol runs against an in-process fake R2, real R2, and RustFS behind a fault-injecting
  proxy, and from Chromium through the example on RustFS and on real R2. Wrangler's local R2 runs the storage contract
  and single uploads only: it does not implement `ListParts`, so a multipart upload cannot complete there.
- **Next:** React hooks (`useUpload`) arrive in M4.

Where the project stands and what comes next: [docs/superpowers/plans/README.md](docs/superpowers/plans/README.md).

## Quickstart

Three files: the server, the route that mounts it, and the page that uploads. `getUser` and `showError` stand for your
own app's session lookup and error display.

**1. Create the server** in `lib/cloudrop.ts`:

```ts
import { createCloudrop, r2, route, unauthorized } from "cloudrop";

export const cloudrop = createCloudrop({
  // Reads CLOUDROP_R2_ACCOUNT_ID, CLOUDROP_R2_ACCESS_KEY_ID and CLOUDROP_R2_SECRET_ACCESS_KEY from the environment.
  storage: r2({ bucket: "media" }),
  // The upload token secret comes from CLOUDROP_SECRET. Generate one with: openssl rand -base64 32
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

Write `authorize` before `prefix`, `key` and `onComplete`: TypeScript types their context from its result, in the order
the options are written. What `authorize` returns is signed into the upload token, which the browser can read, so
return ids, never secrets.

**2. Mount the handler.** In Next.js, `app/api/cloudrop/[...all]/route.ts`:

```ts
import { toNextHandler } from "cloudrop/next";
import { cloudrop } from "../../../../lib/cloudrop";

export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);
```

Node, Express and other runtimes: [Mounting the handler](docs/guide/server.md#mounting-the-handler).

**3. Upload from the browser:**

```ts
"use client";
import { createCloudropClient } from "cloudrop/client";
// A type import: a value import would pull the server, its storage driver and its secret into the browser bundle.
import type { cloudrop } from "../lib/cloudrop"; // from app/page.tsx

const { upload } = createCloudropClient<typeof cloudrop>();

async function onPick(file: File) {
  const { data, error } = await upload("avatar", file);
  if (error) {
    showError(error.message); // your app's error display
    return;
  }
  console.log(data.file.key, data.data); // data.data is what onComplete returned, null without one
}
```

`upload()` never rejects for an expected failure. It resolves to `{ data, error }`: branch on `error.code` (such as
`UNAUTHORIZED`, `FILE_TOO_LARGE`, `NETWORK_ERROR`, or `ABORTED` after a cancel) and show `error.message`, which tells
the user what to do next. Every code is listed in [Errors](docs/guide/errors.md).

A working version of these three files, with a demo sign-in, runs against a local RustFS container without any
credentials: [`examples/next`](examples/next/README.md).

## Set up your bucket

Browsers upload to the bucket directly, so the bucket must allow it:

- **A CORS rule** that allows `PUT` from your page's origin with the headers cloudrop signs (`content-type`,
  `content-disposition`, `if-none-match`, `x-amz-meta-cloudrop-id`) and exposes `ETag` and `Retry-After`.
- **A lifecycle rule** that aborts incomplete multipart uploads, so parts of an upload that never finished do not stay
  in the bucket.

The exact rules for R2 and S3, the Wrangler commands and the token permissions: [Bucket setup](docs/guide/bucket-setup.md).
In development, the server checks the bucket on its first request and logs what is missing.

## Documentation

| Page | What it covers |
| --- | --- |
| [Server](docs/guide/server.md) | `createCloudrop`, storage drivers, routes, the upload token, mounting, origins, `cloudrop.api` |
| [Client](docs/guide/client.md) | `createCloudropClient`, `upload()` and `start()`, progress, pause, retry, concurrency, offline |
| [Resume after reload](docs/guide/resume.md) | Continuing a large upload after a reload or a closed tab |
| [Bucket setup](docs/guide/bucket-setup.md) | CORS and lifecycle rules for R2 and S3, credentials, `checkBucket` |
| [Errors](docs/guide/errors.md) | Every error code, where it comes from and what to do |
| [Troubleshooting](docs/guide/troubleshooting.md) | Symptoms and their usual causes |
| [Testing](docs/guide/testing.md) | For contributors: every test lane and what it needs |
| [`examples/next`](examples/next/README.md) | A Next.js app that uploads to RustFS, Wrangler or R2, with a lab page |
| [`docs/decisions`](docs/decisions/README.md) | Why the code is the way it is |
| [`docs/research`](docs/research) | Measured R2 and backend behaviour ([test backends](docs/research/test-backends.md)) |

## Requirements

- **Server:** Node.js 24+, Bun, Deno or Cloudflare Workers.
- **Client:** a browser with `fetch` and `AbortSignal`. The browser test lane runs Chromium only.
- **TypeScript:** 5.4 or newer for cloudrop's types (`route()`'s return type uses `NoInfer`).

## Development

```bash
bun install
bun run verify             # check, typecheck, test, build and package checks
bun run test:rustfs        # storage contract on RustFS in Docker
bun run test:wrangler      # storage contract on Wrangler's local R2
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
