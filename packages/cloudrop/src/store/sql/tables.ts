// The store's two tables: names validated and quoted once at construction, and a lazy check that every column the
// core reads exists, so a schema mistake fails with a message naming the table and the column instead of a driver error
// on the first upload.

import { CloudropError, configError } from "../../errors.ts";
import { isMissingFromSchema, isPermissionDenied, type SqlDialect, type SqlExecutor } from "./executor.ts";
import { FILE_COLUMNS } from "./records.ts";

/** The table names a store is built with; columns are fixed. */
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

type Reader = Pick<SqlExecutor<unknown>, "query" | "dialect">;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const NO_SQLITE_SCHEMA = "SQLite has no schemas: remove schema from { tables }.";

/** The erase mark's columns (M12-O1), added in 1.0: a table without them gets the upgrade's exact SQL. */
const ERASE_COLUMNS = ["erase_requested_at", "erased_at"];
const USAGE_COLUMNS = ["owner", "reserved_bytes", "active_bytes", "files", "updated_at", ...ERASE_COLUMNS];

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
 * The SQL that adds the erase mark to a usage table of 0.6 or earlier, for this dialect and these names: the `columns`
 * it lacks, then the index, which cannot exist while either is missing.
 */
export function eraseMarkUpgrade(dialect: SqlDialect, names: TableNames, columns: readonly string[]): string {
  const usage = quoteTables(names).usage;
  const index = `CREATE INDEX "${names.usage}_erasing_idx" ON ${usage} (owner) WHERE erase_requested_at IS NOT NULL AND erased_at IS NULL;`;
  // SQLite adds one column per statement.
  const added =
    dialect === "postgres"
      ? `ALTER TABLE ${usage} ${columns.map((column) => `ADD COLUMN ${column} timestamptz(3)`).join(", ")};`
      : columns.map((column) => `ALTER TABLE ${usage} ADD COLUMN ${column} INTEGER;`).join(" ");
  return `${added} ${index}`;
}

/** What to do about the first missing piece: the upgrade's SQL for the erase mark, else the tables from the docs. */
async function remedy(dialect: SqlDialect, names: TableNames, missing: MissingRead, table: string, found: string) {
  const eraseMark =
    table === quoteTables(names).usage && ERASE_COLUMNS.some((column) => found.endsWith(`"${column}".`));
  if (!eraseMark) return "Create the store's tables as the cloudrop docs show, or pass their names in { tables }.";
  const absent: string[] = [];
  for (const column of ERASE_COLUMNS) if ((await missing(table, column)) !== null) absent.push(column);
  const upgrade = eraseMarkUpgrade(dialect, names, absent);
  return `cloudrop 1.0 keeps an owner's erase mark in that table. Run, in a migration: ${upgrade}`;
}

/**
 * Reads every column of both tables without reading a row. Only the database's own word blames the schema or the role
 * (M11-R62): when it says a table or a column is not there, throws `INVALID_CONFIG` naming the table (qualified, when
 * it has a schema) and its first missing column; when it says the role may not read a table, `INVALID_CONFIG` naming
 * the grants the store needs. Any other failure (the database is down, a statement was cancelled) is thrown as it is.
 */
export async function checkSchema(executor: Reader, names: TableNames): Promise<void> {
  const { files, usage } = quoteTables(names);
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
    const fix = await remedy(executor.dialect, names, missing, table, found);
    throw new CloudropError("INVALID_CONFIG", `${found} ${fix}`, { cause });
  }
}
