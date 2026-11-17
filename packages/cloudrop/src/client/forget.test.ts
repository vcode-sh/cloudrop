// Contract: resume spec §2, §3.6 and §3.7 with rulings M3-U77 and M3-U78 and the plan audit's M10, through the real
// client. resumable() lists the namespace's unexpired records newest first, as exactly M3-U77's fields, by route when
// asked, and deletes the expired ones; it leaves out every upload this client holds: a running or failed file's, and
// one being resumed, until the page lets it go, each claim released on its own (M4-F22). forget() deletes the
// namespace's records or, with { all: true }, every one, refuses any other argument, and leaves a running upload
// running. A failed store is STORAGE_ERROR; with persistence
// off, no indexedDB or no Web Locks (M3-U88) nothing is kept and nothing can be resumed.
// Oracle: what the fake IndexedDB holds, the requests the fixture saw, literal records and literal messages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumableUpload } from "../client.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import {
  fourParts,
  gate,
  nth,
  partThree,
  persistFixture,
  reloaded,
  smallFile,
  threeParts,
} from "../testing/persist-fixture.ts";
import { createRecords, type UploadRecord } from "./records.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const STORAGE_ERROR = {
  code: "STORAGE_ERROR",
  message:
    "The browser's storage for unfinished uploads could not be read or written. Uploads still work; resuming after a reload may not.",
};
const ids = (uploads: ResumableUpload[] | null) => uploads?.map(({ id }) => id);
/** Part 2 refused for good: the file ends failed at once. */
const partTwoRefused = (call: { label: string }) =>
  call.label === "PUT part 2" ? errorResponse(400, "InvalidArgument", "Invalid.") : undefined;
/** Part 2 fails through every attempt with a retryable error, which a resume after a reload could fix (M4-F1). */
const partTwoDown = (call: { label: string }) =>
  call.label === "PUT part 2" ? errorResponse(500, "InternalError", "Try again.") : undefined;
const brief = (error: { code: string; message: string } | null) =>
  error && { code: error.code, message: error.message };

/** A record of 50 MiB in five 10 MiB parts, valid for a day from now (the faked clock's now where a test fakes it, so a
 * fixed date cannot expire under tests that run on the real clock). */
const recordOf = (id: string, changes: Partial<UploadRecord> = {}): UploadRecord => ({
  id,
  namespace: "",
  route: "files",
  metadata: { album: "Trip" },
  name: `${id}.bin`,
  size: 52_428_800,
  type: "application/octet-stream",
  lastModified: 1_763_200_000_000,
  fingerprint: "ab".repeat(32),
  token: `token-${id}`,
  key: `uploads/${id}.bin`,
  partSize: 10_485_760,
  partCount: 5,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  savedAt: NOW,
  ...changes,
});

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resumable()", () => {
  it("lists the namespace's unexpired records newest first, as exactly M3-U77's fields, and deletes the expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { client, db } = persistFixture();
    const seed = createRecords(true);
    seed.save(recordOf("older", { savedAt: NOW - 2000 }));
    seed.save(recordOf("avatar", { route: "avatars", savedAt: NOW - 1000 }));
    seed.save(recordOf("theirs", { namespace: "user-12" }));
    seed.save(recordOf("expired", { expiresAt: "2026-11-16T12:00:59.999Z" }));
    await db.settled();
    const all = await client.resumable();
    const files = await client.resumable("files");
    const shown = (id: string, route: string): ResumableUpload => ({
      id,
      route,
      name: `${id}.bin`,
      size: 52_428_800,
      type: "application/octet-stream",
      lastModified: 1_763_200_000_000,
      expiresAt: "2026-11-17T12:00:00.000Z",
    });

    expect({ all, files, stored: Object.keys(db.stored()).sort() }).toEqual({
      all: { data: [shown("avatar", "avatars"), shown("older", "files")], error: null },
      files: { data: [shown("older", "files")], error: null },
      stored: ["avatar", "older", "theirs"],
    });
  });

  it("resolves STORAGE_ERROR when the browser's storage fails", async () => {
    const { client, db } = persistFixture();
    db.failNext("UnknownError");
    expect(brief((await client.resumable()).error)).toEqual(STORAGE_ERROR);
  });
});

