// claim, release and complete: the guarded steps that let exactly one /complete run onComplete, and move its bytes.

import { expect, it } from "vitest";
import { at, LEASE, MINUTE, newFile, pendingRow, type StoreSuite, usageRow } from "./suite.ts";

export function claimCases(suite: StoreSuite): void {
  const { skipWithout, rawFile, seed, advance } = suite;
  const file = newFile("f-1", 100);

  it("claim takes a pending row; another claim is busy until the lease has passed, then takes it over", async () => {
    const { store } = suite;
    await seed("u-1", [file]);
    expect(await store.claim("f-1", "claim-a", at(MINUTE), LEASE)).toEqual({ kind: "claimed" });
    expect(await rawFile("f-1")).toEqual(
      pendingRow(file, "u-1", { status: "completing", claim: "claim-a", claimedAt: at(MINUTE), updatedAt: at(MINUTE) }),
    );
    // Exactly one lease after the claim it is still live; one millisecond later it is over.
    expect(await store.claim("f-1", "claim-b", at(MINUTE + LEASE), LEASE)).toEqual({ kind: "busy" });
    expect(await store.claim("f-1", "claim-b", at(MINUTE + LEASE + 1), LEASE)).toEqual({ kind: "claimed" });
    expect(await rawFile("f-1")).toMatchObject({ claim: "claim-b", claimedAt: at(MINUTE + LEASE + 1) });
  });

  it("claim with the holder's own token while its claim lives is busy and leaves the claim as it was", async () => {
    const { store } = suite;
    await seed("u-1", [file]);
    await store.claim("f-1", "claim-a", at(MINUTE), LEASE);
    expect(await store.claim("f-1", "claim-a", at(2 * MINUTE), LEASE)).toEqual({ kind: "busy" });
    expect(await rawFile("f-1")).toEqual(
      pendingRow(file, "u-1", { status: "completing", claim: "claim-a", claimedAt: at(MINUTE), updatedAt: at(MINUTE) }),
    );
  });

  it("claim takes a pending row past its token's deadline: the server, not the store, checks the deadline", async () => {
    const { store } = suite;
    await seed("u-1", [file], at(0));
    expect(await store.claim("f-1", "claim-a", at(MINUTE), LEASE)).toEqual({ kind: "claimed" });
  });

  it("claim answers a completed row with its record, an ended row with its record, and a missing row", async () => {
    const { store } = suite;
    await seed("u-1", [file, newFile("f-2", 10)]);
    await advance("f-1", "completed", at(MINUTE));
    await advance("f-2", "aborted", at(MINUTE));
    expect(await store.claim("f-1", "claim-x", at(2 * MINUTE), LEASE)).toEqual({
      kind: "completed",
      record: await store.get("f-1"),
    });
    expect(await store.claim("f-2", "claim-x", at(2 * MINUTE), LEASE)).toEqual({
      kind: "ended",
      record: await store.get("f-2"),
    });
    expect((await store.get("f-2"))?.status).toBe("aborted");
    expect(await store.claim("missing", "claim-x", at(2 * MINUTE), LEASE)).toEqual({ kind: "missing" });
  });

  it("exactly one of many concurrent claims wins", async (ctx) => {
    const { store } = suite;
    skipWithout(ctx, "concurrency");
    await seed("u-1", [file]);
    const claims = Array.from({ length: 16 }, (_, index) => `claim-${index}`);
    const outcomes = await Promise.all(claims.map((claim) => store.claim("f-1", claim, at(MINUTE), LEASE)));
    const winners = claims.filter((_, index) => outcomes[index]?.kind === "claimed");
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "busy")).toHaveLength(15);
    expect((await rawFile("f-1"))?.claim).toBe(winners[0]);
  });

  it("release hands the row back only for its own claim, so the next claim succeeds at once", async () => {
    const { store, raw } = suite;
    await seed("u-1", [file]);
    await store.claim("f-1", "claim-a", at(MINUTE), LEASE);
    expect(await store.release("f-1", "claim-b", at(2 * MINUTE))).toBe(false);
    expect(await store.release("f-1", "claim-a", at(2 * MINUTE))).toBe(true);
    expect(await rawFile("f-1")).toEqual(pendingRow(file, "u-1", { updatedAt: at(2 * MINUTE) }));
    expect(await raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 100 })]);
    expect(await store.release("f-1", "claim-a", at(3 * MINUTE))).toBe(false);
    expect(await store.claim("f-1", "claim-c", at(3 * MINUTE), LEASE)).toEqual({ kind: "claimed" });
  });

  it("complete moves the size from reserved to active bytes and counts the file, once", async () => {
    const { store, raw } = suite;
    await seed("u-1", [file, newFile("f-2", 30)]);
    await store.claim("f-1", "claim-a", at(MINUTE), LEASE);
    const completed = pendingRow(file, "u-1", {
      status: "completed",
      claim: "claim-a",
      claimedAt: at(MINUTE),
      result: '{"photoId":7}',
      completedAt: at(2 * MINUTE),
      updatedAt: at(2 * MINUTE),
    });
    const { claim: _claim, updatedAt: _updatedAt, requestKey: _requestKey, ...record } = completed;
    expect(await store.complete("f-1", "claim-a", '{"photoId":7}', at(2 * MINUTE))).toEqual({
      changed: true,
      record,
      replaced: [],
    });
    expect(await rawFile("f-1")).toEqual(completed);
    const counted = [usageRow("u-1", { reservedBytes: 30, activeBytes: 100, files: 1, updatedAt: at(2 * MINUTE) })];
    expect(await raw.usage()).toEqual(counted);
    // A repeat is a replay: the stored row, and nothing counted twice.
    expect(await store.complete("f-1", "claim-a", "{}", at(3 * MINUTE))).toEqual({
      changed: false,
      record,
      replaced: [],
    });
    expect(await raw.usage()).toEqual(counted);
    expect(await store.complete("missing", "claim-a", null, at(3 * MINUTE))).toEqual({
      changed: false,
      record: null,
      replaced: [],
    });
  });

  it("a claim lost to a later /complete can neither complete nor release the row", async () => {
    const { store, raw } = suite;
    await seed("u-1", [file]);
    await store.claim("f-1", "claim-a", at(0), LEASE);
    await store.claim("f-1", "claim-b", at(LEASE + 1), LEASE);
    const lost = await store.complete("f-1", "claim-a", "{}", at(LEASE + 2));
    expect(lost).toEqual({ changed: false, record: await store.get("f-1"), replaced: [] });
    expect(lost.record).toMatchObject({ status: "completing", claimedAt: at(LEASE + 1), result: null });
    expect(await store.release("f-1", "claim-a", at(LEASE + 2))).toBe(false);
    expect(await raw.usage()).toEqual([usageRow("u-1", { reservedBytes: 100 })]);
    expect((await store.complete("f-1", "claim-b", null, at(LEASE + 3))).changed).toBe(true);
  });
}
