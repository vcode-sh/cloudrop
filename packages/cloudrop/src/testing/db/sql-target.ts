// The store contract's target for any SQL-backed store (the sql adapter's executors, Drizzle, Prisma, D1): fresh
// tables before every case, the renamed and broken tables the `tables` cases need, and the one-shot usage-write failure.
// The failure's "already fired" state must survive the rollback it causes, so it lives outside the database's
// transactions: a Postgres sequence (never rolled back) or a JS closure behind a SQLite function.

import type { CloudropStore } from "../../server/store.ts";
import type { SetupStore, StoreGap } from "../store-contract.ts";
import type { D1TestDatabase } from "./d1.ts";
import type { PostgresTestDatabase } from "./postgres.ts";
import { rawTables } from "./raw-tables.ts";
import type { TableNames } from "./schema.ts";
import type { SqliteTestDatabase } from "./sqlite.ts";

export const RENAMED: TableNames = { files: "renamed_files", usage: "renamed_usage" };
const BROKEN: TableNames = { files: "broken_files", usage: "broken_usage" };
/** Dropped from the broken files table: a column in the middle, so the schema check must look past the first. */
const DROPPED = "result";

const FAILURE = "Injected failure: the usage table refused this write.";

/** Builds the store under test over the tables of these names (the defaults when none are given). */
export type StoreFactory = (tables?: TableNames) => CloudropStore<unknown>;

/** A trigger on the default usage table that fails the first write after it is armed, and passes every later one. */
async function armPostgres(db: PostgresTestDatabase): Promise<void> {
  await db.query("CREATE SEQUENCE cloudrop_fail_once");
  await db.query(`CREATE FUNCTION cloudrop_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('cloudrop_fail_once') = 1 THEN RAISE EXCEPTION '${FAILURE}'; END IF;
      RETURN NEW;
    END $$`);
  await db.query(`CREATE TRIGGER cloudrop_fail_once BEFORE INSERT OR UPDATE ON cloudrop_usage
    FOR EACH ROW EXECUTE FUNCTION cloudrop_fail_once()`);
}

async function armSqlite(db: SqliteTestDatabase): Promise<void> {
  let armed = true;
  db.database.function("cloudrop_fail_once", { deterministic: false }, () => {
    const fire = armed;
    armed = false;
    return fire ? 1 : 0;
  });
  for (const event of ["INSERT", "UPDATE"]) {
    await db.query(`CREATE TRIGGER cloudrop_fail_once_${event.toLowerCase()} BEFORE ${event} ON cloudrop_usage
      WHEN cloudrop_fail_once() BEGIN SELECT RAISE(ABORT, '${FAILURE}'); END`);
  }
}

/** D1 has no user functions, so it cannot arm the trigger and declares "failureInjection" as a gap. */
function armerFor(db: PostgresTestDatabase | SqliteTestDatabase | D1TestDatabase): (() => Promise<void>) | undefined {
  if (db.dialect === "postgres") return () => armPostgres(db);
  return "database" in db ? () => armSqlite(db) : undefined;
}

/**
 * The contract's setup for a SQL store over `db`. Postgres and D1 start each case from emptied tables; node:sqlite
 * gets a new database per case from its fixture, so `useSqliteDatabase()` must be called in an enclosing scope.
 */
export function sqlStoreTarget(
  db: PostgresTestDatabase | SqliteTestDatabase | D1TestDatabase,
  storeOver: StoreFactory,
  gaps: Partial<Record<StoreGap, string>> = {},
): SetupStore {
  return async () => {
    if ("reset" in db) await db.reset();
    for (const tables of [undefined, RENAMED, BROKEN]) await db.createTables(tables);
    await db.query(`ALTER TABLE "${BROKEN.files}" DROP COLUMN ${DROPPED}`);
    return {
      store: storeOver(),
      raw: rawTables(db),
      gaps,
      injectFailure: armerFor(db),
      tables: {
        renamed: { store: storeOver(RENAMED), raw: rawTables(db, RENAMED) },
        missingColumn: { store: storeOver(BROKEN), table: BROKEN.files, column: DROPPED },
      },
      // Postgres and D1 drop the tables at the next setup or with the file; SQLite's fixture closes the database.
      teardown: async () => {},
    };
  };
}
