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

  `completionLeaseMs` is a `createCloudrop` option, 300000 (5 minutes) by default and from 1 second to 30 days: set
  it above your slowest `onComplete`. Keep `onComplete` idempotent in this mode: write with `INSERT … ON CONFLICT`, as the example's
  `recordUpload` does.
- **Retries are answered from the row.** A `/complete` of a completed file answers the stored result with no storage
  call and no hook, also after the token expired. So does a file deleted with `api.deleteFile`: its answer still names
  the deleted object, so a resumed client does not upload it again.
- **`onDelete` with the deletion.** A route's [`onDelete`](#ondelete) runs for each completed file `deleteFile`,
  `replace` or `eraseOwner` deletes: with `transaction: true` inside the deletion's transaction, exactly once for
  writes through `tx`; otherwise before the deletion, at least once. A throw keeps the file, and so does a
  `CloudropError` the hook returns, which [refuses the deletion](#refuse-a-deletion).
- **A hard quota.** Concurrent uploads of one owner cannot pass their limit.
- **`/abort` never deletes a completed file**, and an ended row refuses `/sign` and `/complete`.
- **The sweep deletes only what it may.** It removes an object only when the object's `cloudrop-id` names a row that
  never completed, and never touches completed files or keys without a row.

## Set it up

Every adapter builds the same store over one SQL core; pick the one that matches how your app reaches its database.
Each method of the store is one atomic unit (one statement on Postgres, one batch on SQLite), and the store checks
its tables on its first call: a missing table or column is logged as `INVALID_CONFIG` naming it, and clients get a
retryable `SERVER_ERROR` until the tables are fixed. On Postgres, a role that may not read the tables is told that
instead, with the grants the store needs: `SELECT, INSERT, UPDATE` on the files table, `SELECT, INSERT, UPDATE,
DELETE` on the usage table, and `USAGE` on their schema when it is not `public`. Any other failure of that first
read, such as a database that is down, is logged as the driver reported it.

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
other requests run their statements. Give the pool an error listener, `pool.on("error", (error) => log(error))`, as
node-postgres asks: without one, a connection that dies while idle in the pool, as in a database restart, stops
the process. `pgExecutor` handles the connections it has checked out itself. Any other driver fits too: an executor
is an object with `dialect`, `query` and an atomic, ordered `batch` (`SqlExecutor`), plus `transaction` for
`{ transaction: true }`.

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
  `await tx.update(users).set({ avatarKey: file.key }).where(eq(users.id, userId))`. On drizzle-orm 0.45 with
  node-postgres, Drizzle's transaction does not listen for its connection's errors, so a database restart during
  `onComplete` stops the process: give every connection a listener,
  `pool.on("connect", (client) => client.on("error", (error) => log(error)))` (the next statement still fails, and
  the completion answers a retryable error), or use 1.0.0-rc.5 or later, which listens itself.
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
  `api.files({ owner })` lists a user's files and `api.allFiles()` every owner's; for anything else, read the tables freely
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

CREATE INDEX "cloudrop_files_created_at_idx" ON "cloudrop_files" (created_at);

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

CREATE INDEX "cloudrop_files_created_at_idx" ON "cloudrop_files" (created_at);

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

On a large Postgres table, `CREATE INDEX CONCURRENTLY` (outside a transaction) avoids blocking uploads while it builds;
check afterwards that the index is valid, as [Upgrading from 0.5](#upgrading-from-05) shows.
With [`tables.schema`](#tables-in-another-schema) or table names of your own, put those names in both statements.

### Upgrading from 0.5

0.6.0 adds one index, on `created_at`, for [`api.allFiles`](#list-every-owners-files). No column changes. Only that
listing without an `owner` reads the index: every other statement of the store, `api.files` and `eraseOwner`
included, is planned as it was in 0.5 (checked on Postgres 16, 17 and 18 after each of 20 `ANALYZE` runs, and on
SQLite). Its cost is one more index entry written per upload, and about 3.4 MB per 300,000 files on Postgres. A
database without it answers the same pages, only slower: each page of every owner's files reads and sorts the whole
table (about 30 ms a page at 300,000 files on Postgres 18, against 0.05 ms with the index), so an upgrade never
breaks an app that has not migrated yet, and an app that never calls `api.allFiles` may leave it out.

- **Plain SQL**, on Postgres, SQLite or D1, in a migration:

  ```sql
  CREATE INDEX "cloudrop_files_created_at_idx" ON "cloudrop_files" (created_at);
  ```

- **Drizzle:** `cloudropPgTables()` and `cloudropSqliteTables()` declare the index, so `drizzle-kit generate` writes
  the migration, with no question to answer:

  ```sql
  CREATE INDEX "cloudrop_files_created_at_idx" ON "cloudrop_files" ("created_at");
  ```

- **Prisma:** add `@@index([createdAt])` to your `CloudropFile` model, as the shipped models have it, and
  `prisma migrate dev` writes:

  ```sql
  CREATE INDEX "cloudrop_files_created_at_idx" ON "cloudrop_files"("created_at");
  ```

On a large Postgres table a plain `CREATE INDEX` blocks uploads while it builds. Build it first, by hand:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cloudrop_files_created_at_idx" ON "cloudrop_files" (created_at);
```

Send it as one statement of its own. `CONCURRENTLY` cannot run inside a transaction, so not from a migration file
either when the tool wraps the file in one or sends several statements at once: Postgres answers `CREATE INDEX
CONCURRENTLY cannot run inside a transaction block`. Then add `IF NOT EXISTS` to the statement in the migration,
which finds the index there and does nothing.

Check the index before you rely on it. A concurrent build that is cancelled or runs into a `statement_timeout` (or
loses its connection) leaves the index behind, marked invalid. No query uses an invalid index, uploads may still
write to it, and both statements above then answer `relation "cloudrop_files_created_at_idx" already exists,
skipping` and build nothing, so running them again does not help. This must answer `t`:

```sql
SELECT indisvalid FROM pg_index WHERE indexrelid = '"cloudrop_files_created_at_idx"'::regclass;
```

If it answers `f`, drop the index and build it again, each statement on its own:

```sql
DROP INDEX CONCURRENTLY "cloudrop_files_created_at_idx";
CREATE INDEX CONCURRENTLY "cloudrop_files_created_at_idx" ON "cloudrop_files" (created_at);
```

With [`tables.schema`](#tables-in-another-schema) or table names of your own, put those names in the statements. A
store you wrote yourself also needs the new `listAll` method before `api.allFiles` works with it; every other call
works without.

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

- `owner` names who a file counts against: a user, team or workspace id of 1 to 255 characters, or null for no one.
  It must be well-formed text without NUL: Postgres text cannot hold U+0000, and a database stores a lone surrogate
  (half of a surrogate pair, such as a string cut in the middle of an emoji) as U+FFFD, which would make one owner of
  two. Another value fails the upload as the route's bug, and the file API refuses it with `INVALID_INPUT`. It runs
  once per `/upload`, before plugins' `beforeUpload`, and sees the authorize result, the request and the metadata,
  not the files. It is not the authorize result signed into the token.
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
- `revokeUploads`, `eraseOwner` and the sweep wait for the row lock too: one that reaches a file whose completion is
  running `onComplete` returns once that completion commits or rolls back. Another reason to keep `onComplete` short.
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

## `onDelete`

A route's `onDelete` runs when one of its completed files is deleted: by `api.deleteFile` (`reason: "deleted"`), by the
next completion on a [`replace: true`](#one-file-per-owner-replace) route (`"replaced"`), or by
[`api.eraseOwner`](#erase-an-owner) (`"erased"`). It keeps what your app holds about the file right: an audit trail, a
pointer such as the user's current avatar, a counter. An audit trail on Postgres, with Drizzle:

```ts
const files = store.route(policy, {
  owner: ({ userId }) => userId,
  onDelete: async ({ tx, file, owner, reason }) => {
    // Commits with the deletion, or not at all.
    await tx.insert(auditEvents).values({ action: "file-deleted", userId: owner, fileId: file.id, reason });
    await tx.delete(avatars).where(eq(avatars.fileId, file.id));
  },
});
```

`file` is the file's row as it was before the deletion (`status: "completed"`, with its `key`, `name`, `size`, `type`
and `result`); `owner` is its owner, or null. `context` is what the caller passed to `api.deleteFile(id, { context })` or
`api.eraseOwner(owner, { context })`, as it is, or undefined: who asked and why, for the audit row. A replacement has
no caller, so its hook gets `request` instead, the `/complete` request of the upload that replaces the file, such as for
the client's address:

```ts
// The person deletes one of their files, or an administrator does, with a reason.
await cloudrop.api.deleteFile(id, { context: { actorId: session.user.id, ip, reason } });

onDelete: async ({ tx, file, owner, reason, context, request }) => {
  const by = context as { actorId: string; ip: string | null; reason?: string } | undefined;
  await tx.insert(auditEvents).values({
    action: "file-deleted",
    actorId: by?.actorId ?? owner,
    ip: by?.ip ?? request?.headers.get("cf-connecting-ip") ?? null,
    fileId: file.id,
    reason: by?.reason ?? reason,
  });
},
```

That `request` has its body already read, as every hook's does: read its headers and `url`, since `request.json()`
throws ([Server](server.md#the-requests-body-is-already-read)).

cloudrop does not read `context`; check its shape in the hook, as it is whatever your code passed. Only completed files run it: an upload that never completed was never
yours, so `/abort`, `revokeUploads`, a refusal and the sweep run nothing, and neither does `api.delete(key)`, which
removes an object and leaves its row. `onDelete` needs a store (`INVALID_CONFIG` otherwise), and a file whose route is
no longer among your `routes` is deleted without one.

| | With `transaction: true` (Postgres) | Without (SQLite, D1, or a lease on Postgres) |
| --- | --- | --- |
| When | Inside the deletion's transaction, before cloudrop locks the file and the owner's counters. | Before the deletion is recorded. |
| How often | Exactly once for writes through `tx`. Two deletions of one file at once may both run it, but the one that finds the file already deleted rolls its writes back. | At least once, like `onComplete` under a lease: again after a deletion that failed after it is retried, and twice when two calls delete the file at once. Make it idempotent by `file.id`. |
| A throw, or a [refusal](#refuse-a-deletion) | Rolls back the deletion and everything written through `tx`. | Keeps the file: the deletion is not recorded. What the hook wrote before it stays. |

### Refuse a deletion

To keep a file, **return** a `CloudropError` from `onDelete`. The file stays completed, with its bytes and its object,
nothing is logged, and the caller gets your error: its `code`, `message` and `retryable`. The rule is checked inside
the hook, under the locks the hook takes, so it needs no second check before the call that could go stale:

```ts
import { CloudropError } from "cloudrop";

onDelete: async ({ tx, file, owner, context }) => {
  const by = context as { actorId: string } | undefined;
  // Locks the owner's row, so their role cannot change before the deletion commits.
  const [user] = await tx.select().from(users).where(eq(users.id, owner ?? "")).for("update");
  if (user?.role === "admin" && by?.actorId !== owner) {
    return new CloudropError("FORBIDDEN", "This file belongs to an administrator. Only they can delete it.");
  }
  await tx.insert(auditEvents).values({ action: "file-deleted", actorId: by?.actorId ?? owner, fileId: file.id });
},
```

```ts
const { data, error } = await cloudrop.api.deleteFile(id, { context: { actorId: session.user.id } });
if (error?.code === "FORBIDDEN") return forbidden(error.message); // the hook's refusal, not an outage
```

A throw keeps the file too, but as a failure. What each caller answers:

| Caller | A refusal: `onDelete` returned a `CloudropError` | A failure: `onDelete` threw, or returned anything else |
| --- | --- | --- |
| `api.deleteFile` | That error, as it is. | A retryable `SERVER_ERROR`, "onDelete failed for route "files", so the file was kept. Its error is in the server log; fix it and try again." |
| `api.eraseOwner` | The file counts in `refused`, and in `waiting` as it is still completed. The run goes on with the next file and reports `done: false`; the next run asks the hook again. | The file counts in `failed` and in `waiting`. The run goes on and reports `done: false`; the next run tries it again. |
| A replacing `/complete` | The client gets that error, with the HTTP status of its code (`FORBIDDEN` is 403). The new file is not recorded and the previous one stays. | The retryable `SERVER_ERROR` a throw in `onComplete` gives. The new file is not recorded, the previous one stays, and the client's retry runs both hooks again. |
| The server log | Nothing. | The error, with the route and the file's id. |

- **Only a returned error refuses.** A thrown `CloudropError` is a failure like any other throw, so an error from a
  cloudrop call that your hook rethrows never passes for your refusal. Any other returned value is a failure too,
  logged with its type: a string, `false`, `null`, the result of a query in an arrow function without braces, or a
  `CloudropError` made by a second installed copy of cloudrop. Up to 0.5.0 a returned value was ignored.
- **A replacing `/complete`.** With a transaction the whole completion rolls back, `onComplete`'s writes through `tx`
  included. Under a lease `onComplete` has already run and what it wrote stays, as after a throw; the claim is handed
  back, so a later `/complete` runs both hooks again without waiting. The client ends the file with your error, as
  for any `/complete` error that is not retryable; with `retryable: true` it tries `/complete` again first. Use a code
  the handler sends ([endpoint errors](errors.md#upload-endpoint-errors)), such as `FORBIDDEN`: a client's own code,
  such as `ABORTED`, reaches the browser as the generic `SERVER_ERROR`. Avoid `SERVER_ERROR` itself: the client reads
  it as a completion that may have finished, and keeps the upload instead of cancelling it.
- **A refusal is the hook's answer to that caller.** When another call deletes the file while your hook refuses, the
  refused caller still gets the refusal, not the answer for a file already deleted, and with a transaction what the
  hook wrote rolls back. `eraseOwner` counts such a file in `refused`, and `done` follows the owner's rows as always.
- **Refuse before you write, without `tx`.** Under a lease, and in a plain `route()` on a store with a transaction
  (it gets no `tx`), cloudrop cannot undo what the hook wrote before it refused.

### A replacement whose files change meanwhile

A replacing completion runs `onDelete`, after `onComplete`, for the owner's files it is about to replace, then records
the completion. When the owner's files change in between (another upload on the route completes, or a `deleteFile`
takes the previous file):

- **with a transaction**, the completion rolls back and the client is asked to retry, which lists the files again;
- **without one**, a file that completed in between is replaced too, and its `onDelete` runs right after the record,
  where a throw is only logged, and so is a refusal: the file is deleted already and cannot be kept. A crash, or a
  database answer lost after the commit, between the record and that run skips it.

When `onDelete` throws because another deletion got there first (an audit row keyed by the file already exists), the
file is deleted all the same. `api.deleteFile` then answers as it does for a file already deleted (`deleted: false`),
and `api.eraseOwner` counts the file nowhere. A replacing `/complete` does not look at the file again: it answers the
retryable `SERVER_ERROR` of any throw and its new file stays unfinished. The client's retry finds nothing left to
replace, runs no `onDelete` and completes.

- **Lock order.** `onDelete` runs before cloudrop locks the file or the owner's counters, as `onComplete` runs before
  cloudrop records the completion, so rows of yours that both write (a counter, the user's row) are locked before
  cloudrop's in every path. Write them in the same order in both hooks, and concurrent uploads and deletions of one
  owner take turns instead of deadlocking.
- **Keep network calls out**, as in `onComplete`: in transaction mode they hold a connection and row locks, and a
  rollback cannot undo them. Write an outbox row through `tx` instead.

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
  completed there (`api.files` lists it). The route's [`onDelete`](#ondelete) runs for the previous file with
  `reason: "replaced"`. `afterComplete` runs after: the previous file's row is deleted and the removal of its object was
  tried. Neither gets a new field.
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
default 100) at a time. Files deleted between two pages make the next page skip nothing. Narrow and order it with:

| Option | What it does |
| --- | --- |
| `route` | Only that route's files; it must be one of the server's routes. |
| `name` | Only files whose name contains it. ASCII letters match in either case (`"report"` finds `"Q3 Report.pdf"`); every other character, `%` and `_` included, matches only itself, so `"é"` does not find `"É"`. At most 255 characters; `""` filters nothing, so a search box can pass what was typed. |
| `type` | Only that type (`"application/pdf"`), or with a trailing slash every type under a top-level type (`"image/"`). Not `"image/*"`. |
| `order` | `"newest"` (the default) or `"oldest"` upload first. |

```ts
const page = await cloudrop.api.files({ owner: userId, name: search, type: "image/", order: "oldest", limit: 50 });
```

The cursor is opaque and belongs to its listing: pass it back with the same `route`, `name`, `type` and `order`, or the
call answers `INVALID_INPUT`. Every backend answers the same files: Postgres, SQLite, D1 and the testing memory store.

## List every owner's files

`api.allFiles` lists the files of **every** owner, in any status: an admin inventory, a moderation queue, a support
tool. It crosses owners, so call it only behind your app's own admin check, and never with options a visitor chose
without that check:

```ts
// An admin inventory: your app's own check first, then one page.
export async function GET(request: Request) {
  if (!(await isAdmin(request))) return new Response("Forbidden", { status: 403 });
  const query = new URL(request.url).searchParams;
  const { data, error } = await cloudrop.api.allFiles({
    status: "completed",
    name: query.get("search") ?? undefined,
    limit: 50,
    cursor: query.get("cursor"), // null, like the cursor of a last page, is the first page
  });
  if (error) return Response.json({ error: error.message }, { status: error.code === "INVALID_INPUT" ? 400 : 500 });
  // data.items: FileRecord[] of every owner, newest upload first. data.cursor: the next page; null on the last one.
  return Response.json(data);
}
```

The page is the `{ items, cursor }` of [`api.files`](#list-an-owners-files), and `route`, `name`, `type`, `order`,
`limit` and `cursor` mean what they mean there. Two options are its own, and every option may be left out:

| Option | What it does |
| --- | --- |
| `owner` | Only that owner's files, in any status. Left out: every owner's files, and those of routes without an `owner`. |
| `status` | Only files in that status: `"pending"`, `"completing"`, `"completed"`, `"aborted"`, `"rejected"`, `"failed"`, `"expired"` or `"deleted"`. Left out: every status. |

```ts
// A support tool: everything one user ever uploaded, cancelled and deleted uploads included.
const page = await cloudrop.api.allFiles({ owner: userId });
// A moderation queue: the oldest completed files of one route first.
const queue = await cloudrop.api.allFiles({ status: "completed", route: "attachments", order: "oldest" });
```

It is a method of its own and not `api.files` without an owner: `api.files` refuses a missing `owner`, so a user id
that is `undefined` by a bug never lists everyone's files. A cursor belongs to its listing (the same owner, status,
route, name, type and order) and to its method: `api.allFiles` refuses a cursor of `api.files`, and `api.files` one of
`api.allFiles`, with `INVALID_INPUT`. Files uploaded at the same instant page by id, so none is skipped or repeated,
also when files arrive or leave between two pages. Every backend answers the same files in the same order.

Without `owner` it reads the files in upload order along the `created_at` index and checks each against the options,
so its cost is the rows it passes to fill a page; with `owner` it finds that owner's files by owner, as `api.files`
does: see [Known costs](#known-costs). The index is new in 0.6.0 ([Upgrading from 0.5](#upgrading-from-05)); without
it the listing answers the same, slower.

## Erase an owner

For an account deletion or an erasure request: everything an owner uploaded goes, driven by the owner's rows, so it
needs no knowledge of your key layout.

```ts
// Stop the owner's access first (delete the account or its sessions), then run it, now and on a schedule, until done.
const { data, error } = await cloudrop.api.eraseOwner(userId);
// data: { revoked, deleted, refused, cleaned, failed, waiting, done }
if (data?.done) await markErased(userId); // your app's record
```

Each run revokes the owner's unfinished uploads, deletes every completed file its `onDelete` lets go (the row first,
then the object, as `deleteFile` does), and checks the key of every ended upload the store cannot already prove clean,
removing what is still the upload's own. It reports counts of files, and a file can count twice: one deleted in this
run is in `deleted`, and again in `cleaned` or `waiting` once its key was checked.

| Field | Meaning | In the bucket after the run |
| --- | --- | --- |
| `revoked` | Unfinished uploads ended in this run. | What they had uploaded is removed later in the same run, where each counts again in `cleaned`, `waiting` or `failed`. |
| `deleted` | Completed files deleted in this run: the row is `deleted` and the owner's bytes are released. | The object is removed later in the same run, where each counts again in `cleaned`, `waiting` or `failed`. |
| `refused` | Completed files kept because their route's [`onDelete` refused](#refuse-a-deletion). They count in `waiting` too, so the owner is not `done` until the hook lets them go. | Untouched: the file is still completed and its object is there. |
| `cleaned` | Ended uploads (cancelled, revoked, refused, expired, failed or deleted, in this run or before it) whose key this run checked once their URLs and the grace had run out. | Nothing of theirs, and nothing can arrive any more. |
| `failed` | Files this run could not handle; each is logged with its id. | After a storage or database error, not known: the object may still be there. A file whose `onDelete` threw is still completed, with its object, and counts in `waiting` too. |
| `waiting` | Files not proven gone yet. | **Still there** for a file that is still live: a completed file its `onDelete` kept, a completion under way, and an upload that started while the run went on. **Removed, but not for good** for an ended upload whose URLs, or the grace after them, have not run out: this run removed its object, a `PUT` already signed can still put one back, and a later run checks the key again. |
| `done` | Nothing of the owner was unfinished or completed, and every ended upload had its key checked after its URLs and the grace ran out. | Nothing of the owner's uploads, and nothing can arrive any more. |

**Why it takes two runs.** A `PUT` with a URL signed before the revocation can still land afterwards. A URL works for
15 minutes and never past the upload's token, so the last `PUT` can start 15 minutes after the upload stopped being
unfinished (it completed, or ended), or at the token's deadline if that comes first; a key is checked for the last
time `graceMs` after that (default 1 hour, from 15 minutes to 30 days), the time a `PUT` already under way gets to land. Files
completed or ended longer ago than that are proven in the first run; a recent one makes the first run answer
`waiting`, and a run 1 hour 15 minutes later `done`. Run it again until it reports `done`: it is idempotent, and two
runs at once are safe.

- **It needs the sweep.** `eraseOwner` never ends a completion that is under way, since it may still record the file.
  One whose server died in the middle of `/complete` stays `completing`: every run counts it in `waiting`, leaves its
  object where it is and reports `done: false`, however often you run it. [The sweep](#the-sweep) ends it as `failed`
  once it is past its lease and `graceMs` past its token's deadline: with the defaults, 25 hours after its `/upload`
  (a token lasts 24 hours, the grace 1 hour). The sweep keeps that object, since its `onComplete` may have recorded
  it; the next `eraseOwner` removes it and can report `done`. Keep the sweep on its schedule while you erase: without
  it, such an owner never reports `done`.
- **`signal`** (an `AbortSignal`) stops a run with `done: false`. The run finishes the file it is on, then handles no
  further file and reads no further page of them. What the files it had deleted left in the bucket is removed by the
  next run.
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
| `files({ owner, route?, name?, type?, order?, limit?, cursor? })` | An owner's completed files, newest or oldest first, filtered by route, name and type, a page at a time ([above](#list-an-owners-files)). |
| `allFiles({ owner?, status?, route?, name?, type?, order?, limit?, cursor? })` | The files of every owner, in any status, a page at a time, for your admin tools ([above](#list-every-owners-files)). It crosses owners: call it behind your own admin check. |
| `usage(owner)` | `{ reservedBytes, activeBytes, files }` for an owner, with or without a quota. |
| `revokeUploads({ owner })` | Ends the owner's unfinished uploads (above). |
| `deleteFile(id, { context? })` | Deletes a completed file and answers `{ id, deleted, cleaned }` ([below](#what-deletefile-answers)): the route's [`onDelete`](#ondelete) runs, with `context`, its row becomes `deleted`, its bytes and file count are released, and its object is removed when it is still this upload's. Idempotent. `NOT_FOUND` for a file that never completed; the hook's own error when [`onDelete` refuses](#refuse-a-deletion). |
| `eraseOwner(owner, { graceMs?, signal?, context? })` | Removes everything an owner uploaded, and reports `{ revoked, deleted, refused, cleaned, failed, waiting, done }`: when that is proven, and which files an `onDelete` refused ([above](#erase-an-owner)); `context` reaches each file's [`onDelete`](#ondelete). |
| `reconcile({ owner? })` | Recounts usage from the rows, for one owner or all of them, and answers `{ checked, repaired }`. Only needed after editing the tables by hand. |
| `sweep(options?)` | One bounded round of cleanup, or every round with `all: true` (below). |

`api.delete(key)` still deletes an object by key, but leaves the row and the owner's usage as they were: use
`deleteFile` for uploaded files.

### What `deleteFile` answers

```ts
const { data, error } = await cloudrop.api.deleteFile(id);
// data: { id, deleted, cleaned }
if (data?.deleted) await notifyOwner(id); // only the call that deleted the file
```

| Field | Meaning |
| --- | --- |
| `deleted` | `true` when this call moved the file from completed to deleted; `false` when it was deleted already, by an earlier call, a replacement or `eraseOwner`. Of two calls at once exactly one answers `true`. |
| `cleaned` | `true` when the file's row is marked cleaned: the bucket was checked once the file's URLs and the grace after them had run out, and holds nothing of it. `false` while the sweep still has to check again. |

- **`cleaned: false` is the usual first answer.** A `PUT` with one of the file's URLs can still land for 15 minutes
  after the upload completed, and gets an hour more to finish. Within that 1 hour 15 minutes the object is removed and
  the row is left for the sweep to check once more; a file completed longer ago answers `cleaned: true` at once.
- **Once the row is deleted, the call succeeds.** The file is gone for its owner, its bytes released. When the object
  then cannot be removed, or the row cannot be marked cleaned, the failure is logged with the file's id and the answer
  is `cleaned: false`: the sweep removes the object, and so does another `deleteFile`.
- **An error means the file was not deleted by this call**: `NOT_FOUND`, your `onDelete`'s refusal, or a retryable
  `SERVER_ERROR` when the hook threw or the database failed. After a database failure the deletion may have been
  committed all the same, and the call that follows then answers `deleted: false`.

## The sweep

Uploads that never finish leave rows, reservations and sometimes parts or objects behind. `api.sweep()` cleans them up
in bounded rounds; run it on a schedule, once an hour is plenty. `all: true` runs every round in one call, `limit` rows
(default 100) at a time, and answers their reports summed; its `signal` is checked before each round, and once it
aborts, the answer's `cursor` says where to continue (it is null when every row was seen).

On Cloudflare Workers, a [cron trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
(`[triggers] crons = ["41 * * * *"]` in `wrangler.toml`) calls `scheduled`. With D1, sweep one bounded round per run
instead of `all`, because [D1 limits a run](#cloudflare-workers-with-d1-how-much-fits-in-one-run):

```ts
export default {
  async scheduled(controller, env, ctx) {
    const cloudrop = createUploads(env); // your createCloudrop, with the store over env.DB
    // At most 400 uploads per run: about 800 of the 1,000 D1 queries a run may make. On the Free plan: limit: 15.
    const { data, error } = await cloudrop.api.sweep({ limit: 400 });
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
row may be cleaned up, and at most 30 days. A failing row is logged, counted in `failed` and left for the next sweep; the rows after it are
still swept. Two sweeps at once are safe, and so is a sweep racing a `/complete`: the sweep takes the row before it
deletes anything. Each sweep counts in `cleaned` the rows it marked, so two at once may both count the same row.

The sweep never deletes a completed file, never touches an object whose `cloudrop-id` belongs to another upload or
that has no row, and runs no plugin `onAbort` (rows carry no authorize result). Keep the bucket's lifecycle rule that
aborts incomplete multipart uploads ([Bucket setup](bucket-setup.md)): it covers a server that crashes between creating
a multipart upload and recording it, which leaves no row to sweep. With a store, `api.checkBucket()` reports that rule
as required.

### Cloudflare Workers with D1: how much fits in one run

Cloudflare allows one Worker invocation 1,000 D1 queries on Workers Paid and 50 on Free, where a `batch()` counts as
one query, and 10,000 subrequests on Paid (more with `limits.subrequests`) or 50 on Free; a cron run may take 15
minutes ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-11-21). Past the D1 limit
every further query of that invocation fails with "Too many API requests by single Worker invocation". Counted on
the store, a query being one statement or one batch:

| Call | D1 queries | Requests to the bucket |
| --- | --- | --- |
| `/upload` | 1 for all its files, and 1 more per multipart file | 1 per multipart file |
| `/complete` | 3 (1 when the file is already completed) | 1 |
| `api.sweep`, a round | 2 to find the work | none |
| … per unfinished upload it expires | 2 | 1 to 3 |
| … per ended upload it cleans up | 1 | 1 to 3 |
| The first call in a new isolate | 2 more, the check of the tables | none |

- **The sweep is what needs a bound.** `api.sweep({ limit: 400 })` makes at most 804 queries and 1,200 requests to
  the bucket, under the Paid limits whatever the rows are; `all: true` over a backlog does not stop at 1,000. On the
  Free plan use `limit: 15`: at most 34 queries and 45 requests. The Free plan also gives a cron run 10 ms of CPU,
  which signing that many requests may not fit (not measured).
- **A backlog needs more runs, not a bigger one.** A run leaves what is over its `limit` where it was, and the next
  run starts with the oldest work, so there is no cursor to keep between runs: `crons = ["*/5 * * * *"]` with
  `limit: 400` sweeps 4,800 uploads an hour.
- **Past the limit nothing is lost.** The sweep logs each upload whose query was refused, counts it in `failed` and
  leaves it as it was; the next run does it. `eraseOwner` has no `limit` and costs about as much per file, so an
  owner with several hundred files can pass the limit in one run: it then counts the files it could not handle in
  `failed`, or answers a retryable error when a listing was refused. Run it again from the next invocation until it
  reports `done`, as for any owner.
- **Uploads fit.** A route takes at most 100 files per `/upload` (`maxFiles`), so the largest `/upload` is 101
  queries and 100 requests when every file is multipart. On the Free plan that is 47 multipart files at most, or any
  number of smaller ones, which cost one query together.

## Postgres notes

- **Isolation:** READ COMMITTED, the default. See [`onComplete` with `tx`](#oncomplete-with-tx).
- **Deadlocks:** the store's own statements lock a file's row before its owner's usage row, and several file rows in
  byte order of id, so they never deadlock each other. A transaction of your own over these tables can: lock in that
  order too. A store call that Postgres ends to break a deadlock or a serialization conflict (`40P01`, `40001`) is run
  once more; if that fails too, the call answers a retryable `SERVER_ERROR` with nothing written, so check `error`
  after `revokeUploads` at sign-out. A completion in a transaction (`transaction: true`) is not run again: it rolls
  back and the client's `/complete` retries.
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
- **D1** batches are atomic and serialised by Cloudflare; nothing to configure. Its limit on queries per invocation
  bounds a sweep: see [how much fits in one run](#cloudflare-workers-with-d1-how-much-fits-in-one-run).

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
- **Searching by name or type reads the owner's files.** The `(owner, status, created_at)` index finds an owner's
  completed files in order, and `name` and `type` are checked on each of them, so a search that matches few of an
  owner's many files reads them all to fill a page. No other index is needed, and 0.4.0 needs no migration.
- **Listing every owner's files reads them in upload order.** `api.allFiles` without an `owner` walks the
  `created_at` index and checks each file against the options, so a page costs the rows it passes until it is full.
  Measured on Postgres 18 with 300,000 files, a page of 100: no option, a status or a route that most files have,
  0.05 ms; a name that 12% of the files have, 1.2 ms; a name that almost no file has reads every file, 0.3 to 0.5 s
  (0.16 s without the index, which makes this one case slower). With `owner` the walk is never used: the owner's
  files are found by owner and sorted, 5 ms for an owner of 16,000 files, or, when a `status` is given too, read as
  one page of the owner index like `api.files`, 0.05 to 0.1 ms whatever the owner's share of the table. Without an
  `owner`, Postgres picks another index when its statistics say few rows match (a rare status or route: 0.1 ms).
  SQLite and D1 have no such statistics, so there the walk is fixed: a status or a route that very few files have
  reads most or all of them (22 to 72 ms at 300,000 files, and D1 bills the rows read). For frequent narrow searches
  over many files, keep a query and an index of your own, such as a trigram index on Postgres.
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
