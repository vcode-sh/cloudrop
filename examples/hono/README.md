# cloudrop Hono example

The API half of a two-origin app: a Hono server on Bun with better-auth, Drizzle on Postgres and cloudrop's database
store. Its web app is [`examples/vite-react`](../vite-react/README.md), served from `http://localhost:5173`; this API
listens on `http://localhost:5181`. [Hono with better-auth and Drizzle](../../docs/guide/hono.md) walks through the same
setup step by step.

- `src/index.ts` is the composition root: settings, the `pg` pool under Drizzle, better-auth, cloudrop and `Bun.serve`.
- `src/app.ts` builds the Hono app (`createApp(deps)`): a global `hono/cors` for the app's own routes that skips
  `/api/cloudrop/*`, better-auth at `/api/auth/*`, cloudrop at `/api/cloudrop/*` and the oRPC router at `/rpc/*`, with
  oRPC's CSRF plugin (a form posted from another origin of the site is refused).
- `src/uploads.ts` creates cloudrop (`createUploads(deps)`): `avatar` (one image of at most 2 MB, one PUT; its
  `onComplete` writes the `avatar` row through the completion's transaction, and `replace: true` deletes the previous
  avatar when the next one completes) and `attachments` (up to 10 files of 100 MB, in parts of 8 MiB above 8 MB), with a quota per user
  (`UPLOAD_QUOTA_MB`, 500 unless set).
- `src/db/schema/` holds one file per feature: better-auth's tables (`auth.ts`), the app's `avatar` table and cloudrop's
  two tables from `cloudropPgTables()` (`cloudrop.ts`). Every timestamp is `timestamptz(3)`. `drizzle/` holds the
  migration drizzle-kit generated from them.
- `src/rpc/router.ts` is the oRPC router `files`: `list` reads the user's completed files from cloudrop's table,
  `delete` removes one through `cloudrop.api.deleteFile`, `avatar` signs a short-lived URL of the avatar.
- `src/worker.ts` is a separate process that sweeps abandoned uploads every hour (`SWEEP_INTERVAL_MINUTES`), every
  page in one `sweep({ all: true })` call. Its comment shows the same job as a scheduled queue.
- `src/types.ts` is what the web app imports, types only.
- `src/settings.ts` reads the environment with a small typed reader. An app with its own env schema reads the same
  settings through it.

Sign-up takes any email and a password of 8 characters or more; no email is sent, so nothing is verified. Never ship
that as it is.

## Run with RustFS

Prerequisites: Docker, Bun and Node.js 24. From this directory:

```sh
(cd ../.. && bun install && bun run build)   # once, after cloning: builds the cloudrop package
CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs ../../scripts/rustfs.sh up
../../scripts/postgres.sh up                  # Postgres 18 as cloudrop-example-postgres on 127.0.0.1:19600
bun run setup:rustfs                          # the bucket, its CORS and lifecycle rules, and .env
bun run db:migrate
bun run dev                                   # the API on http://localhost:5181
bun run worker                                # optional, in another terminal: the sweep
```

Then start the web app ([`examples/vite-react`](../vite-react/README.md)) and open <http://localhost:5173>.

The example runs the package's built output, so after changing `packages/cloudrop` run `bun run build` in the
repository root and restart `bun run dev`.

`bun run setup:rustfs` creates the bucket `cloudrop-example-hono`, sets a CORS rule for `http://localhost:5173` (the
web app's origin: the browser sends the bytes from there, so the rule never names the API's), checks that a browser
preflight from it is allowed, adds a lifecycle rule that aborts incomplete multipart uploads after a day, and writes
`.env` with `DATABASE_URL`, fresh `BETTER_AUTH_SECRET` and `CLOUDROP_SECRET`, and the RustFS settings. It keeps an
existing `.env`. Exported variables win over `.env`.

When you are done:

```sh
../../scripts/postgres.sh down    # its data lives in memory and goes with it
CLOUDROP_RUSTFS_NAME=cloudrop-example-rustfs ../../scripts/rustfs.sh down
rm .env
```

## Settings

| Variable | What it is | Default |
| --- | --- | --- |
| `DATABASE_URL` | Postgres | required |
| `BETTER_AUTH_SECRET` | better-auth's secret, 32 characters or more | required |
| `CLOUDROP_SECRET` and `CLOUDROP_S3_*` or `CLOUDROP_R2_*` | cloudrop's secret and storage, read on the first request ([Server](../../docs/guide/server.md#settings-from-the-environment)) | required |
| `PORT` | The API's port | 5181 |
| `API_ORIGIN` | The API's public origin, better-auth's `baseURL` | `http://localhost:5181` |
| `WEB_ORIGIN` | The web app's origin, trusted by CORS, better-auth and cloudrop | `http://localhost:5173` |
| `UPLOAD_QUOTA_MB` | Bytes each user may keep, in MB | 500 |
| `SWEEP_INTERVAL_MINUTES` | How often the worker sweeps | 60 |

Leave `CLOUDROP_S3_ENDPOINT` unset to use R2 with `CLOUDROP_R2_*`; the bucket then needs the CORS rule above for the web
origin ([Bucket setup](../../docs/guide/bucket-setup.md)).

## Schema changes

```sh
bun run db:generate --name <what-changed>   # writes a migration to drizzle/
bun run db:migrate
```
