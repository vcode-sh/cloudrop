// cloudropPgTables() and cloudropSqliteTables() against the plain DDL (testing/db/schema.ts, the schema every SQL lane
// runs on): the tables made from that DDL, read back from the database's catalogue, must declare what the Drizzle
// tables declare: every column with its type (precision included), nullability and primary key, every index with its
// uniqueness and its columns in order, and Postgres's CHECKs. A migration generated from them then builds the tables
// the store was proven on.

import { PgDialect, getTableConfig as pgConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import { useAppSchema, usePostgresDatabase } from "../testing/db/postgres.ts";
import { qualified, type TableNames } from "../testing/db/schema.ts";
import { RENAMED } from "../testing/db/sql-target.ts";
import { useSqliteDatabase } from "../testing/db/sqlite.ts";
import { cloudropPgTables, cloudropSqliteTables } from "./drizzle.ts";

interface Shape {
  columns: { name: string; type: string; notNull: boolean; primaryKey: boolean }[];
  indexes: { name: string; unique: boolean; columns: string[] }[];
  checks: { name: string; expression: string }[];
}

const byName = <T extends { name: string }>(items: T[]): T[] => items.toSorted((a, b) => a.name.localeCompare(b.name));
const namings: { name: string; tables?: Partial<TableNames> }[] = [
  { name: "default names" },
  { name: "renamed", tables: RENAMED },
];

describe("Postgres", () => {
  const db = usePostgresDatabase();
  const schema = useAppSchema(db);

  /** The table's shape in `tableSchema`, or in the search path's schema without one. */
  async function catalogue(table: string, tableSchema?: string): Promise<Shape> {
    const relation = qualified(tableSchema, table);
    const columns = await db.query(
      `SELECT c.column_name::text AS name, c.is_nullable = 'NO' AS "notNull",
         (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
           WHERE a.attrelid = $1::text::regclass AND a.attname = c.column_name::text) AS type,
         c.column_name::text IN (SELECT a.attname::text FROM pg_index ix
           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY (ix.indkey)
           WHERE ix.indrelid = $1::text::regclass AND ix.indisprimary) AS "primaryKey"
       FROM information_schema.columns c
       WHERE c.table_schema = coalesce($3::text, current_schema()) AND c.table_name = $2::text
       ORDER BY c.ordinal_position`,
      [relation, table, tableSchema ?? null],
    );
    const indexes = await db.query(
      `SELECT i.relname AS name, ix.indisunique AS unique, array_agg(a.attname::text ORDER BY k.ord) AS columns
       FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
       CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
       WHERE ix.indrelid = $1::text::regclass AND NOT ix.indisprimary GROUP BY i.relname, ix.indisunique`,
      [relation],
    );
    const checks = await db.query(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS expression FROM pg_constraint
       WHERE conrelid = $1::text::regclass AND contype = 'c'`,
      [relation],
    );
    return {
      columns: columns as Shape["columns"],
      indexes: byName(indexes as Shape["indexes"]),
      // pg_get_constraintdef prints "CHECK ((files >= 0))".
      checks: byName(checks as Shape["checks"]).map(({ name, expression }) => ({
        name,
        expression: expression.replace(/^CHECK \(\((.*)\)\)$/, "$1"),
      })),
    };
  }

  function declared(table: ReturnType<typeof pgConfig>): Shape {
    return {
      columns: table.columns.map((column) => ({
        name: column.name,
        // Drizzle writes a Date-mode timestamp's precision as "timestamp (3)"; format_type, the catalogue's spelling
        // with precision, writes "timestamp(3)".
        type: column.getSQLType().replace(" (", "("),
        notNull: column.notNull,
        primaryKey: column.primary,
      })),
      indexes: byName(
        table.indexes.map(({ config }) => ({
          name: config.name ?? "(unnamed)",
          unique: config.unique,
          columns: config.columns.map((column) => ("name" in column && column.name ? column.name : "(expression)")),
        })),
      ),
      // Drizzle writes a CHECK's column out as `"table"."column"`; the catalogue prints the bare column name.
      checks: byName(
        table.checks.map(({ name, value }) => ({
          name,
          expression: new PgDialect()
            .sqlToQuery(value)
            .sql.replaceAll(/"\w+"\./g, "")
            .replaceAll('"', ""),
        })),
      ),
    };
  }

  test.for([...namings, { name: "in a schema", tables: { schema } }])(
    "cloudropPgTables matches the DDL's tables, $name",
    async ({ tables }) => {
      await db.reset();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.createTables(tables);
      const { files, usage } = cloudropPgTables({ tables });
      const [filesConfig, usageConfig] = [pgConfig(files), pgConfig(usage)];
      expect([filesConfig.schema, usageConfig.schema]).toEqual([tables?.schema, tables?.schema]);
      expect(declared(filesConfig)).toEqual(await catalogue(filesConfig.name, filesConfig.schema));
      expect(declared(usageConfig)).toEqual(await catalogue(usageConfig.name, usageConfig.schema));
    },
  );
});

describe("SQLite", () => {
  const db = useSqliteDatabase();

  async function catalogue(table: string): Promise<Shape> {
    const columns = await db.query(`SELECT name, type, "notnull", pk FROM pragma_table_info(?) ORDER BY cid`, [table]);
    const indexes = await db.query(
      `SELECT il.name AS name, il."unique" AS "unique", json_group_array(ii.name) AS columns
       FROM pragma_index_list(?) il, pragma_index_info(il.name) ii WHERE il.origin = 'c'
       GROUP BY il.name`,
      [table],
    );
    return {
      columns: columns.map((column) => ({
        name: String(column.name),
        type: String(column.type).toLowerCase(),
        notNull: column.notnull === 1,
        primaryKey: column.pk === 1,
      })),
      indexes: byName(
        indexes.map((index) => ({
          name: String(index.name),
          unique: index.unique === 1,
          columns: JSON.parse(String(index.columns)),
        })),
      ),
      checks: [],
    };
  }

  function declared(table: ReturnType<typeof sqliteConfig>): Shape {
    return {
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType(),
        notNull: column.notNull,
        primaryKey: column.primary,
      })),
      indexes: byName(
        table.indexes.map(({ config }) => ({
          name: config.name,
          unique: config.unique,
          columns: config.columns.map((column) => ("name" in column && column.name ? column.name : "(expression)")),
        })),
      ),
      checks: table.checks.map(({ name }) => ({ name, expression: "" })),
    };
  }

  test.for(namings)("cloudropSqliteTables matches the DDL's tables, $name", async ({ tables }) => {
    await db.createTables(tables);
    const { files, usage } = cloudropSqliteTables({ tables });
    const [filesConfig, usageConfig] = [sqliteConfig(files), sqliteConfig(usage)];
    expect(declared(filesConfig)).toEqual(await catalogue(filesConfig.name));
    expect(declared(usageConfig)).toEqual(await catalogue(usageConfig.name));
  });
});
