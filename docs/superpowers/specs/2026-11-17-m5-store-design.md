# M5: the database store

Date: 2026-11-17. Status: done (merged to `main` 2026-11-17); approved by the owner on 2026-11-17 ("build the store interface before the M5 plugins"),
under the standing instruction to follow the best recommendations without check-ins. Decisions: series `M5-T` in
`docs/decisions/m5-store.md`. This milestone takes the number M5; the plugins move to M6 and docs/beta/1.0 to M7
(spec §14 is amended in the same change).

## 1. Why, and the evidence

The product-fit review of 2026-11-17 found that in the owner's reference apps (one on Prisma, a React Native app and a
Bun + Hono app on Drizzle) the hard part of uploads is not the transfer but the database around it. The Prisma app and
the React Native app each built, by hand, the same
shape: a row per upload written before anything is signed, a guarded state transition at completion so the app's
completion work runs once, quota reserved and committed atomically, and a sweep that ends what was never finished.
Their incidents are the design's test cases:

- The Prisma app deleted a pending row when an early `/complete` saw no object yet, leaving the later PUT as an orphan; it
  reused a status column as a lock token; its quota check at presign could be overshot before confirm.
- The React Native app's backend ran storage calls inside a database transaction holding row locks; deleted 2,522 live objects when a reference
  table was missing from its sweep; held reserved bytes until physical deletion.
- Both treat a lost acknowledgement (storage completed, database not updated) as the case to survive.

Library research (better-auth, Auth.js, Lucia, Payload, UploadThing, tus) found: one core with narrow, domain-specific,
single-statement adapter methods beats generic CRUD for a single table; exactly-once needs a conditional update whose
affected-row count is exact; HTTP Postgres drivers and Cloudflare D1 have no interactive transactions; Prisma 8 (RC)
replaces the generated client. The code study found six seams in the server where store calls fit, each behind
`if (config.store)`, leaving the stateless mode byte-for-byte unchanged. An adversarial review of the first draft
(`.superpowers/sdd/m5/spec-review.md`, 2026-11-17: 3 critical, 13 important findings) shaped this revision.

## 2. Goals and non-goals

Goals:
1. **Opt-in.** `createCloudrop({ store })`. Without a store nothing changes: same requests, same answers, same tests.
2. **A row before signing.** `/upload` writes one row per accepted file before any URL is signed or any multipart
   upload is created; a row that cannot be written refuses that file.
3. **`onComplete` once.** A guarded claim decides the one `/complete` that runs `onComplete`; retries and overlapping
   completions get the stored result without running it again. With a transactional adapter (Postgres) the claim,
   `onComplete`'s database writes through `tx` and the completion commit together: exactly once for database work.
   Without one, `onComplete` runs again only after a crash or timeout between claim and completion (stated plainly in
   the docs); an `onComplete` that throws releases its claim at once, so a retry runs it without waiting.
4. **Hard quota.** Per owner, reserved at `/upload` by a guarded increment, moved to active bytes at `/complete`,
   released on abort, rejection, failure, expiry and deletion. Concurrent uploads cannot overshoot it.
5. **Revocation.** An ended row blocks later `/sign` and `/complete`; `/abort` never deletes a completed file;
   `api.revokeUploads({ owner })` stops a signed-out user's unfinished uploads at their next call.
6. **A sweep that cannot destroy live data.** Row-driven, bounded, keyset-paged, idempotent, safe when two run at
   once; deletes only objects whose `cloudrop-id` matches a row that never completed; never touches completed rows or
   keys without a row; reports a stuck row once.
7. **Adapters** for raw SQL executors (node-postgres, postgres.js, `node:sqlite`, Cloudflare D1), Drizzle (Postgres and
   SQLite) and Prisma 7, all over one SQL core, proven by one contract suite on real databases.

