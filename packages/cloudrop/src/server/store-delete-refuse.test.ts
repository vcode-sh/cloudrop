// An onDelete that refuses (M11-D3 to M11-D8): it returns a CloudropError, the file is kept, and each caller answers
// that error. A throw, and any other returned value, stays a failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import { complete } from "../testing/complete-fixture.ts";
import { deleting, MODES } from "../testing/delete-fixture.ts";
import { gate, NOW } from "../testing/store-fixture.ts";

const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const denied = () => new CloudropError("FORBIDDEN", "An administrator's file may not be deleted.");

const failed = {
  code: "SERVER_ERROR",
  retryable: true,
  message:
    'onDelete failed for route "files", so the file was kept. Its error is in the server log; fix it and try again.',
};

describe("an onDelete that refuses, with api.deleteFile", () => {
  it.for(MODES)("%s: answers the hook's error as it is, keeps the file and logs nothing", async (mode) => {
    const refusal = denied();
    let refusing = true;
    const { fixture, memory, uploaded, status, stored } = deleting(mode, {
      answer: () => (refusing ? refusal : undefined),
    });
    const ticket = await uploaded();
    const { api } = fixture.cloudrop;
    const refused = await api.deleteFile(ticket.id);
    expect(refused).toEqual({ data: null, error: refusal });
    expect(refused.error).toBe(refusal);
    expect([await status(ticket.id), await stored(ticket.key)]).toEqual(["completed", true]);
    expect(await memory.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 5, files: 1, erasure: null });
    // The hook wrote through tx before it refused: rolled back with the deletion.
    expect([memory.appRows(), fixture.logger.errors]).toEqual([[], []]);
    refusing = false;
    expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, deleted: true, cleaned: false });
  });

  // An error rethrown from a cloudrop call inside the hook must never pass for the app's refusal.
  it.for(MODES)("%s: a thrown CloudropError is a failure, not a refusal", async (mode) => {
    const thrown = denied();
    const { fixture, uploaded, status } = deleting(mode, {
      answer: () => {
        throw thrown;
      },
    });
    const ticket = await uploaded();
    expect(await fixture.cloudrop.api.deleteFile(ticket.id)).toEqual({
      data: null,
      error: expect.objectContaining(failed),
    });
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      `cloudrop: onDelete failed for route "files" while deleting file ${ticket.id}.`,
    ]);
    expect(fixture.logger.errors[0]?.error).toBe(thrown);
    expect(await status(ticket.id)).toBe("completed");
  });

  it.for([
    { name: "a string", value: "no", type: "string" },
    {
      // What a second installed copy of cloudrop makes: the same shape, another class.
      name: "an error that only looks like a CloudropError",
      value: Object.assign(new Error("No."), { name: "CloudropError", code: "FORBIDDEN", retryable: false }),
      type: "object",
    },
    { name: "null", value: null, type: "object" },
  ])("$name returned by onDelete is a failure, logged with the route and its type", async ({ value, type }) => {
    const { fixture, memory, uploaded, status } = deleting("transaction", { answer: () => value });
    const ticket = await uploaded();
    expect((await fixture.cloudrop.api.deleteFile(ticket.id)).error).toEqual(expect.objectContaining(failed));
    expect(fixture.logger.errors).toEqual([
      {
        message: `cloudrop: onDelete failed for route "files" while deleting file ${ticket.id}.`,
        error: new TypeError(
          `onDelete returned a value of type ${type}. To keep the file, return a CloudropError (one from a cloudrop older than 1.0 is not recognised: install cloudrop once); otherwise return nothing.`,
        ),
      },
    ]);
    expect([await status(ticket.id), memory.appRows()]).toEqual(["completed", []]);
  });

  // Two deletions of one file at once, one refused and one allowed: each answers what its own hook said (M11-D5,
  // M11-D6). The refused caller is not told the file is gone.
  it.for(MODES)("%s: a refusal stands when another deletion took the file meanwhile", async (mode) => {
    const refusal = denied();
    const { fixture, memory, state, uploaded, status } = deleting(mode, {
      answer: ({ context }) => (context === "guest" ? refusal : undefined),
    });
    const ticket = await uploaded();
    const paused = gate();
    state.pause = paused.pass;
    const { api } = fixture.cloudrop;
    const guest = api.deleteFile(ticket.id, { context: "guest" });
    await paused.arrived;
    expect((await api.deleteFile(ticket.id, { context: "admin" })).data).toEqual({
      id: ticket.id,
      deleted: true,
      cleaned: false,
    });
    paused.open();
    expect(await guest).toEqual({ data: null, error: refusal });
    expect(await status(ticket.id)).toBe("deleted");
    expect(memory.appRows()).toEqual(mode === "transaction" ? [`deleted ${ticket.id}`] : []);
    expect(fixture.logger.errors).toEqual([]);
  });

  // The hook gets no tx, so cloudrop's rollback undoes nothing the hook wrote (M11-D7): the answer is the same.
  it("a plain route() on a store with a transaction refuses the same way", async () => {
    const refusal = denied();
    const { fixture, seen, uploaded, status } = deleting("transaction", { plain: true, answer: () => refusal });
    const ticket = await uploaded();
    expect(await fixture.cloudrop.api.deleteFile(ticket.id)).toEqual({ data: null, error: refusal });
    expect([await status(ticket.id), seen.map((call) => call.tx), fixture.logger.errors]).toEqual([
      "completed",
      [false],
      [],
    ]);
  });
});

