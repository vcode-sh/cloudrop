// The store's tables as plain DDL for the database lane (M5 spec §3), and the shape every test database shares.
// Index and key names follow Prisma's defaults (`<table>_<columns>_idx`, `<table>_pkey`). On Postgres a Prisma
// migration of the shipped models finds nothing to change (prisma.db.integration.test.ts runs `prisma migrate diff`,
// which compares columns, types, nullability, keys and indexes: CHECK constraints are outside Prisma's schema and the
// diff, so Prisma-created tables lack them until a migration adds them);
// on SQLite it would rebuild both tables only because Prisma declares its BigInt columns `BIGINT` where this DDL says
// `INTEGER`, the same storage (M5-T56). The CHECK constraints are Postgres-only, as §3 specifies.

export type Dialect = "postgres" | "sqlite";

export interface TableNames {
  files: string;
  usage: string;
  /** Postgres only: the schema both tables are in; without it, the search path's. */
  schema?: string;
}

export const DEFAULT_TABLES: TableNames = { files: "cloudrop_files", usage: "cloudrop_usage" };

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fills in the default names and rejects any name that would need more than double quotes to be safe in SQL. */
export function resolveTables(tables: Partial<TableNames> = {}): TableNames {
  const resolved = { ...DEFAULT_TABLES, ...tables };
  for (const name of [resolved.files, resolved.usage, resolved.schema]) {
    if (name !== undefined && !TABLE_NAME.test(name)) {
      throw new Error(`Table name "${name}" is not allowed: use letters, digits and "_", not starting with a digit.`);
    }
  }
  return resolved;
}

/** The table's name for SQL: quoted, and qualified when the tables have a schema. */
export const qualified = (schema: string | undefined, table: string): string =>
  schema === undefined ? `"${table}"` : `"${schema}"."${table}"`;

/** One database of the lane, reached straight through its driver; no store adapter is involved. */
export interface TestDatabase {
  readonly dialect: Dialect;
  /** Runs one statement, with `$1` placeholders on Postgres and `?` on SQLite, and returns the driver's rows. */
  query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /** Creates both tables and their indexes under these names (defaults `cloudrop_files`, `cloudrop_usage`). */
  createTables(tables?: Partial<TableNames>): Promise<void>;
}

const TYPES = {
  postgres: { text: "text", bigint: "bigint", integer: "integer", time: "timestamptz" },
  // Times are integer milliseconds since the epoch. A non-INTEGER primary key may hold NULL in SQLite unless told not to.
  sqlite: { text: "TEXT", bigint: "INTEGER", integer: "INTEGER", time: "INTEGER" },
} as const;

/** The DDL of both tables, one statement per string, so drivers that take a single statement can run them in order. */
export function schemaStatements(dialect: Dialect, tables?: Partial<TableNames>): string[] {
  const { files, usage, schema } = resolveTables(tables);
  const { text, bigint, integer, time } = TYPES[dialect];
  const nonNegative = (column: string) => (dialect === "postgres" ? ` CHECK (${column} >= 0)` : "");
  const index = (columns: string[]) =>
    `CREATE INDEX "${files}_${columns.join("_")}_idx" ON ${qualified(schema, files)} (${columns.join(", ")})`;
  return [
    `CREATE TABLE ${qualified(schema, files)} (
  id ${text} NOT NULL PRIMARY KEY,
  route ${text} NOT NULL,
  key ${text} NOT NULL,
  owner ${text},
  status ${text} NOT NULL,
  name ${text} NOT NULL,
  type ${text} NOT NULL,
  size ${bigint} NOT NULL,
  upload_id ${text},
  metadata ${text},
  result ${text},
  claim ${text},
  claimed_at ${time},
  expires_at ${time} NOT NULL,
  created_at ${time} NOT NULL,
  updated_at ${time} NOT NULL,
  completed_at ${time},
  ended_at ${time},
  cleaned_at ${time},
  request_key ${text}
)`,
    index(["status", "expires_at"]),
    index(["status", "claimed_at"]),
    index(["status", "cleaned_at", "ended_at"]),
    index(["owner", "status"]),
    index(["key"]),
    index(["route", "request_key"]),
    `CREATE TABLE ${qualified(schema, usage)} (
  owner ${text} NOT NULL PRIMARY KEY,
  reserved_bytes ${bigint} NOT NULL${nonNegative("reserved_bytes")},
  active_bytes ${bigint} NOT NULL${nonNegative("active_bytes")},
  files ${integer} NOT NULL${nonNegative("files")},
  updated_at ${time} NOT NULL
)`,
  ];
}
