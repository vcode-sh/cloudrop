// `cloudropTables`: the store's tables as Drizzle tables for either dialect. Column, index and constraint names match
// the plain DDL exactly (index `<table>_<columns>_idx`, Postgres CHECK `<table>_<column>_check`);
// drizzle.db.integration.test.ts compares both with tables made from that DDL.

import { configError } from "../../errors.ts";
import { quoteTables, type StoreTables } from "../../store/sql/tables.ts";
import { type CloudropPostgresTables, postgresTables } from "./postgres-tables.ts";
import { type CloudropSqliteTables, sqliteTables } from "./sqlite-tables.ts";

export type { CloudropPostgresTables } from "./postgres-tables.ts";
export type { CloudropSqliteTables } from "./sqlite-tables.ts";

/** Which dialect's tables, and their names: the same options as `drizzleStore`'s. */
export interface CloudropTablesOptions {
  dialect: "postgres" | "sqlite";
  /** Defaults `cloudrop_files` and `cloudrop_usage`. */
  tables?: StoreTables;
}

/**
 * The store's tables as Drizzle tables, for an app's schema and migrations (drizzle-kit picks them up from the schema
 * file that exports them) and for typed reads: `db.select().from(files)`. Pass the same `tables` as to `drizzleStore`.
 * Write to them only through the store, which keeps `usage` in step with `files`.
 *
 * ```ts
 * export const { files: cloudropFiles, usage: cloudropUsage } = cloudropTables({ dialect: "postgres" });
 * ```
 */
export function cloudropTables(options: { dialect: "postgres"; tables?: StoreTables }): CloudropPostgresTables;
export function cloudropTables(options: { dialect: "sqlite"; tables?: StoreTables }): CloudropSqliteTables;
export function cloudropTables({
  dialect,
  tables,
}: CloudropTablesOptions): CloudropPostgresTables | CloudropSqliteTables {
  const { names } = quoteTables(tables);
  if (dialect === "postgres") return postgresTables(names);
  if (dialect === "sqlite") return sqliteTables(names);
  throw configError(`cloudropTables' dialect ${JSON.stringify(dialect)} is not supported. Use "postgres" or "sqlite".`);
}
