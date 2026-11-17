// The database lane's SQLite: a fresh node:sqlite database for every test, in memory unless another client (Prisma,
// a second connection) must open the same database, which needs a file.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { schemaStatements, type TestDatabase } from "./schema.ts";

/** Under the repository's git-ignored .superpowers/, never the OS temp directory (RAM-backed on the owner's machine). */
const FILE_ROOT = fileURLToPath(new URL("../../../../../.superpowers/test-db/", import.meta.url));

export interface SqliteTestDatabase extends TestDatabase {
  readonly dialect: "sqlite";
  /** This test's connection. */
  readonly database: DatabaseSync;
  /** The database file with `{ file: true }`, for clients that open it themselves; null in memory. */
  readonly path: string | null;
}

/**
 * Call at the top of a test file or `describe`. Every test gets a new database, closed (and its file deleted) after the
 * test; the teardown is registered here, before anything is acquired.
 */
export function useSqliteDatabase(options: { file?: boolean } = {}): SqliteTestDatabase {
  let state: { database: DatabaseSync; directory: string | null } | undefined;

  beforeEach(() => {
    let directory: string | null = null;
    if (options.file) {
      mkdirSync(FILE_ROOT, { recursive: true });
      directory = mkdtempSync(join(FILE_ROOT, "sqlite-"));
    }
    state = { directory, database: new DatabaseSync(directory ? join(directory, "test.db") : ":memory:") };
  });
  afterEach(() => {
    if (!state) return;
    try {
      state.database.close();
    } finally {
      if (state.directory) rmSync(state.directory, { recursive: true, force: true });
      state = undefined;
    }
  });

  const ready = () => {
    if (!state) throw new Error("useSqliteDatabase() is ready only in tests and hooks that run after its beforeEach.");
    return state;
  };
  const query = async (sql: string, params: readonly unknown[] = []) =>
    // node:sqlite checks every value at bind time and names the one it cannot store.
    ready()
      .database.prepare(sql)
      .all(...(params as SQLInputValue[]));
  return {
    dialect: "sqlite",
    get database() {
      return ready().database;
    },
    get path() {
      const { directory } = ready();
      return directory ? join(directory, "test.db") : null;
    },
    query,
    async createTables(tables) {
      for (const statement of schemaStatements("sqlite", tables)) await query(statement);
    },
  };
}
