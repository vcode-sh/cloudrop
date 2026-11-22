// Deletions that race another change of the same file (M11-R150 to M11-R152): each caller answers from what it read,
// and no completed file ever becomes deleted without its onDelete.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { deleting, MODES } from "../testing/delete-fixture.ts";
import { gate, NOW } from "../testing/store-fixture.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const RETRY = {
  code: "SERVER_ERROR",
  message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
  retryable: true,
};

describe("api.deleteFile racing the completion of its file", () => {
  // The deletion read the upload while it was unfinished, so it chose no hook. Ending the row after that read would
  // delete the file the completion recorded meanwhile, with no onDelete: no audit row, no pointer cleared.
  it.for(MODES)("%s: an upload read before it completed is not deleted, and keeps its onDelete", async (mode) => {
    const { fixture, memory, seen, state, upload, status, stored } = deleting(mode);
    const ticket = await upload();
    const read = gate();
    state.read = read.pass;
    const { api } = fixture.cloudrop;
    const deletion = api.deleteFile(ticket.id);
    await read.arrived;
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    read.open();
    expect((await deletion).error?.code).toBe("NOT_FOUND");
    expect([await status(ticket.id), await stored(ticket.key), seen, memory.appRows()]).toEqual([
      "completed",
      true,
      [],
      [],
    ]);
    expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, deleted: true, cleaned: false });
    expect(seen.map((call) => [call.id, call.reason])).toEqual([[ticket.id, "deleted"]]);
  });
});

describe("api.eraseOwner racing another deletion of a file", () => {
  // Its hook threw only because it lost the race (M10-D7): the file is gone, and this run did not delete it.
  it.for(MODES)("%s: a file another call deleted while its onDelete ran is counted nowhere", async (mode) => {
    const { fixture, state, uploaded } = deleting(mode);
    const ticket = await uploaded();
    // Past the file's URLs and the grace, so the call that deletes it also proves it clean.
    vi.setSystemTime(NOW.getTime() + 2 * 3_600_000);
    state.unique = true;
    const paused = gate();
    state.pause = paused.pass;
    const { api } = fixture.cloudrop;
    const erasing = api.eraseOwner("u1");
    await paused.arrived;
    expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, deleted: true, cleaned: true });
    paused.open();
    expect((await erasing).data).toEqual({
      requestedAt: new Date(NOW.getTime() + 2 * 3_600_000),
      revoked: 0,
      deleted: 0,
      refused: 0,
      cleaned: 0,
      failed: 0,
      waiting: 0,
      prefixed: 0,
      done: true,
    });
  });
});

describe("a replacement racing another change of the owner's files", () => {
  // The listing held only the first file; the record would replace the one completed since, for which no onDelete ran.
  it("transaction: a file completed between the listing and the record rolls the replacement back", async () => {
    const { fixture, memory, seen, state, uploaded, upload, status } = deleting("transaction", { replace: true });
    const first = await uploaded();
    const slow = await upload();
    const fast = await upload();
    const paused = gate();
    state.pause = paused.pass;
    const slowCompletion = complete(fixture, slow.token);
    await paused.arrived;
    expect((await complete(fixture, fast.token)).status).toBe(200);
    paused.open();
    const rolledBack = await slowCompletion;
    expect([rolledBack.status, rolledBack.body.error]).toEqual([500, RETRY]);
    expect([await status(first.id), await status(fast.id), await status(slow.id)]).toEqual([
      "deleted",
      "completed",
      "pending",
    ]);
    // The slow completion's onDelete for the first file was undone with it: only the fast one's write stays.
    expect(memory.appRows()).toEqual([`replaced ${first.id}`]);
    expect((await complete(fixture, slow.token)).status).toBe(200);
    expect([await status(fast.id), await status(slow.id)]).toEqual(["deleted", "completed"]);
    expect(seen.map((call) => call.id)).toEqual([first.id, first.id, fast.id]);
    expect(memory.appRows()).toEqual([`replaced ${first.id}`, `replaced ${fast.id}`]);
  });

  // deleteFile and eraseOwner answer a hook that threw for having lost the race as a file already deleted. A
  // replacement does not read the file again: it asks its client to retry, and the retry finds nothing to replace.
  it.for(MODES)(
    "%s: an onDelete that throws after a deletion won fails /complete, which a retry finishes",
    async (mode) => {
      const { fixture, state, uploaded, upload, status } = deleting(mode, { replace: true });
      const previous = await uploaded();
      const next = await upload();
      state.unique = true;
      const paused = gate();
      state.pause = paused.pass;
      const replacing = complete(fixture, next.token);
      await paused.arrived;
      expect((await fixture.cloudrop.api.deleteFile(previous.id)).data?.deleted).toBe(true);
      paused.open();
      const failed = await replacing;
      expect([failed.status, failed.body.error]).toEqual([500, RETRY]);
      expect([await status(previous.id), await status(next.id)]).toEqual(["deleted", "pending"]);
      expect((await complete(fixture, next.token)).status).toBe(200);
      expect(await status(next.id)).toBe("completed");
    },
  );
});
