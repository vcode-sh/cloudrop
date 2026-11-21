// Contract: M11-R261, on the real server with a store and a quota that fits the file once. A cancel while an /upload
// is in flight ends the files at once and leaves the request to answer: each ticket it then brings gets its /abort, so
// what the server reserved for the cancelled files is free again without the sweep. The same for a one-file /upload,
// which runs on its file's own cancel, and close() resolves only once that cleanup was answered.
// Oracle: the rows read straight from the store, what the next upload of the same owner answers, and the requests the
// fixture saw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, type FaultCall } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { firstOf, nth } from "../testing/persist-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const file = () => new File([offsetBytes(600)], "a.bin", { type: "application/octet-stream" });

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The server takes the call `matches` picks, reserving what it asks for, and its answer is held until open(). As in a
 * browser, a request the page cuts rejects at once and its answer is never read.
 */
function answerHeld(matches: (call: FaultCall) => boolean) {
  const reserved = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  const fault: Fault = async (call) => {
    if (!matches(call)) return undefined;
    const answer = await call.forward(call.init);
    reserved.resolve();
    const cut = new Promise<never>((_, reject) => {
      call.init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted.", "AbortError")));
    });
    await Promise.race([opened.promise, cut]);
    return answer;
  };
  return { fault, reserved: reserved.promise, open: () => opened.resolve() };
}

/** A page of the owner "u1": the 600-byte file takes 600 of their 1,000 bytes, so two reservations never fit. */
function nearQuota(...faults: Fault[]) {
  const store = memoryStore();
  const owned = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone }, { owner: () => "u1" });
  const fixture = clientFixture({ owned }, { store, quota: () => 1000, fault: firstOf(...faults) });
  const client = () => createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false });
  return {
    fixture,
    client,
    /** Each row's status, oldest first. */
    rows: async () =>
      (await store.raw.files()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((row) => row.status),
    /** What the owner's next upload of the file ends with. */
    next: async () => (await client().upload("owned", file())).error?.code ?? "done",
  };
}

describe("a cancel while the server has reserved and its /upload answer is on the way", () => {
  it("job.abort() ends the job at once, and the ticket the answer brings is aborted", async () => {
    const held = answerHeld(nth("POST /upload", 1));
    const page = nearQuota(held.fault);
    const job = page.client().start("owned", file());
    await held.reserved;
    job.abort();
    // Settled while the answer is still held: the caller does not wait for the cleanup.
    const { error } = await job.done;
    const whileHeld = await page.rows();
    held.open();
    await vi.waitFor(async () => expect(await page.rows()).toEqual(["aborted"]), { interval: 1 });
    const sent = [...page.fixture.requests];

    expect({ error: error?.code, whileHeld, sent, next: await page.next() }).toEqual({
      error: "ABORTED",
      whileHeld: ["pending"],
      sent: ["POST /upload", "POST /abort"],
      next: "done",
    });
  });

  it("close() resolves once the cancelled /upload answered and its ticket was aborted", async () => {
    const held = answerHeld(nth("POST /upload", 1));
    const page = nearQuota(held.fault);
    const client = page.client();
    const job = client.start("owned", file());
    await held.reserved;
    let closed = false;
    // Without `abort`, which keeps an upload a reload can resume: a ticket that arrives now has no record to resume.
    const closing = client.close().then(() => {
      closed = true;
    });
    await job.done;
    // A macrotask later every step of a close() that did not wait has run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closedWhileHeld = closed;
    held.open();
    await closing;

    expect({ closedWhileHeld, rows: await page.rows() }).toEqual({ closedWhileHeld: false, rows: ["aborted"] });
  });

  it("close() waits for the job's /upload after its every file was cancelled one by one", async () => {
    const held = answerHeld(nth("POST /upload", 1));
    const page = nearQuota(held.fault);
    const client = page.client();
    const job = client.start("owned", file());
    await held.reserved;
    // The file's own cancel, not the job's: the job's /upload keeps running on the job's signal.
    job.files[0]?.abort();
    let closed = false;
    const closing = client.close({ abort: true }).then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closedWhileHeld = closed;
    held.open();
    await closing;

    expect({ closedWhileHeld, rows: await page.rows() }).toEqual({ closedWhileHeld: false, rows: ["aborted"] });
  });

  it("abort() of a file whose retry asks /upload alone aborts the ticket that ask brings", async () => {
    const refused: Fault = (call) =>
      nth("PUT object", 1)(call) ? errorResponse(400, "BadRequest", "Refused.") : undefined;
    const held = answerHeld(nth("POST /upload", 2));
    const page = nearQuota(held.fault, refused);
    const job = page.client().start("owned", file());
    await job.done;
    // The retry gives the refused ticket up, then asks for a new one, which the server reserves.
    const retried = job.files[0]?.retry();
    await held.reserved;
    job.files[0]?.abort();
    const outcome = await retried;
    held.open();
    await vi.waitFor(async () => expect(await page.rows()).toEqual(["aborted", "aborted"]), { interval: 1 });

    expect({ outcome: outcome?.status, next: await page.next() }).toEqual({ outcome: "aborted", next: "done" });
  });
});
