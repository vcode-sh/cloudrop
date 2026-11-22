// Contract: checkSchema's INVALID_CONFIG for a usage table without the erase mark prints SQL that runs (M12-O1). The
// database lanes prove the SQL for missing columns (erase-upgrade.db.integration.test.ts); this row covers a column
// that a migration adds between the check's reads, which no real database can be timed to show. Oracle: the guide's
// index statement, and no ALTER TABLE without a column.

import { expect, test } from "vitest";
import type { SqlDialect } from "./executor.ts";
import { checkSchema, tableNames } from "./tables.ts";

/** A database whose erase_requested_at column is missing for the first `reads` reads that name it, then present. */
function migratedMidCheck(dialect: SqlDialect, reads: number) {
  let left = reads;
  return {
    dialect,
    query: async (sql: string) => {
      if (!sql.includes("erase_requested_at") || left-- <= 0) return [];
      throw Object.assign(new Error('column "erase_requested_at" does not exist'), { code: "42703" });
    },
  };
}

test.each(["postgres", "sqlite"] as const)(
  "%s: a column added during the check leaves only the index to print",
  async (dialect) => {
    // Missing for the read of the whole table and for findMissing's read of the column, present by the remedy's.
    const executor = migratedMidCheck(dialect, 2);
    await expect(checkSchema(executor, tableNames({}, dialect))).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message:
        'The table "cloudrop_usage" has no column "erase_requested_at". cloudrop 1.0 keeps an owner\'s erase mark in that table. Run, in a migration: CREATE INDEX "cloudrop_usage_erasing_idx" ON "cloudrop_usage" (owner) WHERE erase_requested_at IS NOT NULL AND erased_at IS NULL;',
    });
  },
);
