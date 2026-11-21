import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { deleting, MODES } from "../testing/delete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { gate, hello, leaseStore, NOW, owned, recordCalls, storeFixture, TEXT } from "../testing/store-fixture.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** What deleteFile answers beside the id, inside the hour and a quarter in which the file's URLs could put it back. */
const first = { deleted: true, cleaned: false };
const again = { deleted: false, cleaned: false };

const kept = {
  code: "SERVER_ERROR",
  retryable: true,
  message:
    'onDelete failed for route "files", so the file was kept. Its error is in the server log; fix it and try again.',
};

describe("onDelete with api.deleteFile", () => {
  it.for(MODES)(
    "%s: runs once with the completed row, the owner, reason deleted and the caller's context",
    async (mode) => {
      const { fixture, memory, seen, uploaded, status } = deleting(mode);
      const ticket = await uploaded();
      const { api } = fixture.cloudrop;
      const context = { actorId: "admin-1", why: "spam" };
      expect((await api.deleteFile(ticket.id, { context })).data).toEqual({ id: ticket.id, ...first });
      expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, ...again });
      const tx = mode === "transaction";
      expect(seen).toEqual([
        { id: ticket.id, owner: "u1", reason: "deleted", status: "completed", tx, context, request: false },
      ]);
      expect(await status(ticket.id)).toBe("deleted");
      expect(memory.appRows()).toEqual(tx ? [`deleted ${ticket.id}`] : []);
    },
  );

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

  it("transaction: works on a store whose methods are inherited, as a class's are", async () => {
    const { fixture, memory, uploaded, status } = deleting("transaction", { inherited: true });
    const ticket = await uploaded();
    expect((await fixture.cloudrop.api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, ...first });
    expect([await status(ticket.id), memory.appRows()]).toEqual(["deleted", [`deleted ${ticket.id}`]]);
  });

  it("transaction: two deletions at once commit onDelete's writes once", async () => {
    const { fixture, memory, seen, state, uploaded } = deleting("transaction");
    const ticket = await uploaded();
    const paused = gate();
    state.pause = paused.pass;
    const { api } = fixture.cloudrop;
    const slow = api.deleteFile(ticket.id);
    await paused.arrived;
    expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, ...first });
    paused.open();
    expect((await slow).data).toEqual({ id: ticket.id, ...again });
    // Both ran, but the slow one found the row already deleted and rolled its writes back.
    expect(seen.map((call) => call.id)).toEqual([ticket.id, ticket.id]);
    expect(memory.appRows()).toEqual([`deleted ${ticket.id}`]);
  });

  // A hook can throw only because it lost the race, such as on an audit row keyed by the file: the file is gone all the
  // same, so the loser answers as for a file already deleted.
  it.for(MODES)("%s: an onDelete that throws after another deletion won answers the file deleted", async (mode) => {
    const { fixture, memory, state, uploaded, status } = deleting(mode);
    const ticket = await uploaded();
    state.unique = true;
    const paused = gate();
    state.pause = paused.pass;
    const { api } = fixture.cloudrop;
    const slow = api.deleteFile(ticket.id);
    await paused.arrived;
    expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, ...first });
    paused.open();
    expect(await slow).toEqual({ data: { id: ticket.id, ...again }, error: null });
    expect(await status(ticket.id)).toBe("deleted");
    expect(memory.appRows()).toEqual(mode === "transaction" ? [`deleted ${ticket.id}`] : []);
  });

  it.for(MODES)(
    "%s: a store failure after onDelete answers a retryable SERVER_ERROR and keeps the file",
    async (mode) => {
      const { fixture, memory, uploaded, status } = deleting(mode);
      const ticket = await uploaded();
      const { api } = fixture.cloudrop;
      memory.injectFailure("end", 0);
      expect((await api.deleteFile(ticket.id)).error).toEqual(
        expect.objectContaining({
          code: "SERVER_ERROR",
          retryable: true,
          message: "The server could not reach its upload records. Try again in a moment.",
        }),
      );
      expect([await status(ticket.id), memory.appRows()]).toEqual(["completed", []]);
      expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, ...first });
    },
  );

  it.for(MODES)("%s: a file whose route the server no longer has is deleted without any hook", async (mode) => {
    const { memory, seen, uploaded } = deleting(mode);
    const ticket = await uploaded();
    // A later deploy on the same database: "files" is gone, and another route has an onDelete of its own.
    const ran: string[] = [];
    const renamed = route(
      { accept: "*/*", maxSize: 1024, authorize: () => ({}) },
      { owner: () => "u1", onDelete: ({ file }) => void ran.push(file.id) },
    );
    const later = storeFixture({ renamed }, { store: mode === "transaction" ? memory : leaseStore(memory) });
    expect(await later.cloudrop.api.deleteFile(ticket.id)).toEqual({
      data: { id: ticket.id, ...first },
      error: null,
    });
    expect([(await later.cloudrop.api.file(ticket.id)).data?.status, ran, seen]).toEqual(["deleted", [], []]);
  });

  it("without any onDelete on the server, deleteFile makes only the store call it made before onDelete", async () => {
    const { store, calls } = recordCalls(memoryStore());
    const fixture = storeFixture({ owned }, { store });
    const ticket = await fixture.single("owned", TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    calls.length = 0;
    expect((await fixture.cloudrop.api.deleteFile(ticket.id)).error).toBeNull();
    expect(calls).toEqual(["end"]);
  });

  it("refuses options that are not an object", async () => {
    const { fixture, uploaded } = deleting("transaction");
    const ticket = await uploaded();
    const refused = await fixture.cloudrop.api.deleteFile(ticket.id, "admin" as never);
    expect(refused.error?.message).toBe("deleteFile takes the file id and optionally { context }.");
  });

  it.for(MODES)("%s: a file that never completed runs no onDelete", async (mode) => {
    const { fixture, seen, upload } = deleting(mode);
    const ticket = await upload();
    expect((await fixture.cloudrop.api.deleteFile(ticket.id)).error?.code).toBe("NOT_FOUND");
    expect(seen).toEqual([]);
  });
});