Non-goals: MySQL (no `RETURNING`; later), Prisma 8 until stable (the executor seam allows it), MongoDB, a schema
generator CLI (docs ship the schema), derivatives and domain links (the app's), bucket-driven orphan scans, cross-device
resume, an idempotency key on `/upload` (a later protocol change, see §5.7; added after M5 by M5-T100), per-file refusal
from plugin `beforeUpload` (moved to M6 with `limits()`), `bun:sqlite` as a tested target (the executor shape fits it;
no lane runs it, so it is not claimed).

## 3. Data model (`M5-T1`)

Two tables. Table names are configurable (`{ tables: { files, usage } }`, defaults `cloudrop_files`,
`cloudrop_usage`, validated `^[A-Za-z_][A-Za-z0-9_]*$` and quoted). On Postgres, `tables.schema` (validated the same
way) qualifies both everywhere the core writes SQL, `"app"."cloudrop_files"`; without it the names stand alone and the
search path finds them; on SQLite it is `INVALID_CONFIG` (amended 2026-11-17 by M5-T120 to M5-T122). Column names are
fixed snake_case (Prisma users map fields with `@map`). Postgres types shown; SQLite uses `TEXT` and `INTEGER`, times
as integer milliseconds since the epoch, with the same names.

`cloudrop_files`:

| Column | Type | Meaning |
|---|---|---|
| `id` | `text` primary key | The file id cloudrop already puts in the token and the object's `cloudrop-id` (a ULID), generated before the insert. |
| `route` | `text` not null | Route name. |
| `key` | `text` not null, indexed (not unique) | Object key. Not unique: a route with a deterministic `key` may upload the same name again after a cancel, as today; the `cloudrop-id` check protects deletes. |
| `owner` | `text` null | From the route's `owner(context)` callback, 1 to 255 characters; null when the route defines none. Not the token's `owner` field (the `authorize` JSON); code comments say so. |
| `status` | `text` not null | `pending`, `completing`, `completed`, `aborted`, `rejected`, `failed`, `expired`, `deleted`. |
| `name`, `type` | `text` not null | Normalized file name and content type as signed. |
| `size` | `bigint` not null | Size; verification makes the stored size equal to it (signed `content-length`, HEAD and part-plan checks). |
| `upload_id` | `text` null | Multipart upload id, written right after it is created. |
| `metadata` | `text` null | Validated metadata as JSON (≤ 2 KiB, the existing cap). |
| `result` | `text` null | `onComplete`'s JSON result (≤ 16 KiB; larger fails the completion like a throw). |
| `claim` | `text` null | The claim token of the `/complete` that holds `completing`. |
| `claimed_at` | `timestamptz(3)` null | When the claim was taken. |
| `expires_at` | `timestamptz(3)` not null | The token's `exp` (computed before the insert). |
| `created_at`, `updated_at` | `timestamptz(3)` not null | |
| `completed_at`, `ended_at`, `cleaned_at` | `timestamptz(3)` null | Completion; reaching a terminal non-completed state or `deleted`; the sweep's cleanup done. |
| `request_key` | `text` null | The `/upload` request's `idempotencyKey`, or null; a retry with it supersedes the row while it is `pending` (added after M5, M5-T101). |

Indexes: `(status, expires_at)`, `(status, claimed_at)`, `(status, cleaned_at, ended_at)`, `(owner, status)`, `(key)`,
`(route, request_key)`.

`cloudrop_usage`, maintained for every row with an owner (so turning `quota` on later needs no backfill):
`owner text primary key`, `reserved_bytes bigint`, `active_bytes bigint`, `files integer` (completed and not deleted),
`updated_at timestamptz(3)`, all not null, with `CHECK (… >= 0)` on the counters in Postgres (safe because §4's
`reconcile` locks before it recounts).

The docs ship, for each dialect, a Prisma model snippet (on SQLite with `BigInt` millisecond columns, since Prisma `Int`
is 32-bit and its `DateTime` encoding on SQLite differs: measured in task E), Drizzle table definitions (also exported
from `cloudrop/adapters/drizzle` as `cloudropPgTables({ tables? })` and `cloudropSqliteTables({ tables? })`, amended
2026-11-17 by M5-T47) and plain SQL DDL. Each
adapter checks the schema once, lazily, with `SELECT <every column> FROM <table> WHERE 1 = 0`, and fails with
`INVALID_CONFIG` naming the table (schema-qualified when `tables.schema` is set) and the first missing column.

## 4. The store interface (`M5-T2`)

Public, so an app can write its own. Each method is one atomic unit: a single statement on Postgres, one atomic batch
on SQLite (D1 `batch()`, `BEGIN IMMEDIATE … COMMIT` on synchronous drivers). Methods **throw** on a database failure;
every expected outcome is in the return value; the server maps any throw to a retryable `SERVER_ERROR` and logs it.
Times are passed in by the server; tests use fake timers. The lease and the grace periods are minutes, far above normal
clock skew between servers (a known cost, recorded).

```ts
type FileStatus = "pending" | "completing" | "completed" | "aborted" | "rejected" | "failed" | "expired" | "deleted";
type EndedStatus = "aborted" | "rejected" | "failed" | "expired" | "deleted";

interface NewFile { id: string; route: string; key: string; name: string; type: string; size: number;
  metadata: string | null }

interface FileRecord extends NewFile {
  owner: string | null; status: FileStatus; uploadId: string | null; result: string | null; expiresAt: Date;
  createdAt: Date; claimedAt: Date | null; completedAt: Date | null; endedAt: Date | null; cleanedAt: Date | null;
}

type ClaimOutcome =
  | { kind: "claimed" }
  | { kind: "completed"; record: FileRecord }   // replay: the stored result, no hook
  | { kind: "busy" }                            // a live claim, or the row lock timed out in transaction mode
  | { kind: "ended"; record: FileRecord }
  | { kind: "missing" };

type Transition =
  | { changed: true; record: FileRecord }           // the row after the change
  | { changed: false; record: FileRecord | null };  // the row as it is now, or none

interface CloudropStore<TTx = never> {
  /** One /upload, one owner. Atomic for the call: every outcome written, or a throw and nothing written. With a
   *  limit, each file in order is a guarded increment: reserved + active + size <= limit, else "over-quota". With a
   *  requestKey (added after M5, M5-T101), first ends as aborted the pending rows of that key, route and owner,
   *  releasing their bytes before the quota check; new rows store the key. */
  reserve(input: { owner: string | null; limit: number | null; expiresAt: Date; requestKey: string | null;
    files: readonly NewFile[] }, now: Date): Promise<readonly ("reserved" | "over-quota")[]>;
  /** pending with upload_id null or equal → true (idempotent); anything else → false. */
  attach(id: string, uploadId: string, now: Date): Promise<boolean>;
  get(id: string): Promise<FileRecord | null>;
  /** pending, or completing with claimed_at older than the lease → completing with this claim. */
  claim(id: string, claim: string, now: Date, leaseMs: number): Promise<ClaimOutcome>;
  /** completing with this claim → pending; usage untouched. Called when onComplete threw in-process. */
  release(id: string, claim: string, now: Date): Promise<boolean>;
  /** completing with this claim → completed with the result; reserved -= size, active += size, files += 1. */
  complete(id: string, claim: string, result: string | null, now: Date): Promise<Transition>;
  /** One status to one ended status. From pending or completing releases reserved bytes; from completed (to deleted)
   *  releases active bytes and files -= 1. `cleaned: true` also sets cleaned_at in the same unit. */
  end(id: string, from: FileStatus, to: EndedStatus, now: Date, options?: { cleaned?: boolean }): Promise<Transition>;
  /** pending → aborted for one owner, releasing their reservations; returns the rows changed. */
  revoke(owner: string, now: Date): Promise<number>;
  /** Sweep work, keyset-paged with an opaque cursor. "expire": pending with expires_at < before, and completing with
   *  expires_at < before and claimed_at < claimedBefore. "cleanup": aborted|rejected|failed|expired|deleted with
   *  cleaned_at null and ended_at < before. */
  stale(input: { kind: "expire" | "cleanup"; before: Date; claimedBefore: Date; limit: number;
    cursor: string | null }): Promise<{ records: FileRecord[]; cursor: string | null }>;
  cleaned(id: string, now: Date): Promise<void>;
  usage(owner: string): Promise<{ reservedBytes: number; activeBytes: number; files: number }>;
  /** Locks the owner's usage row, then recounts from rows; true when it changed anything. */
  reconcile(owner: string): Promise<boolean>;
  owners(cursor: string | null, limit: number): Promise<{ owners: string[]; cursor: string | null }>;
  /** Only adapters that can hold an interactive transaction (Postgres). */
  transaction?<T>(run: (tx: TTx, store: Omit<CloudropStore<TTx>, "transaction">) => Promise<T>): Promise<T>;
}
```

`src/testing/memory-store.ts` implements it with the same semantics, including a `transaction` that snapshots and
restores its maps on a throw and passes a recording `tx`, so the handler's transactional path runs in the unit lane.

## 5. Server behaviour with a store (`M5-T3` to `M5-T9`)

Every rule here applies only when `store` is configured; the stateless path is untouched and its tests pass unchanged.

### 5.1 Configuration (`M5-T3`)
- `createCloudrop({ store, quota?, completionLeaseMs? })`. `quota: (owner) => Awaitable<number | null>`, bytes per owner
  (null: unlimited), resolved once per `/upload` before `reserve`; a throw refuses the files with a retryable
  `SERVER_ERROR` (fail closed). `completionLeaseMs` defaults to 5 minutes and must exceed the slowest `onComplete`.
- New route callbacks (callbacks argument, typed from `authorize`): `owner(context) => Awaitable<string | null>`
  (1 to 255 characters, `TypeError` otherwise, like `prefix`) and `afterComplete(context)`. Both without a store, or
  `quota` without a store: `INVALID_CONFIG`. `quota` set while some route has no `owner`: a warning naming the routes.
- The token payload gains `stored: true`. A token without it (issued before the store was enabled, or by an instance of
  a rolling deploy that has none) takes the stateless path until it expires; a token with it whose row is missing is
  refused as revoked. Turning the store off makes stored tokens stateless. Documented.

### 5.2 `/upload` (`M5-T4`)
After `authorize`, metadata, the per-file policy and `beforeUpload`, with `exp` computed first: resolve `owner` and the
quota limit, then `store.reserve` for the accepted files, with the request's `idempotencyKey` as `requestKey` (null when
the client sent none or the owner is null; added after M5, M5-T101, M5-T105). `over-quota` files get the new per-file
`QUOTA_EXCEEDED` (below) and plugins that accepted them get `onAbort("rejected")`; a throw refuses every file of the
call with a retryable `SERVER_ERROR` and nothing is signed. Then signing as today. After `createMultipart`,
`store.attach`: false or a throw → `abortMultipart`, `end(id, "pending", "failed")` (best effort), and a rejected ticket
(`UPLOAD_EXPIRED` when the row was revoked, retryable `SERVER_ERROR` otherwise). A crash between `createMultipart` and
`attach` issues no ticket; the bucket's abort-incomplete lifecycle rule is the stated backstop, and `checkBucket`
reports that rule as required when a store is configured. A file that fails to start: `end(id, "pending", "failed")`.

