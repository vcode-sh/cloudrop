// Contract: spec §4.5 and M3-U4 through the real client in a browser (the XHR transport): pause() aborts a queued
// or uploading file's PUTs and keeps its token, its landed parts and its bytes; resume() sends only the parts that have
// not landed (a single PUT again from the start); abort() of a paused file tells the server before `done` settles; a
// completing or settled file ignores pause and resume; a pause that meets a pool grant sends nothing.
// Oracle: the requests the fake XHR and the fixture saw, the bytes each fake request reported, and the bytes the fake
// bucket stored.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type JobSnapshot, type UploadJob } from "../client.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, lostPart } from "../testing/client-fixture.ts";
import { fakeXhr } from "../testing/fake-xhr.ts";
import { firstOf, gate as heldCalls, threeParts } from "../testing/persist-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });

/** A browser client (bucket PUTs through the fake XHR); `hold` leaves each PUT open, `fault` answers app requests. */
function setup({ hold = false, concurrency = 4, fault = (() => undefined) as Fault } = {}) {
  const fixture = clientFixture({ files }, { multipartThreshold: "8MB", fault });
  const xhr = fakeXhr(fixture.fetch, { hold });
  vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
  vi.stubGlobal("fetch", fixture.fetch);
  return { fixture, xhr, client: createCloudropClient({ basePath: fixture.basePath, concurrency }) };
}

const fileOf = (size: number, name = "a.bin") =>
  new File([offsetBytes(size)], name, { type: "application/octet-stream" });

/** A request the fault holds until `release()`; `seen` resolves when it arrives. */
function gate() {
  let arrived = () => {};
  let release = () => {};
  const seen = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold = async () => {
    arrived();
    await open;
  };
  return { seen, release, hold };
}

/** Resolves with the first snapshot published after this call for which `test` holds. */
function until(job: UploadJob<unknown>, test: (snapshot: JobSnapshot<unknown>) => boolean) {
  return new Promise<JobSnapshot<unknown>>((resolve) => {
    const stop = job.subscribe(() => {
      if (!test(job.getSnapshot())) return;
      stop();
      resolve(job.getSnapshot());
    });
  });
}

/** A macrotask, which fake timers leave alone: every microtask queued before it has run. */
const everyMicrotask = () => new Promise((resolve) => setImmediate(resolve));

