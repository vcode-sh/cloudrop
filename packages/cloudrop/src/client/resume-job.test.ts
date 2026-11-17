// Contract: resume spec §2 and §3.4 with rulings M3-U73, M3-U74 and M3-U75 and the plan audit's C2, I3 and M9, through
// the real client after a simulated reload: a resumed job is any job. It pauses and resumes while it sends the missing
// parts; a cancel sends /abort with the record's token and lets the record and the lock go; a failure keeps both, and
// retry() asks /complete again, with the free PARTS_MISSING still unused and the start over still applying. In the page
// that holds an upload's ticket, a failed file or a resume() running, resume() of it is UPLOAD_IN_USE, and once that
// page gives the ticket up, NOT_FOUND.
// Oracle: the requests the fixture saw and the bodies it read, the tickets /upload answered, what the fake IndexedDB
// holds, the locks the fake LockManager holds, and the bucket's object hashed by node:crypto against the file's bytes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FaultCall, lostPart } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import {
  bodiesOf,
  bytesHash,
  FOUR_PARTS,
  fourParts,
  gate,
  noSuchUpload,
  nth,
  partThree,
  persistFixture,
  reloaded,
  unreachable,
} from "../testing/persist-fixture.ts";
import { MAX_ATTEMPTS } from "./retry.ts";

const lockOf = (id: string | undefined) => `cloudrop:upload:${id}`;
/** Every attempt of the probe's /complete, and of its own retries, gets no answer: NETWORK_ERROR. */
const probeUnreachable = (call: FaultCall) =>
  call.label === "POST /complete" && call.nth <= MAX_ATTEMPTS ? unreachable() : undefined;

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a resumed job sending its missing parts", () => {
  it("pauses and resumes: the paused PUT stops, and the next pass sends the parts left on their URLs (M4-F8)", async () => {
    const third = gate(nth("PUT part 3", 2));
    const setup = await reloaded(gate(partThree), third.fault);
    const job = setup.client.resume(setup.upload, fourParts());
    await third.reached;
    job.pause();
    const paused = job.getSnapshot().files[0]?.status;
    job.resume();
    const { error } = await job.done;
    await setup.drained();

    expect({
      paused,
      error,
      sent: setup.sent(),
      object: await setup.storedHash(setup.issued[0]?.key ?? ""),
      stored: setup.db.stored(),
    }).toEqual({
      paused: "paused",
      error: null,
      sent: [
        ...["POST /complete", "POST /sign", "PUT part 3"],
        // The first pass's /sign signed parts 3 and 4: the next pass signs neither again.
        ...["PUT part 3", "PUT part 4", "POST /complete"],
      ],
      object: bytesHash(FOUR_PARTS),
      stored: {},
    });
  });

  it("abort() sends /abort with the record's token, and lets the record and the lock go", async () => {
    const aborts = bodiesOf("POST /abort");
    const third = gate(nth("PUT part 3", 2));
    const setup = await reloaded(gate(partThree), aborts.fault, third.fault);
    const job = setup.client.resume(setup.upload, fourParts());
    await third.reached;
    await setup.drained();
    const whileSent = { stored: Object.keys(setup.db.stored()), locks: setup.locks.held() };
    job.abort();
    const { data } = await job.done;
    await setup.drained();
    const [ticket] = setup.issued;

    expect({
      whileSent,
      status: data?.files[0]?.status,
      sent: setup.sent(),
      aborted: aborts.bodies,
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({
      whileSent: { stored: [ticket?.id], locks: [lockOf(ticket?.id)] },
      status: "aborted",
      sent: ["POST /complete", "POST /sign", "PUT part 3", "POST /abort"],
      aborted: [{ token: ticket?.token }],
      stored: {},
      locks: [],
    });
  });
});

