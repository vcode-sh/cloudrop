// The store's two tables: names validated and quoted once at construction, and a lazy check that every column the
// core reads exists, so a schema mistake fails with a message naming the table and the column instead of a driver error
// on the first upload.

import { CloudropError, configError } from "../../errors.ts";
import type { SqlDialect, SqlExecutor } from "./executor.ts";
import { FILE_COLUMNS } from "./records.ts";

/** The table names a store is built with (spec §3); columns are fixed. */
export interface StoreTables {
  files?: string;
  usage?: string;
  /**
   * Postgres only: the schema both tables live in, such as `"app"`. Without it the statements name the tables alone,
   * and the connection's search path finds them.
   */
  schema?: string;
}

/** The names with their defaults, validated. */
export interface TableNames {
  files: string;
  usage: string;
  schema?: string;
}

/** Both tables as SQL names: quoted, and qualified with the schema when there is one. */
export interface QuotedTables {
  files: string;
  usage: string;
}

type Reader = Pick<SqlExecutor<unknown>, "query">;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const NO_SQLITE_SCHEMA =
  "SQLite has no schemas, so { tables: { schema } } applies only to Postgres. Remove schema from { tables }; SQLite finds the tables by their names alone.";

const USAGE_COLUMNS = ["owner", "reserved_bytes", "active_bytes", "files", "updated_at"];

/** Fills in the default names and validates every name: they are the only text the core puts into SQL unbound. */
export function tableNames(tables: StoreTables = {}, dialect: SqlDialect): TableNames {
  const { schema } = tables;
  if (schema !== undefined && dialect === "sqlite") throw configError(NO_SQLITE_SCHEMA);
  const names = { files: tables.files ?? "cloudrop_files", usage: tables.usage ?? "cloudrop_usage" };
  const checked = schema === undefined ? names : { ...names, schema };
  for (const [option, name] of Object.entries(checked)) {
    if (typeof name !== "string" || !NAME.test(name)) {
      const what = option === "schema" ? "schema" : `${option} table`;
      throw configError(
        `The ${what} name ${JSON.stringify(name)} is not allowed. Use letters, digits and "_", not starting with a digit: { tables: { ${option}: "..." } }.`,
      );
    }
  }
  return checked;
}

export function quoteTables({ files, usage, schema }: TableNames): QuotedTables {
  const prefix = schema === undefined ? "" : `"${schema}".`;
  return { files: `${prefix}"${files}"`, usage: `${prefix}"${usage}"` };
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
  if (!(await runs(executor, `SELECT 1 FROM ${table} WHERE 1 = 0`))) return `The table ${table} does not exist.`;
  for (const column of columns) {
    if (!(await runs(executor, `SELECT ${column} FROM ${table} WHERE 1 = 0`))) {
      return `The table ${table} has no column "${column}".`;
    }
  }
  return null;
}

/**
 * Reads every column of both tables without reading a row. When that fails and the database answers a bare `SELECT 1`,
 * the schema is at fault: throws `INVALID_CONFIG` naming the table (qualified, when it has a schema) and its first
 * missing column. Any other failure (the database is down) is rethrown as it is.
 */
export async function checkSchema(executor: Reader, quoted: QuotedTables): Promise<void> {
  const tables: [string, readonly string[]][] = [
    [quoted.files, FILE_COLUMNS],
    [quoted.usage, USAGE_COLUMNS],
  ];
  for (const [table, columns] of tables) {
    try {
      await executor.query(`SELECT ${columns.join(", ")} FROM ${table} WHERE 1 = 0`, []);
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
