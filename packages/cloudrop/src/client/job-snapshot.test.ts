// Contract: spec §2.1, §4.2 and §4.3 through the real client in a browser (the XHR transport): a job's snapshot shows
// each file's bytes, which never go backwards, its progress, speed and time left, and totals over the files that did
// not fail or abort; it is the same object until a publish, listeners hear of bytes at most every 100 ms and of a status
// at once (ruling M3-U7), and a listener that throws stops nothing (ruling M3-U8). Oracle: the bytes each fake request
// reports, the meter's hand-worked values (progress.test.ts) and the server's verdicts for the routes below.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type JobSnapshot, type UploadJob } from "../client.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture } from "../testing/client-fixture.ts";
import { fakeXhr } from "../testing/fake-xhr.ts";
import { offsetBytes } from "../testing/storage-contract.ts";
import { files } from "../testing/upload-fixture.ts";

const upTo2000 = route({ accept: "*/*", maxSize: 2000, authorize: allowAnyone });
const single = route({ accept: "*/*", maxSize: 2000, maxFiles: 1, authorize: allowAnyone });

/** A browser client: no fetch option, so bucket PUTs go through the fake XHR; `hold` leaves each one open. */
function setup({ hold = false, concurrency = 4 } = {}) {
  const fixture = clientFixture({ files, upTo2000, single }, { multipartThreshold: "8MB" });
  const xhr = fakeXhr(fixture.fetch, { hold });
  vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
  vi.stubGlobal("fetch", fixture.fetch);
  return { xhr, client: createCloudropClient({ basePath: fixture.basePath, concurrency }) };
}

const fileOf = (size: number, name = "a.bin") =>
  new File([offsetBytes(size)], name, { type: "application/octet-stream" });

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

/** Lets a held request's snapshot publish: bytes wait at most 100 ms. */
const publishBytes = () => vi.advanceTimersByTime(100);

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

