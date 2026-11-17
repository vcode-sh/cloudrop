// The store's two tables: names validated and quoted once at construction, and a lazy check that every column the
// core reads exists, so a schema mistake fails with a message naming the table and the column instead of a driver error
// on the first upload.

import { CloudropError, configError } from "../../errors.ts";
import type { SqlExecutor } from "./executor.ts";
import { FILE_COLUMNS } from "./records.ts";

/** The table names a store is built with (spec §3); columns are fixed. */
export interface StoreTables {
  files?: string;
  usage?: string;
}

/** Both names, already quoted for SQL. */
export interface QuotedTables {
  files: string;
  usage: string;
}

type Reader = Pick<SqlExecutor<unknown>, "query">;

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const USAGE_COLUMNS = ["owner", "reserved_bytes", "active_bytes", "files", "updated_at"];

/** Validates the names (the only text the core puts into SQL unbound) and quotes them. */
export function quoteTables(tables: StoreTables = {}): QuotedTables & { names: Required<StoreTables> } {
  const names = { files: tables.files ?? "cloudrop_files", usage: tables.usage ?? "cloudrop_usage" };
  for (const [option, name] of Object.entries(names)) {
    if (typeof name !== "string" || !TABLE_NAME.test(name)) {
      throw configError(
        `The ${option} table name ${JSON.stringify(name)} is not allowed. Use letters, digits and "_", not starting with a digit: { tables: { ${option}: "..." } }.`,
      );
    }
  }
  return { files: `"${names.files}"`, usage: `"${names.usage}"`, names };
}

/** Answers whether the statement runs; any failure counts as no. */
async function runs(executor: Reader, sql: string): Promise<boolean> {
  try {
    await executor.query(sql, []);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first problem with one table: the table itself, or its first missing column in the order of spec §3. Only called
 * after the whole-table read failed, so the probes run on the error path alone.
 */
async function findMissing(executor: Reader, table: string, columns: readonly string[]): Promise<string | null> {
  if (!(await runs(executor, `SELECT 1 FROM "${table}" WHERE 1 = 0`))) return `The table "${table}" does not exist.`;
  for (const column of columns) {
    if (!(await runs(executor, `SELECT ${column} FROM "${table}" WHERE 1 = 0`))) {
      return `The table "${table}" has no column "${column}".`;
    }
  }
  return null;
}

/**
 * Reads every column of both tables without reading a row. When that fails and the database answers a bare `SELECT 1`,
 * the schema is at fault: throws `INVALID_CONFIG` naming the table and its first missing column. Any other failure
 * (the database is down) is rethrown as it is.
 */
export async function checkSchema(executor: Reader, names: Required<StoreTables>): Promise<void> {
  const tables: [string, readonly string[]][] = [
    [names.files, FILE_COLUMNS],
    [names.usage, USAGE_COLUMNS],
  ];
  for (const [table, columns] of tables) {
    try {
      await executor.query(`SELECT ${columns.join(", ")} FROM "${table}" WHERE 1 = 0`, []);
    } catch (error) {
      const missing = (await runs(executor, "SELECT 1")) ? await findMissing(executor, table, columns) : null;
      if (missing === null) throw error;
      throw new CloudropError(
        "INVALID_CONFIG",
        `${missing} Create the store's tables as the cloudrop docs show, or pass their names in { tables }.`,
        { cause: error },
      );
    }
  }
}
