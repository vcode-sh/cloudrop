// Contract: resume spec §3.2, §3.4 and §3.7 with the plan audit's I4, I5, I12 and M6, through the real client: a
// retry's new ticket replaces the record under the new id and moves the lock; NO_SUCH_UPLOAD makes retry() ask for a
// new ticket, also after a /complete that got no answer (M3-U74, M3-U83); upload() persists too, deleting the record
// with its /abort and keeping it, without the lock, when a /complete may have finished the file (M3-U82); a store that
// fails in any way, or a file the browser can no longer read, changes nothing the upload sends; with persistence off,
// no indexedDB, no Web Locks or a browser that refuses every lock request (M3-U88) nothing is hashed, stored or
// locked, and the file is still stored.
// Oracle: what the fake IndexedDB holds, the locks the fake LockManager says this page holds, the tickets /upload
// answered, the requests the fixture saw and the object the fake bucket stored.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MiB } from "../rules.ts";
import type { FaultCall } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { gate, noSuchUpload, persistFixture, smallFile, threeParts, unreachable } from "../testing/persist-fixture.ts";

const lockOf = (id: string | undefined) => `cloudrop:upload:${id}`;
/** More store requests than any row here makes: every one of them fails. */
const EVERY_REQUEST = 1000;
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

    const [first, second] = setup.issued;

    expect({
      failed: error?.code,
      sent: sent(),
      key: outcome?.status === "done" ? outcome.result.file.key : outcome?.error.code,
      stored: setup.db.stored(),
    }).toEqual({ failed: "NO_SUCH_UPLOAD", sent: THREE_PARTS, key: second?.key, stored: {} });
    expect(second?.key).not.toBe(first?.key);
  });
});

describe("upload() persists too (audit I5)", () => {
  it.each([
    {
      name: "a multipart file the network failed keeps the record for a reload, sending no /abort (M4-F1)",
      file: threeParts,
      fault: (call: FaultCall) => (call.label === "PUT part 2" ? unreachable() : undefined),
      expected: { code: "NETWORK_ERROR", aborted: false, stored: 1 },
    },
    {
      // M3-U31's failures: the same ticket can never finish the upload, so no resume could either (M4-F1).
      name: "a refused multipart file still sends /abort and leaves no record",
      file: threeParts,
      fault: (call: FaultCall) =>
        call.label === "PUT part 2" ? errorResponse(400, "InvalidArgument", "Invalid argument.") : undefined,
      expected: { code: "UPLOAD_REJECTED", aborted: true, stored: 0 },
    },
    {
      name: "a /complete that may have finished keeps the record for a resume, sending no /abort",
      file: threeParts,
      fault: (call: FaultCall) => (call.label === "POST /complete" ? unreachable() : undefined),
      expected: { code: "NETWORK_ERROR", aborted: false, stored: 1 },
    },
    {
      // No record can resume a single PUT, and no lifecycle rule removes its object: /abort deletes it (M3-S15).
      name: "a failed single PUT sends /abort",
      file: () => smallFile("a.txt"),
      fault: (call: FaultCall) =>
        call.label === "PUT object" ? errorResponse(400, "InvalidArgument", "Invalid argument.") : undefined,
      expected: { code: "UPLOAD_REJECTED", aborted: true, stored: 0 },
    },
  ])("$name, and lets the lock go", async ({ file, fault, expected }) => {
    const setup = persistFixture({ fault });
    const { error } = await setup.client.upload("files", file());
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
    { name: "every store request fails", breakStore: (db: Setup["db"]) => db.failNext("UnknownError", EVERY_REQUEST) },
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
  { name: "persist is false", setup: { options: { persist: false } } },
  { name: "the runtime has no indexedDB", setup: { noIndexedDb: true } },
  { name: "the runtime has no Web Locks (M3-U88)", setup: { webLocks: "missing" as const } },
  // Fails closed: a record no lock guards could be resumed while this page still holds the ticket (M3-U88).
  { name: "the browser refuses every lock request (M3-U88)", setup: { webLocks: "refused" as const } },
])("when $name", ({ setup: given }) => {
  it("hashes, stores and locks nothing while a multipart file runs", async () => {
    const held = gate((call) => call.label === "PUT part 3");
    const setup = persistFixture({ fault: held.fault, ...given });
    const job = setup.client.start("files", threeParts());
    await held.reached;
    await setup.drained();
    const whileRunning = { hashed: setup.hashedFiles(), stored: setup.db.stored(), locks: setup.locks.held() };
    held.open();
    const { error } = await job.done;

    expect({ whileRunning, error }).toEqual({ whileRunning: { hashed: 0, stored: {}, locks: [] }, error: null });
  });
});
