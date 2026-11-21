// The store's two tables: names validated and quoted once at construction, and a lazy check that every column the
// core reads exists, so a schema mistake fails with a message naming the table and the column instead of a driver error
// on the first upload.

import { CloudropError, configError } from "../../errors.ts";
import { isMissingFromSchema, isPermissionDenied, type SqlDialect, type SqlExecutor } from "./executor.ts";
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

const NO_SQLITE_SCHEMA = "SQLite has no schemas: remove schema from { tables }.";

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

/** The names as SQL: quoted, and prefixed with the quoted schema when there is one. */
export function quoteTables({ files, usage, schema }: TableNames): QuotedTables {
  const prefix = schema === undefined ? "" : `"${schema}".`;
  return { files: `${prefix}"${files}"`, usage: `${prefix}"${usage}"` };
}

/** Reads `columns` of `table` without reading a row: the database's error when it says they are not there, else null. */
type MissingRead = (table: string, columns: string) => Promise<unknown>;

/**
 * The first problem with one table: the table itself, or its first missing column in the order of spec §3. Only called
 * after the whole-table read failed, so the probes run on the error path alone.
 */
async function findMissing(missing: MissingRead, table: string, columns: readonly string[]): Promise<string | null> {
  if ((await missing(table, "1")) !== null) return `The table ${table} does not exist.`;
  for (const column of columns) {
    if ((await missing(table, column)) !== null) return `The table ${table} has no column "${column}".`;
  }
  return null;
}

/**
 * Reads every column of both tables without reading a row. Only the database's own word blames the schema or the role
 * (M11-R62): when it says a table or a column is not there, throws `INVALID_CONFIG` naming the table (qualified, when
 * it has a schema) and its first missing column; when it says the role may not read a table, `INVALID_CONFIG` naming
 * the grants the store needs. Any other failure (the database is down, a statement was cancelled) is thrown as it is.
 */
export async function checkSchema(executor: Reader, { files, usage }: QuotedTables): Promise<void> {
  const missing: MissingRead = async (table, columns) => {
    try {
      await executor.query(`SELECT ${columns} FROM ${table} WHERE 1 = 0`, []);
      return null;
    } catch (error) {
      if (isMissingFromSchema(error)) return error;
      if (!isPermissionDenied(error)) throw error;
      throw new CloudropError(
        "INVALID_CONFIG",
        `The database role may not read the table ${table} (permission denied). Grant it what the store needs: GRANT SELECT, INSERT, UPDATE ON ${files} TO <role>; GRANT SELECT, INSERT, UPDATE, DELETE ON ${usage} TO <role>; and, for tables outside the public schema, GRANT USAGE ON SCHEMA <schema> TO <role>;`,
        { cause: error },
      );
    }
  };
  const tables: [string, readonly string[]][] = [
    [files, FILE_COLUMNS],
    [usage, USAGE_COLUMNS],
  ];
  for (const [table, columns] of tables) {
    const cause = await missing(table, columns.join(", "));
    if (cause === null) continue;
    const found = await findMissing(missing, table, columns);
    // Nothing is missing any more: the schema was fixed between the two reads, and the next call passes.
    if (found === null) throw cause;
    throw new CloudropError(
      "INVALID_CONFIG",
      `${found} Create the store's tables as the cloudrop docs show, or pass their names in { tables }.`,
      { cause },
    );
  }
}
