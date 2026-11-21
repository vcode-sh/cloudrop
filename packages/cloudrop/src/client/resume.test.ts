// Contract: resume spec §3.4 with rulings M3-U74, M3-U75 and M3-U92 and the plan audit's I1, I3, I6, I8, I9, M8, M9 and
// M14, through the real client after a simulated reload (the page's locks let go, a new client on the same IndexedDB,
// server and bucket; the old client's held requests never reach the bucket). A resumed file asks /complete first: what
// landed is not sent again, a finished upload is done without a PUT (onComplete runs again), the probe's first
// PARTS_MISSING takes no repair round and credits the landed parts' bytes, and an upload that is gone starts over with
// one new /upload within the same run, in its first run and in a retry; the file's cancel and pause stop that /upload
// and its backoff. Otherwise a resumed job is any job: pause, cancel, failure and retry.
// Oracle: the requests the fixture saw and the bodies it read, the tickets /upload answered, what the fake IndexedDB
// holds, the locks the fake LockManager holds, and the bucket's object hashed by node:crypto against the file's bytes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadJob } from "../client.ts";
import { MiB } from "../rules.ts";
import { type FaultCall, lostPart, storageBusy } from "../testing/client-fixture.ts";
import { type PageEvents, pageEvents } from "../testing/page-events.ts";
import {
  bodiesOf,
  bytesHash,
  FOUR_PARTS,
  fourParts,
  gate,
  lockOf,
  METADATA,
  noSuchUpload,
  nth,
  partThree,
  persistFixture,
  reloaded,
  serverError,
  unreachable,
} from "../testing/persist-fixture.ts";
import { MAX_ATTEMPTS } from "./retry.ts";

const FILE_TYPE = "application/octet-stream";

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a resumed file asks /complete first", () => {
  // Over 250 ms in the full lane, about 140 ms alone: reloaded()'s 16 MiB (persist-fixture.ts), then 8 MiB more.
  it("sends only parts 3 and 4, signed through /sign, after 2 of 4 parts landed before the reload (I6)", async () => {
    const signs = bodiesOf("POST /sign");
    const setup = await reloaded(gate(partThree), signs.fault);
    const result = await setup.client.resume(setup.upload, fourParts()).done;
    await setup.drained();
    const [ticket] = setup.issued;

    expect({
      sent: setup.sent(),
      signed: signs.bodies,
      result,
      object: await setup.storedHash(ticket?.key ?? ""),
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({
      sent: ["POST /complete", "POST /sign", "PUT part 3", "PUT part 4", "POST /complete"],
      signed: [{ token: ticket?.token, parts: [3, 4] }],
      result: {
        data: {
          files: [
            {
              id: "1",
              name: "b.bin",
              status: "done",
              result: {
                file: { id: ticket?.id, key: ticket?.key, name: "b.bin", size: FOUR_PARTS, type: FILE_TYPE, url: null },
                data: null,
              },
            },
          ],
        },
        error: null,
      },
      object: bytesHash(FOUR_PARTS),
      stored: {},
      locks: [],
    });
  });

  it("is done without a PUT when every part landed before the reload, its bytes the whole file (I3)", async () => {
    const setup = await reloaded(gate(nth("POST /complete", 1)));
    const job = setup.client.resume(setup.upload, fourParts());
    const { data } = await job.done;
    const outcome = data?.files[0];
    const { bytes, progress } = job.getSnapshot().totals;

    expect({
      sent: setup.sent(),
      key: outcome?.status === "done" ? outcome.result.file.key : outcome?.error.code,
      bytes,
      progress,
      completed: setup.completed,
    }).toEqual({
      sent: ["POST /complete"],
      key: setup.issued[0]?.key,
      bytes: FOUR_PARTS,
      progress: 1,
      completed: [setup.issued[0]?.id],
    });
  });

  it("is done, same key, when a /complete before the reload finished but its answer was lost; onComplete runs again (M8)", async () => {
    // The first /complete reaches the server and its answer is lost; the next five never reach it.
    const lost = (call: FaultCall) => {
      if (call.label !== "POST /complete" || call.nth > MAX_ATTEMPTS) return undefined;
      if (call.nth > 1) return unreachable();
      return call.forward(call.init).then(unreachable);
    };
    const setup = persistFixture({ fault: lost, options: { concurrency: 1 } });
    const first = await setup.client.start("files", fourParts()).done;
    await setup.drained();
    const kept = { code: first.error?.code, stored: Object.keys(setup.db.stored()).length };
    const client = setup.reload();
    const [upload] = (await client.resumable()).data ?? [];
    const sent = setup.from();
    if (!upload) throw new Error("The failed file left no record.");
    const { data } = await client.resume(upload, fourParts()).done;
    const outcome = data?.files[0];
    await setup.drained();
    const id = setup.issued[0]?.id;

    expect({
      kept,
      sent: sent(),
      key: outcome?.status === "done" ? outcome.result.file.key : outcome?.error.code,
      completed: setup.completed,
      stored: setup.db.stored(),
    }).toEqual({
      kept: { code: "NETWORK_ERROR", stored: 1 },
      sent: ["POST /complete"],
      key: setup.issued[0]?.key,
      completed: [id, id],
      stored: {},
    });
  });
});

