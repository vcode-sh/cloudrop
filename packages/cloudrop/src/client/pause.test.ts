// Contract: spec §4.5 and ruling P4 through the real client in a browser (the XHR transport): pause() aborts a queued
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
    // The first repair's PUT: the file is uploading again, so the pause applies (ruling P4).
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
  it("ends it aborted once the server has answered its /abort", async () => {
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
    const beforeAnswer = settled;
    abortCall.release();
    const { error } = await done;
    expect({ beforeAnswer, code: error?.code, status: fileAt(job, 0)?.status, last: fixture.requests.at(-1) }).toEqual({
      beforeAnswer: false,
      code: "ABORTED",
      status: "aborted",
      last: "POST /abort",
    });
  });
});