const fileAt = (job: UploadJob<unknown>, index: number) => job.getSnapshot().files[index];
const statuses = (job: UploadJob<unknown>) => job.getSnapshot().files.map((file) => file.status);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pause and resume", () => {
  it("stops a multipart file's open parts and sends only the parts that had not landed", async () => {
    const { xhr, client } = setup({ hold: true, concurrency: 2 });
    const job = client.start("files", fileOf(16 * MiB + 1000));
    const [handle] = job.files;
    const first = [await xhr.next(), await xhr.next()];
    await first.find((put) => put.label === "PUT part 1")?.finish();
    const third = await xhr.next();
    first.find((put) => put.label === "PUT part 2")?.progress(3 * MiB);
    handle?.pause();
    const paused = { status: fileAt(job, 0)?.status, bytes: fileAt(job, 0)?.bytes, open: xhr.open.length };
    handle?.resume();
    const again = [await xhr.next(), await xhr.next()];
    for (const put of again) await put.finish();
    const { data } = await job.done;
    expect({
      third: third.label,
      paused,
      resent: again.map((put) => put.label).sort(),
      partOneSent: xhr.sent.filter((label) => label === "PUT part 1").length,
      outcome: data?.files[0]?.status,
    }).toEqual({
      third: "PUT part 3",
      paused: { status: "paused", bytes: 8 * MiB + 3 * MiB, open: 0 },
      resent: ["PUT part 2", "PUT part 3"],
      partOneSent: 1,
      outcome: "done",
    });
  });

  it("sends a paused single PUT again from the start without lowering its bytes", async () => {
    const { fixture, xhr, client } = setup({ hold: true });
    const job = client.start("files", fileOf(1000));
    const [handle] = job.files;
    const put = await xhr.next();
    put.progress(600);
    handle?.pause();
    const paused = { bytes: fileAt(job, 0)?.bytes, open: xhr.open.length };
    handle?.resume();
    const again = await xhr.next();
    again.progress(300);
    vi.advanceTimersByTime(100);
    const resent = fileAt(job, 0)?.bytes;
    await again.finish();
    const { data } = await job.done;
    const outcome = data?.files[0];
    const key = outcome?.status === "done" ? outcome.result.file.key : "";
    expect({
      paused,
      resent,
      sent: xhr.sent,
      stored: (await fixture.server.storage.getRange(key, 0, 999)).data,
    }).toEqual({
      paused: { bytes: 600, open: 0 },
      resent: 600,
      sent: ["PUT object", "PUT object"],
      stored: offsetBytes(1000),
    });
  });

  it("holds /complete of a file paused once its last part landed, and sends nothing again on resume", async () => {
    const { fixture, xhr, client } = setup({ hold: true });
    const job = client.start("files", fileOf(1000));
    await (await xhr.next()).finish();
    // The PUT is stored, and the pass has not reached /complete yet.
    job.files[0]?.pause();
    await everyMicrotask();
    const whilePaused = { status: fileAt(job, 0)?.status, last: fixture.requests.at(-1) };
    job.files[0]?.resume();
    const { data } = await job.done;
    expect({ whilePaused, sent: xhr.sent, outcome: data?.files[0]?.status }).toEqual({
      whilePaused: { status: "paused", last: "PUT object" },
      sent: ["PUT object"],
      outcome: "done",
    });
  });

  it("ignores pause while the file completes", async () => {
    const completing = gate();
    const { client } = setup({
      fault: async ({ label }) => {
        if (label === "POST /complete") await completing.hold();
        return undefined;
      },
    });
    const job = client.start("files", fileOf(1000));
    await completing.seen;
    const before = job.getSnapshot();
    job.files[0]?.pause();
    const unchanged = job.getSnapshot() === before;
    completing.release();
    const { data } = await job.done;
    expect({ status: before.files[0]?.status, unchanged, outcome: data?.files[0]?.status }).toEqual({
      status: "completing",
      unchanged: true,
      outcome: "done",
    });
  });

  it("keeps a file paused before /upload answered from sending until it is resumed", async () => {
    const answer = gate();
    const { xhr, client } = setup({
      fault: async ({ label }) => {
        if (label === "POST /upload") await answer.hold();
        return undefined;
      },
    });
    // The second file sends meanwhile: once its first part is out, the paused one would have sent too.
    const job = client.start("files", [fileOf(1000, "small.bin"), fileOf(8 * MiB + 5, "large.bin")]);
    await answer.seen;
    job.files[0]?.pause();
    answer.release();
    await xhr.next();
    const whilePaused = { status: fileAt(job, 0)?.status, sentObject: xhr.sent.includes("PUT object") };
    job.files[0]?.resume();
    const { data } = await job.done;
    expect({ whilePaused, outcomes: data?.files.map((file) => file.status) }).toEqual({
      whilePaused: { status: "paused", sentObject: false },
      outcomes: ["done", "done"],
    });
  });

  it("fails a file paused before /upload answered when /upload fails, and sends nothing", async () => {
    const answer = gate();
    const { xhr, client } = setup({
      fault: async ({ label }) => {
        if (label !== "POST /upload") return undefined;
        await answer.hold();
        const error = { code: "UNAUTHORIZED", message: "Sign in to upload files.", retryable: false };
        return Response.json({ error }, { status: 401 });
      },
    });
    const job = client.start("files", [fileOf(1000, "a.bin"), fileOf(1000, "b.bin")]);
    await answer.seen;
    job.files[0]?.pause();
    answer.release();
    const { data, error } = await job.done;
    expect({ data, code: error?.code, statuses: statuses(job), sent: xhr.sent }).toEqual({
      data: null,
      code: "UNAUTHORIZED",
      statuses: ["failed", "failed"],
      sent: [],
    });
  });

  it("sends nothing for a file paused while it waits for the pool, though a slot frees at once", async () => {
    const { xhr, client } = setup({ hold: true, concurrency: 1 });
    const job = client.start("files", [fileOf(1000, "first.bin"), fileOf(1000, "second.bin")]);
    const put = await xhr.next();
    const firstDone = until(job, (snapshot) => snapshot.files[0]?.status === "done");
    // The second file waits for the only slot, which the first file's PUT frees.
    job.files[1]?.pause();
    await put.finish();
    await firstDone;
    const whilePaused = { status: fileAt(job, 1)?.status, sent: xhr.sent.length };
    job.files[1]?.resume();
    await (await xhr.next()).finish();
    const { data } = await job.done;
    expect({ whilePaused, outcomes: data?.files.map((file) => file.status) }).toEqual({
      whilePaused: { status: "paused", sent: 1 },
      outcomes: ["done", "done"],
    });
  });

  it("pauses and resumes every file of a job that can take it, and leaves a done file done", async () => {
    const { xhr, client } = setup({ hold: true, concurrency: 1 });
    const job = client.start("files", [fileOf(1000, "a.bin"), fileOf(1000, "b.bin"), fileOf(1000, "c.bin")]);
    const firstDone = until(job, (snapshot) => snapshot.files[0]?.status === "done");
    await (await xhr.next()).finish();
    await firstDone;
    // b.bin holds the slot now, c.bin waits for it.
    await xhr.next();
    job.pause();
    const paused = { statuses: statuses(job), open: xhr.open.length };
    job.resume();
    const resumed = statuses(job);
    await (await xhr.next()).finish();
    await (await xhr.next()).finish();
    const { data, error } = await job.done;
    expect({ paused, resumed, outcomes: data?.files.map((file) => file.status), error }).toEqual({
      paused: { statuses: ["done", "paused", "paused"], open: 0 },
      resumed: ["done", "queued", "queued"],
      outcomes: ["done", "done", "done"],
      error: null,
    });
  });

  it("pauses a repair after PARTS_MISSING and still fails at the third PARTS_MISSING", async () => {
    // The bucket says it stored part 2 every time, so every /complete answers PARTS_MISSING [2].
    const { fixture, xhr, client } = setup({
      hold: true,
      fault: ({ label }) => (label === "PUT part 2" ? lostPart() : undefined),
    });
    const job = client.start("files", fileOf(8 * MiB + 5));
    await (await xhr.next()).finish();
    await (await xhr.next()).finish();
    // The first repair's PUT: the file is uploading again, so the pause applies (ruling M3-U4).
    await xhr.next();
    job.files[0]?.pause();
    const paused = fileAt(job, 0)?.status;
    job.files[0]?.resume();
    await (await xhr.next()).finish();
    await (await xhr.next()).finish();
    const { error } = await job.done;
    expect({
      paused,
      code: error?.code,
      completes: fixture.requests.filter((label) => label === "POST /complete").length,
    }).toEqual({ paused: "paused", code: "PARTS_MISSING", completes: 3 });
  });

  it("changes nothing when a settled file is paused or resumed", async () => {
    const { client } = setup();
    const job = client.start("files", fileOf(1000));
    await job.done;
    const settled = job.getSnapshot();
    job.files[0]?.pause();
    job.files[0]?.resume();
    expect(job.getSnapshot()).toBe(settled);
  });
});

