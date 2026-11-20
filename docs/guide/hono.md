# Hono with better-auth and Drizzle

This page adds cloudrop to an app built like this: a Hono API on Bun with better-auth, Drizzle on Postgres with
drizzle-kit migrations, a React SPA on another origin of the same site calling the API with cookies, background jobs
in a worker process, and shadcn on Base UI. The steps are in the order you take them. The working version of every
snippet is in [`examples/hono`](../../examples/hono/README.md) (the API and the worker) and
[`examples/vite-react`](../../examples/vite-react/README.md) (the web app), which run against RustFS and Postgres in
Docker with no credentials.

The page uses the layout of a monorepo with an API app, a web app, a worker app and shared packages (`@app/db` for the
schema and the pool, `@app/api` for oRPC). Adapt the names to yours.

## 1. One package owns cloudrop

Give the server side a package of its own, say `@app/uploads`, that depends on `cloudrop` and exports a factory and its
type:

```ts
// packages/uploads/src/index.ts
export function createUploads(deps: UploadsDeps) { /* step 5 */ }
export type Uploads = ReturnType<typeof createUploads>;
```

Three places import cloudrop, each a different entry:

| Who | Imports | Why |
| --- | --- | --- |
| `@app/uploads` | `cloudrop`, `cloudrop/adapters/drizzle` | the server, its routes and the store |
| `@app/db` | `cloudrop/adapters/drizzle` | `cloudropPgTables()` in the schema (step 2) |
| the web app | `cloudrop/react`, `cloudrop/client` | the hooks and their client; the server only as `import type` |

If your repository checks which package may import which SDK, register those three. The web app must reach
`@app/uploads` only through `import type`: a value import pulls the server, the database driver and the secret's
settings into the browser bundle.

`drizzle-orm` is an optional peer dependency of cloudrop (`>=0.45.0 <1 || >=1.0.0-rc.5 <2`): it uses your app's copy,
so the store and your queries share one Drizzle.

## 2. Declare the tables in your schema

cloudrop keeps two tables, `cloudrop_files` and `cloudrop_usage`. Declare them in a schema file of their own, beside
your other features:

```ts
// packages/db/src/schema/cloudrop.ts
import { cloudropPgTables } from "cloudrop/adapters/drizzle";

export const { files: cloudropFiles, usage: cloudropUsage } = cloudropPgTables();
```

Export it from the schema index (`export * from "./cloudrop"`), as you do for every feature. The time columns are
`timestamptz(3)`, millisecond precision, the same as `timestamp(name, { withTimezone: true, precision: 3 })`.

The tables are your app's: read them with your own Drizzle queries, which is how you list a user's files (step 6).
cloudrop's file API has no listing call because you already have the better one, a query you can join and page as
you like. Write to them only through cloudrop, which keeps each owner's usage in step with their files.

## 3. Generate and apply the migration

```sh
bun run db:generate   # drizzle-kit generate: a migration with both tables, their indexes and CHECKs
bun run db:migrate    # drizzle-kit migrate, as an explicit step
```

Until the tables exist, every upload fails with a retryable `SERVER_ERROR` and the server logs which table is missing.
The store needs no session state, so it works through PgBouncer in transaction mode: its one setting, a 2 s
`lock_timeout` while it claims a file, is set with `set_config(..., true)`, local to the transaction.

## 4. Mount the handler beside better-auth, outside your CORS middleware

