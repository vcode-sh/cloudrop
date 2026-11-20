// Contract: resume spec §3.1, §3.2, §3.5 and §3.7 with the plan audit's C1, C2, I5 and I12, through the real client:
// a multipart ticket is saved once, as one record holding the ticket's, the file's, the job's and the client's fields
// and no URL, and its upload's Web Lock is taken; a single PUT is neither. Both stay while the page keeps the ticket
// (a failed file of start() included) and go when it gives the ticket up: done, a cancel, abort() of a failed file,
// pagehide, a retry's new ticket. A file cancelled before its ticket arrives leaves nothing, though its record was
// still being hashed.
// Oracle: what the fake IndexedDB holds, the locks the fake LockManager says this page holds, the tickets /upload
// answered and the requests the fixture saw. The fingerprint is hashed independently, with node:crypto.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MiB } from "../rules.ts";
import type { Fault } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { pageEvents } from "../testing/page-events.ts";
import {
  edgeHash,
  firstOf,
  gate,
  LAST_MODIFIED,
  lockOf,
  persistFixture,
  smallFile,
  threeParts,
  unreachable,
} from "../testing/persist-fixture.ts";
import { MAX_ATTEMPTS } from "./retry.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
/** The longest namespace ruling M3-U79 allows. */
const NAMESPACE = "user-7".padEnd(256, "-");

/** A part the bucket refuses for good (UPLOAD_REJECTED, not retried). */
const refused = () => errorResponse(400, "InvalidArgument", "Invalid argument.");

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a multipart file of start()", () => {
  it("is saved once, with exactly the fields of spec §3.1, and locked while it runs; both go when it is done", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const held = gate((call) => call.label === "PUT part 3");
    const setup = persistFixture({ fault: held.fault, options: { namespace: NAMESPACE } });
    // JSON keeps the album, writes the date as text and leaves the function out: what /upload received (audit I12).
    const metadata = { album: "Trip", taken: new Date(NOW), share() {} };
    const job = setup.client.start("files", threeParts(), { metadata });
    await held.reached;
    await setup.drained();
    const [ticket] = setup.issued;
    const whileRunning = { stored: setup.db.stored(), locks: setup.locks.held() };
    held.open();
    const { data } = await job.done;
    await setup.drained();

    expect(whileRunning).toEqual({
      stored: {
        [`${ticket?.id}`]: {
          id: ticket?.id,
          namespace: NAMESPACE,
          route: "files",
          metadata: { album: "Trip", taken: "2026-11-16T12:00:00.000Z" },
          name: "a.bin",
          size: 16 * MiB + 5,
          type: "application/octet-stream",
          lastModified: LAST_MODIFIED,
          fingerprint: edgeHash(16 * MiB + 5),
          token: ticket?.token,
          key: ticket?.key,
          partSize: 8 * MiB,
          partCount: 3,
          expiresAt: "2026-11-17T12:00:00.000Z",
          savedAt: NOW,
        },
      },
      locks: [lockOf(ticket?.id)],
    });
    expect({ status: data?.files[0]?.status, stored: setup.db.stored(), locks: setup.locks.held() }).toEqual({
      status: "done",
      stored: {},
      locks: [],
    });
  });

  it("saves and locks only the multipart file of a job that also has a single PUT, in the default namespace", async () => {
    // Both files stay sending, so a record or a lock of the single PUT would still be there.
    const held = gate((call) => call.label === "PUT object" || call.label === "PUT part 3");
    const setup = persistFixture({ fault: held.fault });
    const job = setup.client.start("files", [smallFile("note.txt"), threeParts()]);
    await held.reached;
    await setup.drained();
    const [single, multipart] = setup.issued;

    expect({
      kinds: [single?.kind, multipart?.kind],
      stored: Object.entries(setup.db.stored()).map(([id, record]) => [
        id,
        (record as { namespace: string }).namespace,
      ]),
      locks: setup.locks.held(),
    }).toEqual({ kinds: ["single", "multipart"], stored: [[multipart?.id, ""]], locks: [lockOf(multipart?.id)] });
    held.open();
    await job.done;
  });

  it("takes no lock and saves nothing when the file was cancelled while /upload was in flight (M4-F2)", async () => {
    const held = gate((call) => call.label === "POST /upload");
    const abort = gate((call) => call.label === "POST /abort");
    // Not drained(): it waits for every multipart ticket's hash, which this ticket must never start.
    const setup = persistFixture({ fault: firstOf(held.fault, abort.fault) });
    const job = setup.client.start("files", threeParts());
    await held.reached;
    job.files[0]?.abort();
    held.open();
    await abort.reached;
    // A ticket that was locked and saved would still hold its lock here, until /abort answers.
    const whileAborting = { hashed: setup.hashedFiles(), locks: setup.locks.held() };
    abort.open();
    const { data } = await job.done;
    await setup.db.settled();

    expect({
      status: data?.files[0]?.status,
      sent: setup.fixture.requests,
      whileAborting,
      stored: setup.db.stored(),
    }).toEqual({
      status: "aborted",
      sent: ["POST /upload", "POST /abort"],
      whileAborting: { hashed: 0, locks: [] },
      stored: {},
    });
  });
});

