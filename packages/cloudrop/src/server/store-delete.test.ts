import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { type MemoryTx, memoryStore } from "../testing/memory-store.ts";
import { gate, hello, leaseStore, NOW, storeFixture, TEXT } from "../testing/store-fixture.ts";
import { route, routeFor } from "./route.ts";
import type { DeleteContext } from "./store.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Mode = "transaction" | "lease";
const MODES: Mode[] = ["transaction", "lease"];

/** One onDelete call as the hook saw it. */
interface Seen {
  id: string;
  owner: string | null;
  reason: string;
  status: string;
  tx: boolean;
}

/**
 * A server whose "files" route (one file per owner with `replace`) records each onDelete call, writes an app row through
 * `tx` when it has one, and throws while `failing` is set. `pause` stops the next call until the test opens it.
 */
function deleting(mode: Mode, options: { replace?: boolean } = {}) {
  const memory = memoryStore();
  const seen: Seen[] = [];
  const state = { failing: false, pause: undefined as (() => Promise<void>) | undefined };
  const onDelete = async ({ file, owner, reason, tx }: DeleteContext & { tx?: MemoryTx }) => {
    const pause = state.pause;
    state.pause = undefined;
    await pause?.();
    seen.push({ id: file.id, owner, reason, status: file.status, tx: tx !== undefined });
    tx?.write(`${reason} ${file.id}`);
    if (state.failing) throw new Error("The audit table is down.");
  };
  const policy = { accept: "*/*", maxSize: 1024, replace: options.replace, authorize: () => ({ userId: "u1" }) };
  const callbacks = { owner: ({ userId }: { userId: string }) => userId, onDelete };
  const files =
    mode === "transaction" ? routeFor<{ tx: MemoryTx }>(memory)(policy, callbacks) : route(policy, callbacks);
  const fixture = storeFixture({ files }, { store: mode === "transaction" ? memory : leaseStore(memory) });
  const upload = async () => {
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, hello);
    return ticket;
  };
  const uploaded = async () => {
    const ticket = await upload();
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    return ticket;
  };
  const status = async (id: string) => (await fixture.cloudrop.api.file(id)).data?.status;
  const stored = async (key: string) => (await fixture.storage.head(key)).data !== null;
  return { fixture, memory, seen, state, upload, uploaded, status, stored };
}

const kept = {
  code: "SERVER_ERROR",
  retryable: true,
  message:
    'onDelete failed for route "files", so the file was kept. Its error is in the server log; fix it and try again.',
};

describe("onDelete with api.deleteFile", () => {
  it.for(MODES)("%s: runs once with the completed row, the owner and reason deleted", async (mode) => {
    const { fixture, memory, seen, uploaded, status } = deleting(mode);
    const ticket = await uploaded();
    const { api } = fixture.cloudrop;
    expect(await api.deleteFile(ticket.id)).toEqual({ data: { id: ticket.id }, error: null });
    expect(await api.deleteFile(ticket.id)).toEqual({ data: { id: ticket.id }, error: null });
    const tx = mode === "transaction";
    expect(seen).toEqual([{ id: ticket.id, owner: "u1", reason: "deleted", status: "completed", tx }]);
    expect(await status(ticket.id)).toBe("deleted");
    expect(memory.appRows()).toEqual(tx ? [`deleted ${ticket.id}`] : []);
  });

  it.for(MODES)("%s: a throw keeps the file, its bytes and its object, and deleteFile answers why", async (mode) => {
    const { fixture, memory, state, uploaded, status, stored } = deleting(mode);
    const ticket = await uploaded();
    const { api } = fixture.cloudrop;
    state.failing = true;
    expect(await api.deleteFile(ticket.id)).toEqual({ data: null, error: expect.objectContaining(kept) });
    expect([await status(ticket.id), await stored(ticket.key)]).toEqual(["completed", true]);
    expect(await memory.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 5, files: 1 });
    expect(memory.appRows()).toEqual([]);
    expect(fixture.logger.errors).toEqual([
      {
        message: `cloudrop: onDelete failed for route "files" while deleting file ${ticket.id}.`,
        error: new Error("The audit table is down."),
      },
    ]);
    state.failing = false;
    expect((await api.deleteFile(ticket.id)).error).toBeNull();
    expect([await status(ticket.id), await stored(ticket.key)]).toEqual(["deleted", false]);
  });

  it("transaction: two deletions at once commit onDelete's writes once", async () => {
    const { fixture, memory, seen, state, uploaded } = deleting("transaction");
    const ticket = await uploaded();
    const first = gate();
    state.pause = first.pass;
    const { api } = fixture.cloudrop;
    const slow = api.deleteFile(ticket.id);
    await first.arrived;
    expect((await api.deleteFile(ticket.id)).error).toBeNull();
    first.open();
    expect((await slow).error).toBeNull();
    // Both ran, but the slow one found the row already deleted and rolled its writes back.
    expect(seen.map((call) => call.id)).toEqual([ticket.id, ticket.id]);
    expect(memory.appRows()).toEqual([`deleted ${ticket.id}`]);
  });

  it.for(MODES)("%s: a file that never completed runs no onDelete", async (mode) => {
    const { fixture, seen, upload } = deleting(mode);
    const ticket = await upload();
    expect((await fixture.cloudrop.api.deleteFile(ticket.id)).error?.code).toBe("NOT_FOUND");
    expect(seen).toEqual([]);
  });
});

