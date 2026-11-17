// The store's tables as Drizzle `sqlite-core` tables (spec M5 §3): sizes and counters as integers read as numbers,
// times as integer milliseconds read as Dates. The column types are spelled out for the same reason as on Postgres
// (postgres-tables.ts).

import type { $Type, BuildColumns, ColumnBuilderBase, IsPrimaryKey, NotNull } from "drizzle-orm";
import {
  index,
  integer,
  type SQLiteIntegerBuilderInitial,
  type SQLiteTableWithColumns,
  type SQLiteTextBuilderInitial,
  type SQLiteTimestampBuilderInitial,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { FileStatus } from "../../server/store.ts";
import type { StoreTables } from "../../store/sql/tables.ts";

type Text<TName extends string> = SQLiteTextBuilderInitial<TName, [string, ...string[]], number | undefined>;
type Count<TName extends string> = NotNull<SQLiteIntegerBuilderInitial<TName>>;
type Time<TName extends string> = SQLiteTimestampBuilderInitial<TName>;

type FileColumns = {
  id: IsPrimaryKey<NotNull<Text<"id">>>;
  route: NotNull<Text<"route">>;
  key: NotNull<Text<"key">>;
  owner: Text<"owner">;
  status: NotNull<$Type<Text<"status">, FileStatus>>;
  name: NotNull<Text<"name">>;
  type: NotNull<Text<"type">>;
  size: Count<"size">;
  uploadId: Text<"upload_id">;
  metadata: Text<"metadata">;
  result: Text<"result">;
  claim: Text<"claim">;
  claimedAt: Time<"claimed_at">;
  expiresAt: NotNull<Time<"expires_at">>;
  createdAt: NotNull<Time<"created_at">>;
  updatedAt: NotNull<Time<"updated_at">>;
  completedAt: Time<"completed_at">;
  endedAt: Time<"ended_at">;
  cleanedAt: Time<"cleaned_at">;
};

type UsageColumns = {
  owner: IsPrimaryKey<NotNull<Text<"owner">>>;
  reservedBytes: Count<"reserved_bytes">;
  activeBytes: Count<"active_bytes">;
  files: Count<"files">;
  updatedAt: NotNull<Time<"updated_at">>;
};

type Table<TColumns extends Record<string, ColumnBuilderBase>> = SQLiteTableWithColumns<{
  name: string;
  schema: undefined;
  columns: BuildColumns<string, TColumns, "sqlite">;
  dialect: "sqlite";
}>;

/** `cloudropTables({ dialect: "sqlite" })`: the files and usage tables as Drizzle `sqlite-core` tables. */
export interface CloudropSqliteTables {
  files: Table<FileColumns>;
  usage: Table<UsageColumns>;
}

const time = <TName extends string>(name: TName) => integer(name, { mode: "timestamp_ms" });
const count = <TName extends string>(name: TName) => integer(name, { mode: "number" }).notNull();

export function sqliteTables(names: Required<StoreTables>): CloudropSqliteTables {
  const files = sqliteTable(
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
    },
    (t) => [
      index(`${names.files}_status_expires_at_idx`).on(t.status, t.expiresAt),
      index(`${names.files}_status_claimed_at_idx`).on(t.status, t.claimedAt),
      index(`${names.files}_status_cleaned_at_ended_at_idx`).on(t.status, t.cleanedAt, t.endedAt),
      index(`${names.files}_owner_status_idx`).on(t.owner, t.status),
      index(`${names.files}_key_idx`).on(t.key),
    ],
  );
  const usage = sqliteTable(names.usage, {
    owner: text("owner").primaryKey(),
    reservedBytes: count("reserved_bytes"),
    activeBytes: count("active_bytes"),
    files: count("files"),
    updatedAt: time("updated_at").notNull(),
  });
  return { files, usage };
}
