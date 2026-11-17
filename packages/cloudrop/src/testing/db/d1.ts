// The Wrangler lane's D1: the `DB` binding of fixtures/wrangler/wrangler.jsonc, reached from Node through Wrangler's
// getPlatformProxy. That runs the same workerd and local D1 as `wrangler dev`, keeps nothing on disk, and hands Node
// the real binding, so the store contract runs here unchanged and `d1Executor` gets the object a Worker would.

import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { afterAll, beforeAll } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { schemaStatements, type TestDatabase } from "./schema.ts";

const CONFIG = fileURLToPath(new URL("../../../fixtures/wrangler/wrangler.jsonc", import.meta.url));

export interface D1TestDatabase extends TestDatabase {
  readonly dialect: "sqlite";
  /** The binding itself, typed as Workers declares it. */
  readonly binding: D1Database;
  /** Drops every table, so the next test starts empty. */
  reset(): Promise<void>;
}

/**
 * Call at the top of a test file or `describe`. It starts workerd before the scope's tests and stops it after them;
 * the teardown is registered here, before anything is acquired.
 */
export function useD1Database(): D1TestDatabase {
  let proxy: PlatformProxy<{ DB: D1Database }> | undefined;
  beforeAll(async () => {
    proxy = await getPlatformProxy({ configPath: CONFIG, persist: false, remoteBindings: false });
  });
  afterAll(async () => {
    const started = proxy;
    proxy = undefined;
    await started?.dispose();
  });

  const binding = () => {
    if (!proxy) throw new Error("useD1Database() is ready only in tests and hooks that run after its beforeAll.");
    return proxy.env.DB;
  };
  const query = async (sql: string, params: readonly unknown[] = []) =>
    (
      await binding()
        .prepare(sql)
        .bind(...params)
        .all<Record<string, unknown>>()
    ).results;
  return {
    dialect: "sqlite",
    get binding() {
      return binding();
    },
    query,
    async createTables(tables) {
      for (const statement of schemaStatements("sqlite", tables)) await query(statement);
    },
    async reset() {
      // D1 keeps internal `_cf_` tables that cannot be dropped.
      const tables = await query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      );
      for (const { name } of tables) await query(`DROP TABLE "${String(name)}"`);
    },
  };
}