### 5.3 `QUOTA_EXCEEDED` (`M5-T5`)
New error code, HTTP 403, not retryable, per file, message: the storage limit is reached; delete files or ask for more
space. Added to the protocol, `http.ts`'s status table, the client's codes and the docs. Older clients pass it through
as non-retryable.

### 5.4 `/sign` (`M5-T6`)
After the token verifies (never before), `store.get`; anything but `pending` is refused with `UPLOAD_EXPIRED` and its
own message ("This upload was cancelled or has expired. Start it again."), as is a missing row whose token says
`stored`. The client treats `UPLOAD_EXPIRED` as needing a new ticket, so `retry()` goes back through `/upload` and
`authorize` (a signed-out user is refused; a resumed upload restarts automatically while the user is still signed in).

### 5.5 `/complete` (`M5-T7`)
Order, with a store:
1. Verify the token, allowing an expired one only for the replay in step 2.
2. `store.get`: `completed` → answer the stored `result` and file, no storage call, no hook (also after `exp`);
   `ended` or missing → `UPLOAD_EXPIRED`; `completing` with a live claim → `busy`; past `exp` and not completed →
   `UPLOAD_EXPIRED`; `pending` → go on.
3. Storage verification and `afterVerify`, outside any transaction (no network I/O inside one).
4. A refusal (verification or `afterVerify`): `end(id, "pending", "rejected")` first; only when it changed, delete the
   object (`discard`) and run `onAbort`. Unchanged: `completing` → `busy`, `completed` → replay.
