// The chaos lane's server: the real cloudrop on the "files" route, stateless or with a database store. The store is
// `sqlStore(sqliteExecutor(db))` over an in-memory node:sqlite database with the spec §3 DDL, one owner for every
// upload, and counters on the route's onComplete and afterComplete, so a row can prove that a completion ran once
// whatever the faults did to its answers. The oracle reads the tables past the store.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { sqliteExecutor, sqlStore } from "../adapters/sql.ts";
import { createCloudrop } from "../server/cloudrop.ts";
import { allowAnyone, route } from "../server/route.ts";
import type { CloudropStore } from "../server/store.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { rawTables } from "./db/raw-tables.ts";
import { schemaStatements, type TestDatabase } from "./db/schema.ts";
import { type RecordingLogger, SECRET } from "./server-fixture.ts";
import type { RawTables } from "./store-rows.ts";

/** The one owner of every upload in the store rows. */
export const CHAOS_OWNER = "chaos-user";

export interface ChaosStore {
  /** What onComplete ran for, by file id. */
  completions(): Record<string, number>;
  /** What afterComplete ran for, by file id. */
  afterCompletions(): Record<string, number>;
  /** The next onComplete waits for release(); `reached` settles once it is waiting. */
  holdNextCompletion(): { reached: Promise<void>; release(): void };
  /** The store's tables, read past the store. */
  raw: RawTables;
}

export interface ChaosStoreServer {
  store: CloudropStore<never>;
  hooks: ChaosStore;
  onComplete(context: { file: { id: string } }): Promise<null>;
  afterComplete(context: { file: { id: string } }): void;
  /** Lets an onComplete a failed row left waiting finish. */
  freeHeld(): void;
  /** Empties both tables and the counters. */
  reset(): void;
  close(): void;
}

const count = (counts: Record<string, number>, id: string) => {
  counts[id] = (counts[id] ?? 0) + 1;
};

export function chaosStoreServer(): ChaosStoreServer {
  const database = new DatabaseSync(":memory:");
  const db: TestDatabase = {
    dialect: "sqlite",
    query: async (sql, params = []) => database.prepare(sql).all(...(params as SQLInputValue[])),
    async createTables(tables) {
      for (const statement of schemaStatements("sqlite", tables)) database.exec(statement);
    },
  };
  for (const statement of schemaStatements("sqlite")) database.exec(statement);

  let completions: Record<string, number> = {};
  let afterCompletions: Record<string, number> = {};
  let held: { gate: Promise<void>; reached: () => void } | null = null;
  // Kept past the hook taking `held`, so reset() frees an onComplete a failed row left waiting.
  let releaseHeld = () => {};

  const hooks: ChaosStore = {
    completions: () => ({ ...completions }),
    afterCompletions: () => ({ ...afterCompletions }),
    holdNextCompletion() {
      const gate = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();
      held = { gate: gate.promise, reached: reached.resolve };
      releaseHeld = gate.resolve;
      return { reached: reached.promise, release: gate.resolve };
    },
    raw: rawTables(db),
  };

  return {
    store: sqlStore(sqliteExecutor(database)),
    hooks,
    async onComplete({ file }) {
      count(completions, file.id);
      const waiting = held;
      held = null;
      if (waiting) {
        waiting.reached();
        await waiting.gate;
      }
      return null;
    },
    afterComplete({ file }) {
      count(afterCompletions, file.id);
    },
    freeHeld: () => releaseHeld(),
    reset() {
      database.exec("DELETE FROM cloudrop_files; DELETE FROM cloudrop_usage");
      completions = {};
      afterCompletions = {};
      held = null;
    },
    close: () => database.close(),
  };
}

export function chaosCloudrop(
  storage: StorageDriver,
  prefix: string,
  logger: RecordingLogger,
  stored?: ChaosStoreServer,
) {
  return createCloudrop({
    storage,
    secret: SECRET,
    logger,
    ...(stored && { store: stored.store }),
    // Every non-last part is 8 MiB whatever the threshold; this one makes a 20 MiB file go in three of them.
    multipartThreshold: "8MB",
    routes: {
      files: route(
        {
          accept: ["application/octet-stream"],
          maxSize: "100MB",
          // The soak sends up to 20 files through one /upload.
          maxFiles: 20,
          authorize: allowAnyone,
        },
        {
          prefix: () => prefix,
          ...(stored && {
            owner: () => CHAOS_OWNER,
            onComplete: stored.onComplete,
            afterComplete: stored.afterComplete,
          }),
        },
      ),
    },
  });
}

export type ChaosCloudrop = ReturnType<typeof chaosCloudrop>;
