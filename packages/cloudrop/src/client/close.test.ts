// Contract: close() (M7-P3, M8-L1 to M8-L5). Afterwards start(), upload() and resume() are refused with CLIENT_CLOSED
// before any request, and every job of the client stops in any phase. close() alone, for a user who changed in another
// tab, keeps what the same user can resume after signing in again: a multipart upload keeps its record and gets no
// /abort, as when the tab closes. close({ abort: true }), for sign-out, cancels as job.abort() does: the server is told
// and the records go. Either way a file whose /complete may have finished is kept, and nothing asks /upload afterwards.
// Oracle: the requests the fixture saw after close(), the fake bucket's objects and open uploads, the records the fake
// IndexedDB holds, the stored bytes' hash, and literal error codes and messages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type UploadJob } from "../client.ts";
import type { Fault } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import {
  bytesHash,
  FOUR_PARTS,
  firstOf,
  fourParts,
  gate,
  nth,
  partThree,
  persistFixture,
  smallFile,
  threeParts,
  unreachable,
} from "../testing/persist-fixture.ts";

const CLOSED = {
  code: "CLIENT_CLOSED",
  message:
    "This upload client was closed, so it starts no more uploads. Use a new client, such as the one of the user who is signed in now.",
  retryable: false,
};
const brief = (error: { code: string; message: string; retryable: boolean } | null) =>
  error && { code: error.code, message: error.message, retryable: error.retryable };
/** Each file's name and status once the job is done: a job whose /upload was cancelled has no outcomes, only these. */
async function statusesOf(job: UploadJob<unknown>) {
  await job.done;
  return job.getSnapshot().files.map((file) => `${file.name} ${file.status}`);
}

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * One PUT at a time: b.bin (four parts) holds its part 3 while a.bin (three parts) waits for a connection with its
 * ticket, and a second job's c.txt waits for its /upload, which is held. Both multipart files have their records.
 */
async function threeFilesRunning(namespace: string) {
  const upload = gate(nth("POST /upload", 2));
  const setup = persistFixture({
    fault: firstOf(gate(partThree).fault, upload.fault),
    options: { concurrency: 1, namespace },
  });
  const big = setup.client.start("files", [fourParts(), threeParts()]);
  await vi.waitFor(() => expect(setup.fixture.requests).toContain("PUT part 3"), { interval: 1 });
  const [first, second] = setup.issued;
  const small = setup.client.start("files", smallFile("c.txt"));
  await upload.reached;
  await setup.drained();
  return { ...setup, big, small, ids: [first?.id, second?.id].sort(), sent: setup.from() };
}

describe("close() when the user changed in another tab", () => {
  // About 150 ms: 40 MiB sent and checksummed in process, then 16 MiB again by the resume.
  it("stops every job without an /abort, keeps the records, and the same user resumes on a new client", async () => {
    const setup = await threeFilesRunning("user-1");
    setup.client.close();
    // The first call decides: sign-out's close({ abort: true }) after it sends nothing more.
    setup.client.close({ abort: true });
    const stopped = { big: await statusesOf(setup.big), small: await statusesOf(setup.small) };
    await setup.drained();
    const afterClose = setup.sent();
    const kept = Object.keys(setup.db.stored()).sort();
    // The same user signs in again in this page: the locks were let go, so a new client resumes at once.
    const again = createCloudropClient({
      basePath: setup.fixture.basePath,
      fetch: setup.fixture.fetch,
      namespace: "user-1",
    });
    const upload = (await again.resumable()).data?.find((listed) => listed.name === "b.bin");
    if (!upload) throw new Error("close() kept no record of b.bin.");
    const resumed = await again.resume(upload, fourParts()).done;

    expect({
      stopped,
      afterClose,
      kept,
      resumed: resumed.error,
      bytes: await setup.storedHash(setup.issued[0]?.key ?? ""),
    }).toEqual({
      stopped: { big: ["b.bin aborted", "a.bin aborted"], small: ["c.txt aborted"] },
      afterClose: [],
      kept: setup.ids,
      resumed: null,
      bytes: bytesHash(FOUR_PARTS),
    });
  });
});

/**
 * a.bin (three parts) whose first /complete the server finishes while its answer is lost once close() ran: the file may
 * be complete, which the page cannot tell.
 */
async function completingWhenClosed(abort: boolean) {
  const closed = Promise.withResolvers<void>();
  const completing = Promise.withResolvers<void>();
  const lostAnswer: Fault = async (call) => {
    if (call.label !== "POST /complete") return undefined;
    await call.forward(call.init);
    completing.resolve();
    await closed.promise;
    return unreachable();
  };
  const setup = persistFixture({ fault: lostAnswer });
  const job = setup.client.start("files", threeParts());
  await completing.promise;
  await setup.drained();
  const sent = setup.from();
  setup.client.close(abort ? { abort: true } : undefined);
  closed.resolve();
  const status = await statusesOf(job);
  await setup.drained();
  const key = setup.issued[0]?.key ?? "";
  return { setup, status, sent, key, kept: Object.keys(setup.db.stored()) };
}

