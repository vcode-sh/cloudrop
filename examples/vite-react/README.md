# cloudrop Vite React example

The web half of a two-origin app: a Vite and React 19 single-page app on `http://localhost:5173` that signs in with
better-auth and uploads through the [Hono example](../hono/README.md)'s API on `http://localhost:5181`. The two are
different origins of the same site, so the API's session cookie travels with every credentialed request: no proxy and
no rewrite. [Hono with better-auth and Drizzle](../../docs/guide/hono.md) walks through the same setup step by step.

- `src/lib/upload.ts` creates the cloudrop client with the API's absolute `basePath` and the `cloudrop/react` hooks from
  it, typed by `import type { Uploads } from "cloudrop-example-hono/types"`: no server code reaches the bundle.
- `src/lib/auth-client.ts` is better-auth's React client with the API as `baseURL`; `src/lib/orpc.ts` is the oRPC client
  for the `files` router, with TanStack Query and oRPC's CSRF link plugin, which the API requires. Both send
  `credentials: "include"`.
- `src/components/` is built on the hooks with shadcn on Base UI and Tabler icons:
  - `drop-zone.tsx`: the attachments route, with `getDropProps`, `getInputProps` and `isDragOver`;
  - `upload-row.tsx`: one upload as shadcn's `Attachment`, with progress, Cancel, Retry and the error's message. It maps
    cloudrop's statuses onto the Attachment states: `queued` and `paused` are idle, `uploading` is uploading,
    `completing` is processing, `done` is done, `failed` is error, `aborted` is idle;
  - `unfinished-uploads.tsx`: `useResumable` after a reload: pick the same file again to send the missing parts, or
    discard one upload or all of them with the hook's `discard`, which aborts each on the API;
  - `avatar-picker.tsx`: the avatar route, and the current avatar from `files.avatar`;
  - `files-table.tsx`: the user's files from `files.list`, each with a delete;
  - `auth-panel.tsx`: sign-up, sign-in and sign-out, which forgets the browser's unfinished uploads first.
- `src/components/ui/` is vendored from shadcn's registry by `shadcn add`; leave it as the CLI writes it.

## Run with RustFS

Start the API first, as its README says (RustFS, Postgres, `bun run setup:rustfs`, `bun run db:migrate`,
`bun run dev`), then from this directory:

```sh
bun run dev    # http://localhost:5173
```

Open <http://localhost:5173>. Drop a file before signing in to see cloudrop's `UNAUTHORIZED` answer with the route's
message, then sign up with any email and a password of 8 characters or more. `VITE_API_ORIGIN` points the app at
another API origin; the API's `WEB_ORIGIN` and the bucket's CORS rule must then name this app's origin.

The app must run on port 5173: the API trusts that origin and the bucket's CORS rule names it. The Next.js example uses
the same port, so run one at a time.

## The browser tests

`src/app.browser.test.ts` runs in the third pass of `bun run test:browser` from the repository root, which starts its
own RustFS and Postgres containers, applies the API's migrations and lets Playwright start both servers. Each row signs
up a new user: an avatar uploaded in one PUT and shown from the bucket; three attachments, one in three parts, listed
by `files.list`, then one deleted; a 51 MiB file refused with `QUOTA_EXCEEDED` at a 50 MB quota before any byte is sent;
an upload while signed out refused with `UNAUTHORIZED`; a multipart upload interrupted by a reload and resumed by
picking the same file, sending only the missing parts; one of two unfinished uploads discarded after a reload, its row
aborted in the API's database while the other resumes; cloudrop's own preflight answered through the API's global CORS
middleware; and a multipart form posted to an oRPC procedure from another origin, with the session cookie, refused with
403 (`CSRF_TOKEN_MISMATCH`). Install the shell once with `bunx playwright install --only-shell chromium`.
