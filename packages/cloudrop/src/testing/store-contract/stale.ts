// stale: the sweep's two kinds of work, their exact cut-offs, and keyset paging that survives the sweep's own changes.

import { expect, it } from "vitest";
import type { FileRecord } from "../../server/store.ts";
import { at, EXPIRES, LEASE, MINUTE, newFile, type StoreSuite } from "./suite.ts";

const ids = (page: { records: FileRecord[] }) => page.records.map((record) => record.id);

export function staleCases(suite: StoreSuite): void {
  const { seed, advance } = suite;
  const before = EXPIRES;
  const claimedBefore = at(10 * MINUTE);

  it("expire finds pending rows past their deadline and completing rows whose deadline and lease have both passed", async () => {
    const { store } = suite;
    const early = new Date(EXPIRES.getTime() - 1);
    await seed("u-1", [newFile("e-pending", 1), newFile("e-claim-dead", 1), newFile("e-claim-live", 1)], early);
    await seed("u-1", [newFile("e-completed", 1), newFile("e-aborted", 1)], early);
    // Deadline exactly at the cut-off: not before it, so not stale.
    await seed("u-1", [newFile("n-pending-at", 1), newFile("n-claim-at", 1)], EXPIRES);
    await advance("e-claim-dead", "completing", new Date(claimedBefore.getTime() - 1));
    await advance("e-claim-live", "completing", claimedBefore);
    await advance("n-claim-at", "completing", at(0));
    await advance("e-completed", "completed", at(0));
    await advance("e-aborted", "aborted", at(0));
    const found = await store.stale({ kind: "expire", before, claimedBefore, limit: 10, cursor: null });
    expect(ids(found)).toEqual(["e-claim-dead", "e-pending"]);
    expect(found.cursor).toBeNull();
  });

  it("cleanup finds aborted, rejected, failed, expired and deleted rows not yet cleaned that ended before the cut-off", async () => {
    const { store } = suite;
    const names = ["c-aborted", "c-rejected", "c-failed", "c-deleted", "c-expired"];
    names.push("n-expired", "n-cleaned", "n-at", "n-pending");
    await seed(
      "u-1",
      names.map((id) => newFile(id, 1)),
    );
    const ended = new Date(before.getTime() - 1);
    await advance("c-aborted", "aborted", ended);
    await advance("c-rejected", "rejected", ended);
    await advance("c-failed", "failed", ended);
    await advance("c-deleted", "deleted", ended);
    // The sweep ends an expired row before it cleans up after it: one it has not cleaned yet is cleanup work.
    await advance("c-expired", "expired", ended);
    await advance("n-expired", "expired", ended);
    await store.cleaned("n-expired", ended);
    await advance("n-cleaned", "aborted", ended);
    await store.cleaned("n-cleaned", ended);
    await advance("n-at", "aborted", before);
    const found = await store.stale({ kind: "cleanup", before, claimedBefore, limit: 10, cursor: null });
    expect(ids(found)).toEqual(["c-aborted", "c-deleted", "c-expired", "c-failed", "c-rejected"]);
  });

  it("expire pages by deadline then id, skips nothing when the sweep ends rows between pages, and ends with null", async () => {
    const { store } = suite;
    // f-3 and f-4 share a deadline, so the id decides between them.
    for (const [id, minutes] of [
      ["f-5", 1],
      ["f-4", 2],
      ["f-3", 2],
      ["f-2", 3],
      ["f-1", 4],
    ] as const) {
      await seed("u-1", [newFile(id, 1)], at(minutes * MINUTE));
    }
    const ask = (cursor: string | null, limit = 2) =>
      store.stale({ kind: "expire", before, claimedBefore, limit, cursor });
    const first = await ask(null);
    expect(ids(first)).toEqual(["f-5", "f-3"]);
    // The sweep ends the rows it was given before it asks for the next page.
    for (const id of ids(first)) await store.end(id, "pending", "expired", at(LEASE), { cleaned: true });
    const second = await ask(first.cursor);
    expect(ids(second)).toEqual(["f-4", "f-2"]);
    const third = await ask(second.cursor);
    expect(third).toMatchObject({ cursor: null });
    expect(ids(third)).toEqual(["f-1"]);
    // A page that ends exactly at the last row is the last page too.
    expect(await ask(null, 3)).toMatchObject({ cursor: null });
  });

  it("expire pages through a deadline that pending and completing rows share, in id order across both", async () => {
    const { store } = suite;
    // One deadline for all four, and the ids alternate between the statuses: a page read status by status must still
    // answer them in id order, and a cursor inside the tie must skip none of either status.
    await seed("u-1", [newFile("f-a", 1), newFile("f-b", 1), newFile("f-c", 1), newFile("f-d", 1)], at(MINUTE));
    await advance("f-a", "completing", at(0));
    await advance("f-c", "completing", at(0));
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const page = await store.stale({ kind: "expire", before, claimedBefore, limit: 1, cursor });
      pages.push(ids(page));
      cursor = page.cursor;
    } while (cursor !== null);
    expect(pages).toEqual([["f-a"], ["f-b"], ["f-c"], ["f-d"]]);
  });

  it("expire orders and pages ids of one deadline in byte order, also past U+FFFF", async () => {
    const { store } = suite;
    // In a JavaScript string U+1F600 (surrogates D83D DE00) sorts before U+E000; in bytes, after it.
    const [emoji, privateUse] = ["f-\u{1f600}", "f-\ue000"];
    await seed("u-1", [newFile(emoji, 1), newFile(privateUse, 1), newFile("f-z", 1)], at(MINUTE));
    const first = await store.stale({ kind: "expire", before, claimedBefore, limit: 2, cursor: null });
    expect(ids(first)).toEqual(["f-z", privateUse]);
    const second = await store.stale({ kind: "expire", before, claimedBefore, limit: 2, cursor: first.cursor });
    expect(ids(second)).toEqual([emoji]);
  });

  it("cleanup pages by end time then id, and ends with null", async () => {
    const { store } = suite;
    await seed("u-1", [newFile("f-1", 1), newFile("f-2", 1), newFile("f-3", 1)]);
    await advance("f-1", "aborted", at(3 * MINUTE));
    await advance("f-2", "aborted", at(MINUTE));
    // f-2 and f-3 ended at the same time, so the id decides between them, and one row per page puts the page
    // boundary inside the tie: a cursor that kept only the time would skip f-3.
    await advance("f-3", "rejected", at(MINUTE));
    const ask = (cursor: string | null) => store.stale({ kind: "cleanup", before, claimedBefore, limit: 1, cursor });
    const first = await ask(null);
    expect(ids(first)).toEqual(["f-2"]);
    const second = await ask(first.cursor);
    expect(ids(second)).toEqual(["f-3"]);
    const third = await ask(second.cursor);
    expect(third).toMatchObject({ cursor: null });
    expect(ids(third)).toEqual(["f-1"]);
  });
}