```ts
// apps/server/src/app.ts
const UPLOADS_PATH = "/api/cloudrop";

// X-CSRF-Token is oRPC's CSRF header (step 6).
const browserCors = cors({ origin: webOrigins, credentials: true, allowHeaders: ["Content-Type", "X-CSRF-Token"] });
app.use((c, next) => (c.req.path.startsWith(`${UPLOADS_PATH}/`) ? next() : browserCors(c, next)));

app.on(["GET", "POST"], "/api/auth/*", (c) => deps.handleAuth(c.req.raw));
app.on(["POST", "OPTIONS"], `${UPLOADS_PATH}/*`, (c) => deps.uploads.handler(c.req.raw));
```

- The handler serves `POST` (`/upload`, `/sign`, `/complete`, `/abort`) and `OPTIONS`, their preflight. Any other
  method gets Hono's 404; with `app.all` it gets cloudrop's `METHOD_NOT_ALLOWED`.
- **Skip cloudrop's path in a global `hono/cors`.** This is the trap. `hono/cors` answers every `OPTIONS` itself and
  never calls the route, so cloudrop's own preflight, which checks the origin against its `trustedOrigins` and allows
  the headers the page asks for, never runs. Uploads with cookies still pass while the app's list happens to allow
  `Content-Type`; a client that sends an `Authorization` header ([bearer token](client.md#send-a-bearer-token)), or an
  app list without `POST`, fails in the browser's preflight with a CORS error that names no cloudrop code. cloudrop sets
  the CORS headers on its other answers too, so it needs nothing from the middleware. The browser lane proves the
  preflight reaches cloudrop through the real app.
- `basePath` stays `/api/cloudrop`, the default, so the server needs no option for it.

## 5. Authorize with the session

`authorize` reads the session the same way the API does, from the request's headers, and returns the user's id. With a
store, `owner` says whose quota a file counts against:

```ts
// packages/uploads/src/index.ts
export function createUploads(deps: UploadsDeps) {
  const store = drizzleStore(deps.db, { dialect: "postgres", transaction: true });
  const signedIn = async ({ request }: { request: Request }) => {
    const session = await deps.readSession(request.headers); // auth.api.getSession({ headers })
    return session ? { userId: session.user.id } : unauthorized("Sign in to upload files.");
  };
  const uploads = createCloudrop({
    storage: deps.storage,
    store,
    quota: () => deps.quotaBytes,
    trustedOrigins: deps.webOrigins, // the web app's exact origins, as in better-auth's trustedOrigins
    routes: { avatar, attachments }, // step 6
  });
  return uploads;
}
```

The composition root builds it once: `createUploads({ db, storage: r2(), readSession: (headers) =>
auth.api.getSession({ headers }), webOrigins, quotaBytes })`. `trustedOrigins` is required because the web app is on
another origin: without it every call gets `ORIGIN_NOT_ALLOWED`. The cookie needs nothing special: the web app and the
API are the same site, so a host-only `SameSite=Lax` cookie on the API's host travels with `credentials: "include"`
([Deployment](deployment.md#cross-origin-an-api-on-another-origin)).

## 6. Define the routes

```ts
avatar: store.route(
  { accept: "image/*", maxSize: "2MB", maxFiles: 1, authorize: signedIn },
  {
    prefix: ({ userId }) => `users/${userId}/avatar`,
    owner: ({ userId }) => userId,
    onComplete: async ({ tx, userId, file }) => {
      // FOR UPDATE: two replacements of one avatar take turns, so each deletes what it replaced.
      const [previous] = await tx
        .select({ fileId: avatar.fileId })
        .from(avatar)
        .where(eq(avatar.userId, userId))
        .for("update");
      const row = { key: file.key, fileId: file.id, updatedAt: new Date() };
      await tx.insert(avatar).values({ userId, ...row }).onConflictDoUpdate({ target: avatar.userId, set: row });
      return { replaced: previous?.fileId ?? null };
    },
    afterComplete: async ({ data }) => {
      if (data.replaced) await uploads.api.deleteFile(data.replaced);
    },
  },
),
attachments: store.route(
  { accept: "*/*", maxSize: "100MB", maxFiles: 10, authorize: signedIn },
  { prefix: ({ userId }) => `users/${userId}/attachments`, owner: ({ userId }) => userId },
),
```

- `store.route` gives `onComplete` Drizzle's transaction as `tx`: the avatar row commits with cloudrop's record of the
  upload, or neither does. Keep network calls out of it; the old avatar's object is deleted in `afterComplete`, after
  the commit.
- Files above 64 MiB go in parts (`multipartThreshold` changes it; the example uses 8 MB so a demo file shows parts).
- To list a user's files, select from `cloudropFiles` with your app's Drizzle, where `owner` is the user and `status`
  is `completed`: the intended way, since the tables are yours. To delete one, check its owner with
  `uploads.api.file(id)`, then call `uploads.api.deleteFile(id)`, which removes the object and frees its bytes in the
  quota. The example's oRPC router `files` (`list`, `delete`, `avatar`) does both.
- Protect the RPC router against cross-site requests. oRPC accepts a `multipart/form-data` body, which a page on
  another origin of the same site can post without a preflight, and the browser sends the `SameSite=Lax` session
  cookie with it. Add oRPC's pair: `SimpleCsrfProtectionHandlerPlugin` from `@orpc/server/plugins` on the
  `RPCHandler`, `SimpleCsrfProtectionLinkPlugin` from `@orpc/client/plugins` on the `RPCLink`, and allow its
  `X-CSRF-Token` header in your CORS middleware. cloudrop's own endpoints need nothing: they require
  `application/json` and check `Origin`.

## 7. The web client

```ts
// apps/web/src/lib/upload.ts
import { createCloudropClient } from "cloudrop/client";
import { createUploadHooks } from "cloudrop/react";
import { createContext, useContext } from "react";
import type { Uploads as Server } from "@app/uploads"; // types only

function createUploads(userId: string) {
  const client = createCloudropClient<Server>({ basePath: `${API_ORIGIN}/api/cloudrop`, namespace: userId });
  return { client, ...createUploadHooks<Server>({ client }) };
}
export type Uploads = ReturnType<typeof createUploads>;

const byUser = new Map<string, Uploads>();
export function uploadsFor(userId: string): Uploads {
  const known = byUser.get(userId) ?? createUploads(userId);
  byUser.set(userId, known);
  return known;
}
export const UploadsContext = createContext(uploadsFor(""));
export const useUploads = () => useContext(UploadsContext);

