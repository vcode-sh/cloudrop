// A core statement as Drizzle SQL. Drizzle's `sql.raw` takes no parameters, so the text is cut at each placeholder the
// core's binder wrote (store/sql/bind.ts) and every placeholder becomes a Drizzle parameter; Drizzle numbers them
// again as it renders, `$1`, `$2`… on Postgres and `?` on SQLite, and the `::type` casts after them stay in the text.

import { type SQL, type SQLChunk, sql } from "drizzle-orm";
import type { SqlDialect, SqlStatement } from "../../store/sql/executor.ts";

const PLACEHOLDER: Record<SqlDialect, RegExp> = { postgres: /\$(\d+)/g, sqlite: /\?/g };

export function drizzleSql(dialect: SqlDialect, { sql: text, params }: SqlStatement): SQL {
  const chunks: SQLChunk[] = [];
  let end = 0;
  for (const [position, match] of [...text.matchAll(PLACEHOLDER[dialect])].entries()) {
    // `$n` names its parameter; SQLite's `?` takes the next one.
    const value = params[match[1] === undefined ? position : Number(match[1]) - 1];
    chunks.push(sql.raw(text.slice(end, match.index)), sql.param(value));
    end = match.index + match[0].length;
  }
  chunks.push(sql.raw(text.slice(end)));
  return sql.join(chunks);
}