5. With `store.transaction` (Postgres): one transaction with `SET LOCAL lock_timeout` (2 s) runs `claim` →
   `onComplete({ …, tx })` → `complete`; a lock timeout is `busy`; a throw rolls back (the row stays `pending`) and
   answers the existing retryable error.
   Without: `claim` (lease `completionLeaseMs`) → `onComplete` → `complete`; a throw (or an oversized or non-JSON
   result) → `release` and the retryable error, so a retry runs it at once.
6. `complete` unchanged (the claim was lost after the lease and another request took it): read the row; `completed` →
   replay, otherwise retryable `SERVER_ERROR`.
7. After the commit: `afterComplete(context)`, best effort and at most once (a crash right after the commit skips it;
   a throw is logged and the answer is still success). For guaranteed follow-up work, write an outbox row through `tx`
   in `onComplete`. `onComplete` must not call storage or other network services inside a transaction; they belong in
   `afterComplete`, and writes through the global client instead of `tx` escape the guarantee. Documented.
- `busy` stays `SERVER_ERROR`, retryable (the only retryable server code that keeps the client from sending `/abort`
  for a file that may be complete, M3-H16), with its own message and `Retry-After: 2`, and is not logged as an error.
- The typed `tx`: B adds a fourth type parameter to `RouteCallbacks` (`TExtra extends object = {}`, merged into
  `onComplete`'s context; `tx` becomes a reserved name) and an internal `routeFor(brand)` that returns `route()` with
  the route definition branded. Adapters built with `transaction: true` expose `store.route`, typed with their `tx`;
  `createCloudrop` throws `INVALID_CONFIG` when a branded route is given a different store or none. Routes from plain
  `route()` work with any store.

### 5.6 `/abort` (`M5-T8`)
`end(id, "pending", "aborted")` first. Changed, or already `aborted`/`rejected`/`failed`/`expired`: the existing
abort-and-delete runs (the multipart abort and the `cloudrop-id`-checked delete), idempotently, also for an expired
stored token since the row decides. `completed` or `completing`: `ok`, nothing deleted, no `onAbort` (closes the
24-hour delete capability of M2-X1 and M2-D20 for store users). Missing with `stored`: `ok`, nothing to do.

### 5.7 Owner and quota (`M5-T9`)
Usage counts rows with an owner. Quota rule: `reserved_bytes + active_bytes + size <= limit`. `api.usage(owner)` works
with or without `quota`. A lost `/upload` answer (the client's 30 s deadline, a dropped connection, then a retry) no
longer holds its reservation (amended after M5, M5-T100 to M5-T104): each ask carries an `idempotencyKey`, and the
retry's `reserve` ends the lost attempt's `pending` rows as `aborted` and releases their bytes before its own quota
check, for rows with an owner only (owner-less rows hold no quota; M5-T105). The lost attempt's multipart upload is
aborted by the sweep's cleanup pass (M5-T64). What remains: a retry without a key (an app's own client) holds the old
reservation until the sweep expires it (`expires_at` + grace) or `revokeUploads` releases it; a retry refused by
`beforeUpload` reaches no `reserve` and supersedes nothing; an attempt whose `reserve` commits after its retry's (a
first request still running when the client gave up on it) is not superseded either; an ask whose every attempt lost its
answer leaves its last attempt's rows holding their bytes until the sweep, since `retry()` and `resume()` ask again with
a new key. The sweep, `revoke` and superseding run no `onAbort` (rows carry no auth JSON),
so plugin reservations still need their own expiry (base spec §8).

