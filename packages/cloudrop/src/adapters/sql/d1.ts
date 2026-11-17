// Cloudflare D1: a batch is D1's `batch()`, which runs its statements in order as one transaction. D1 has no
// interactive transaction, so no transaction mode. The binding is described by the members used here, so the library
// needs no Workers types.

import type { SqlExecutor, SqlRow } from "../../store/sql/executor.ts";

/** A D1 prepared statement. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all(): Promise<{ results: SqlRow[] }>;
}

/** A D1 database binding, `env.DB`. */
export interface D1Database {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<{ results: SqlRow[] }[]>;
}

/** An executor over a D1 binding: `sqlStore(d1Executor(env.DB))`. */
export function d1Executor(d1: D1Database): SqlExecutor {
  return {
    dialect: "sqlite",
    async query(sql, params) {
      const { results } = await d1
        .prepare(sql)
        .bind(...params)
        .all();
      return results;
    },
    async batch(statements) {
      const answers = await d1.batch(statements.map(({ sql, params }) => d1.prepare(sql).bind(...params)));
      return answers.map((answer) => answer.results);
    },
  };
}
