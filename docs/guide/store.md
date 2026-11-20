# Database store

This page is for developers who want a record of every upload in their own database. cloudrop's server is stateless by
default: the signed upload token carries everything, and nothing is written anywhere. Pass a database store and cloudrop
keeps one row per upload in two tables of your database.

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
           replace: true, // one avatar per user: the next one deletes this one
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

  On SQLite, `cloudropSqliteTables()`. Both take `{ tables }`, the same names you pass to `drizzleStore`.
  `api.files({ owner })` lists a user's files; for anything else, read the tables freely
  (`db.select().from(cloudropFiles)`): they are your app's. Write to them only through the store, which keeps the
  usage counters in step with the files.
- **Everyone else:** run the SQL below in a migration. On D1: `wrangler d1 migrations create DB cloudrop`, paste the
  SQLite statements into the new file, then `wrangler d1 migrations apply DB` (it applies to the local database; add
  `--remote` for the deployed one).

Postgres times are `timestamptz(3)`: the store writes milliseconds, the precision of a JavaScript `Date`, so a
microsecond column would only hold zeros. Tables created earlier with plain `timestamptz` keep working unchanged;
drizzle-kit and Prisma then propose altering the columns to `timestamptz(3)`, a change that is safe to apply or to leave
out.

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
  claimed_at timestamptz(3),
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  completed_at timestamptz(3),
  ended_at timestamptz(3),
  cleaned_at timestamptz(3),
  request_key text
);

CREATE INDEX "cloudrop_files_status_expires_at_idx" ON "cloudrop_files" (status, expires_at);

CREATE INDEX "cloudrop_files_status_claimed_at_idx" ON "cloudrop_files" (status, claimed_at);

CREATE INDEX "cloudrop_files_status_cleaned_at_ended_at_idx" ON "cloudrop_files" (status, cleaned_at, ended_at);

CREATE INDEX "cloudrop_files_owner_status_created_at_idx" ON "cloudrop_files" (owner, status, created_at);

CREATE INDEX "cloudrop_files_key_idx" ON "cloudrop_files" (key);

CREATE INDEX "cloudrop_files_route_request_key_idx" ON "cloudrop_files" (route, request_key);

CREATE TABLE "cloudrop_usage" (
  owner text NOT NULL PRIMARY KEY,
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
  active_bytes bigint NOT NULL CHECK (active_bytes >= 0),
  files integer NOT NULL CHECK (files >= 0),
  updated_at timestamptz(3) NOT NULL
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
  cleaned_at INTEGER,
  request_key TEXT
);

CREATE INDEX "cloudrop_files_status_expires_at_idx" ON "cloudrop_files" (status, expires_at);

CREATE INDEX "cloudrop_files_status_claimed_at_idx" ON "cloudrop_files" (status, claimed_at);

CREATE INDEX "cloudrop_files_status_cleaned_at_ended_at_idx" ON "cloudrop_files" (status, cleaned_at, ended_at);

CREATE INDEX "cloudrop_files_owner_status_created_at_idx" ON "cloudrop_files" (owner, status, created_at);

CREATE INDEX "cloudrop_files_key_idx" ON "cloudrop_files" (key);

CREATE INDEX "cloudrop_files_route_request_key_idx" ON "cloudrop_files" (route, request_key);

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

### Upgrading from 0.1