describe("onDelete with api.eraseOwner", () => {
  it.for(MODES)("%s: runs with reason erased; a throw keeps the file and counts it failed", async (mode) => {
    const { fixture, seen, state, uploaded, status } = deleting(mode);
    const ticket = await uploaded();
    const { api } = fixture.cloudrop;
    state.failing = true;
    expect((await api.eraseOwner("u1")).data).toEqual({
      revoked: 0,
      deleted: 0,
      cleaned: 0,
      failed: 1,
      // Still completed, so also a live file the run could not prove gone.
      waiting: 1,
      done: false,
    });
    expect(await status(ticket.id)).toBe("completed");
    state.failing = false;
    expect((await api.eraseOwner("u1")).data).toMatchObject({ deleted: 1, failed: 0 });
    expect(await status(ticket.id)).toBe("deleted");
    const tx = mode === "transaction";
    const call = { id: ticket.id, owner: "u1", reason: "erased", status: "completed", tx };
    expect(seen).toEqual([call, call]);
  });
});

describe("onDelete with replace", () => {
  it.for(MODES)("%s: runs for the replaced file with reason replaced", async (mode) => {
    const { fixture, memory, seen, uploaded, status } = deleting(mode, { replace: true });
    const previous = await uploaded();
    const next = await uploaded();
    const tx = mode === "transaction";
    expect(seen).toEqual([{ id: previous.id, owner: "u1", reason: "replaced", status: "completed", tx }]);
    expect([await status(previous.id), await status(next.id)]).toEqual(["deleted", "completed"]);
    expect(memory.appRows()).toEqual(tx ? [`replaced ${previous.id}`] : []);
    expect((await fixture.cloudrop.api.files({ owner: "u1" })).data?.items.map((file) => file.id)).toEqual([next.id]);
  });

  it.for(MODES)("%s: a throw keeps the previous file and fails /complete, which a retry finishes", async (mode) => {
    const { fixture, memory, state, uploaded, upload, status } = deleting(mode, { replace: true });
    const previous = await uploaded();
    const next = await upload();
    state.failing = true;
    const failed = await complete(fixture, next.token);
    expect([failed.status, failed.body.error]).toEqual([
      500,
      {
        code: "SERVER_ERROR",
        message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
        retryable: true,
      },
    ]);
    expect([await status(previous.id), await status(next.id)]).toEqual(["completed", "pending"]);
    expect(await memory.usage("u1")).toEqual({ reservedBytes: 5, activeBytes: 5, files: 1 });
    state.failing = false;
    expect((await complete(fixture, next.token)).status).toBe(200);
    expect([await status(previous.id), await status(next.id)]).toEqual(["deleted", "completed"]);
  });

  // Without a transaction onDelete runs before the replacing completion is recorded. A file that completes in between is
  // replaced too, so its onDelete runs right after, and every replaced file has had one.
  it("lease: a file completed while onDelete ran is replaced too, and its onDelete runs after", async () => {
    const { fixture, seen, state, uploaded, upload, status } = deleting("lease", { replace: true });
    const first = await uploaded();
    const slow = await upload();
    const fast = await upload();
    const paused = gate();
    state.pause = paused.pass;
    const slowCompletion = complete(fixture, slow.token);
    await paused.arrived;
    expect((await complete(fixture, fast.token)).status).toBe(200);
    paused.open();
    expect((await slowCompletion).status).toBe(200);
    expect(seen.map(({ id, reason }) => [id, reason])).toEqual([
      [first.id, "replaced"],
      [first.id, "replaced"],
      [fast.id, "replaced"],
    ]);
    expect([await status(first.id), await status(fast.id), await status(slow.id)]).toEqual([
      "deleted",
      "deleted",
      "completed",
    ]);
  });
});