describe("abort of a paused file", () => {
  it("shows it aborted at once and settles done once the server has answered its /abort", async () => {
    const abortCall = gate();
    const { fixture, xhr, client } = setup({
      hold: true,
      fault: async ({ label }) => {
        if (label === "POST /abort") await abortCall.hold();
        return undefined;
      },
    });
    const job = client.start("files", fileOf(1000));
    await xhr.next();
    job.files[0]?.pause();
    let settled = false;
    const done = job.done.then((result) => {
      settled = true;
      return result;
    });
    // The paused file now waits for resume() or abort().
    await everyMicrotask();
    job.files[0]?.abort();
    await abortCall.seen;
    // A `done` that did not wait for /abort has settled by now.
    await everyMicrotask();
    // The page shows the cancel at once, though `done` waits for the server.
    const beforeAnswer = { settled, status: fileAt(job, 0)?.status };
    abortCall.release();
    const { error } = await done;
    expect({ beforeAnswer, code: error?.code, last: fixture.requests.at(-1) }).toEqual({
      beforeAnswer: { settled: false, status: "aborted" },
      code: "ABORTED",
      last: "POST /abort",
    });
  });
});

describe("the URLs a paused file signed", () => {
  it("serve its next pass: a URL renewed before the pause is not renewed again (M4-F8)", async () => {
    const T0 = Date.parse("2026-11-17T12:00:00.000Z");
    vi.setSystemTime(T0);
    const upload = heldCalls((call) => call.label === "POST /upload");
    const part2 = heldCalls((call) => call.label === "PUT part 2" && call.nth === 1);
    // Every part's renewal answered before the pause, so none is cut off by it and asked again.
    const renewed = Promise.withResolvers<void>();
    let renewals = 0;
    const fixture = clientFixture(
      { files },
      {
        multipartThreshold: "8MB",
        // The ticket is signed at T0; it reaches the page 850 s later, when its 900 s URLs expire within the minute.
        fault: firstOf(
          async (call) => {
            if (call.label !== "POST /upload") return undefined;
            const answer = await call.forward(call.init);
            await upload.fault(call);
            return answer;
          },
          async (call) => {
            if (call.label !== "POST /sign") return undefined;
            const answer = await call.forward(call.init);
            if (++renewals === 3) renewed.resolve();
            return answer;
          },
          part2.fault,
        ),
      },
    );
    // fetch PUTs, one at a time.
    const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, concurrency: 1 });
    const job = client.start("files", threeParts());
    await upload.reached;
    vi.setSystemTime(T0 + 850_000);
    upload.open();
    await Promise.all([part2.reached, renewed.promise]);
    await everyMicrotask();
    job.pause();
    await everyMicrotask();
    const beforeResume = fixture.requests.length;
    job.resume();
    const { error } = await job.done;
    const signs = (requests: string[]) => requests.filter((label) => label === "POST /sign").length;

    // Each part's worker renews its URL before it waits for the one connection, so the order of the PUTs before the
    // pause depends on which /sign answers first; the counts do not.
    expect({
      error,
      renewedBeforePause: signs(fixture.requests.slice(0, beforeResume)),
      renewedAfterResume: signs(fixture.requests.slice(beforeResume)),
      last: fixture.requests.at(-1),
    }).toEqual({ error: null, renewedBeforePause: 3, renewedAfterResume: 0, last: "POST /complete" });
  });
});