// apps/web/src/app.tsx: keyed by the user, so a new user's components mount with that user's hooks.
const userId = authClient.useSession().data?.user.id ?? "";
useCloseOtherUsers(userId); // from Signed-in users in the React guide
// React 19 renders a context as its provider; on React 18 write <UploadsContext.Provider>.
<UploadsContext key={userId} value={uploadsFor(userId)}>
  {/* the app */}
</UploadsContext>;

// In a component:
const { useUpload } = useUploads();
const { files, getInputProps } = useUpload("attachments", { multiple: true });
```

- `basePath` is absolute: the handler is on the API's origin, not the page's.
- The client sends cookies with every call to it; the oRPC link and the better-auth client need
  `credentials: "include"` of their own.
- **One client per user, with the user's id as `namespace`** ([Resume](resume.md#namespace-and-sign-out)). A client
  lists and resumes only its namespace's records, so the next user of the browser never sees the last one's
  unfinished uploads, even when that user closed the tab or let the session expire without signing out, and the first
  user still finds them on their next sign-in. The namespace is fixed when the client is created, which is why the app
  keys the context by the user: one module-level client, without a namespace, would show every user's records to
  whoever signs in next. The cost is a context and a component remount when the user changes.
- At sign-out, call `useUploads().close({ abort: true })`, which cancels the user's uploads on every route and tells
  the server, so their rows end `aborted`, then `useUploads().client.forget()`: the namespace hides the records,
  `forget()` deletes them and the upload tokens they hold, and aborts none. Closing first keeps a file that would get
  its ticket afterwards from asking for it. `useCloseOtherUsers` in [Signed-in users](react.md#signed-in-users) closes
  the last user's client when the user changes without a sign-out on this page, keeping its unfinished uploads for
  that user's next sign-in; the example's `src/lib/upload.ts` has it, and `src/components/auth-panel.tsx` the
  sign-out.
- To drop one unfinished upload, call `useResumable().discard(upload)`: the server aborts it, which with the store
  ends its row and frees the bytes it reserved, and the browser deletes its record
  ([Discard one upload](resume.md#discard-one-upload)). The example's panel has Discard per row and Discard all, each
  through `discard`.
- The hooks: [React](react.md). The example's drop zone (`getDropProps`, `getInputProps`, `isDragOver`), upload list,
  unfinished-uploads panel and avatar picker are in `examples/vite-react/src/components`.

## 8. The sweep, as a scheduled job

Abandoned uploads keep their reservation in the quota and may leave parts in the bucket until a sweep ends them
([The sweep](store.md#the-sweep)). Run it from the worker as a scheduled job, not in the API:

```ts
// The worker process, with BullMQ: a job scheduler adds the sweep job every hour. Any queue with cron schedules
// works the same way.
import { Queue, Worker } from "bullmq";

const connection = { host: "127.0.0.1", port: 6379 };
await new Queue("upload-sweep", { connection }).upsertJobScheduler(
  "hourly",
  { pattern: "41 * * * *", tz: "UTC" },
  // BullMQ tries a job once unless told otherwise: here a failed sweep is retried after one minute, then after two.
  { name: "sweep", opts: { attempts: 3, backoff: { type: "exponential", delay: 60_000 } } },
);
new Worker("upload-sweep", () => sweepAll(uploads.api), { connection });

async function sweepAll(api: Uploads["api"]) {
  let cursor: string | undefined;
  do {
    const { data, error } = await api.sweep({ cursor });
    if (error) throw error; // the queue retries the job
    for (const stuck of data.reported) log.warn({ action: "upload_completion_stuck", id: stuck.id });
    cursor = data.cursor ?? undefined;
  } while (cursor);
}
```

The worker builds its own `createUploads` with the same storage and database; it serves no requests, so its
`readSession` can answer `null`. Two sweeps at once are safe. `examples/hono/src/worker.ts` runs the same loop on a
timer.

## 9. The bucket's CORS rule names the web origin

The browser sends the bytes from the page, so the bucket's CORS rule lists the web app's origins, never the API's, with
`PUT`, the four headers cloudrop signs (`content-type`, `content-disposition`, `if-none-match`,
`x-amz-meta-cloudrop-id`) and `ETag` and `Retry-After` exposed. Add a lifecycle rule that aborts incomplete multipart
uploads. Both, for R2 and S3: [Bucket setup](bucket-setup.md).

## 10. Map uploads onto your Attachment component

shadcn's `Attachment` (in its registry) has five states. A file from `useUpload` maps onto them by
its `status`:

| cloudrop `status` | `Attachment` state | Second line |
| --- | --- | --- |
| `queued`, `paused` | `idle` | "Waiting", "Paused" |
| `uploading` | `uploading` | percent of the size, with a progress bar |
| `completing` | `processing` | the server verifies the object and runs `onComplete` |
| `done` | `done` | the size |
| `failed` | `error` | `file.error.code` and `file.error.message`, with Retry |
| `aborted` | `idle` | "Cancelled" |

`examples/vite-react/src/components/upload-row.tsx` is that mapping, with Cancel while the file runs and Retry once it
failed.