describe("onDelete with api.eraseOwner", () => {
  it.for(MODES)("%s: runs with reason erased and the context; a throw keeps the file, counted failed", async (mode) => {
    const { fixture, seen, state, uploaded, status } = deleting(mode);
    const ticket = await uploaded();
    const { api } = fixture.cloudrop;
    state.failing = true;
    const context = "account deleted";
    expect((await api.eraseOwner("u1", { context })).data).toEqual({
      revoked: 0,
      deleted: 0,
      refused: 0,
      cleaned: 0,
      failed: 1,
      // Still completed, so also a live file the run could not prove gone.
      waiting: 1,
      done: false,
    });
    expect(await status(ticket.id)).toBe("completed");
    state.failing = false;
    expect((await api.eraseOwner("u1", { context })).data).toMatchObject({ deleted: 1, failed: 0 });
    expect(await status(ticket.id)).toBe("deleted");
    const tx = mode === "transaction";
    const call = { id: ticket.id, owner: "u1", reason: "erased", status: "completed", tx, context, request: false };
    expect(seen).toEqual([call, call]);
  });
});

describe("onDelete with replace", () => {
  it.for(MODES)("%s: runs for the replaced file with reason replaced and the replacing request", async (mode) => {
    const { fixture, memory, seen, uploaded, status } = deleting(mode, { replace: true });
    const previous = await uploaded();
    const next = await uploaded();
    const tx = mode === "transaction";
    expect(seen).toEqual([
      { id: previous.id, owner: "u1", reason: "replaced", status: "completed", tx, context: undefined, request: true },
    ]);
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
    expect(memory.appRows()).toEqual([]);
    state.failing = false;
    expect((await complete(fixture, next.token)).status).toBe(200);
    expect([await status(previous.id), await status(next.id)]).toEqual(["deleted", "completed"]);
  });

  it("transaction: a deleteFile racing the replacement of its file rolls its onDelete back", async () => {
    const { fixture, memory, state, uploaded, upload, status } = deleting("transaction", { replace: true });
    const previous = await uploaded();
    const next = await upload();
    const paused = gate();
    state.pause = paused.pass;
    const deletion = fixture.cloudrop.api.deleteFile(previous.id);
    await paused.arrived;
    expect((await complete(fixture, next.token)).status).toBe(200);
    paused.open();
    expect(await deletion).toEqual({ data: { id: previous.id, ...again }, error: null });
    expect([await status(previous.id), memory.appRows()]).toEqual(["deleted", [`replaced ${previous.id}`]]);
  });

  it("transaction: a replacement whose file another call deleted meanwhile rolls back, and its retry completes", async () => {
    const { fixture, memory, state, uploaded, upload, status } = deleting("transaction", { replace: true });
    const previous = await uploaded();
    const next = await upload();
    const paused = gate();
    state.pause = paused.pass;
    const completing = complete(fixture, next.token);
    await paused.arrived;
    expect((await fixture.cloudrop.api.deleteFile(previous.id)).error).toBeNull();
    paused.open();
    // Its onDelete ran for a file the completion then did not replace: undone, and the client is asked to retry.
    expect((await completing).status).toBe(500);
    expect([await status(next.id), memory.appRows()]).toEqual(["pending", [`deleted ${previous.id}`]]);
    expect((await complete(fixture, next.token)).status).toBe(200);
    expect([await status(next.id), memory.appRows()]).toEqual(["completed", [`deleted ${previous.id}`]]);
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
    // The late one, run after the record, gets the replacing request too.
    expect(seen.map(({ id, reason, request }) => [id, reason, request])).toEqual([
      [first.id, "replaced", true],
      [first.id, "replaced", true],
      [fast.id, "replaced", true],
    ]);
    expect([await status(first.id), await status(fast.id), await status(slow.id)]).toEqual([
      "deleted",
      "deleted",
      "completed",
    ]);
  });
});
