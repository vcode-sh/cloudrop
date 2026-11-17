# Database store

cloudrop's server is stateless by default: the signed upload token carries everything, and nothing is written
anywhere. Pass a database store and cloudrop keeps one row per upload in two tables of your database.

## Quick start

1. **Create the two tables.** [Create the tables](#create-the-tables) has the SQL for Postgres and SQLite, the Drizzle
   tables and the Prisma models. Until they exist, every upload fails with a retryable `SERVER_ERROR`, and the log
   names the missing table (`INVALID_CONFIG`).
2. **Build the store** with the adapter for the driver your app already uses ([Set it up](#set-it-up)). Here,
   node-postgres with a transaction, so `onComplete` can write through `tx`:

   ```ts
   import { pgExecutor, sqlStore } from "cloudrop/adapters/sql";
   import pg from "pg";

   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
   const store = sqlStore(pgExecutor(pool), { transaction: true });
   ```

3. **Pass it to `createCloudrop`**, and give each route an `owner`:

   ```ts
   // lib/cloudrop.ts
   import { createCloudrop, r2, unauthorized } from "cloudrop";

   export const cloudrop = createCloudrop({
     storage: r2({ bucket: "media" }),
     store,
     quota: () => 1024 * 1024 * 1024, // 1 GiB per owner
     routes: {
       avatar: store.route(
         {
           accept: "image/*",
           maxSize: "5MB",
           authorize: async ({ request }) => {
             const user = await getUser(request); // your app's session lookup
             return user ? { userId: user.id } : unauthorized();
           },
         },
         {
           owner: ({ userId }) => userId,
           onComplete: async ({ tx, userId, file }) => {
             await tx.query("UPDATE users SET avatar_key = $1 WHERE id = $2", [file.key, userId]);
             return { key: file.key };
           },
           afterComplete: async ({ userId, file }) => {
             await notifyFollowers(userId, file.key); // network calls belong here
           },
         },
       ),
     },
   });
   ```

The client needs no change: it speaks the same protocol, and gets two more answers (`QUOTA_EXCEEDED`, and a busy
`SERVER_ERROR` while another request completes the same file) that it already handles.

This page covers what the store guarantees, how to set it up with each adapter, how to create the tables, the
callbacks and file operations it adds, the sweep that cleans up after abandoned uploads, and what it costs. The
[Next.js example](../../examples/next/README.md#run-with-a-database-store) runs it on SQLite.

## Why a store

Without one, cloudrop already uploads safely: the token is the authority, and `onComplete` runs at least once per file
with a stable `file.id`. What it cannot do without a record of its own:

- **Run `onComplete` once.** A client that lost the answer to `/complete` asks again, and without a row the server
  cannot tell that the file is done. Your `onComplete` must then be idempotent.
- **Enforce a quota that cannot be overshot.** Checking a total at `/upload` lets several uploads started at once all
  pass; a store reserves the bytes at `/upload` and counts them when the upload completes.
- **Stop an upload.** A signed token stays valid for 24 hours, even after the user signs out. A row can be ended.
- **Keep `/abort` from deleting a finished file.** Without a store, whoever holds the token can delete the file through
  `/abort` until the token expires, even after `onComplete` ran.
- **Clean up after abandoned uploads.** A row says which objects belong to an upload that never finished.

## What it guarantees

- **A row before anything is signed.** `/upload` writes one row per accepted file before it signs a URL or creates a
  multipart upload. When the rows cannot be written, every file of that `/upload` is refused with a retryable error.
- **`onComplete` once, exactly once for database work on Postgres with a transaction.** With a store built with
  `transaction: true` (Postgres only, on any of the three adapters), the claim on the file, your `onComplete`'s writes
  through `tx` and the completion's record commit together, or not at all. A crash, a throw or a timeout rolls
  everything back, and the next `/complete` runs `onComplete` again from a clean state. Writes through anything other
  than `tx` (your global database client, an API call) are outside that guarantee.
- **Otherwise, once per file under a lease.** On SQLite and D1, and with any store built without `transaction: true`,
  a `/complete` claims the file for `completionLeaseMs` while `onComplete` runs. Another `/complete` of the same file
  is answered busy, and the client retries. `onComplete` runs again in three cases only:
  - the server stops, or the completion's record fails, between the claim and that record, and the lease then ends;
  - `onComplete` runs longer than the lease, which is never extended: the next `/complete` takes the file over and
    runs `onComplete` beside the first run, whose record is then refused;
  - `onComplete` throws: the claim is handed back at once, so the retry runs it without waiting.

  `completionLeaseMs` is a `createCloudrop` option, 300000 (5 minutes) by default: set it above your slowest
  `onComplete`. Keep `onComplete` idempotent in this mode: write with `INSERT … ON CONFLICT`, as the example's
  `recordUpload` does.
- **Retries are answered from the row.** A `/complete` of a completed file answers the stored result with no storage
  call and no hook, also after the token expired. So does a file deleted with `api.deleteFile`: its answer still names
  the deleted object, so a resumed client does not upload it again.
- **A hard quota.** Concurrent uploads of one owner cannot pass their limit.
- **`/abort` never deletes a completed file**, and an ended row refuses `/sign` and `/complete`.
- **The sweep deletes only what it may.** It removes an object only when the object's `cloudrop-id` names a row that
  never completed, and never touches completed files or keys without a row.

## Set it up

Every adapter builds the same store over one SQL core; pick the one that matches how your app reaches its database.
Each method of the store is one atomic unit (one statement on Postgres, one batch on SQLite), and the store checks
its tables on its first call: a missing table or column is logged as `INVALID_CONFIG` naming it, and clients get a
retryable `SERVER_ERROR` until the tables are fixed.

| Adapter | Databases | Completions | Limits |
| --- | --- | --- | --- |
| `sqlStore` (`cloudrop/adapters/sql`) | Postgres through node-postgres or postgres.js; SQLite through `node:sqlite`; Cloudflare D1 | Transaction with `{ transaction: true }` on Postgres, otherwise lease | A node-postgres `Pool`, never a single `Client` |
| `drizzleStore` (`cloudrop/adapters/drizzle`) | Postgres through node-postgres or postgres.js; SQLite through better-sqlite3, libsql (Turso) or D1 | Transaction with `transaction: true` on Postgres, otherwise lease | A single node-postgres `Client` is refused |
| `prismaStore` (`cloudrop/adapters/prisma`) | Prisma 7 with a driver adapter, on Postgres or SQLite | Transaction with `transaction: true` on Postgres, otherwise lease | Prisma's 5-second transaction timeout includes `onComplete`; SQLite for one process |

`store.route`, and with it `tx` in `onComplete`, exists only on a store built with `transaction: true`. SQLite and D1
have no transaction mode: an interactive transaction would hold their only writer while `onComplete` awaits.

### Plain SQL drivers: `cloudrop/adapters/sql`

```ts
import { d1Executor, pgExecutor, postgresJsExecutor, sqliteExecutor, sqlStore } from "cloudrop/adapters/sql";
```

| Driver | Store | With `{ transaction: true }` |
| --- | --- | --- |
| node-postgres | `sqlStore(pgExecutor(new pg.Pool({ connectionString })))` | `tx` is the transaction's client (`tx.query`) |
| postgres.js | `sqlStore(postgresJsExecutor(postgres(connectionString)))` | `tx` is postgres.js's transaction (`` tx`…` ``) |
| `node:sqlite` | `sqlStore(sqliteExecutor(new DatabaseSync(path, { timeout: 5000 })))` | Refused: lease only |
| Cloudflare D1 | `sqlStore(d1Executor(env.DB))` | Refused: lease only (D1 has no interactive transaction) |

Pass a node-postgres `Pool`, never a single `Client`: the store runs a transaction on a connection of its own while
other requests run their statements. Any other driver fits too: an executor is an object with `dialect`, `query` and an
atomic, ordered `batch` (`SqlExecutor`), plus `transaction` for `{ transaction: true }`.

On Cloudflare Workers, the D1 binding is reachable at module scope through `cloudflare:workers`:

```ts
// src/cloudrop.ts, in a Worker
import { env } from "cloudflare:workers";
import { createCloudrop, r2, route, unauthorized } from "cloudrop";
import { d1Executor, sqlStore } from "cloudrop/adapters/sql";

export const cloudrop = createCloudrop({
  storage: r2({ bucket: "media" }),
  store: sqlStore(d1Executor(env.DB)),
  routes: {
    files: route(
      {
        accept: "image/*",
        maxSize: "10MB",
        authorize: async ({ request }) => {
          const user = await getUser(request);
          return user ? { userId: user.id } : unauthorized();
        },
      },
      { owner: ({ userId }) => userId },
    ),
  },
});
```

### Drizzle: `cloudrop/adapters/drizzle`

`drizzle-orm` is an optional peer dependency, `>=0.45.0 <1 || >=1.0.0-rc.5 <2`: 0.45 and later 0.x releases, and
1.0 from its fifth release candidate. Pass your app's Drizzle database:

```ts
import { drizzleStore } from "cloudrop/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }));
export const store = drizzleStore(db, { dialect: "postgres", transaction: true });
```

- **Postgres:** `drizzle-orm/node-postgres` over a `Pool` (a single `Client` is refused), or `drizzle-orm/postgres-js`.
  With `transaction: true`, `store.route` gives `onComplete` Drizzle's transaction as `tx`:
  `await tx.update(users).set({ avatarKey: file.key }).where(eq(users.id, userId))`.
- **SQLite:** `drizzle-orm/better-sqlite3`, `drizzle-orm/libsql` (Turso) or `drizzle-orm/d1`, with
  `{ dialect: "sqlite" }`. No transaction mode: an interactive transaction would hold SQLite's only writer while
  `onComplete` awaits.

### Prisma: `cloudrop/adapters/prisma`

For Prisma 7 with a driver adapter. cloudrop imports nothing from Prisma:

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { prismaStore } from "cloudrop/adapters/prisma";
import { PrismaClient } from "./generated/prisma/client";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
export const store = prismaStore(prisma, { dialect: "postgres", transaction: true });
```

With `transaction: true` (Postgres only), `store.route` gives `onComplete` Prisma's interactive-transaction client as
`tx`: `await tx.avatar.create({ data: { userId, key: file.key } })`. Prisma rolls back an interactive transaction after
5 seconds by default, and that time includes your `onComplete`; a completion that runs out answers a retryable error
and keeps nothing. Raise it when you need more: `prismaStore(prisma, { dialect: "postgres", transaction: true,
transactionOptions: { timeout: 15_000 } })`. On SQLite, use `{ dialect: "sqlite" }` without a transaction.

Add the two models to your Prisma schema: copy them from the shipped files, which the test suite generates, migrates
and round-trips, so they match the store:

- Postgres: [`cloudrop.prisma`](../../packages/cloudrop/src/testing/db/prisma/postgres/cloudrop.prisma)
- SQLite: [`cloudrop.prisma`](../../packages/cloudrop/src/testing/db/prisma/sqlite/cloudrop.prisma)

The model and field names are yours to change. The column names (`@map`) are fixed; so are the table names
(`@@map`), unless you pass the same names to `prismaStore` as `tables`.

## Create the tables

Use the tool you query with:

- **Prisma:** `prisma migrate dev --create-only` from the two models above, add the CHECK line (below) to the
  generated `migration.sql`, then apply it with `prisma migrate dev`.
- **Drizzle:** export the tables from your schema file and let drizzle-kit create them:

  ```ts
  // db/schema.ts
  import { cloudropPgTables } from "cloudrop/adapters/drizzle";

  export const { files: cloudropFiles, usage: cloudropUsage } = cloudropPgTables();
  ```

  On SQLite, `cloudropSqliteTables()`. Both take `{ tables }`, the same names you pass to `drizzleStore`. Read them
  freely (`db.select().from(cloudropFiles)`); write to them only through the store, which keeps the usage counters in
  step with the files.
- **Everyone else:** run the SQL below in a migration. On D1: `wrangler d1 migrations create DB cloudrop`, paste the
  SQLite statements into the new file, then `wrangler d1 migrations apply DB` (it applies to the local database; add
  `--remote` for the deployed one).

<!-- ddl:postgres -->
```sql
CREATE TABLE "cloudrop_files" (
  id text NOT NULL PRIMARY KEY,
  route text NOT NULL,
  key text NOT NULL,
  owner text,
  status text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  size bigint NOT NULL,
  upload_id text,
  metadata text,
  result text,
  claim text,
  claimed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  ended_at timestamptz,
  cleaned_at timestamptz
);

CREATE INDEX "cloudrop_files_status_expires_at_idx" ON "cloudrop_files" (status, expires_at);

CREATE INDEX "cloudrop_files_status_claimed_at_idx" ON "cloudrop_files" (status, claimed_at);

CREATE INDEX "cloudrop_files_status_cleaned_at_ended_at_idx" ON "cloudrop_files" (status, cleaned_at, ended_at);

CREATE INDEX "cloudrop_files_owner_status_idx" ON "cloudrop_files" (owner, status);

CREATE INDEX "cloudrop_files_key_idx" ON "cloudrop_files" (key);

CREATE TABLE "cloudrop_usage" (
  owner text NOT NULL PRIMARY KEY,
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
  active_bytes bigint NOT NULL CHECK (active_bytes >= 0),
  files integer NOT NULL CHECK (files >= 0),
  updated_at timestamptz NOT NULL
);
```

SQLite and D1 store times as integer milliseconds:

<!-- ddl:sqlite -->
```sql
CREATE TABLE "cloudrop_files" (
  id TEXT NOT NULL PRIMARY KEY,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  owner TEXT,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  upload_id TEXT,
  metadata TEXT,
  result TEXT,
  claim TEXT,
  claimed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  ended_at INTEGER,
  cleaned_at INTEGER
);

CREATE INDEX "cloudrop_files_status_expires_at_idx" ON "cloudrop_files" (status, expires_at);

CREATE INDEX "cloudrop_files_status_claimed_at_idx" ON "cloudrop_files" (status, claimed_at);

CREATE INDEX "cloudrop_files_status_cleaned_at_ended_at_idx" ON "cloudrop_files" (status, cleaned_at, ended_at);

CREATE INDEX "cloudrop_files_owner_status_idx" ON "cloudrop_files" (owner, status);

CREATE INDEX "cloudrop_files_key_idx" ON "cloudrop_files" (key);

CREATE TABLE "cloudrop_usage" (
  owner TEXT NOT NULL PRIMARY KEY,
  reserved_bytes INTEGER NOT NULL,
  active_bytes INTEGER NOT NULL,
  files INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Other table names: pass `tables: { files: "uploads", usage: "upload_usage" }` to the adapter (letters, digits and `_`)
and rename them in the SQL, including the index and constraint names if you like.

**Prisma and the CHECK constraints.** Prisma's schema language has no CHECK, so `prisma migrate` creates the usage
table without the three `CHECK (… >= 0)` on Postgres. Run `prisma migrate dev --create-only`, add this line to the
generated `migration.sql`, then apply it:

```sql
ALTER TABLE cloudrop_usage ADD CONSTRAINT cloudrop_usage_reserved_bytes_check CHECK (reserved_bytes >= 0), ADD CONSTRAINT cloudrop_usage_active_bytes_check CHECK (active_bytes >= 0), ADD CONSTRAINT cloudrop_usage_files_check CHECK (files >= 0);
```

The names are the ones the plain SQL gets by default, so both routes end with the same schema. The store works without
them; they only guard the counters against a bug or a hand edit.

**Moving a SQLite database from the SQL to Prisma.** Prisma declares its `BigInt` columns `BIGINT` where the SQL says
`INTEGER`. Both have INTEGER affinity, so storage and behaviour are the same, but Prisma's first `migrate dev` rebuilds
both tables (the data is kept). To skip the rebuild, write the baseline yourself:

```sh
mkdir -p prisma/migrations/0_cloudrop
prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/migrations/0_cloudrop/migration.sql
prisma migrate resolve --applied 0_cloudrop
```

On Postgres Prisma finds nothing to change in tables made from the SQL.

## Owners and quota

```ts
createCloudrop({
  storage,
  store,
  // Bytes each owner may keep, or null for no limit. Asked once per /upload.
  quota: async (owner) => (await planOf(owner)).storageBytes,
  routes: {
    files: route(
      { accept: "*/*", maxSize: "100MB", authorize },
      { owner: ({ userId }) => userId },
    ),
  },
});
```

- `owner` names who a file counts against: a user, team or workspace id of 1 to 255 characters, or null for no one. It
  runs once per `/upload`, before plugins' `beforeUpload`, and sees the authorize result, the request and the
  metadata, not the files. It is not the authorize result signed into the token.
- The store counts each owner's usage whether or not you set `quota`, so turning a quota on later needs no backfill.
- The rule is `reserved + stored + size <= limit` (stored is `activeBytes` in `api.usage`), checked file by file in
  the order sent: a file that does not fit is refused with `QUOTA_EXCEEDED` (HTTP 403, not retryable), and the files
  of the same `/upload` that fit go on. Bytes are reserved at `/upload`, move to stored when the upload completes, and
  are released when it is cancelled, refused, revoked, expires or the file is deleted.
- A `quota` that throws, or answers something other than a non-negative whole number or null, refuses the upload with a
  retryable `SERVER_ERROR`: it fails closed.
- With `quota` set, a route without `owner` logs a warning at startup: its uploads count against no one.

## `onComplete` with `tx`

On a store built with `transaction: true`, build routes with `store.route` instead of `route` to get the transaction
in `onComplete`:

```ts
const avatar = store.route(policy, {
  owner: ({ userId }) => userId,
  onComplete: async ({ tx, userId, file }) => {
    // Commits with the upload's completion, or not at all.
    await tx.query("INSERT INTO avatars (user_id, key) VALUES ($1, $2)", [userId, file.key]);
    return { key: file.key };
  },
});
```

- `tx` is the adapter's own transaction handle, typed: node-postgres's client, postgres.js's transaction, Drizzle's or
  Prisma's transaction client. A route from `store.route` works only with that store; `createCloudrop` refuses it with
  any other store or none. Routes from plain `route()` run inside the transaction too, without `tx`.
- **Keep network calls out.** No storage calls, emails or HTTP requests inside `onComplete` in transaction mode:
  they hold a database connection and a row lock while they wait, and a rollback cannot undo them. They belong in
  `afterComplete`.
- **Never swallow an error from `tx`.** On Postgres a failed statement aborts the whole transaction. If `onComplete`
  catches the error and returns normally, Postgres refuses every later statement of the transaction, including
  cloudrop's record of the completion, so the completion rolls back and the client gets a retryable `SERVER_ERROR`.
  Every retry fails the same way, until the upload expires and the sweep deletes its file. Let the error propagate, or
  catch it inside a savepoint (Drizzle's nested `tx.transaction`, `SAVEPOINT` with node-postgres).
- The store waits at most 2 seconds for the file's row lock, so a second `/complete` of the same file is answered busy
  rather than waiting. Your own statements through `tx` keep your session's lock timeout.
- Postgres must run at its default isolation level, READ COMMITTED. Under REPEATABLE READ or SERIALIZABLE, concurrent
  uploads fail with serialization errors instead of waiting their turn.
- `onComplete`'s result must be JSON of at most 16 KiB with a store: it is stored and replayed to every retry. A larger
  one fails the completion like a throw.

## `afterComplete`

```ts
store.route(policy, {
  onComplete: async ({ tx, file }) => {
    await tx.query("INSERT INTO outbox (kind, payload) VALUES ('avatar-changed', $1)", [file.key]);
    return { key: file.key };
  },
  // Written after onComplete, so its `data` is typed from onComplete's result.
  afterComplete: async ({ data, userId }) => {
    await sendEmail(userId, `Your new avatar: ${data.key}`);
  },
});
```

`afterComplete` runs after the completion is recorded, at most once per file and best effort: a crash right after the
record skips it, and a throw is logged while the client still gets its answer. The answer waits for it, so keep it
short. For work that must happen, write an outbox row through `tx` in `onComplete` and process the outbox elsewhere.
`afterComplete` needs a store, like `owner`.

## What changes for the client

- **`/upload`** refuses a file over the quota with `QUOTA_EXCEEDED`, and answers a retryable `SERVER_ERROR` when the
  store cannot be reached ("The server could not reach its upload records. Try again in a moment.").
- **`/sign` and `/complete`** refuse an upload whose row was ended (cancelled, revoked, refused, failed or expired)
  with `UPLOAD_EXPIRED`: "This upload was cancelled or has expired. Start it again." The file fails with that code and
  the client sends its `/abort`. `retry()` asks for a new ticket through `/upload` and `authorize`, so a signed-out
  user is refused. A `resume()` after a reload asks for a new ticket by itself and starts the file again while the
  user is still signed in ([Resume](resume.md)).
- **A second `/complete` of a file being completed** is answered busy: `SERVER_ERROR`, retryable, "Another request is
  completing this upload. Try again in a moment.", with `Retry-After: 2`. The client waits and asks again, and gets
  the stored answer. Busy is not logged as an error.
- **`/abort`** of a completed file answers `ok` and deletes nothing. An unfinished upload is aborted and its object
  deleted as before.
- **A refused file whose delete fails** (the object did not match what was declared, and the storage service did not
  answer the delete) is still answered with the refusal, `VERIFICATION_FAILED`. Its row already says `rejected`, so a
  retry of the same token answers `UPLOAD_EXPIRED`, and the sweep's cleanup pass deletes the object.

These words map to the `status` of [`api.file(id)`](#file-operations): cancelled and revoked uploads are `aborted`,
refused ones `rejected`, uploads that could not start and stuck completions `failed`, and expired ones `expired`; a
file removed with `deleteFile` is `deleted`.

[Errors](errors.md#upload-endpoint-errors) lists every code.

## Revoke a user's uploads

```ts
// At sign-out, or when an account is suspended:
const { data, error } = await cloudrop.api.revokeUploads({ owner: userId });
// data.revoked: how many unfinished uploads were ended
```

Each unfinished upload of that owner that is not already being completed is ended and its reservation released; its
next `/sign` or `/complete` is refused with `UPLOAD_EXPIRED`, and its client's `/abort` removes what it had uploaded.
A completion already under way finishes, and completed files are not touched.

## File operations

With a store, `cloudrop.api` gains these, each returning `{ data, error }`. Without one they answer `INVALID_CONFIG`.

| Call | What it does |
| --- | --- |
| `file(id)` | The file's row (`FileRecord`: status, key, owner, size, result, times), or `null`. |
| `usage(owner)` | `{ reservedBytes, activeBytes, files }` for an owner, with or without a quota. |
| `revokeUploads({ owner })` | Ends the owner's unfinished uploads (above). |
| `deleteFile(id)` | Deletes a completed file: its row becomes `deleted`, its bytes and file count are released, and its object is removed when it is still this upload's. Idempotent; `NOT_FOUND` for a file that never completed. |
| `reconcile({ owner? })` | Recounts usage from the rows, for one owner or all of them, and answers `{ checked, repaired }`. Only needed after editing the tables by hand. |
| `sweep(options?)` | One bounded round of cleanup (below). |

`api.delete(key)` still deletes an object by key, but leaves the row and the owner's usage as they were: use
`deleteFile` for uploaded files.

## The sweep

Uploads that never finish leave rows, reservations and sometimes parts or objects behind. `api.sweep()` cleans them up
in bounded rounds; run it on a schedule:

```ts
// A Worker's cron trigger, or any scheduled job: once an hour is plenty.
export default {
  async scheduled() {
    let cursor: string | undefined;
    do {
      const { data, error } = await cloudrop.api.sweep({ cursor });
      if (error) throw error; // the next run starts over
      for (const stuck of data.reported) console.warn(`cloudrop: completion of ${stuck.id} never finished; check it`);
      cursor = data.cursor ?? undefined;
    } while (cursor);
  },
};
```

Each call handles up to `limit` rows (default 100, at most 1,000) and answers `{ expired, cleaned, failed, reported,
cursor }`; pass `cursor` back to continue. It runs two passes:

- **Expire:** an unfinished upload past its token's deadline plus `graceMs` is ended as `expired` first, its
  reservation released; then its multipart upload is aborted and its object deleted only when the object's
  `cloudrop-id` is this upload's. A completion stuck past its lease, and past its deadline plus `graceMs`, is ended as
  `failed` and **reported**, and its object is kept: its `onComplete` may have recorded it, so check each reported
  file.
- **Cleanup:** an ended upload (`aborted`, `rejected`, `failed`, `expired` or `deleted`) not yet cleaned up, and ended
  more than `graceMs` ago, has its late parts and object removed, again only when the object is its own. This catches
  a `PUT` that landed after an `/abort`, an upload that could not start, and an expired one whose first cleanup
  failed.

`graceMs` (default 1 hour) must be at least 15 minutes, the life of an upload URL, so no new `PUT` can start once a
row may be cleaned up. A failing row is logged, counted in `failed` and left for the next sweep; the rows after it are
still swept. Two sweeps at once are safe, and so is a sweep racing a `/complete`: the sweep takes the row before it
deletes anything.

The sweep never deletes a completed file, never touches an object whose `cloudrop-id` belongs to another upload or
that has no row, and runs no plugin `onAbort` (rows carry no authorize result). Keep the bucket's lifecycle rule that
aborts incomplete multipart uploads ([Bucket setup](bucket-setup.md)): it covers a server that crashes between creating
a multipart upload and recording it, which leaves no row to sweep. With a store, `api.checkBucket()` reports that rule
as required.

## Postgres notes

- **Isolation:** READ COMMITTED, the default. See [`onComplete` with `tx`](#oncomplete-with-tx).
- **Tables outside `public`:** the store's SQL finds its tables through the connection's `search_path`. Set it once for
  the database role, which also works behind connection poolers:

  ```sql
  ALTER ROLE app_user SET search_path = app, public;
  ```

  Alternatively set it per connection with `?options=-c%20search_path%3Dapp` in the connection string, which some
  poolers drop or refuse (PgBouncer without `ignore_startup_parameters`, some hosted pooled endpoints). With Prisma,
  PrismaPg's `schema` option (`new PrismaPg({ connectionString }, { schema: "app" })`) reaches only model queries, so
  set the search path as well. If `public` also has tables with the same names, the store uses whichever comes first
  in the search path.
- **Connection pools:** with `transaction: true`, a completion holds one connection and the file's row lock for the
  length of `onComplete`, plain `route()`s included. Size the pool for your concurrent completions plus your other
  traffic, or leave `transaction` off and completions use a lease, holding no connection.

## SQLite notes

- **One writer at a time.** Every store method is a short batch, and `/complete` holds its file with a lease rather
  than a transaction, so `onComplete` never blocks other uploads.
- **Several connections or processes on one file** need a busy timeout, or a second writer fails at once with
  "database is locked": `new DatabaseSync(path, { timeout: 5000 })`.
- **Prisma on SQLite is for one process**, such as a single server or local development. Its adapter starts batches
  with a deferred `BEGIN`, so two processes writing one file may see `SQLITE_BUSY` (not measured).
- **D1** batches are atomic and serialised by Cloudflare; nothing to configure.

## Known costs

- **A lost `/upload` answer holds its reservation.** When the client gives up on `/upload` (after 30 seconds) and asks
  again, the first call's rows still reserve their bytes until the sweep expires them (deadline plus `graceMs`) or
  `revokeUploads` releases them. A user near their quota may be refused meanwhile.
- **A `PUT` that lands after cleanup stays.** The sweep cleans a row once. A `PUT` already under way that lands after
  that is left in the bucket; with the default hour of grace this is unlikely.
- **A completion's record that fails after `onComplete` ran, in lease mode**, keeps the file busy until the lease ends
  (5 minutes by default), longer than the client retries. The client then reports a failure but keeps the file. Once
  the lease has passed, the next `/complete` of it (a `retry()` or a `resume()`) takes the file over and runs
  `onComplete` again: one more reason to keep it idempotent in this mode.
- **Clock skew.** The lease and the grace periods are minutes, far above normal skew between servers. Keep server
  clocks in sync (NTP), as SigV4 signing already requires.
- **Bundle size.** The store paths add about 4.8 kB (gzip) to `cloudrop`'s server code whether or not you use a store;
  the browser bundle does not change.

## Turning it on, or off, in a running app

Tokens signed with a store carry a `stored` mark. During a rolling deploy, a token from an instance without the store
takes the stateless path on an instance with one, until it expires (24 hours); a stored token whose row is missing is
refused as cancelled. Turning the store off makes stored tokens stateless again. So you can enable the store with a
normal deploy: uploads started before it finish as they began, and their files count toward no owner's usage.