describe("the probe's first PARTS_MISSING (M3-U75)", () => {
  it("takes no repair round, and counts the landed parts' bytes only from its answer (I3)", async () => {
    const probe = gate(nth("POST /complete", 1));
    const firstSign = gate(nth("POST /sign", 1));
    // Two repair rounds after the probe, each losing part 3 again (the second and third PUT of it after the reload).
    const lose = (call: FaultCall) =>
      call.label === "PUT part 3" && (call.nth === 2 || call.nth === 3) ? lostPart() : undefined;
    const setup = await reloaded(gate(partThree), probe.fault, firstSign.fault, lose);
    const job = setup.client.resume(setup.upload, fourParts());
    await probe.reached;
    const beforeAnswer = job.getSnapshot().files[0];
    probe.open();
    await firstSign.reached;
    const afterAnswer = job.getSnapshot().files[0]?.bytes;
    firstSign.open();
    const { error } = await job.done;

    expect({
      beforeAnswer: { status: beforeAnswer?.status, bytes: beforeAnswer?.bytes },
      afterAnswer,
      error,
      sent: setup.sent(),
      bytes: job.getSnapshot().files[0]?.bytes,
    }).toEqual({
      beforeAnswer: { status: "completing", bytes: 0 },
      afterAnswer: 16 * MiB,
      error: null,
      sent: [
        ...["POST /complete", "POST /sign", "PUT part 3", "PUT part 4", "POST /complete"],
        // Part 3's URL from the first /sign serves both repair rounds (M4-F8).
        ...["PUT part 3", "POST /complete"],
        ...["PUT part 3", "POST /complete"],
      ],
      bytes: FOUR_PARTS,
    });
  });

  it("lets only two repair rounds follow it: a third lost part fails the file PARTS_MISSING", async () => {
    const lose = (call: FaultCall) => (call.label === "PUT part 3" && call.nth >= 2 ? lostPart() : undefined);
    const setup = await reloaded(gate(partThree), lose);
    const { error } = await setup.client.resume(setup.upload, fourParts()).done;
    await setup.drained();

    expect({
      code: error?.code,
      completes: setup.sent().filter((label) => label === "POST /complete").length,
      stored: Object.keys(setup.db.stored()),
    }).toEqual({ code: "PARTS_MISSING", completes: 4, stored: [setup.issued[0]?.id] });
  });
});

