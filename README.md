# cloudrop

Fast, resumable, direct-to-bucket file uploads for Cloudflare R2 and S3-compatible storage.

## Status

Nothing usable is published yet; `cloudrop@0.0.0` on npm only reserves the name.

- M0 (real-R2 spike) and M1 (storage: SigV4 signer, `r2` and `s3` drivers, contract suite): done.
- M2 (the server: `createCloudrop`, routes, upload tokens, the handler, completion checks, `cloudrop.api`, the Next.js
  and Node adapters): done on this branch.
- M3 (the upload engine and the browser client): next. Until it lands there is no client; the four endpoints are
  described in the [design spec](docs/superpowers/specs/2026-11-15-cloudrop-design.md#5-upload-protocol).

Why the code is the way it is, and what the M2 reviews changed: [docs/decisions](docs/decisions/README.md).

## Goals

- Headless core with a small footprint, plus thin React, Vue and Svelte bindings.
- R2-correct multipart uploads (equal part sizes), adaptive concurrency, retries, pause, resume and abort.
- Resume after a page reload.
- One framework-agnostic server handler (`Request` in, `Response` out) that signs uploads, requires authorization
  and verifies size and type on completion.
- Tested against real R2 and several S3-compatible servers.

## Server

```ts
// lib/cloudrop.ts
import { createCloudrop, r2, route, unauthorized } from "cloudrop";

export const cloudrop = createCloudrop({
  storage: r2({ bucket: "media" }), // CLOUDROP_R2_ACCOUNT_ID, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY from the environment
  // secret: CLOUDROP_SECRET from the environment (openssl rand -base64 32)
  routes: {
    avatar: route({
      accept: "image/*",
      maxSize: "5MB",
      authorize: async ({ request }) => {
        const user = await getUser(request); // your session lookup
        return user ? { userId: user.id } : unauthorized();
      },
      prefix: ({ userId }) => `users/${userId}/avatars`,
    }),
  },
});
```

Write `authorize` before `prefix`, `key` and `onComplete`: TypeScript types their context from its result in the order
the options are written. Its result is signed into the upload token, which the browser can read, so return ids, never
secrets.

### Mounting the handler

`cloudrop.handler(request)` takes a `Request` and always resolves to a `Response`. It serves `POST` (and the CORS
preflight, `OPTIONS`) to `/api/cloudrop/upload`, `/sign`, `/complete` and `/abort` (change the prefix with
`basePath`), in any framework that speaks `Request` and `Response`.

```ts
// Next.js: app/api/cloudrop/[...all]/route.ts
import { toNextHandler } from "cloudrop/next";
export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);

// Node http or http2, or Express mounted at the path, before any body parser
import { toNodeHandler } from "cloudrop/node";
http.createServer(toNodeHandler(cloudrop));
app.use("/api/cloudrop", toNodeHandler(cloudrop));
```

`toNodeHandler` takes the request's origin from `Host` (or HTTP/2's `:authority`) and answers `400` to a request
target that is not a path, such as the absolute form `POST http://host/api/cloudrop/upload`.

### Origins

The handler accepts requests from its own origin and from `trustedOrigins` (exact origins such as
`"https://app.example.com"`, never `"*"`), and requests without `Origin`, which come from servers and native apps
(unless `Sec-Fetch-Site: cross-site` shows a browser that dropped it).
It sees its own origin in the request URL and trusts no `X-Forwarded-*` header. Behind a proxy that terminates TLS or
rewrites `Host`, your own pages therefore look cross-origin: list the app's public origin in `trustedOrigins`. The
first time the handler refuses a request from an origin, it logs a warning naming the refused origin and the one it
sees (for up to 16 origins).

### Uploads and the token

- `/upload` checks the request, validates the route's metadata schema, runs `authorize`, then checks each file's size
  and type before anything is signed. File names are normalized to NFC before they are counted (1 to 255 Unicode
  code points) and stored.
- `authorize` runs only in `/upload`. The token it signs is the authority for that file for 24 hours: a session revoked
  mid-upload can still finish the upload, so re-check the session in `onComplete` when that matters (`request` carries
  the caller's cookies and headers).
- `/abort` is cleanup, not revocation. Until the token expires, whoever holds it can get a new single-PUT URL,
  upload and complete, and can delete its own completed file through `/abort`. Upload URLs live 15 minutes.
- `/abort` still cleans up, and runs `onAbort`, after a deploy removed or renamed the token's route; `/sign` and
  `/complete` refuse such a token.
- A custom `key` must be unique: a rejected or aborted upload's object is deleted by key after a HEAD, not
  conditionally.
- Hooks can run more than once: a retried or replayed request repeats `afterVerify` and `onComplete` (on `/complete`)
  and `onAbort` (on `/abort`). Make their side effects idempotent by the stable `file.id`.

### File API

`cloudrop.api` works on the same storage and returns `{ data, error }`: `getUrl`, `head`, `put`, `delete`,
`deleteMany`, `copy`, `deletePrefix` (a folder prefix ending in `/`, emptied and listed again to prove it) and
`checkBucket`. `checkBucket({ origins })` reports CORS for browser uploads, the abort-incomplete lifecycle rule and
private routes on a public bucket. An R2 object token may not read bucket settings, so those checks come back
`unknown`, as do settings the storage cannot report at all (Wrangler's local R2 answers `501 NotImplemented`); with
an admin read token, R2's answers have not been measured yet. In development
(`NODE_ENV=development`) the first request runs it once and logs each problem.

### Not done yet

- The upload protocol is tested on the in-process fake and on real R2; RustFS and Wrangler run only the storage
  contract until M3.
- How the server's parallel storage calls fit Cloudflare Workers' subrequest limits is unmeasured.

## Development

```bash
bun install
bun run verify        # check, typecheck, test, build and package checks
bun run test:rustfs   # storage contract on RustFS in Docker
bun run test:wrangler # storage contract on Wrangler's local R2
bun run test:live     # storage contract and upload protocol on real R2 (credentials: CLOUDROP_R2_ENV_FILE)
```

Background research: [`docs/research`](docs/research). Measured backend behaviour:
[`docs/research/test-backends.md`](docs/research/test-backends.md).

Not affiliated with Cloudflare.

## License

[MIT](LICENSE)
