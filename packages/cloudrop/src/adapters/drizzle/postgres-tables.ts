// The store's tables as Drizzle `pg-core` tables (spec M5 §3). The column types are spelled out because the package
// emits declarations without inference (isolatedDeclarations); the compiler checks the builders below against them,
// and drizzle.test.ts pins the row types they give.
import {
  type $Type,
  type BuildColumns,
  type ColumnBuilderBase,
  type IsPrimaryKey,
  type NotNull,
  sql,
} from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  type PgBigInt53BuilderInitial,
  type PgIntegerBuilderInitial,
  type PgTableWithColumns,
  type PgTextBuilderInitial,
  type PgTimestampBuilderInitial,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { FileStatus } from "../../server/store.ts";
import type { StoreTables } from "../../store/sql/tables.ts";

type Text<TName extends string> = PgTextBuilderInitial<TName, [string, ...string[]]>;
type Count<TName extends string> = NotNull<PgBigInt53BuilderInitial<TName>>;
type Time<TName extends string> = PgTimestampBuilderInitial<TName>;

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
  files: NotNull<PgIntegerBuilderInitial<"files">>;
  updatedAt: NotNull<Time<"updated_at">>;
};

type Table<TColumns extends Record<string, ColumnBuilderBase>> = PgTableWithColumns<{
  name: string;
  schema: undefined;
  columns: BuildColumns<string, TColumns, "pg">;
  dialect: "pg";
}>;

/** `cloudropTables({ dialect: "postgres" })`: the files and usage tables as Drizzle `pg-core` tables. */
export interface CloudropPostgresTables {
  files: Table<FileColumns>;
  usage: Table<UsageColumns>;
}

const time = <TName extends string>(name: TName) => timestamp(name, { withTimezone: true, mode: "date" });
const count = <TName extends string>(name: TName) => bigint(name, { mode: "number" }).notNull();

export function postgresTables(names: Required<StoreTables>): CloudropPostgresTables {
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
    },
    (t) => [
      index(`${names.files}_status_expires_at_idx`).on(t.status, t.expiresAt),
      index(`${names.files}_status_claimed_at_idx`).on(t.status, t.claimedAt),
      index(`${names.files}_status_cleaned_at_ended_at_idx`).on(t.status, t.cleanedAt, t.endedAt),
      index(`${names.files}_owner_status_idx`).on(t.owner, t.status),
      index(`${names.files}_key_idx`).on(t.key),
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