describe("an upload the probe finds gone starts over in the same run (M3-U74)", () => {
  it.each([
    { name: "UPLOAD_EXPIRED", answer: () => serverError(410, "UPLOAD_EXPIRED", "This upload has expired.") },
    { name: "INVALID_TOKEN", answer: () => serverError(400, "INVALID_TOKEN", "This upload token is not valid.") },
    { name: "NO_SUCH_UPLOAD", answer: noSuchUpload },
  ])("$name: one /upload with the record's route and metadata, the whole file under a new key", async ({ answer }) => {
    const uploads = bodiesOf("POST /upload");
    // Part 4 was never sent before the reload.
    const lastPart = gate(nth("PUT part 4", 1));
    const probe = (call: FaultCall) => (call.label === "POST /complete" && call.nth === 1 ? answer() : undefined);
    const setup = await reloaded(gate(partThree), uploads.fault, probe, lastPart.fault);
    const job = setup.client.resume(setup.upload, fourParts());
    await lastPart.reached;
    await setup.drained();
    const whileSent = { stored: Object.keys(setup.db.stored()), locks: setup.locks.held() };
    lastPart.open();
    const { data, error } = await job.done;
    await setup.drained();
    const [old, renewed] = setup.issued;
    const outcome = data?.files[0];
    const { idempotencyKey: _randomKey, ...asked } = uploads.bodies[1] as Record<string, unknown>;

    expect({
      error,
      sent: setup.sent(),
      asked,
      whileSent,
      key: outcome?.status === "done" ? outcome.result.file.key : outcome?.error.code,
      object: await setup.storedHash(renewed?.key ?? ""),
      stored: setup.db.stored(),
    }).toEqual({
      error: null,
      sent: [
        // The old ticket is given up before the new one is asked for (M11-R90).
        ...["POST /complete", "POST /abort", "POST /upload"],
        ...["PUT part 1", "PUT part 2", "PUT part 3", "PUT part 4", "POST /complete"],
      ],
      asked: { route: "files", files: [{ name: "b.bin", size: FOUR_PARTS, type: FILE_TYPE }], metadata: METADATA },
      whileSent: { stored: [renewed?.id], locks: [lockOf(renewed?.id)] },
      key: renewed?.key,
      object: bytesHash(FOUR_PARTS),
      stored: {},
    });
    expect(renewed?.key).not.toBe(old?.key);
  });

  it("ends failed with the /upload's refusal, and nothing left to resume, when that /upload is refused (I1)", async () => {
    const refusal = () => serverError(403, "UNAUTHORIZED", "Sign in to upload files.");
    const setup = await reloaded(
      gate(partThree),
      (call) => (call.label === "POST /complete" ? noSuchUpload() : undefined),
      (call) => (call.label === "POST /upload" && call.nth === 2 ? refusal() : undefined),
    );
    const { data, error } = await setup.client.resume(setup.upload, fourParts()).done;
    await setup.drained();

    expect({
      outcome: data?.files.map(({ status }) => status),
      error: { code: error?.code, message: error?.message },
      sent: setup.sent(),
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({
      outcome: ["failed"],
      error: { code: "UNAUTHORIZED", message: "Sign in to upload files." },
      sent: ["POST /complete", "POST /abort", "POST /upload"],
      stored: {},
      locks: [],
    });
  });

  it("is not started over when the file was cancelled while the probe was in flight: /abort, and no /upload", async () => {
    const probe = gate(nth("POST /complete", 1));
    const setup = await reloaded(gate(partThree), probe.fault, (call) =>
      call.label === "POST /complete" ? noSuchUpload() : undefined,
    );
    const job = setup.client.resume(setup.upload, fourParts());
    await probe.reached;
    job.abort();
    probe.open();
    const { data } = await job.done;
    await setup.drained();

    expect({ status: data?.files[0]?.status, sent: setup.sent(), stored: setup.db.stored() }).toEqual({
      status: "aborted",
      sent: ["POST /complete", "POST /abort"],
      stored: {},
    });
  });

  /**
   * Resumes an upload the probe finds gone and resolves in the backoff after its new /upload was answered 503, the next
   * wait at least 499.5 ms of fake time. The third /upload gives a ticket.
   */
  async function inNewTicketBackoff() {
    const busy = Promise.withResolvers<void>();
    const setup = await reloaded(
      gate(partThree),
      (call) => (call.label === "POST /complete" && call.nth === 1 ? noSuchUpload() : undefined),
      (call) => {
        if (!nth("POST /upload", 2)(call)) return undefined;
        busy.resolve();
        return storageBusy();
      },
    );
    // After the reload, which waits on the store's setTimeout: only the backoff's timers are fake.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(Math.random).mockReturnValue(0.999);
    const page = pageEvents();
    const job = setup.client.resume(setup.upload, fourParts());
    await busy.promise;
    // A macrotask, which fake timers leave alone: the 503 has been read and the backoff has begun.
    await new Promise((resolve) => setImmediate(resolve));
    return { setup, job, page, status: () => job.getSnapshot().files[0]?.status };
  }

  it("cancelled in the backoff of its new /upload, ends aborted at once and sends nothing more (M3-U92)", async () => {
    const { setup, job, status } = await inNewTicketBackoff();
    const waiting = status();
    job.files[0]?.abort();
    await new Promise((resolve) => setImmediate(resolve));
    const ended = status();
    await vi.advanceTimersByTimeAsync(60_000);

    expect({ waiting, ended, sent: setup.sent() }).toEqual({
      waiting: "queued",
      ended: "aborted",
      sent: ["POST /complete", "POST /abort", "POST /upload"],
    });
  });

  type Held = { job: UploadJob<unknown>; page: PageEvents };
  it.each([
    { name: "paused by the caller", hold: ({ job }: Held) => job.pause(), free: ({ job }: Held) => job.resume() },
    {
      // The start over runs inside its run's connectivity bracket (M3-U49), so offline reaches its backoff.
      name: "paused by offline",
      hold: ({ page }: Held) => page.fire("offline"),
      free: ({ page }: Held) => page.fire("online"),
    },
  ])(
    "$name in the backoff of its new /upload, asks nothing until freed, then sends the file (M3-U92)",
    async ({ hold, free }) => {
      const { setup, job, page, status } = await inNewTicketBackoff();
      hold({ job, page });
      const paused = status();
      await vi.advanceTimersByTimeAsync(60_000);
      const whilePaused = setup.sent();
      free({ job, page });
      const { error } = await job.done;

      expect({ paused, whilePaused, error, sent: setup.sent() }).toEqual({
        paused: "paused",
        whilePaused: ["POST /complete", "POST /abort", "POST /upload"],
        error: null,
        sent: [
          "POST /complete",
          "POST /abort",
          "POST /upload",
          "POST /upload",
          "PUT part 1",
          "PUT part 2",
          "PUT part 3",
          "PUT part 4",
          "POST /complete",
        ],
      });
    },
  );

  it("cancelled while its new /upload is in flight, stops that /upload and sends nothing more (I1, M3-U92)", async () => {
    const newTicket = gate(nth("POST /upload", 2));
    const setup = await reloaded(
      gate(partThree),
      (call) => (call.label === "POST /complete" ? noSuchUpload() : undefined),
      newTicket.fault,
    );
    const job = setup.client.resume(setup.upload, fourParts());
    await newTicket.reached;
    // Queued again while it waits for its new ticket, so a pause applies (M3-U36, M3-U4).
    const waiting = job.getSnapshot().files[0]?.status;
    job.files[0]?.abort();
    // Lets the /upload through had the cancel not stopped it: a ticket would then bring a PUT or an /abort.
    newTicket.open();
    const { data } = await job.done;
    await setup.drained();

    expect({
      waiting,
      status: data?.files[0]?.status,
      sent: setup.sent(),
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({
      waiting: "queued",
      status: "aborted",
      sent: ["POST /complete", "POST /abort", "POST /upload"],
      stored: {},
      locks: [],
    });
  });
});
