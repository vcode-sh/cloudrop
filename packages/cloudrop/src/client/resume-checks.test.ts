// Contract: resume spec §2.1, §3.3 and §3.6 with rulings M3-U72 and M3-U76 and the plan audit's I7, through the real
// client after a simulated reload. resume() refuses, before any request and leaving the record as it was, wrong
// arguments, an upload with no unexpired record in the namespace or a lock the browser refuses (M3-U88), a store it
// cannot read, a different file and an upload another tab holds; a cancel while it checks ends it ABORTED the same way, and a refused job stops hearing its
// signal.
// Oracle: what the fake IndexedDB holds, the locks the fake LockManager holds, the requests the fixture saw and literal
// messages. Each field of the file match is refused in fingerprint.test.ts; here one fact and the edge bytes stand for
// the two checks resume() runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumableUpload } from "../client.ts";
import {
  edgeHash,
  FOUR_PARTS,
  fourParts,
  gate,
  LAST_MODIFIED,
  partThree,
  persistFixture,
  reloaded,
} from "../testing/persist-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const STORAGE_ERROR = {
  code: "STORAGE_ERROR",
  message:
    "The browser's storage for unfinished uploads could not be read or written. Uploads still work; resuming after a reload may not.",
};
const NOT_FOUND = {
  code: "NOT_FOUND",
  message: "This upload can no longer be resumed: it finished, was cancelled or expired. Start it again.",
};
const NOT_SAME_FILE = {
  code: "INVALID_INPUT",
  message: "This is not the file the upload started with. Pick the same file again to resume it.",
};
const brief = (error: { code: string; message: string } | null) =>
  error && { code: error.code, message: error.message };

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resume() refuses before any request, leaving the record as it was", () => {
  const PASS_RESUME = "Pass resume() an upload from resumable() and the File the user picked again.";
  it.each([
    { name: "no upload", upload: null, file: fourParts(), options: undefined, message: PASS_RESUME },
    {
      name: "an upload without a string id",
      upload: { id: 7 },
      file: fourParts(),
      options: undefined,
      message: PASS_RESUME,
    },
    {
      name: "a Blob for the file",
      upload: { id: "x" },
      file: new Blob(["x"]),
      options: undefined,
      message: PASS_RESUME,
    },
    {
      name: "options that are not an object, as start() words it",
      upload: { id: "x" },
      file: fourParts(),
      options: "fast",
      message: "Pass the upload options as an object, such as { metadata, signal }.",
    },
  ])("INVALID_INPUT for $name, with no file in the job", async ({ upload, file, options, message }) => {
    const { client, fixture } = persistFixture();
    const job = client.resume(upload as unknown as ResumableUpload, file as File, options as undefined);
    const { data, error } = await job.done;

    expect({
      files: job.files,
      snapshot: job.getSnapshot().files,
      data,
      error: brief(error),
      sent: fixture.requests,
    }).toEqual({ files: [], snapshot: [], data: null, error: { code: "INVALID_INPUT", message }, sent: [] });
  });

  /** A record left by a reload, the new client, and what resume() of it with `file` ends with. */
  async function refusal(
    file: File,
    change: (setup: Awaited<ReturnType<typeof reloaded>>) => ResumableUpload | undefined = (setup) => setup.upload,
  ) {
    const setup = await reloaded(gate(partThree));
    const before = setup.db.stored();
    const upload = change(setup) ?? setup.upload;
    const job = setup.client.resume(upload, file);
    const { data, error } = await job.done;
    await setup.drained();
    return {
      data,
      error: brief(error),
      status: job.getSnapshot().files[0]?.status,
      sent: setup.sent(),
      unchanged: JSON.stringify(setup.db.stored()) === JSON.stringify(before),
      locks: setup.locks.held(),
    };
  }

  it.each([
    { name: "an id no record has", change: (setup: Setup) => ({ ...setup.upload, id: "01NOSUCHUPLOAD" }) },
    {
      name: "a record of another namespace",
      change: (setup: Setup) => {
        setup.client = setup.reload({ namespace: "user-12" });
        return setup.upload;
      },
    },
    {
      name: "a browser that refuses the lock, where nothing can be resumed (M3-U88)",
      change: (setup: Setup) => {
        setup.locks.refuse();
        return setup.upload;
      },
    },
  ])("NOT_FOUND for $name", async ({ change }) => {
    expect(await refusal(fourParts(), change)).toEqual({
      data: null,
      error: NOT_FOUND,
      status: "failed",
      sent: [],
      unchanged: true,
      locks: [],
    });
  });

  it.each([
    {
      name: "a lastModified one millisecond later",
      file: () => new File([offsetBytes(FOUR_PARTS)], "b.bin", { lastModified: LAST_MODIFIED + 1, type: TYPE }),
    },
    {
      name: "a different first byte, every fact equal",
      file: () => {
        const bytes = offsetBytes(FOUR_PARTS);
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        return new File([bytes], "b.bin", { lastModified: LAST_MODIFIED, type: TYPE });
      },
    },
  ])("INVALID_INPUT for $name", async ({ file }) => {
    expect(await refusal(file())).toEqual({
      data: null,
      error: NOT_SAME_FILE,
      status: "failed",
      sent: [],
      unchanged: true,
      locks: [],
    });
  });

  it("UPLOAD_IN_USE when another tab holds the upload, taking no lock itself", async () => {
    const outcome = await refusal(fourParts(), (setup) => {
      setup.locks.holdElsewhere(`cloudrop:upload:${setup.upload.id}`);
      return setup.upload;
    });
    expect(outcome).toEqual({
      data: null,
      error: {
        code: "UPLOAD_IN_USE",
        message:
          "This upload is being sent in this browser, in this tab or another. Finish or cancel it there, then try again.",
      },
      status: "failed",
      sent: [],
      unchanged: true,
      locks: [],
    });
  });

  it("NOT_FOUND for a record with less than 60 s left, which it deletes (M3-U72)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const setup = await reloaded(gate(partThree));
    // The ticket expires a day after NOW; 59 999 ms before that, the record counts as expired.
    vi.setSystemTime(NOW + 86_400_000 - 59_999);
    const { error } = await setup.client.resume(setup.upload, fourParts()).done;
    await setup.drained();
    expect({ error: brief(error), sent: setup.sent(), stored: setup.db.stored() }).toEqual({
      error: NOT_FOUND,
      sent: [],
      stored: {},
    });
  });

  it("stops hearing its signal once refused: a later abort leaves the file failed", async () => {
    const setup = await reloaded(gate(partThree));
    const controller = new AbortController();
    const job = setup.client.resume({ ...setup.upload, id: "01NOSUCHUPLOAD" }, fourParts(), {
      signal: controller.signal,
    });
    await job.done;
    controller.abort();
    expect(job.getSnapshot().files[0]?.status).toBe("failed");
  });

  it("STORAGE_ERROR when the browser's storage cannot be read", async () => {
    const setup = await reloaded(gate(partThree));
    setup.db.failNext("UnknownError");
    const { error } = await setup.client.resume(setup.upload, fourParts()).done;
    expect({ error: brief(error), sent: setup.sent() }).toEqual({ error: STORAGE_ERROR, sent: [] });
  });
});

