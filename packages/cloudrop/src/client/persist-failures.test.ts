// Contract: resume spec §3.2, §3.4 and §3.7 with the plan audit's I4, I5, I12 and M6, through the real client: a
// retry's new ticket replaces the record under the new id and moves the lock; NO_SUCH_UPLOAD makes retry() ask for a
// new ticket, also after a /complete that got no answer (M3-U74, M3-U83); upload() persists too, deleting the record
// with its /abort and keeping it, without the lock, when a /complete may have finished the file (M3-U82); a store that
// fails in any way, or a file the browser can no longer read, changes nothing the upload sends; with persistence off or
// no indexedDB nothing is hashed, stored or locked.
// Oracle: what the fake IndexedDB holds, the locks the fake LockManager says this page holds, the tickets /upload
// answered, the requests the fixture saw and the object the fake bucket stored.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MiB } from "../rules.ts";
import type { FaultCall } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { gate, noSuchUpload, persistFixture, threeParts, unreachable } from "../testing/persist-fixture.ts";

const lockOf = (id: string | undefined) => `cloudrop:upload:${id}`;
const THREE_PARTS = ["POST /upload", "PUT part 1", "PUT part 2", "PUT part 3", "POST /complete"];

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a retry's new ticket", () => {
  it("replaces the record and the lock under the new id; both go when the file is done", async () => {
    const held = gate((call) => call.label === "PUT part 3" && call.nth === 2);
    const setup = persistFixture({
      fault: (call) =>
        call.label === "PUT part 2" && call.nth === 1
          ? errorResponse(403, "SignatureDoesNotMatch", "Signature mismatch.")
          : held.fault(call),
    });
    const job = setup.client.start("files", threeParts());
    await job.done;
    await setup.drained();
    const failed = { stored: Object.keys(setup.db.stored()), locks: setup.locks.held() };
    const retried = job.retry();
    await held.reached;
    await setup.drained();
    const [first, second] = setup.issued;
    const whileRetried = { stored: Object.keys(setup.db.stored()), locks: setup.locks.held() };
    held.open();
    const { data } = await retried;
    await setup.drained();

    expect({
      failed,
      whileRetried,
      status: data?.files[0]?.status,
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({
      failed: { stored: [first?.id], locks: [lockOf(first?.id)] },
      whileRetried: { stored: [second?.id], locks: [lockOf(second?.id)] },
      status: "done",
      stored: {},
      locks: [],
    });
  });

  it.each([
    { name: "at once", answers: [noSuchUpload] },
    { name: "after a /complete that got no answer (audit I4)", answers: [unreachable, noSuchUpload] },
  ])("is asked for when /complete answers NO_SUCH_UPLOAD $name", async ({ answers }) => {
    const setup = persistFixture({
      fault: (call: FaultCall) => (call.label === "POST /complete" ? answers[call.nth - 1]?.() : undefined),
    });
    const job = setup.client.start("files", threeParts());
    const { error } = await job.done;
    const sent = setup.from();
    const { data } = await job.retry();
    await setup.drained();
    const outcome = data?.files[0];

    expect({
      failed: error?.code,
      sent: sent(),
      newKey: outcome?.status === "done" && outcome.result.file.key !== setup.issued[0]?.key,
      stored: setup.db.stored(),
    }).toEqual({ failed: "NO_SUCH_UPLOAD", sent: THREE_PARTS, newKey: true, stored: {} });
  });
});

describe("upload() persists too (audit I5)", () => {
  it.each([
    {
      name: "a refused part sends /abort and deletes the record",
      fault: (call: FaultCall) =>
        call.label === "PUT part 2" ? errorResponse(400, "InvalidArgument", "Invalid argument.") : undefined,
      expected: { code: "UPLOAD_REJECTED", aborted: true, stored: 0 },
    },
    {
      name: "a /complete that may have finished keeps the record for a resume, sending no /abort",
      fault: (call: FaultCall) => (call.label === "POST /complete" ? unreachable() : undefined),
      expected: { code: "NETWORK_ERROR", aborted: false, stored: 1 },
    },
  ])("$name, and lets the lock go", async ({ fault, expected }) => {
    const setup = persistFixture({ fault });
    const { error } = await setup.client.upload("files", threeParts());
    await setup.drained();

    expect({
      code: error?.code,
      aborted: setup.fixture.requests.includes("POST /abort"),
      stored: Object.keys(setup.db.stored()).length,
      locks: setup.locks.held(),
    }).toEqual({ ...expected, locks: [] });
  });
});

describe("the store never changes what an upload sends (spec §3.2)", () => {
  it.each([
    { name: "every store request fails", breakStore: (db: Setup["db"]) => db.failNext("UnknownError", 1000) },
    {
      name: "opening the database throws (an opaque-origin frame)",
      breakStore: (db: Setup["db"]) =>
        vi.spyOn(db.indexedDB, "open").mockImplementation(() => {
          throw new DOMException("The operation is insecure.", "SecurityError");
        }),
    },
    {
      name: "the browser can no longer read the file to hash it (audit M6)",
      hash: () => Promise.reject(new DOMException("The file could not be read.", "NotReadableError")),
    },
  ])("$name: the file is stored with the usual requests and no record", async ({ breakStore, hash }) => {
    const setup = persistFixture({ hash });
    breakStore?.(setup.db);
    const { data, error } = await setup.client.upload("files", threeParts());
    await setup.drained();

    expect({
      error,
      sent: setup.fixture.requests,
      size: data && (await setup.fixture.server.storage.head(data.file.key)).data?.size,
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({ error: null, sent: THREE_PARTS, size: 16 * MiB + 5, stored: {}, locks: [] });
  });
});

type Setup = ReturnType<typeof persistFixture>;

describe.each([
  { name: "persist is false", options: { persist: false }, noIndexedDb: false },
  { name: "the runtime has no indexedDB", options: {}, noIndexedDb: true },
])("when $name", ({ options, noIndexedDb }) => {
  it("hashes, stores and locks nothing while a multipart file runs", async () => {
    const held = gate((call) => call.label === "PUT part 3");
    const setup = persistFixture({ fault: held.fault, options, noIndexedDb });
    const job = setup.client.start("files", threeParts());
    await held.reached;
    await setup.drained();
    const whileRunning = { hashed: setup.hashedFiles(), stored: setup.db.stored(), locks: setup.locks.held() };
    held.open();
    const { error } = await job.done;

    expect({ whileRunning, error }).toEqual({ whileRunning: { hashed: 0, stored: {}, locks: [] }, error: null });
  });
});