## 6. File API with a store (`M5-T10`)

With a store only (without one each resolves `INVALID_CONFIG`):
- `file(id)`, `usage(owner)`, `revokeUploads({ owner })`.
- `deleteFile(id)`: `end(id, "completed", "deleted")`, then delete the object by the stored key and `cleaned`;
  idempotent (a crash between the two leaves a `deleted` row the cleanup pass finishes).
- `reconcile({ owner? })`: one owner, or every owner paged through `owners()`.
- `sweep({ limit = 100, cursor?, graceMs = 1 h })`, two passes, each keyset-paged. `graceMs` is at least 15 minutes,
  the life of an upload URL, so no new PUT can start once a row may be cleaned up; a smaller one is `INVALID_INPUT`. A
  PUT already under way that lands after its row was cleaned is left in the bucket, a known cost: the cleanup pass does
  not return cleaned rows (amended 2026-11-17, M5-T64):
  - **expire:** `pending` rows with `expires_at < now − graceMs` → `end(id, "pending", "expired")` first; only when
    that changed the row, abort the multipart upload when `upload_id` is set (otherwise the lifecycle rule), HEAD the
    key and delete the object only when its `cloudrop-id` equals the row id, then `cleaned`. Taking the row first means
    a `/complete` that claims it in between keeps its object; a crash after the `end` leaves an `expired` row without
    `cleaned_at`, which the cleanup pass finishes. (Amended 2026-11-17, M5-T64: the first draft deleted before the
    `end`, which could delete a completed file.) `completing` rows with a dead token and an expired lease →
    `end(id, "completing", "failed", { cleaned: true })`: the object is kept (its `onComplete` may have recorded it), the
    reservation released, and the row reported once. Live-token `completing` rows are left alone.
  - **cleanup:** `aborted | rejected | failed | expired | deleted` with `cleaned_at` null and
    `ended_at < now − graceMs` → the same abort, HEAD and delete steps, then `cleaned`. This removes late
    objects (a PUT that lands after an `/abort`'s HEAD or a revoke, a crash inside `deleteFile` or the expire pass).
  - A row that fails (storage or database) is logged and counted, and stays as it was for the next sweep; the rows
    after it are still swept. A listing that fails answers the store's error when no row was handled yet, otherwise
    the report so far with the listing counted in `failed` and a null cursor (amended 2026-11-17, M5-T65).
  - Returns `{ expired, cleaned, failed, reported, cursor }`; bounded per call so a Workers cron can run it;
    scheduling is the app's.

## 7. Adapters (`M5-T11` to `M5-T14`)

- **SQL core (`M5-T11`).** Internal, in its own shared chunk; builds every statement of §4 for Postgres (single
  statements with data-modifying CTEs and `RETURNING`, explicit casts `$n::bigint`, `$n::timestamptz`) and SQLite
  (atomic batches whose statements each check their own condition; no reliance on the previous statement's row count;
  times passed as numbers). One decoder `toSafeInteger` accepts number, numeric string, bigint or a decimal-like object
  and throws on non-integers or values over 2^53; times decode from `Date`, ISO string or milliseconds. Executor:
  ```ts
  interface SqlExecutor {
    dialect: "postgres" | "sqlite";
    query(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
    /** In order and atomic; need not be interactive. */
    batch(statements: readonly { sql: string; params: readonly unknown[] }[]): Promise<Record<string, unknown>[][]>;
    transaction?<T>(run: (executor: Omit<SqlExecutor, "transaction">, tx: unknown) => Promise<T>): Promise<T>;
  }
  ```
- **`cloudrop/adapters/sql` (`M5-T12`).** `sqlStore(executor, { tables?, transaction? })` plus shipped, structurally
  typed executor factories (code, not doc snippets): `pgExecutor(pool)` (node-postgres, with transactions),
  `postgresJsExecutor(sql)` (with transactions), `sqliteExecutor(db)` (`node:sqlite`, batch through `BEGIN IMMEDIATE`),
  `d1Executor(d1)` (batch through `db.batch()`, no transactions). (Amended 2026-11-17, M5-T92: the store uses the
  executor's transaction only with `transaction: true`, as the ORM adapters do; every transactional store is a
  `TransactionalStore<TTx>` from `cloudrop`, M5-T93.)
- **`cloudrop/adapters/drizzle` (`M5-T13`).** `drizzleStore(db, { dialect, tables?, transaction? })` over the core using
  Drizzle's raw `sql` execution, normalising each driver's result shape (`{ rows }` for node-postgres, an array for
  postgres.js, `.all()` for SQLite); `transaction: true` (Postgres only, `INVALID_CONFIG` on SQLite) wraps
  `db.transaction` and passes Drizzle's `tx`; `cloudropPgTables()` and `cloudropSqliteTables()` exported (M5-T47).
  SQLite batches run in a synchronous driver's immediate transaction (better-sqlite3) or through `db.batch` (libsql,
  D1; M5-T46). `drizzle-orm` optional peer, `>=0.45.0 <1 || >=1.0.0-rc.5 <2` (M5-T51).
