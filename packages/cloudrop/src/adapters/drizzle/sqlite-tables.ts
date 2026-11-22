// The store's tables as Drizzle `sqlite-core` tables (spec M5 §3): sizes and counters as integers read as numbers,
// times as integer milliseconds read as Dates. The types are spelled out from what drizzle-orm 0.45 and 1.0 both export,
// as on Postgres (postgres-tables.ts).

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { FileRecordStatus } from "../../server/store.ts";
import { type StoreTables, tableNames } from "../../store/sql/tables.ts";

// drizzle-orm 0.45 and 1.0 share no builder type names, and `text`'s overload that takes a name erases to `any` on both,
// so each builder type comes from an overload both lines have. `text`'s third type argument is the length in 0.45 and
// the mode in 1.0; `never` satisfies both and selects the plain text builder. An integer's mode defaults to a number.
type Text = ReturnType<typeof text<string, [string, ...string[]], never>>;
type Time = ReturnType<typeof integer<"timestamp_ms">>;
type Count = NotNull<ReturnType<typeof integer>>;
type NotNull<TColumn extends { notNull(): unknown }> = ReturnType<TColumn["notNull"]>;
type PrimaryKey<TColumn extends { primaryKey(): unknown }> = ReturnType<TColumn["primaryKey"]>;
// A type-only stand-in for a text column, so `$type`, a generic method, can be instantiated with the status type.
declare const textStandIn: Text;
type Status = NotNull<ReturnType<typeof textStandIn.$type<FileRecordStatus>>>;

type FileColumns = {
  id: PrimaryKey<Text>;
  route: NotNull<Text>;
  key: NotNull<Text>;
  owner: Text;
  status: Status;
  name: NotNull<Text>;
  type: NotNull<Text>;
  size: Count;
  uploadId: Text;
  metadata: Text;
  result: Text;
  claim: Text;
  claimedAt: Time;
  expiresAt: NotNull<Time>;
  createdAt: NotNull<Time>;
  updatedAt: NotNull<Time>;
  completedAt: Time;
  endedAt: Time;
  cleanedAt: Time;
  requestKey: Text;
};

type UsageColumns = {
  owner: PrimaryKey<Text>;
  reservedBytes: Count;
  activeBytes: Count;
  files: Count;
  updatedAt: NotNull<Time>;
  eraseRequestedAt: Time;
  erasedAt: Time;
};

/** `cloudropSqliteTables()`: the files and usage tables as Drizzle `sqlite-core` tables. */
export interface CloudropSqliteTables {
  files: ReturnType<typeof sqliteTable<string, FileColumns>>;
  usage: ReturnType<typeof sqliteTable<string, UsageColumns>>;
}

// The overloads above are the ones without a column name, which 0.45 types as `""` (and then names after the property)
// and 1.0 does not type at all. The builders below take the real SQL name, so on 0.45 their types differ from those
// overloads in the name and the text length only: cast here, and pinned by the row-type tests and the catalogue test.
const textColumn = (name: string) => text(name) as unknown as Text;
const time = (name: string) => integer(name, { mode: "timestamp_ms" }) as unknown as Time;
const count = (name: string) => integer(name, { mode: "number" }).notNull();

/**
 * The store's tables as Drizzle `sqlite-core` tables, for an app's schema and migrations (drizzle-kit picks them up from
 * the schema file that exports them) and for typed reads: `db.select().from(files)`. Write to them only through the
 * store, which keeps `usage` in step with `files`.
 *
 * ```ts
 * export const { files: cloudropFiles, usage: cloudropUsage } = cloudropSqliteTables();
 * ```
 */
export function cloudropSqliteTables(options: { tables?: Omit<StoreTables, "schema"> } = {}): CloudropSqliteTables {
  const names = tableNames(options.tables, "sqlite");
  const files = sqliteTable(
    names.files,
    {
      id: textColumn("id").primaryKey(),
      route: textColumn("route").notNull(),
      key: textColumn("key").notNull(),
      /** From the route's `owner` callback; not the token's `owner` (what `authorize` returned). */
      owner: textColumn("owner"),
      status: textColumn("status").$type<FileRecordStatus>().notNull(),
      name: textColumn("name").notNull(),
      type: textColumn("type").notNull(),
      size: count("size"),
      uploadId: textColumn("upload_id"),
      metadata: textColumn("metadata"),
      result: textColumn("result"),
      claim: textColumn("claim"),
      claimedAt: time("claimed_at"),
      expiresAt: time("expires_at").notNull(),
      createdAt: time("created_at").notNull(),
      updatedAt: time("updated_at").notNull(),
      completedAt: time("completed_at"),
      endedAt: time("ended_at"),
      cleanedAt: time("cleaned_at"),
      /** The idempotency key of the `/upload` that wrote the row: a retry with it supersedes the row while pending. */
      requestKey: textColumn("request_key"),
    },
    (t) => [
      index(`${names.files}_status_expires_at_idx`).on(t.status, t.expiresAt),
      index(`${names.files}_status_claimed_at_idx`).on(t.status, t.claimedAt),
      index(`${names.files}_status_cleaned_at_ended_at_idx`).on(t.status, t.cleanedAt, t.endedAt),
      index(`${names.files}_owner_status_created_at_idx`).on(t.owner, t.status, t.createdAt),
      index(`${names.files}_created_at_idx`).on(t.createdAt),
      index(`${names.files}_key_idx`).on(t.key),
      index(`${names.files}_route_request_key_idx`).on(t.route, t.requestKey),
    ],
  );
  const usage = sqliteTable(
    names.usage,
    {
      owner: textColumn("owner").primaryKey(),
      reservedBytes: count("reserved_bytes"),
      activeBytes: count("active_bytes"),
      files: count("files"),
      updatedAt: time("updated_at").notNull(),
      /** The owner's erase mark (M12-O1): when `eraseOwner` first asked, and when the erasure finished. */
      eraseRequestedAt: time("erase_requested_at"),
      erasedAt: time("erased_at"),
    },
    // The sweep's erase pass reads only the owners whose erasure is unfinished.
    (t) => [
      index(`${names.usage}_erasing_idx`)
        .on(t.owner)
        .where(sql`${t.eraseRequestedAt} IS NOT NULL AND ${t.erasedAt} IS NULL`),
    ],
  );
  return { files, usage };
}