describe("the record and the lock go when the page gives the ticket up", () => {
  it("abort() mid-upload sends /abort and deletes the record", async () => {
    const held = gate((call) => call.label === "PUT part 3");
    const setup = persistFixture({ fault: held.fault });
    const job = setup.client.start("files", threeParts());
    await held.reached;
    await setup.drained();
    const before = Object.keys(setup.db.stored()).length;
    job.abort();
    const { data } = await job.done;
    await setup.drained();

    expect({
      before,
      status: data?.files[0]?.status,
      abort: setup.fixture.requests.at(-1),
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({ before: 1, status: "aborted", abort: "POST /abort", stored: {}, locks: [] });
  });

  /**
   * A start() job whose one file failed at part 2, answered by `part2` on every attempt (refused by default), so it
   * holds its ticket for retry().
   */
  async function failedFile(fault: Fault = () => undefined, part2: () => Response | Promise<never> = refused) {
    const setup = persistFixture({ fault: (call) => (call.label === "PUT part 2" ? part2() : fault(call)) });
    const job = setup.client.start("files", threeParts());
    const { error } = await job.done;
    await setup.drained();
    const id = setup.issued[0]?.id;
    const kept = { code: error?.code, stored: Object.keys(setup.db.stored()), locks: setup.locks.held() };
    return { ...setup, job, id, kept };
  }

  it("a failed file keeps both (C2); abort() of it deletes the record and lets the lock go once /abort answers", async () => {
    // Until the server has aborted the upload, another tab that took the lock could complete it, and this /abort,
    // with a live token, would then delete the finished object.
    const answer = gate((call) => call.label === "POST /abort");
    const { job, id, kept, from, drained, db, locks } = await failedFile(answer.fault);
    const sent = from();
    job.files[0]?.abort();
    await answer.reached;
    await drained();
    const whileAborting = { stored: db.stored(), locks: locks.held() };
    answer.open();
    await drained();

    expect({ kept, whileAborting, sent: sent(), stored: db.stored(), locks: locks.held() }).toEqual({
      kept: { code: "UPLOAD_REJECTED", stored: [id], locks: [lockOf(id)] },
      whileAborting: { stored: {}, locks: [lockOf(id)] },
      sent: ["POST /abort"],
      stored: {},
      locks: [],
    });
  });

  it("a retry with the same ticket keeps the record and the lock, asking for neither again (C2)", async () => {
    // A busy bucket on every attempt of part 2's first run: STORAGE_ERROR, which the same ticket can still fix.
    const held = gate((call) => call.label === "PUT part 2" && call.nth === MAX_ATTEMPTS + 1);
    const setup = persistFixture({
      fault: (call) =>
        call.label === "PUT part 2" && call.nth <= MAX_ATTEMPTS
          ? errorResponse(500, "InternalError", "We encountered an internal error.")
          : held.fault(call),
    });
    const job = setup.client.start("files", threeParts());
    const { error } = await job.done;
    const retried = job.retry();
    await held.reached;
    await setup.drained();
    const id = setup.issued[0]?.id;
    const whileRetried = { stored: Object.keys(setup.db.stored()), locks: setup.locks.held() };
    held.open();
    const { data } = await retried;
    await setup.drained();

    expect({
      failed: error?.code,
      tickets: setup.issued.length,
      whileRetried,
      status: data?.files[0]?.status,
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({
      failed: "STORAGE_ERROR",
      tickets: 1,
      whileRetried: { stored: [id], locks: [lockOf(id)] },
      status: "done",
      stored: {},
      locks: [],
    });
  });

  it("pagehide gives a file failed by the network up without an /abort: the record stays for a reload (M4-F1)", async () => {
    const page = pageEvents();
    const { job, id, kept, from, drained, db, locks, reload } = await failedFile(undefined, unreachable);
    const sent = from();
    page.fire("pagehide");
    await drained();
    const afterHide = { sent: sent(), stored: Object.keys(db.stored()), locks: locks.held() };
    // A page restored from the back-forward cache: another tab may have resumed and completed the upload since, so
    // this page's abort() must not delete it (M3-U88).
    job.files[0]?.abort();
    await drained();
    const listed = (await reload().resumable()).data?.map((upload) => upload.id);

    expect({ kept, afterHide, sent: sent(), status: job.getSnapshot().files[0]?.status, listed }).toEqual({
      kept: { code: "NETWORK_ERROR", stored: [id], locks: [lockOf(id)] },
      afterHide: { sent: [], stored: [id], locks: [] },
      sent: [],
      status: "aborted",
      listed: [id],
    });
  });

  it("pagehide still sends a refused file's /abort and leaves no record: no resume can fix it (M4-F1)", async () => {
    const page = pageEvents();
    const { id, kept, from, drained, db, locks } = await failedFile();
    const sent = from();
    page.fire("pagehide");
    await drained();

    expect({ kept, sent: sent(), stored: db.stored(), locks: locks.held() }).toEqual({
      kept: { code: "UPLOAD_REJECTED", stored: [id], locks: [lockOf(id)] },
      sent: ["POST /abort"],
      stored: {},
      locks: [],
    });
  });

  it("a retry after a back-forward cache restore leaves the given-up record, which another tab may hold", async () => {
    const page = pageEvents();
    let failing = true;
    const setup = persistFixture({
      fault: (call) => (failing && call.label === "PUT part 2" ? unreachable() : undefined),
    });
    const job = setup.client.start("files", threeParts());
    await job.done;
    page.fire("pagehide");
    await setup.drained();
    failing = false;
    const { data } = await job.retry();
    await setup.drained();
    const [first, second] = setup.issued;

    expect({
      status: data?.files[0]?.status,
      fresh: second?.id !== first?.id,
      stored: Object.keys(setup.db.stored()),
    }).toEqual({ status: "done", fresh: true, stored: [first?.id] });
  });

  it("abort() of a failed file that a /complete may have finished lets both go without an /abort", async () => {
    const setup = persistFixture({ fault: (call) => (call.label === "POST /complete" ? unreachable() : undefined) });
    const job = setup.client.start("files", threeParts());
    const { error } = await job.done;
    await setup.drained();
    const kept = { code: error?.code, stored: Object.keys(setup.db.stored()).length, locks: setup.locks.held().length };
    const sent = setup.from();
    job.files[0]?.abort();
    await setup.drained();

    expect({ kept, sent: sent(), stored: setup.db.stored(), locks: setup.locks.held() }).toEqual({
      kept: { code: "NETWORK_ERROR", stored: 1, locks: 1 },
      sent: [],
      stored: {},
      locks: [],
    });
  });

  it("a cancel while a /complete that got no answer is tried again lets both go without an /abort", async () => {
    let job: ReturnType<ReturnType<typeof persistFixture>["client"]["start"]> | undefined;
    const setup = persistFixture({
      fault: (call) => {
        if (call.label !== "POST /complete") return undefined;
        if (call.nth === 2) job?.abort();
        return unreachable();
      },
    });
    job = setup.client.start("files", threeParts());
    const { data } = await job.done;
    await setup.drained();

    expect({
      status: data?.files[0]?.status,
      sent: setup.fixture.requests.filter((label) => !label.startsWith("PUT")),
      stored: setup.db.stored(),
      locks: setup.locks.held(),
    }).toEqual({
      status: "aborted",
      sent: ["POST /upload", "POST /complete", "POST /complete"],
      stored: {},
      locks: [],
    });
  });
});