describe("close() during /complete", () => {
  it("keeps the file and its record, and asks nothing more", async () => {
    const { setup, status, sent, key, kept } = await completingWhenClosed(false);

    expect({ status, afterClose: sent(), bytes: await setup.storedHash(key), kept }).toEqual({
      status: ["a.bin aborted"],
      afterClose: [],
      bytes: bytesHash(16 * 1024 * 1024 + 5),
      kept: [setup.issued[0]?.id],
    });
  });

  it("with abort, keeps the file, sends no /abort for it and deletes its record", async () => {
    const { setup, status, sent, key, kept } = await completingWhenClosed(true);

    expect({ status, afterClose: sent(), bytes: await setup.storedHash(key), kept }).toEqual({
      status: ["a.bin aborted"],
      afterClose: [],
      bytes: bytesHash(16 * 1024 * 1024 + 5),
      kept: [],
    });
  });
});

describe("close({ abort: true }) at sign-out", () => {
  it("tells the server of every ticket, frees the bucket's uploads, and forget() leaves no record", async () => {
    const setup = await threeFilesRunning("user-1");
    await setup.client.close({ abort: true });
    // Resolved once each /abort was answered: the bucket already holds no open upload.
    const open = setup.fixture.server.fake.pendingUploads();
    const stopped = { big: await statusesOf(setup.big), small: await statusesOf(setup.small) };
    const forgotten = await setup.client.forget();
    await setup.drained();

    expect({
      stopped,
      afterClose: setup.sent(),
      open,
      stored: setup.db.stored(),
      forgotten: forgotten.data,
    }).toEqual({
      stopped: { big: ["b.bin aborted", "a.bin aborted"], small: ["c.txt aborted"] },
      afterClose: ["POST /abort", "POST /abort"],
      open: 0,
      stored: {},
      forgotten: { forgotten: 0 },
    });
  });
});

describe("close() and a failed file that keeps its ticket for retry()", () => {
  /** Part 2 fails through every attempt with a retryable error: the file ends failed and keeps its ticket. */
  const partTwoDown: Fault = (call) =>
    call.label === "PUT part 2" ? errorResponse(500, "InternalError", "Try again.") : undefined;

  it.for([
    { name: "close() keeps its record and sends nothing", abort: false, afterClose: [], records: 1, uploads: 1 },
    {
      name: "close({ abort: true }) sends its /abort",
      abort: true,
      afterClose: ["POST /abort"],
      records: 0,
      uploads: 0,
    },
  ])("$name", async ({ abort, afterClose, records, uploads }) => {
    const setup = persistFixture({ fault: partTwoDown });
    const job = setup.client.start("files", threeParts());
    await job.done;
    await setup.drained();
    const sent = setup.from();
    await setup.client.close(abort ? { abort: true } : undefined);
    const open = setup.fixture.server.fake.pendingUploads();
    await setup.drained();
    const retried = await job.retry();

    expect({
      status: retried.data?.files.map((file) => file.status),
      afterClose: sent(),
      records: Object.keys(setup.db.stored()).length,
      open,
    }).toEqual({ status: ["aborted"], afterClose, records, open: uploads });
  });

  it("waits for an /abort the page sent just before it", async () => {
    const held = gate((call) => call.label === "POST /abort");
    const setup = persistFixture({ fault: firstOf(held.fault, partTwoDown) });
    const job = setup.client.start("files", threeParts());
    await job.done;
    // The user cancels the failed file, which ends the job at once, then signs out while the /abort is on its way.
    job.abort();
    await held.reached;
    let stopped = false;
    const closing = setup.client.close({ abort: true }).then(() => {
      stopped = true;
    });
    await setup.drained();
    const whileHeld = stopped;
    held.open();
    await closing;

    expect({ whileHeld, open: setup.fixture.server.fake.pendingUploads() }).toEqual({ whileHeld: false, open: 0 });
  });
});

describe("close() and an upload no reload could resume", () => {
  it.for([
    { name: "a single PUT", file: () => smallFile("c.txt"), held: "PUT object", options: {} },
    {
      name: "a multipart upload with persistence off",
      file: threeParts,
      held: "PUT part 2",
      options: { persist: false },
    },
  ])("cancels $name, telling the server", async ({ file, held, options }) => {
    const put = gate(nth(held, 1));
    const setup = persistFixture({ fault: put.fault, options: { concurrency: 1, ...options } });
    const job = setup.client.start("files", file());
    await put.reached;
    await setup.drained();
    const sent = setup.from();
    await setup.client.close();

    expect({
      status: await statusesOf(job),
      afterClose: sent(),
      open: setup.fixture.server.fake.pendingUploads(),
    }).toEqual({
      status: [`${file().name} aborted`],
      afterClose: ["POST /abort"],
      open: 0,
    });
  });
});

describe("after close()", () => {
  it("refuses start(), upload() and resume() with CLIENT_CLOSED before any request", async () => {
    const setup = persistFixture();
    setup.client.close();
    const started = setup.client.start("files", smallFile("c.txt"));
    const uploaded = await setup.client.upload("files", smallFile("c.txt"));
    const listed = { id: "x", route: "files", name: "a.bin", size: 1, type: "", lastModified: 0, expiresAt: "" };
    const resumed = setup.client.resume(listed, threeParts());

    expect({
      started: brief((await started.done).error),
      files: started.files.length,
      uploaded: brief(uploaded.error),
      resumed: brief((await resumed.done).error),
      requests: setup.fixture.requests,
    }).toEqual({ started: CLOSED, files: 0, uploaded: CLOSED, resumed: CLOSED, requests: [] });
  });
});
