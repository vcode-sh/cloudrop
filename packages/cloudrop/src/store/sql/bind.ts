// Builds one statement's parameter list while its SQL is written, so placeholders and values cannot drift apart.
// Postgres gets explicit casts on every placeholder: drivers that send typed parameters (Prisma sends a string as text)
// would otherwise fail on `timestamptz = text`, and casts let one statement serve every driver. SQLite keeps times as
// integer milliseconds, so no driver converts a Date its own way.

import type { SqlDialect, SqlStatement } from "./executor.ts";

export interface Binder {
  text(value: string | null): string;
  bigint(value: number | null): string;
  integer(value: number): string;
  time(value: Date | null): string;
  /** Postgres only: a JSON document read with `json_to_recordset`. */
  json(value: string): string;
  /** The statement with every value bound so far, in placeholder order. */
  statement(sql: string): SqlStatement;
}

/** A fresh parameter list. Template literals evaluate left to right, so `?` placeholders take values in order. */
export function binder(dialect: SqlDialect): Binder {
  const params: unknown[] = [];
  const bind = (value: unknown, type: string): string => {
    params.push(value);
    return dialect === "postgres" ? `$${params.length}::${type}` : "?";
  };
  return {
    text: (value) => bind(value, "text"),
    bigint: (value) => bind(value, "bigint"),
    integer: (value) => bind(value, "integer"),
    time: (value) =>
      dialect === "postgres"
        ? bind(value?.toISOString() ?? null, "timestamptz")
        : bind(value?.getTime() ?? null, "bigint"),
    // Bound as text, then cast: postgres.js JSON-encodes a string bound to a json parameter a second time.
    json: (value) => `${bind(value, "text")}::json`,
    statement: (sql) => ({ sql, params }),
  };
}
