import { expect, test } from "vitest";
import { schemaStatements } from "./schema.ts";

test("a table name that is not a plain identifier is refused before any SQL is built", () => {
  expect(() => schemaStatements("postgres", { files: 'x"; DROP TABLE y; --' })).toThrow(
    'Table name "x"; DROP TABLE y; --" is not allowed: use letters, digits and "_", not starting with a digit.',
  );
});