describe("an onDelete that refuses, with api.eraseOwner", () => {
  it.for(MODES)("%s: counts the file refused and waiting, goes on with the next and is not done", async (mode) => {
    const refusal = denied();
    let keep = "";
    const { fixture, memory, seen, uploaded, status } = deleting(mode, {
      answer: ({ file }) => (file.id === keep ? refusal : undefined),
    });
    const older = await uploaded();
    vi.setSystemTime(NOW.getTime() + 60_000);
    const newer = await uploaded();
    keep = newer.id;
    // Past both files' URLs and the grace, so the run that deletes the older one also proves it clean.
    vi.setSystemTime(NOW.getTime() + 2 * HOUR);
    expect(await fixture.cloudrop.api.eraseOwner("u1")).toEqual({
      data: {
        requestedAt: new Date(NOW.getTime() + 2 * HOUR),
        revoked: 0,
        deleted: 1,
        refused: 1,
        cleaned: 1,
        failed: 0,
        waiting: 1,
        prefixed: 0,
        done: false,
      },
      error: null,
    });
    // Newest first: the refused file came before the one deleted.
    expect(seen.map((call) => call.id)).toEqual([newer.id, older.id]);
    expect([await status(newer.id), await status(older.id)]).toEqual(["completed", "deleted"]);
    expect(memory.appRows()).toEqual(mode === "transaction" ? [`erased ${older.id}`] : []);
    expect(fixture.logger.errors).toEqual([]);
  });

  // `done` follows the owner's rows, not `refused` (M11-D5): the file the hook kept is gone all the same.
  it("counts a refusal whose file another call deleted meanwhile, and is done when nothing is left", async () => {
    const refusal = denied();
    const { fixture, state, uploaded } = deleting("transaction", {
      answer: ({ reason }) => (reason === "erased" ? refusal : undefined),
    });
    const ticket = await uploaded();
    vi.setSystemTime(NOW.getTime() + 2 * HOUR);
    const paused = gate();
    state.pause = paused.pass;
    const { api } = fixture.cloudrop;
    const erasing = api.eraseOwner("u1");
    await paused.arrived;
    expect((await api.deleteFile(ticket.id)).data).toEqual({ id: ticket.id, deleted: true, cleaned: true });
    paused.open();
    expect((await erasing).data).toEqual({
      requestedAt: new Date(NOW.getTime() + 2 * HOUR),
      revoked: 0,
      deleted: 0,
      refused: 1,
      cleaned: 0,
      failed: 0,
      waiting: 0,
      prefixed: 0,
      done: true,
    });
  });
});

