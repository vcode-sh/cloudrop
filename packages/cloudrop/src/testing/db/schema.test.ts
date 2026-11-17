import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type Dialect, schemaStatements } from "./schema.ts";

const read = (path: string) => readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

/** A file of SQL statements, without comments, split at each `;` and trimmed. */
const statements = (sql: string) =>
  sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/** The ```sql block after `<!-- ddl:<dialect> -->` in the store guide. */
function guideBlock(dialect: Dialect): string {
  const block = new RegExp(`<!-- ddl:${dialect} -->\\n\`\`\`sql\\n([\\s\\S]*?)\`\`\``).exec(read("docs/guide/store.md"));
  if (!block?.[1]) throw new Error(`docs/guide/store.md has no sql block after <!-- ddl:${dialect} -->.`);
  return block[1];
}

test("a table name that is not a plain identifier is refused before any SQL is built", () => {
  expect(() => schemaStatements("postgres", { files: 'x"; DROP TABLE y; --' })).toThrow(
    'Table name "x"; DROP TABLE y; --" is not allowed: use letters, digits and "_", not starting with a digit.',
  );
});

// The guide's DDL and the example's are copies people run; the lane's DDL is the one every store is tested on.
test.for(["postgres", "sqlite"] as const)("the store guide's %s DDL is the lane's", (dialect) => {
  expect(statements(guideBlock(dialect))).toEqual(schemaStatements(dialect));
});

test("the Next.js example's DDL is the lane's SQLite DDL, made safe to run at every start", () => {
  const example = statements(read("examples/next/lib/cloudrop-tables.sql"));
  expect(example.map((statement) => statement.replace(" IF NOT EXISTS", ""))).toEqual(schemaStatements("sqlite"));
  expect(example.filter((statement) => !/^CREATE (TABLE|INDEX) IF NOT EXISTS /.test(statement))).toEqual([]);
});
