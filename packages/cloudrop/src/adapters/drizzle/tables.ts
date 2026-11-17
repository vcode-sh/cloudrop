// What `cloudropPgTables` and `cloudropSqliteTables` share: their options and the table names. Each lives in its own
// module, importing only its dialect's Drizzle core, so an app's schema file pulls in one of them.

import { quoteTables, type StoreTables } from "../../store/sql/tables.ts";

/** The tables' names, defaults `cloudrop_files` and `cloudrop_usage`: pass the same `tables` as to `drizzleStore`. */
export interface CloudropTablesOptions {
  tables?: StoreTables;
}

/** Both names, validated as the store validates them. */
export const tableNames = (options: CloudropTablesOptions): Required<StoreTables> => quoteTables(options.tables).names;