0.2.0 replaces the index on `(owner, status)` with one on `(owner, status, created_at)`, so
[`api.files`](#list-an-owners-files) reads one page of an owner's files without sorting all of them. The store works
without it, only slower for owners with many files. Drizzle and Prisma users regenerate their migration from the
updated tables (`drizzle-kit generate` asks whether the new index renames the old one: answer that it is created).
Everyone else runs, on Postgres or SQLite, in a migration:

```sql
CREATE INDEX "cloudrop_files_owner_status_created_at_idx" ON "cloudrop_files" (owner, status, created_at);
DROP INDEX "cloudrop_files_owner_status_idx";
```

On a large Postgres table, `CREATE INDEX CONCURRENTLY` (outside a transaction) avoids blocking uploads while it builds.
With [`tables.schema`](#tables-in-another-schema) or table names of your own, put those names in both statements.

### Tables in another schema

On Postgres, pass the schema with the names: `tables: { schema: "app" }` (letters, digits and `_`). Every statement
then names `"app"."cloudrop_files"` and `"app"."cloudrop_usage"`, the first-call table check included, whatever the
connection's search path is. SQLite has no schemas, so every adapter refuses the option there with `INVALID_CONFIG`.

- **Plain SQL:** `CREATE SCHEMA app;`, then the SQL above with each table name written `app.cloudrop_files` and
  `app.cloudrop_usage`. Pass `sqlStore(executor, { tables: { schema: "app" } })`.
- **Drizzle:** pass the same `tables` to the tables and the store, and export the schema from your schema file too, as
  Drizzle's [schemas page](https://orm.drizzle.team/docs/schemas) does, whose SQL starts with `CREATE SCHEMA`:

  ```ts
  // db/schema.ts
  import { cloudropPgTables } from "cloudrop/adapters/drizzle";
  import { pgSchema } from "drizzle-orm/pg-core";

  export const app = pgSchema("app");
  export const cloudropTables = { schema: app.schemaName };
  export const { files: cloudropFiles, usage: cloudropUsage } = cloudropPgTables({ tables: cloudropTables });
  ```

  and build the store with them: `drizzleStore(db, { dialect: "postgres", tables: cloudropTables })`. `drizzle-kit
  push` and `pull` manage all schemas by default; if your `drizzle.config.ts` sets `schemaFilter`, list `app` there
  ([config file](https://orm.drizzle.team/docs/drizzle-config-file)).

- **Prisma:** list the schema in the datasource and put both models in it, then pass
  `prismaStore(prisma, { dialect: "postgres", tables: { schema: "app" } })`. Prisma 7 needs no preview feature for
  this. Once the datasource lists `schemas`, every model needs its `@@schema`, your own included
  (`@@schema("public")`), and the CHECK line above names `app.cloudrop_usage`. PrismaPg's own `schema` option is not
  needed and does not reach the store.

  ```prisma
  datasource db {
    provider = "postgresql"
    schemas  = ["public", "app"]
  }

  model CloudropFile {
    // the fields as shipped
    @@map("cloudrop_files")
    @@schema("app")
  }

  model CloudropUsage {
    // the fields as shipped
    @@map("cloudrop_usage")
    @@schema("app")
  }
  ```

The alternative is to leave `schema` out and let the search path find the tables: set it once for the database role,
which also works behind connection poolers:

```sql
ALTER ROLE app_user SET search_path = app, public;
```

or per connection with `?options=-c%20search_path%3Dapp` in the connection string, which some poolers drop or refuse
(PgBouncer without `ignore_startup_parameters`, some hosted pooled endpoints). With Prisma, the search path reaches the
store's SQL, and PrismaPg's `schema` option (`new PrismaPg({ connectionString }, { schema: "app" })`) reaches model
queries; set both. If `public` also has tables with the same names, the store uses whichever comes first in the search
path.

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

## One file per owner: `replace`

```ts
avatar: store.route(
  { accept: "image/*", maxSize: "5MB", replace: true, authorize },
  {
    owner: ({ userId }) => userId,
    onComplete: async ({ tx, userId, file }) => {
      await tx.query("UPDATE users SET avatar_key = $1 WHERE id = $2", [file.key, userId]);
    },
  },
),
```

With `replace: true`, a route keeps one file per owner, such as an avatar or a profile banner. When a file completes,
the owner's previous completed files on that route are deleted in the same database write that records the
completion: their rows become `deleted` and their bytes leave the quota. Then, before `/complete` answers, their
objects are removed from the bucket; a removal that fails is logged and left to [the sweep](#the-sweep), which finds
the row deleted but not cleaned up.

- **The previous file goes only after the next one completes.** An upload that is cancelled, refused or never
  finished deletes nothing, and the previous file stays.
- **Two uploads completing at once leave exactly one file:** the one recorded last. On Postgres the two completions
  take turns on a transaction-scoped advisory lock for the owner and route; SQLite and D1 have one writer at a time.
- **What the hooks see.** `onComplete` runs before the completion is recorded, so the previous file is still
  completed there (`api.files` lists it). `afterComplete` runs after: the previous file's row is deleted and the removal
  of its object was tried. Neither gets a new field.
- **Read the kept file; do not keep a pointer of your own.** `api.files({ owner, route, limit: 1 })` answers the file
  that survived. A pointer such as `users.avatar_key` written in `onComplete` can name the file that was deleted: without
  `transaction: true`, `onComplete` runs before the completion is recorded and outside any lock, so two uploads at once
  can set the pointer in one order and record their completions in the other. A pointer is safe only on Postgres with
  `transaction: true`, written through `tx` by a statement that locks the owner's row (an `UPDATE users … WHERE id =`
  does), so the two completions take turns from that statement on.
- **It needs a store and `owner`**, and takes one file per `/upload`: `maxFiles` is 1, and `createCloudrop` refuses a
  replacing route without a store, without `owner`, or with another `maxFiles`, with `INVALID_CONFIG`. A file whose
  `owner` answered null replaces nothing.
- Only files of the same owner and route go. Files uploaded before you turned `replace` on are replaced too, by the
  owner's next completion on the route.
- **Under a quota, the owner needs room for both files** until the replacement completes: the new file's bytes are
  reserved at `/upload` while the previous file still counts. An owner at their limit is refused `QUOTA_EXCEEDED` for a
  new avatar; give replacing routes room in your `quota`, or keep their files out of it.

## What changes for the client

- **`/upload`** refuses a file over the quota with `QUOTA_EXCEEDED`, and answers a retryable `SERVER_ERROR` when the
  store cannot be reached ("The server could not reach its upload records. Try again in a moment.").
- **`/sign` and `/complete`** refuse an upload whose row was ended (cancelled, revoked, refused, failed or expired)
  with `UPLOAD_EXPIRED`: "This upload was cancelled or has expired. Start it again." The file fails with that code and
  the client sends its `/abort`. `retry()` asks for a new ticket through `/upload` and `authorize`, so a signed-out
  user is refused. A `resume()` after a reload asks for a new ticket by itself and starts the file again while the
  user is still signed in ([Resume](resume.md)).
- **A lost `/upload` answer** no longer holds its reservation. Each ask of `/upload` carries a random
  `idempotencyKey`, the same on every automatic retry of that ask. When the client gives up waiting (30 seconds, or a
  dropped connection) and asks again, the retry ends the earlier attempt's rows as `aborted`, releasing their bytes
  before the quota is checked, so a user near their limit is not refused for files they never got tickets for. The
  sweep's cleanup pass aborts any multipart upload those rows had started. Only `pending` rows with the same key,
  route and owner are ended; plugins hear no `onAbort` for them, as with the sweep and `revokeUploads`. Rows without
  an owner (a route without `owner`, or one that answered null) hold no quota, so there the key does nothing.
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

## List an owner's files

```ts
const { data, error } = await cloudrop.api.files({ owner: userId, route: "attachments", limit: 50 });
if (error) throw error;
// data.items: FileRecord[], newest upload first. data.cursor: pass it back for the next page; null on the last one.
if (data.cursor) {
  const next = await cloudrop.api.files({ owner: userId, route: "attachments", limit: 50, cursor: data.cursor });
}
```

Completed files only, newest upload first (by when `/upload` accepted them), one page of `limit` files (1 to 1,000,
default 100) at a time. `route` must be one of the server's routes; leave it out for all of them. The cursor is
opaque: pass back only what a page answered. Files deleted between two pages make the next page skip nothing.

## Erase an owner

For an account deletion or an erasure request: everything an owner uploaded goes, driven by the owner's rows, so it
needs no knowledge of your key layout.

```ts
// Stop the owner's access first (delete the account or its sessions), then run it, now and on a schedule, until done.
const { data, error } = await cloudrop.api.eraseOwner(userId);
// data: { revoked, deleted, cleaned, failed, waiting, done }
if (data?.done) await markErased(userId); // your app's record
```

Each run revokes the owner's unfinished uploads, deletes every completed file (row and object, as `deleteFile` does),
and checks the key of every ended upload the store cannot already prove clean, removing what is still the upload's
own. It reports:

| Field | Meaning |
| --- | --- |
| `revoked` | Unfinished uploads ended in this run. |
| `deleted` | Completed files deleted in this run. |
| `cleaned` | Ended uploads whose key this run checked once their URLs and the grace had run out. |
| `failed` | Files a storage or database error kept from being handled; each is logged with its id. |
| `waiting` | Files that cannot be proven yet: a completion still under way, an upload that started while it ran, or an ended upload whose URLs, or the grace after them, have not run out. What they had stored was removed. |
| `done` | Nothing of the owner was unfinished or completed, and every ended upload had its key checked after its URLs and the grace ran out. |

**Why it takes two runs.** A `PUT` with a URL signed before the revocation can still land afterwards. A URL works for
15 minutes and never past the upload's token, so the last `PUT` can start 15 minutes after the upload stopped being
unfinished (it completed, or ended), or at the token's deadline if that comes first; a key is checked for the last
time `graceMs` after that (default 1 hour, at least 15 minutes), the time a `PUT` already under way gets to land. Files
completed or ended longer ago than that are proven in the first run; a recent one makes the first run answer
`waiting`, and a run 1 hour 15 minutes later `done`. Run it again until it reports `done`: it is idempotent, and two
runs at once are safe.

- **Stuck completions too.** The sweep keeps the object of a completion it ended as `failed`, since its `onComplete`
  may have recorded it; `eraseOwner` removes it.
- **`signal`** (an `AbortSignal`) stops a run before the next file, with `done: false`.
- **`done` is about the moment it ran.** It reads the owner's unfinished and completed files in one statement before
  it checks the ended ones, so a file that changes status while it runs is not missed, and at the end it is not done
  when any upload of the owner started after the run did, even one already cancelled. An
  `/upload` that passed `authorize` before you revoked the owner's access can still reserve a file after the last read;
  a run that sees it answers `waiting`. Revoke access first, and if a request may still be in flight, run it once more
  after it.
- The usage row stays, at zeros. The rows stay too, as `deleted` and the other ended statuses, which name the file
  (`name`, `key`); delete them with your own SQL once `done` if your erasure policy requires it, never before.

## File operations

With a store, `cloudrop.api` gains these, each returning `{ data, error }`. Without one they answer `INVALID_CONFIG`.

| Call | What it does |
| --- | --- |
| `file(id)` | The file's row (`FileRecord`: status, key, owner, size, result, times), or `null`. |
| `files({ owner, route?, limit?, cursor? })` | An owner's completed files, newest first, a page at a time ([above](#list-an-owners-files)). |
| `usage(owner)` | `{ reservedBytes, activeBytes, files }` for an owner, with or without a quota. |
| `revokeUploads({ owner })` | Ends the owner's unfinished uploads (above). |
| `deleteFile(id)` | Deletes a completed file: its row becomes `deleted`, its bytes and file count are released, and its object is removed when it is still this upload's. Within 1 hour 15 minutes of the file's completion (its URLs' 15 minutes, then an hour), the row is left for the sweep to check once more, in case a `PUT` with one of its URLs lands later. Idempotent; `NOT_FOUND` for a file that never completed. |
| `eraseOwner(owner, { graceMs?, signal? })` | Removes everything an owner uploaded, and reports when that is proven ([above](#erase-an-owner)). |
| `reconcile({ owner? })` | Recounts usage from the rows, for one owner or all of them, and answers `{ checked, repaired }`. Only needed after editing the tables by hand. |
| `sweep(options?)` | One bounded round of cleanup, or every round with `all: true` (below). |

`api.delete(key)` still deletes an object by key, but leaves the row and the owner's usage as they were: use
`deleteFile` for uploaded files.

## The sweep

Uploads that never finish leave rows, reservations and sometimes parts or objects behind. `api.sweep()` cleans them up
in bounded rounds; run it on a schedule, once an hour is plenty. `all: true` runs every round in one call, `limit` rows
(default 100) at a time, and answers their reports summed; its `signal` is checked before each round, and once it
aborts, the answer's `cursor` says where to continue (it is null when every row was seen).

On Cloudflare Workers, a [cron trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
(`[triggers] crons = ["41 * * * *"]` in `wrangler.toml`) calls `scheduled`:

```ts
export default {
  async scheduled(controller, env, ctx) {
    const cloudrop = createUploads(env); // your createCloudrop, with the store over env.DB
    const { data, error } = await cloudrop.api.sweep({ all: true, signal: AbortSignal.timeout(60_000) });
    if (error) throw error; // shown as a failed run; the next one starts over
    for (const stuck of data.reported) console.warn(`cloudrop: completion of ${stuck.id} never finished; check it`);
  },
} satisfies ExportedHandler<Env>;
```

On Node, from a long-running process (or any job scheduler that runs a script, such as a Kubernetes `CronJob`):

```ts
async function sweepUploads() {
  const { data, error } = await cloudrop.api.sweep({ all: true, signal: AbortSignal.timeout(10 * 60_000) });
  if (error) return console.error(`Sweep stopped: ${error.message} The next run retries.`);
  for (const stuck of data.reported) console.warn(`cloudrop: completion of ${stuck.id} never finished; check it`);
}
setInterval(sweepUploads, 60 * 60_000);
```

Without `all`, each call handles up to `limit` rows (default 100, at most 1,000) and answers `{ expired, cleaned,
failed, reported, cursor }`; pass `cursor` back to continue. It runs two passes:

- **Expire:** an unfinished upload past its token's deadline plus `graceMs` is ended as `expired` first, its
  reservation released; then its multipart upload is aborted and its object deleted only when the object's
  `cloudrop-id` is this upload's. A completion stuck past its lease, and past its deadline plus `graceMs`, is ended as
  `failed` and **reported**, and its object is kept: its `onComplete` may have recorded it, so check each reported
  file.
- **Cleanup:** an ended upload (`aborted`, `rejected`, `failed`, `expired` or `deleted`) not yet cleaned up, and ended
  more than `graceMs` ago, has its late parts and object removed, again only when the object is its own. This catches
  a `PUT` that landed after an `/abort`, an upload that could not start, and an expired one whose first cleanup
  failed. The row is marked cleaned up, and counted in `cleaned`, only once no `PUT` can still land: `graceMs` after
  its last upload URL ran out, which for a row ended within 15 minutes of leaving `pending` is up to 15 minutes later
  than `graceMs` after its end. Until then each sweep checks its key again.

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
- **Tables outside `public`:** pass `tables: { schema: "app" }`, or set the search path; see
  [Tables in another schema](#tables-in-another-schema).
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

- **Some lost `/upload` answers still hold their reservation.** A client that sends no `idempotencyKey` (your own
  code calling `/upload`) cannot be told apart from a new request: its first attempt's rows reserve their bytes until
  the sweep expires them (deadline plus `graceMs`) or `revokeUploads` releases them. A retry whose `beforeUpload`
  refuses the request reaches no store call, so it supersedes nothing either. Nor does a retry that reaches the store
  before its first attempt does (a first request still being worked on, its `authorize` slow, when the client gives up
  on it): that attempt's rows are written after the retry's and keep their bytes until the sweep. An ask whose every
  attempt lost its answer: its last attempt's rows hold their bytes until the sweep, since `retry()` and `resume()` ask
  again with a new key. Plugin reservations of a superseded attempt need their own expiry.
- **A `PUT` that lands after cleanup stays.** The sweep cleans a row once. A `PUT` already under way that lands after
  that is left in the bucket; with the default hour of grace this is unlikely. `eraseOwner` checks such keys again.
- **A completion's record that fails after `onComplete` ran, in lease mode**, keeps the file busy until the lease ends
  (5 minutes by default), longer than the client retries. The client then reports a failure but keeps the file. Once
  the lease has passed, the next `/complete` of it (a `retry()` or a `resume()`) takes the file over and runs
  `onComplete` again: one more reason to keep it idempotent in this mode.
- **Clock skew.** The lease and the grace periods are minutes, far above normal skew between servers. A server whose
  clock runs ahead can delay `eraseOwner`'s `done` by that much: a file it wrote looks newer than the run. Keep server
  clocks in sync (NTP), as SigV4 signing already requires.
- **Bundle size.** The store paths add about 6.7 kB (gzip) to `cloudrop`'s server code whether or not you use a store;
  the browser bundle does not change.

## Turning it on, or off, in a running app

Tokens signed with a store carry a `stored` mark. During a rolling deploy, a token from an instance without the store
takes the stateless path on an instance with one, until it expires (24 hours); a stored token whose row is missing is
refused as cancelled. Turning the store off makes stored tokens stateless again. So you can enable the store with a
normal deploy: uploads started before it finish as they began, and their files count toward no owner's usage.