describe("an onDelete that refuses, with replace", () => {
  it.for(MODES)(
    "%s: /complete answers the refusal and records nothing; a later one runs the hooks again",
    async (mode) => {
      const refusal = denied();
      let refusing = true;
      const { fixture, memory, seen, completions, uploaded, upload, status } = deleting(mode, {
        replace: true,
        completing: true,
        answer: () => (refusing ? refusal : undefined),
      });
      const previous = await uploaded();
      const next = await upload();
      const refused = await complete(fixture, next.token);
      expect([refused.status, refused.body.error]).toEqual([
        403,
        { code: "FORBIDDEN", message: "An administrator's file may not be deleted.", retryable: false },
      ]);
      // Pending, not completing: under a lease the claim was released, with a transaction it rolled back.
      expect([await status(previous.id), await status(next.id)]).toEqual(["completed", "pending"]);
      expect(await memory.usage("u1")).toEqual({ reservedBytes: 5, activeBytes: 5, files: 1, erasure: null });
      const tx = mode === "transaction";
      // onComplete ran for the new file either way; with a transaction its write rolled back with the hook's.
      expect([completions, memory.appRows()]).toEqual([[previous.id, next.id], tx ? [`completed ${previous.id}`] : []]);
      expect(fixture.logger.errors).toEqual([]);
      refusing = false;
      expect((await complete(fixture, next.token)).status).toBe(200);
      expect([await status(previous.id), await status(next.id)]).toEqual(["deleted", "completed"]);
      expect([seen.map((call) => call.id), completions]).toEqual([
        [previous.id, previous.id],
        [previous.id, next.id, next.id],
      ]);
      expect(memory.appRows()).toEqual(
        tx ? [`completed ${previous.id}`, `completed ${next.id}`, `replaced ${previous.id}`] : [],
      );
    },
  );

  // M12-R31: rebuilt as an afterVerify refusal is. A code /complete cannot send, such as a client's own or a storage
  // driver's, reaches the client as the generic SERVER_ERROR and is logged; part numbers never leave with a refusal.
  const generic = {
    code: "SERVER_ERROR",
    message: "The server could not handle the upload. Contact the site owner if this keeps happening.",
    retryable: false,
  };
  it.for([
    { returned: new CloudropError("ABORTED", "Not now."), status: 500, error: generic, logged: ["ABORTED"] },
    {
      returned: new CloudropError("STORAGE_DENIED", "Check the access key."),
      status: 500,
      error: generic,
      logged: ["STORAGE_DENIED"],
    },
    {
      returned: new CloudropError("FORBIDDEN", "Not now.", { parts: [1, 2] }),
      status: 403,
      error: { code: "FORBIDDEN", message: "Not now.", retryable: false },
      logged: [],
    },
  ])("a refusal with $returned.code reaches the client as $error.code", async ({ returned, status, error, logged }) => {
    const {
      fixture,
      uploaded,
      upload,
      status: statusOf,
    } = deleting("transaction", {
      replace: true,
      answer: () => returned,
    });
    const previous = await uploaded();
    const next = await upload();
    const refused = await complete(fixture, next.token);
    expect([refused.status, refused.body.error]).toStrictEqual([status, error]);
    expect(fixture.logger.errors.map(({ message }) => message)).toEqual(
      logged.map(
        (code) =>
          `cloudrop: onDelete for route "files" returned ${code}, which /complete cannot send. Return one of UNAUTHORIZED, FORBIDDEN, QUOTA_EXCEEDED, RATE_LIMITED, FILE_TOO_LARGE, FILE_TYPE_NOT_ALLOWED, INVALID_METADATA, VERIFICATION_FAILED, SERVER_ERROR.`,
      ),
    );
    expect([await statusOf(previous.id), await statusOf(next.id)]).toEqual(["completed", "pending"]);
  });

  it.for(MODES)("%s: a refusal stands when another call deleted the previous file meanwhile", async (mode) => {
    const refusal = denied();
    const { fixture, state, uploaded, upload, status } = deleting(mode, {
      replace: true,
      answer: ({ reason }) => (reason === "replaced" ? refusal : undefined),
    });
    const previous = await uploaded();
    const next = await upload();
    const paused = gate();
    state.pause = paused.pass;
    const completing = complete(fixture, next.token);
    await paused.arrived;
    expect((await fixture.cloudrop.api.deleteFile(previous.id)).data).toEqual({
      id: previous.id,
      deleted: true,
      cleaned: false,
    });
    paused.open();
    expect((await completing).status).toBe(403);
    expect([await status(previous.id), await status(next.id)]).toEqual(["deleted", "pending"]);
    // Nothing is left to replace, so no hook runs and the completion goes through.
    expect((await complete(fixture, next.token)).status).toBe(200);
    expect(await status(next.id)).toBe("completed");
  });

  // Under a lease a file that completes while onDelete runs is replaced with the record, before its own onDelete
  // runs: nothing is left to keep, so its refusal is only logged (M11-D8).
  it("lease: the hook of a file replaced after the record cannot refuse, and its refusal is logged", async () => {
    const refusal = denied();
    let late = "";
    const { fixture, state, uploaded, upload, status } = deleting("lease", {
      replace: true,
      answer: ({ file }) => (file.id === late ? refusal : undefined),
    });
    const first = await uploaded();
    const slow = await upload();
    const fast = await upload();
    late = fast.id;
    const paused = gate();
    state.pause = paused.pass;
    const slowCompletion = complete(fixture, slow.token);
    await paused.arrived;
    expect((await complete(fixture, fast.token)).status).toBe(200);
    paused.open();
    expect((await slowCompletion).status).toBe(200);
    expect([await status(first.id), await status(fast.id), await status(slow.id)]).toEqual([
      "deleted",
      "deleted",
      "completed",
    ]);
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      `cloudrop: onDelete for route "files" refused file ${fast.id} after it was replaced, so the file is deleted all the same.`,
    ]);
    expect(fixture.logger.errors[0]?.error).toBe(refusal);
  });
});