describe("a job's snapshot", () => {
  it("shows a file's bytes while it sends, keeps the object until the next publish, and its result once done", async () => {
    const { xhr, client } = setup({ hold: true });
    const job = client.start("files", fileOf(1000));
    const put = await xhr.next();
    put.progress(400);
    publishBytes();
    const sending = job.getSnapshot();
    const sameObject = job.getSnapshot() === sending;
    await put.finish();
    const { data } = await job.done;
    expect({ sending: sending.files[0], sameObject, settled: job.getSnapshot().files[0] }).toEqual({
      sending: expect.objectContaining({ status: "uploading", bytes: 400, progress: 0.4 }),
      sameObject: true,
      settled: {
        id: "1",
        name: "a.bin",
        size: 1000,
        type: "application/octet-stream",
        status: "done",
        bytes: 1000,
        progress: 1,
        speed: 0,
        eta: null,
        error: null,
        result: data?.files[0]?.status === "done" ? data.files[0].result : "no result",
      },
    });
  });

  it("never lowers a file's bytes when a part is sent again", async () => {
    const { xhr, client } = setup({ hold: true });
    const job = client.start("files", fileOf(16 * MiB + 1000));
    const puts = [await xhr.next(), await xhr.next(), await xhr.next()];
    const first = puts.find((put) => put.label === "PUT part 1");
    const bytes: number[] = [];
    const read = () => bytes.push(job.getSnapshot().files[0]?.bytes ?? -1);
    first?.progress(4 * MiB);
    publishBytes();
    read();
    first?.fail();
    // The part's retry waits 0 ms, then sends again.
    await vi.advanceTimersByTimeAsync(0);
    const again = await xhr.next();
    again.progress(1 * MiB);
    publishBytes();
    read();
    again.progress(5 * MiB);
    publishBytes();
    read();
    job.abort();
    await job.done;
    expect({ again: again.label, bytes }).toEqual({ again: "PUT part 1", bytes: [4 * MiB, 4 * MiB, 5 * MiB] });
  });

  it("calls a listener once for ten progress events within 50 ms, 100 ms after the last publish", async () => {
    const { xhr, client } = setup({ hold: true });
    const job = client.start("files", fileOf(1000));
    const listener = vi.fn();
    job.subscribe(listener);
    const put = await xhr.next();
    // The file turning uploading was published at once.
    listener.mockClear();
    for (let event = 1; event <= 10; event++) {
      put.progress(event * 100);
      vi.advanceTimersByTime(5);
    }
    const within50 = listener.mock.calls.length;
    vi.advanceTimersByTime(50);
    expect({ within50, at100: listener.mock.calls.length }).toEqual({ within50: 0, at100: 1 });
    job.abort();
    await job.done;
  });

  it("publishes each status at once: queued, uploading, completing, done", async () => {
    const { client } = setup();
    // The clock never moves here, so only status changes can publish.
    const job = client.start("files", fileOf(1000));
    const queued = job.getSnapshot().files[0]?.status;
    const seen: [string, number][] = [];
    job.subscribe(() => {
      const file = job.getSnapshot().files[0];
      seen.push([file?.status ?? "missing", file?.bytes ?? -1]);
    });
    await job.done;
    expect({ queued, seen }).toEqual({
      queued: "queued",
      seen: [
        ["uploading", 0],
        ["completing", 1000],
        ["done", 1000],
      ],
    });
  });

  it("shows the speed and the time left from the bytes sent per second since the file got its slot", async () => {
    const { xhr, client } = setup({ hold: true, concurrency: 1 });
    const job = client.start("files", [fileOf(1000, "first.bin"), fileOf(10_000)]);
    // The second file waits 5 s for the only slot: that wait is not part of its speed.
    const first = await xhr.next();
    vi.advanceTimersByTime(5000);
    await first.finish();
    const put = await xhr.next();
    vi.advanceTimersByTime(1000);
    put.progress(1000);
    vi.advanceTimersByTime(1000);
    put.progress(2000);
    // The last publish was more than 100 ms ago, so these bytes publish without the clock moving.
    vi.advanceTimersByTime(0);
    const file = job.getSnapshot().files[1];
    expect(file?.bytes).toBe(2000);
    expect(file?.speed).toBeCloseTo(486.58, 1);
    expect(file?.eta).toBeCloseTo(16.44, 1);
    job.abort();
    await job.done;
  });

  it("totals only the files that did not fail", async () => {
    const { xhr, client } = setup({ hold: true });
    const job = client.start("upTo2000", [fileOf(1000, "a.bin"), fileOf(2000, "b.bin"), fileOf(2001, "big.bin")]);
    const puts = [await xhr.next(), await xhr.next()];
    const firstDone = until(job, (snapshot) => snapshot.files[0]?.status === "done");
    await puts.find((put) => put.size === 1000)?.finish();
    await firstDone;
    puts.find((put) => put.size === 2000)?.progress(800);
    publishBytes();
    const { files: snapshots, totals } = job.getSnapshot();
    expect({ statuses: snapshots.map((file) => file.status), totals }).toEqual({
      statuses: ["done", "uploading", "failed"],
      totals: expect.objectContaining({
        bytes: 1800,
        size: 3000,
        progress: 0.6,
        done: 1,
        failed: 1,
        aborted: 0,
        count: 3,
      }),
    });
    job.abort();
    await job.done;
  });

  it("shows an empty file at 0 until it is done, then at 1", async () => {
    const { client } = setup();
    const job = client.start("files", new File([], "empty.txt", { type: "text/plain" }));
    const before = job.getSnapshot();
    await job.done;
    const after = job.getSnapshot();
    expect({
      before: [before.files[0]?.progress, before.totals.progress],
      after: [after.files[0]?.progress, after.totals.progress],
    }).toEqual({ before: [0, 0], after: [1, 1] });
  });

  it("shows every file failed and the job at 0 when /upload refuses it", async () => {
    const { client } = setup();
    const job = client.start("single", [fileOf(10, "a.bin"), fileOf(20, "b.bin")]);
    await job.done;
    const { files: snapshots, totals } = job.getSnapshot();
    expect({ statuses: snapshots.map((file) => [file.status, file.error?.code]), totals }).toEqual({
      statuses: [
        ["failed", "TOO_MANY_FILES"],
        ["failed", "TOO_MANY_FILES"],
      ],
      totals: { bytes: 0, size: 0, progress: 0, speed: 0, eta: null, done: 0, failed: 2, aborted: 0, count: 2 },
    });
  });

  it("is empty for a job refused for its arguments", () => {
    const { client } = setup();
    const { subscribe, getSnapshot } = client.start("files", "not a file" as unknown as File);
    subscribe(() => {})();
    expect(getSnapshot()).toEqual({
      files: [],
      totals: { bytes: 0, size: 0, progress: 0, speed: 0, eta: null, done: 0, failed: 0, aborted: 0, count: 0 },
    });
  });

  it("finishes the job when a listener throws, and throws the error again from a timer", async () => {
    const { client } = setup();
    const { subscribe, done } = client.start("files", fileOf(1000));
    subscribe(() => {
      throw new Error("listener failed");
    });
    const { data } = await done;
    expect(data?.files[0]?.status).toBe("done");
    expect(() => vi.runOnlyPendingTimers()).toThrow("listener failed");
  });
});
