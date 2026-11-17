// The store's tables as Drizzle `pg-core` tables (spec M5 §3). The package emits declarations without inference
// (isolatedDeclarations), so the table types are spelled out, but only through what drizzle-orm 0.45 and 1.0 both
// export: the builder functions' return types, their `this`-typed methods and `pgTable`'s own signature. The names of
// the builder types differ between the two lines and are never written here. The compiler checks the builders below
// against these types, and drizzle.test.ts pins the row types they give on both lines.

import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { FileStatus } from "../../server/store.ts";
import { type CloudropTablesOptions, tableNames } from "./tables.ts";

// Each builder function's last overload names the column; `timestamp`'s mode defaults to Dates, and `bigint`'s answer
// is a union by mode, of which the number one is taken.
type Text = ReturnType<typeof text>;
type Time = ReturnType<typeof timestamp>;
type NotNull<TColumn extends { notNull(): unknown }> = ReturnType<TColumn["notNull"]>;
type PrimaryKey<TColumn extends { primaryKey(): unknown }> = ReturnType<TColumn["primaryKey"]>;
type Count = NotNull<Extract<ReturnType<typeof bigint>, { _: { data: number } }>>;
// A type-only stand-in for a text column, so `$type`, a generic method, can be instantiated with the status type.
declare const textStandIn: Text;
type Status = NotNull<ReturnType<typeof textStandIn.$type<FileStatus>>>;

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
  files: NotNull<ReturnType<typeof integer>>;
  updatedAt: NotNull<Time>;
};

/** `cloudropPgTables()`: the files and usage tables as Drizzle `pg-core` tables. */
export interface CloudropPgTables {
  files: ReturnType<typeof pgTable<string, FileColumns>>;
  usage: ReturnType<typeof pgTable<string, UsageColumns>>;
}

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const count = (name: string) => bigint(name, { mode: "number" }).notNull();

/**
 * The store's tables as Drizzle `pg-core` tables, for an app's schema and migrations (drizzle-kit picks them up from
 * the schema file that exports them) and for typed reads: `db.select().from(files)`. Write to them only through the
 * store, which keeps `usage` in step with `files`.
 *
 * ```ts
 * export const { files: cloudropFiles, usage: cloudropUsage } = cloudropPgTables();
 * ```
 */
export function cloudropPgTables(options: CloudropTablesOptions = {}): CloudropPgTables {
  const names = tableNames(options);
  const files = pgTable(
    names.files,
    {
      id: text("id").primaryKey(),
      route: text("route").notNull(),
      key: text("key").notNull(),
      /** From the route's `owner` callback; not the token's `owner` (what `authorize` returned). */
      owner: text("owner"),
      status: text("status").$type<FileStatus>().notNull(),
      name: text("name").notNull(),
      type: text("type").notNull(),
      size: count("size"),
      uploadId: text("upload_id"),
      metadata: text("metadata"),
      result: text("result"),
      claim: text("claim"),
      claimedAt: time("claimed_at"),
      expiresAt: time("expires_at").notNull(),
      createdAt: time("created_at").notNull(),
      updatedAt: time("updated_at").notNull(),
      completedAt: time("completed_at"),
      endedAt: time("ended_at"),
      cleanedAt: time("cleaned_at"),
      /** The idempotency key of the `/upload` that wrote the row: a retry with it supersedes the row while pending. */
      requestKey: text("request_key"),
    },
    (t) => [
      index(`${names.files}_status_expires_at_idx`).on(t.status, t.expiresAt),
      index(`${names.files}_status_claimed_at_idx`).on(t.status, t.claimedAt),
      index(`${names.files}_status_cleaned_at_ended_at_idx`).on(t.status, t.cleanedAt, t.endedAt),
      index(`${names.files}_owner_status_idx`).on(t.owner, t.status),
      index(`${names.files}_key_idx`).on(t.key),
      index(`${names.files}_route_request_key_idx`).on(t.route, t.requestKey),
    ],
  );
  const usage = pgTable(
    names.usage,
    {
      owner: text("owner").primaryKey(),
      reservedBytes: count("reserved_bytes"),
      activeBytes: count("active_bytes"),
      files: integer("files").notNull(),
      updatedAt: time("updated_at").notNull(),
    },
    // Named as Postgres names an unnamed column CHECK, so the plain DDL and these tables agree.
    (t) => [
      check(`${names.usage}_reserved_bytes_check`, sql`${t.reservedBytes} >= 0`),
      check(`${names.usage}_active_bytes_check`, sql`${t.activeBytes} >= 0`),
      check(`${names.usage}_files_check`, sql`${t.files} >= 0`),
    ],
  );
  return { files, usage };
}