- **`cloudrop/adapters/prisma` (`M5-T14`).** `prismaStore(prisma, { dialect, tables?, transaction?, transactionOptions? })`
  over the core using `$queryRawUnsafe` and `$transaction([...])` for batches (structurally typed client, no import of
  `@prisma/client`); `transaction: true` (Postgres only) wraps `prisma.$transaction(async tx => …, transactionOptions)`
  (Prisma's default 5 s timeout documented). Prisma 7.
- Packaging follows `cloudrop/react`: subpath exports, optional peers, the biome fence (the core never imports an
  adapter), own size budgets under the M4-F24 rule. Task C scaffolds all three subpaths so D and E touch only their own
  files.

## 8. Tests and lanes (`M5-T15`)

- **Store contract suite** `src/testing/store-contract.ts` (+ case files), against the memory store in the unit lane and
  every adapter and executor in `test:db`, reading results back through the raw reader: reserve (order, quota exact to
  the byte, atomic on a mid-call failure, owner null), attach (idempotent, refused after revoke), claim (exactly one of
  N concurrent claims wins — proven on a Postgres pool of ≥ 8 connections; on single-connection SQLite the row is
  stated, not counted as proof), lease expiry, release, a lost claim cannot complete, complete/end usage arithmetic,
  replay, revoke, both `stale` kinds paging and limits, cleaned, reconcile repairs drift and does not lose a concurrent
  reserve, owners paging, table-name mapping, the schema-check message, transaction rollback. Declared gaps (`transaction`
  on SQLite and D1) skip with a reason, as the storage contract does.
- **Server tests** on the fake R2 with the memory store for every rule in §5 and §6: overlapping completions run one
  `onComplete` (M4-F12), a refusal racing a completion deletes nothing (§5.5 step 4), release after a throw, replay with
  no storage call and after `exp`, replay after `deleteFile`, abort after completion deletes nothing, revoke racing
  `/upload`, attach refused after revoke, quota refusal per file, sweep idempotency, two sweeps at once, a sweep racing a
  `/complete`, a late PUT after revoke cleaned up, completed rows and foreign keys never touched.
- **Handler on a real database** (`test:db`): fake R2 with Postgres through Drizzle and Prisma with
  `transaction: true`: an app row written through `tx` is absent after a throw; concurrent completions run one
  `onComplete`.
- **`bun run test:db`**: Postgres 18 in Docker (label `cloudrop.test`, port `19500`, `CLOUDROP_POSTGRES_PORT`) and SQLite
  via `node:sqlite`; fails, never skips, without Docker. D1 runs the contract in the Wrangler lane. (Amended
  2026-11-17, M5-T84, M5-T85: through Wrangler's `getPlatformProxy`, for `sqlStore(d1Executor(env.DB))` and
  `drizzleStore(drizzle(env.DB))`, gaps `transaction` and `failureInjection`.)
- **Chaos lane:** rows with a store: faults on `/complete` and overlapping retries still run `onComplete` once and leave
  usage exact. (Amended 2026-11-17, M5-T86: `sqlStore` over in-memory `node:sqlite`; also a revoke mid-upload and the
  sweep after closed tabs.)
- **Example:** `examples/next` gains an opt-in store through `cloudrop/adapters/sql` and `node:sqlite` (no native build),
  showing `owner`, `quota` and `afterComplete`; a browser row proves a reload-and-resume completes once. (Amended
  2026-11-17, M5-T87: the browser lanes run a second Playwright pass with the store on; a second row proves the quota
  refusal.)

## 9. Work breakdown

| Task | Owns | Depends on |
|---|---|---|
| C0. `test:db` lane, fixtures, raw reader, dev dependencies | `scripts/test-db.sh`, `src/testing/db/**`, vitest project, CI job | none (running) |
| A. Interface types, memory store (with transaction), contract suite, `QUOTA_EXCEEDED` (incl. `http.ts` status table) | `src/server/store.ts`, `src/testing/memory-store.ts`, `src/testing/store-contract*`, `src/errors.ts`, protocol codes, `src/server/http.ts` (status row only) | none |
| B. Server integration (§5, §6), `RouteCallbacks<…, TExtra>`, `routeFor` | `src/server/**` | A |
| C. SQL core, `cloudrop/adapters/sql` with executors, scaffolding of all three adapter subpaths | `src/store/sql/**`, `src/adapters/sql*`, package exports, peers, build entries, size entries, biome fence | A, C0 |
| D. Drizzle adapter | `src/adapters/drizzle*` and its tests | B, C |
| E. Prisma adapter | `src/adapters/prisma*` and its tests | B, C |
| F. D1 in the Wrangler lane, chaos rows, handler-on-database rows, example, guides (`docs/guide/store.md`), README, base-spec "1.1" wording (§4, §5.2, §5.5, §8, `route.ts` TSDoc) | lanes, example, docs | B, D, E |

B and C run in parallel after A; D and E in parallel after B and C. Every task: TDD, code-quality review, decision
entries, `bun run verify`; B adds `test:chaos`; C–E add `test:db`; F runs every lane. The branch closes with a
whole-branch review, fast-forward to `main` and a push.
