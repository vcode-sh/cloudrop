// `tables.schema` on Postgres: the store contract with every table in a schema of its own, through the sql adapter's
// node-postgres executor and through Drizzle, while the search path holds empty tables of the same names, so a
// statement that left the schema out would write or read the wrong table. Below it, the rows only a schema can break.

import { drizzle } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, test } from "vitest";
import { cloudropPgTables, drizzleStore } from "../../adapters/drizzle.ts";
import { pgExecutor, sqlStore } from "../../adapters/sql.ts";
import { useAppSchema, usePostgresDatabase } from "../../testing/db/postgres.ts";
import { rawReader } from "../../testing/db/raw-reader.ts";
import { sqlStoreTarget } from "../../testing/db/sql-target.ts";
import { describeStoreContract } from "../../testing/store-contract.ts";

const NOW = new Date("2026-11-17T10:20:30.123Z");
const file = {
  id: "f-1",
  route: "files",
  key: "users/u-1/f-1.bin",
  name: "f-1.bin",
  type: "application/octet-stream",
  size: 10,
  metadata: null,
};

describe("Postgres, tables in a schema", () => {
  const db = usePostgresDatabase();
  const schema = useAppSchema(db);

  describeStoreContract(
    "sql adapter, node-postgres, tables.schema",
    sqlStoreTarget(db, (tables) => sqlStore(pgExecutor(db.pool), { tables, transaction: true }), {}, schema),
  );
  describeStoreContract(
    "drizzle, node-postgres, tables.schema",
    sqlStoreTarget(
      db,
      (tables) => drizzleStore(drizzle({ client: db.pool }), { dialect: "postgres", tables, transaction: true }),
      {},
      schema,
    ),
  );

  describe("rows", () => {
    // The search path's default tables, and an empty schema the rows fill as they need.
    beforeEach(async () => {
      await db.reset();
      await db.createTables();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.query(`CREATE SCHEMA ${schema}`);
    });

    test("the store writes the schema's tables, not the search path's, and Drizzle's tables read them", async () => {
      await db.createTables({ schema });
      const tables = { schema };
      expect(
        await sqlStore(pgExecutor(db.pool), { tables }).reserve(
          { owner: "u-1", limit: null, expiresAt: NOW, files: [file] },
          NOW,
        ),
      ).toEqual(["reserved"]);
      const inSchema = rawReader(db, tables);
      expect((await inSchema.files()).map(({ id, status }) => ({ id, status }))).toEqual([
        { id: "f-1", status: "pending" },
      ]);
      expect(await inSchema.usages()).toMatchObject([{ owner: "u-1", reservedBytes: 10 }]);
      const onSearchPath = rawReader(db);
      expect({ files: await onSearchPath.files(), usage: await onSearchPath.usages() }).toEqual({
        files: [],
        usage: [],
      });

      const { files } = cloudropPgTables({ tables });
      expect(await drizzle({ client: db.pool }).select({ id: files.id, owner: files.owner }).from(files)).toEqual([
        { id: "f-1", owner: "u-1" },
      ]);
    });

    test("a table missing from the schema fails the first call with INVALID_CONFIG naming the qualified table", async () => {
      // The search path has a cloudrop_files; an unqualified check would find it and pass.
      const store = sqlStore(pgExecutor(db.pool), { tables: { schema } });
      await expect(store.get("f-1")).rejects.toMatchObject({
        code: "INVALID_CONFIG",
        message: `The table "${schema}"."cloudrop_files" does not exist. Create the store's tables as the cloudrop docs show, or pass their names in { tables }.`,
      });
    });
  });
});
