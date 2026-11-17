// What `cloudropPgTables` and `cloudropSqliteTables` share: their options. Each lives in its own module, importing only
// its dialect's Drizzle core, so an app's schema file pulls in one of them.

import type { StoreTables } from "../../store/sql/tables.ts";

/**
 * The tables' names, defaults `cloudrop_files` and `cloudrop_usage`, and on Postgres their schema: pass the same
 * `tables` as to `drizzleStore`.
 */
export interface CloudropTablesOptions {
  tables?: StoreTables;
}