describe("a resumed file whose probe got no answer (M9)", () => {
  it("fails keeping its record and lock; retry() asks /complete again, its first PARTS_MISSING still free (I3)", async () => {
    // After the retry, part 3 is lost twice: two repair rounds besides the free one.
    const lose = (call: FaultCall) =>
      call.label === "PUT part 3" && (call.nth === 2 || call.nth === 3) ? lostPart() : undefined;
    const setup = await reloaded(gate(partThree), probeUnreachable, lose);
    const job = setup.client.resume(setup.upload, fourParts());
    const { error } = await job.done;
    await setup.drained();
    const id = setup.issued[0]?.id;
    const failed = { code: error?.code, stored: Object.keys(setup.db.stored()), locks: setup.locks.held() };
    const sent = setup.from();
    const { data } = await job.retry();
    await setup.drained();

    expect({ failed, retried: data?.files[0]?.status, sent: sent(), stored: setup.db.stored() }).toEqual({
      failed: { code: "NETWORK_ERROR", stored: [id], locks: [lockOf(id)] },
      retried: "done",
      sent: [
        ...["POST /complete", "POST /sign", "PUT part 3", "PUT part 4", "POST /complete"],
        // Part 3's URL from the first /sign serves both repair rounds (M4-F8).
        ...["PUT part 3", "POST /complete"],
        ...["PUT part 3", "POST /complete"],
      ],
      stored: {},
    });
  });

  it("starts over in the retry when the retry's probe finds the upload gone", async () => {
    const gone = (call: FaultCall) => (nth("POST /complete", MAX_ATTEMPTS + 1)(call) ? noSuchUpload() : undefined);
    const setup = await reloaded(gate(partThree), probeUnreachable, gone);
    const job = setup.client.resume(setup.upload, fourParts());
    await job.done;
    const sent = setup.from();
    const { data } = await job.retry();
    await setup.drained();
    const outcome = data?.files[0];

    expect({
      sent: sent(),
      key: outcome?.status === "done" ? outcome.result.file.key : outcome?.error.code,
      stored: setup.db.stored(),
    }).toEqual({
      sent: [
        ...["POST /complete", "POST /upload"],
        ...["PUT part 1", "PUT part 2", "PUT part 3", "PUT part 4", "POST /complete"],
      ],
      key: setup.issued[1]?.key,
      stored: {},
    });
  });
});

describe("in the page that holds the upload's ticket (audit C2)", () => {
  it("a second resume() of one upload while the first runs is UPLOAD_IN_USE, and sends nothing", async () => {
    const setup = await reloaded(gate(partThree));
    const first = setup.client.resume(setup.upload, fourParts());
    const second = setup.client.resume(setup.upload, fourParts());
    const [one, two] = await Promise.all([first.done, second.done]);
    await setup.drained();

    expect({ first: one.data?.files[0]?.status, second: two.error?.code, sent: setup.sent() }).toEqual({
      first: "done",
      second: "UPLOAD_IN_USE",
      sent: ["POST /complete", "POST /sign", "PUT part 3", "PUT part 4", "POST /complete"],
    });
  });

  it("resume() of a failed file it keeps is UPLOAD_IN_USE; once abort() gave the ticket up, NOT_FOUND", async () => {
    const setup = persistFixture({
      fault: (call) => (call.label === "PUT part 2" ? errorResponse(400, "InvalidArgument", "Invalid.") : undefined),
    });
    const started = setup.client.start("files", fourParts());
    await started.done;
    await setup.drained();
    const [upload] = (await setup.client.resumable()).data ?? [];
    if (!upload) throw new Error("The failed file left no record.");
    const sent = setup.from();
    const inUse = (await setup.client.resume(upload, fourParts()).done).error?.code;
    started.files[0]?.abort();
    await setup.drained();
    const afterAbort = setup.from();
    const gone = (await setup.client.resume(upload, fourParts()).done).error?.code;

    expect({ inUse, sentMeanwhile: sent(), gone, sentAfterAbort: afterAbort() }).toEqual({
      inUse: "UPLOAD_IN_USE",
      sentMeanwhile: ["POST /abort"],
      gone: "NOT_FOUND",
      sentAfterAbort: [],
    });
  });
});
