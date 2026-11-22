// defineStore (M12-S2): a hand-written store gets the store's code from it; an adapter's store keeps that code through
// a spread copy; and code from another copy of cloudrop is refused.

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteExecutor, sqlStore } from "../adapters/sql.ts";
import { CloudropError } from "../errors.ts";
import { route } from "../server/route.ts";
import type { CloudropStore } from "../server/store.ts";
import { STORE_PATHS } from "../server/store-paths.ts";
import { complete } from "../testing/complete-fixture.ts";
import { schemaStatements } from "../testing/db/schema.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { hello, owned, TEXT } from "../testing/store-fixture.ts";
import { defineStore } from "./define-store.ts";

/** Uploads and completes one file of "u1" through a server on `store`, then reads its row through the api. */
async function completedRow(store: CloudropStore<unknown>) {
  const fixture = serverFixture({ owned }, { store });
  const ticket = await fixture.single("owned", TEXT);
  await fixture.send(ticket.put, hello);
  await complete(fixture, ticket.token);
  return { id: ticket.id, row: await fixture.cloudrop.api.file(ticket.id) };
}

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("defineStore", () => {
  it("gives a hand-written store the store's code: an upload completes and its row reads back", async () => {
    // Every method copied by name, as a hand-written store has them: no symbol properties.
    const methods = Object.fromEntries(Object.entries(memoryStore())) as unknown as CloudropStore<unknown>;
    const { id, row } = await completedRow(defineStore(methods));
    expect(row).toEqual({ data: expect.objectContaining({ id, owner: "u1", status: "completed" }), error: null });
  });

  it("is not needed for an adapter's store copied with spread, which keeps the store's code", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    for (const statement of schemaStatements("sqlite")) database.exec(statement);
    const { id, row } = await completedRow({ ...sqlStore(sqliteExecutor(database)), extra: 1 } as CloudropStore);
    expect(row).toEqual({ data: expect.objectContaining({ id, owner: "u1", status: "completed" }), error: null });
  });

  it("refuses store code from another copy of cloudrop, whose version differs", async () => {
    const store = { ...memoryStore(), [STORE_PATHS]: { version: 2 } };
    const { cloudrop } = serverFixture({ owned }, { store });
    expect(await cloudrop.api.file("f1")).toEqual({
      data: null,
      error: expect.objectContaining({
        code: "INVALID_CONFIG",
        message: "cloudrop is installed twice: the store's adapter comes from another copy. Install cloudrop once.",
      }),
    });
  });

  // Every other construction-time mistake answers INVALID_CONFIG naming the fix; defineStore did not (M12-R4).
  it.for([
    { name: "undefined", given: undefined },
    { name: "null", given: null },
    { name: "a string", given: "store" },
  ])("refuses $name with INVALID_CONFIG", ({ given }) => {
    expect(() => defineStore(given as never)).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message: "defineStore takes the store object, with the CloudropStore methods, such as defineStore(myStore).",
      }),
    );
  });

  it("refuses a frozen store with INVALID_CONFIG, naming the fix", () => {
    expect(() => defineStore(Object.freeze({ ...memoryStore() }))).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          "defineStore cannot attach the store code to a frozen or sealed store. Pass the store before freezing it, or a copy made with spread ({ ...store }).",
      }),
    );
  });

  // A store from a second installed copy of the same version runs that copy's deletion code, which must still read the
  // app's CloudropError as a refusal (M12-R2).
  it("lets a store from a second copy of cloudrop keep a file whose onDelete refuses with the app's CloudropError", async () => {
    vi.resetModules();
    const secondCopy: typeof import("../testing.ts") = await import("../testing.ts");
    const refusal = new CloudropError("FORBIDDEN", "Keep it.");
    const kept = route(
      { accept: "*/*", maxSize: 1024, authorize: () => ({ userId: "u1" }) },
      { owner: ({ userId }) => userId, onDelete: () => refusal },
    );
    const fixture = serverFixture({ kept }, { store: secondCopy.memoryStore() });
    const ticket = await fixture.single("kept", TEXT);
    await fixture.send(ticket.put, hello);
    await complete(fixture, ticket.token);
    expect([await fixture.cloudrop.api.deleteFile(ticket.id), fixture.logger.errors]).toEqual([
      { data: null, error: refusal },
      [],
    ]);
  });
});
