// transaction, and the table options of SQL stores: custom table names and the schema check's message.

import { expect, it } from "vitest";
import { at, EXPIRES, LEASE, MINUTE, newFile, pendingRow, provided, type StoreSuite, usageRow } from "./suite.ts";

export function transactionCases(suite: StoreSuite): void {
  const { skipWithout, rawFile, seed } = suite;
  const file = newFile("f-1", 100);

  it("transaction commits the claim and completion made through its store", async (ctx) => {
    const { store, raw } = suite;
    skipWithout(ctx, "transaction");
    const transaction = provided(store.transaction, "transaction").bind(store);
    await seed("u-1", [file]);
    const answer = await transaction(async (_tx, inner) => {
      expect(await inner.claim("f-1", "claim-a", at(MINUTE), LEASE)).toEqual({ kind: "claimed" });
      return (await inner.complete("f-1", "claim-a", '{"ok":true}', at(MINUTE))).changed;
    });
    expect(answer).toBe(true);
    expect(await rawFile("f-1")).toMatchObject({ status: "completed", result: '{"ok":true}' });
    expect(await raw.usage()).toEqual([usageRow("u-1", { activeBytes: 100, files: 1, updatedAt: at(MINUTE) })]);
  });

  it("transaction rolls back every write made through its store on a throw, and rethrows it", async (ctx) => {
    const { store, raw } = suite;
    skipWithout(ctx, "transaction");
    const transaction = provided(store.transaction, "transaction").bind(store);
    await seed("u-1", [file]);
    const thrown = new Error("onComplete failed");
    const failing = transaction(async (_tx, inner) => {
      await inner.claim("f-1", "claim-a", at(MINUTE), LEASE);
      await inner.complete("f-1", "claim-a", "{}", at(MINUTE));
      throw thrown;
    });
    await expect(failing).rejects.toBe(thrown);
    expect(await raw.files()).toEqual([pendingRow(file, "u-1")]);
    expect(await raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 100 })]);
  });

  it("a rolled-back transaction keeps what other calls wrote meanwhile", async (ctx) => {
    const { store, raw } = suite;
    skipWithout(ctx, "transaction");
    const transaction = provided(store.transaction, "transaction").bind(store);
    await seed("u-1", [file]);
    const failing = transaction(async (_tx, inner) => {
      await inner.claim("f-1", "claim-a", at(MINUTE), LEASE);
      await store.reserve(
        { owner: "u-2", limit: null, expiresAt: EXPIRES, requestKey: null, files: [newFile("f-2", 7)] },
        at(MINUTE),
      );
      throw new Error("onComplete failed");
    });
    await expect(failing).rejects.toThrow("onComplete failed");
    expect((await raw.files()).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "f-1", status: "pending" },
      { id: "f-2", status: "pending" },
    ]);
    expect(await store.usage("u-2")).toEqual({ reservedBytes: 7, activeBytes: 0, files: 0, erasure: null });
  });

  it("a store built with custom table names writes those tables and no others", async (ctx) => {
    const { raw, target } = suite;
    skipWithout(ctx, "tables");
    const renamed = provided(target.tables, "tables").renamed;
    expect(
      await renamed.store.reserve(
        { owner: "u-1", limit: null, expiresAt: EXPIRES, requestKey: null, files: [file] },
        at(0),
      ),
    ).toEqual(["reserved"]);
    expect(await renamed.raw.files()).toEqual([pendingRow(file, "u-1")]);
    expect(await renamed.raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 100 })]);
    expect({ files: await raw.files(), usage: await raw.usage() }).toEqual({ files: [], usage: [] });
  });

  it("a files table missing a column fails with INVALID_CONFIG naming the table and the column", async (ctx) => {
    const { target } = suite;
    skipWithout(ctx, "tables");
    const { store, table, column } = provided(target.tables, "tables").missingColumn;
    await expect(store.get("f-1")).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringMatching(new RegExp(`${table}.*${column}|${column}.*${table}`)),
    });
  });

  it("tables that were never created fail with INVALID_CONFIG naming the files table, on every call", async (ctx) => {
    const { target } = suite;
    skipWithout(ctx, "tables");
    const { store, table } = provided(target.tables, "tables").missingTable;
    const missing = {
      code: "INVALID_CONFIG",
      message: expect.stringMatching(
        new RegExp(`^The table (?:"\\w+"\\.)?"${table}" does not exist\\. Create the store's tables`),
      ),
    };
    await expect(store.get("f-1")).rejects.toMatchObject(missing);
    // A failed check is not remembered as passed: the next call checks again.
    await expect(store.usage("u-1")).rejects.toMatchObject(missing);
  });
}