describe("resumable() and the uploads this client holds (M4-F22)", () => {
  it("leaves out a running upload, whose record is kept", async () => {
    const held = gate(partThree);
    const setup = persistFixture({ fault: held.fault, options: { concurrency: 1 } });
    setup.client.start("files", threeParts());
    await held.reached;
    await setup.drained();

    expect({ listed: await setup.client.resumable(), kept: Object.keys(setup.db.stored()).length }).toEqual({
      listed: { data: [], error: null },
      kept: 1,
    });
  });

  it("leaves out a failed file of start(), kept for retry()", async () => {
    const setup = persistFixture({ fault: partTwoRefused });
    await setup.client.start("files", threeParts()).done;
    await setup.drained();

    expect({ listed: await setup.client.resumable(), kept: Object.keys(setup.db.stored()).length }).toEqual({
      listed: { data: [], error: null },
      kept: 1,
    });
  });

  it("lists a failed file of upload(), whose ticket this page gave up (M4-F1)", async () => {
    const setup = persistFixture({ fault: partTwoDown });
    await setup.client.upload("files", threeParts());
    await setup.drained();

    expect(ids((await setup.client.resumable()).data)).toEqual([setup.issued[0]?.id]);
  });

  it("hides an upload resumed right after a resume of it that is refused", async () => {
    const probe = gate(nth("POST /complete", 1));
    const setup = await reloaded(gate(partThree), probe.fault);
    const refused = setup.client.resume(setup.upload, smallFile("other.txt"));
    setup.client.resume(setup.upload, fourParts());
    const code = (await refused.done).error?.code;
    await probe.reached;

    expect({ code, whileRunning: ids((await setup.client.resumable()).data) }).toEqual({
      code: "INVALID_INPUT",
      whileRunning: [],
    });
  });

  it("hides an upload resumed again at once after a cancelled resume of it", async () => {
    const probe = gate(nth("POST /complete", 1));
    const setup = await reloaded(gate(partThree), probe.fault);
    const cancelled = setup.client.resume(setup.upload, fourParts());
    cancelled.abort();
    setup.client.resume(setup.upload, fourParts());
    const code = (await cancelled.done).error?.code;
    await probe.reached;

    expect({ code, whileRunning: ids((await setup.client.resumable()).data) }).toEqual({
      code: "ABORTED",
      whileRunning: [],
    });
  });

  it("hides an upload while its resume runs, and lists it again after a refused or cancelled resume", async () => {
    const probe = gate(nth("POST /complete", 1));
    const setup = await reloaded(gate(partThree), probe.fault);
    const refused = (await setup.client.resume(setup.upload, smallFile("other.txt")).done).error?.code;
    const afterRefused = ids((await setup.client.resumable()).data);
    const cancelled = setup.client.resume(setup.upload, fourParts());
    cancelled.abort();
    await cancelled.done;
    const afterCancelled = ids((await setup.client.resumable()).data);
    setup.client.resume(setup.upload, fourParts());
    await probe.reached;
    const whileRunning = ids((await setup.client.resumable()).data);

    expect({ refused, afterRefused, afterCancelled, whileRunning }).toEqual({
      refused: "INVALID_INPUT",
      afterRefused: [setup.upload.id],
      afterCancelled: [setup.upload.id],
      whileRunning: [],
    });
  });
});

describe("forget()", () => {
  async function seeded() {
    const setup = persistFixture({ options: { namespace: "user-1" } });
    const seed = createRecords(true);
    seed.save(recordOf("a", { namespace: "user-1" }));
    seed.save(recordOf("b", { namespace: "user-1" }));
    seed.save(recordOf("c", { namespace: "user-12" }));
    await setup.db.settled();
    return setup;
  }

  it("deletes the client's namespace and resolves the count; { all: true } deletes the rest", async () => {
    const { client, db } = await seeded();
    const mine = await client.forget();
    const left = Object.keys(db.stored());
    const all = await client.forget({ all: true });
    expect({ mine, left, all, stored: db.stored() }).toEqual({
      mine: { data: { forgotten: 2 }, error: null },
      left: ["c"],
      all: { data: { forgotten: 1 }, error: null },
      stored: {},
    });
  });

  it.each([
    { name: "a user id", options: "user-1" },
    { name: "{ all: false }", options: { all: false } },
    { name: "an option it does not know beside all", options: { all: true, namespace: "user-12" } },
  ])("refuses $name with INVALID_INPUT and deletes nothing", async ({ options }) => {
    const { client, db } = await seeded();
    const { data, error } = await client.forget(options as never);
    expect({ data, error: brief(error), stored: Object.keys(db.stored()) }).toEqual({
      data: null,
      error: {
        code: "INVALID_INPUT",
        message:
          "Call forget() for this client's unfinished uploads, or forget({ all: true }) for every one in this browser.",
      },
      stored: ["a", "b", "c"],
    });
  });

  it("resolves STORAGE_ERROR when the browser's storage fails", async () => {
    const { client, db } = await seeded();
    db.failNext("UnknownError");
    expect(brief((await client.forget()).error)).toEqual(STORAGE_ERROR);
  });

  it("leaves a running upload running, and it saves no record again (M3-U78)", async () => {
    const third = gate((call) => call.label === "PUT part 3");
    const setup = persistFixture({ fault: third.fault });
    const job = setup.client.start("files", fourParts());
    await third.reached;
    await setup.drained();
    const forgotten = await setup.client.forget();
    third.open();
    const { error } = await job.done;
    await setup.drained();
    expect({ forgotten: forgotten.data, error, stored: setup.db.stored() }).toEqual({
      forgotten: { forgotten: 1 },
      error: null,
      stored: {},
    });
  });
});

describe.each([
  { name: "persist is false", setup: { options: { persist: false } } },
  { name: "the runtime has no indexedDB", setup: { noIndexedDb: true } },
  {
    name: "the runtime has no Web Locks, as a page that is not a secure context (M3-U88)",
    setup: { webLocks: "missing" as const },
  },
])("when $name (spec §3.7)", ({ setup }) => {
  it("resumable() lists [], forget() counts 0 and resume() is NOT_FOUND without a request, a record left as it is", async () => {
    const { client, db, locks, fixture } = persistFixture(setup);
    // Saved after the client was created, by a store that has indexedDB and Web Locks: the client looked for them once,
    // when it was created (M3-U89), so it reads nothing even now.
    vi.stubGlobal("indexedDB", db.indexedDB);
    vi.stubGlobal("navigator", { locks: locks.locks });
    createRecords(true).save(recordOf("x"));
    await db.settled();
    const upload = { ...recordOf("x"), route: "files" };
    expect({
      resumable: await client.resumable(),
      forget: await client.forget({ all: true }),
      resume: brief((await client.resume(upload, fourParts()).done).error),
      sent: fixture.requests,
      stored: Object.keys(db.stored()),
    }).toEqual({
      resumable: { data: [], error: null },
      forget: { data: { forgotten: 0 }, error: null },
      resume: {
        code: "NOT_FOUND",
        message: "This upload can no longer be resumed: it finished, was cancelled or expired. Start it again.",
      },
      sent: [],
      stored: ["x"],
    });
  });
});