const TYPE = "application/octet-stream";
type Setup = Awaited<ReturnType<typeof reloaded>>;

describe("while resume() checks (audit I7)", () => {
  it("its one file is queued under the client's next id; a cancel then ends it ABORTED, sending nothing", async () => {
    const setup = await reloaded(gate(partThree));
    // The file match's hash answers only after the cancel, with the right digest: the lock is then taken, and let go.
    const hashed = Promise.withResolvers<ArrayBuffer>();
    vi.mocked(crypto.subtle.digest).mockImplementationOnce(() => hashed.promise);
    const before = setup.db.stored();
    const job = setup.client.resume(setup.upload, fourParts());
    const checking = { ids: job.files.map(({ id }) => id), status: job.getSnapshot().files[0]?.status };
    job.abort();
    hashed.resolve(Uint8Array.from(Buffer.from(edgeHash(FOUR_PARTS), "hex")).buffer);
    const { data, error } = await job.done;
    await setup.drained();

    expect({
      checking,
      data,
      error: brief(error),
      status: job.getSnapshot().files[0]?.status,
      sent: setup.sent(),
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({
      checking: { ids: ["1"], status: "queued" },
      data: null,
      error: { code: "ABORTED", message: "The upload was cancelled. Start it again to upload the file." },
      status: "aborted",
      sent: [],
      stored: before,
      locks: [],
    });
  });

  // Before the fix the file had no run of its own while it was checked, and retry() waited on a settled promise in a
  // loop of microtasks that starved the store, the hash and the lock: the tab froze (final review I2).
  it("answers retry() called meanwhile once the checks end, with only the resumed upload's requests", async () => {
    const setup = await reloaded(gate(partThree));
    const job = setup.client.resume(setup.upload, fourParts());
    const [retried, done] = await Promise.all([job.retry(), job.done]);
    await setup.drained();

    expect({ retried: retried.data?.files[0]?.status, done: done.data?.files[0]?.status, sent: setup.sent() }).toEqual({
      retried: "done",
      done: "done",
      sent: ["POST /complete", "POST /sign", "PUT part 3", "PUT part 4", "POST /complete"],
    });
  });

  it("ends ABORTED, sending nothing, when its signal was already aborted", async () => {
    const setup = await reloaded(gate(partThree));
    const before = setup.db.stored();
    const { error } = await setup.client.resume(setup.upload, fourParts(), { signal: AbortSignal.abort() }).done;
    await setup.drained();
    expect({ code: error?.code, sent: setup.sent(), stored: setup.db.stored(), locks: setup.locks.held() }).toEqual({
      code: "ABORTED",
      sent: [],
      stored: before,
      locks: [],
    });
  });
});
