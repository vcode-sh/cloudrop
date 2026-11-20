// Contract: spec §4.6 and rulings M3-U28 and M3-U39 through the real client in a browser (the XHR transport): the
// page's `offline` pauses every queued and uploading file and aborts its PUTs; `online` resumes only the files
// `offline` paused, so a file the caller paused stays paused; a job that starts while the page is offline pauses its
// files at once; the job listens only while a file runs; where the global has no addEventListener, nothing pauses.
// Oracle: the statuses the snapshot shows, the requests the fake XHR saw, and the listeners the stubbed global holds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type JobSnapshot, type UploadJob } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, statuses } from "../testing/client-fixture.ts";
import { fakeXhr } from "../testing/fake-xhr.ts";
import { pageEvents } from "../testing/page-events.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });

/** A browser client whose bucket PUTs stay open until the test finishes them. */
function setup(concurrency: number) {
  const fixture = clientFixture({ files });
  const xhr = fakeXhr(fixture.fetch, { hold: true });
  vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
  vi.stubGlobal("fetch", fixture.fetch);
  return { xhr, client: createCloudropClient({ basePath: fixture.basePath, concurrency }) };
}

const fileOf = (name: string) => new File([offsetBytes(1000)], name, { type: "application/octet-stream" });

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

describe("offline and online", () => {
  it("pauses a queued and an uploading file on offline, aborting the PUT, and resumes both on online", async () => {
    const { xhr, client } = setup(1);
    const connectivity = pageEvents();
    const job = client.start("files", [fileOf("a.bin"), fileOf("b.bin")]);
    await xhr.next();
    const before = statuses(job);
    connectivity.fire("offline");
    const offline = { statuses: statuses(job), open: xhr.open.length };
    connectivity.fire("online");
    await (await xhr.next()).finish();
    await (await xhr.next()).finish();
    const { data } = await job.done;
    expect({ before, offline, sent: xhr.sent, outcomes: data?.files.map((file) => file.status) }).toEqual({
      before: ["uploading", "queued"],
      offline: { statuses: ["paused", "paused"], open: 0 },
      sent: ["PUT object", "PUT object", "PUT object"],
      outcomes: ["done", "done"],
    });
  });

  it("resumes on online only the files offline paused and the caller did not pause (M3-U28)", async () => {
    const { xhr, client } = setup(3);
    const connectivity = pageEvents();
    const job = client.start("files", [fileOf("a.bin"), fileOf("b.bin"), fileOf("c.bin")]);
    const [a, b] = job.files;
    await Promise.all([xhr.next(), xhr.next(), xhr.next()]);
    a?.pause();
    connectivity.fire("offline");
    b?.pause();
    connectivity.fire("online");
    const online = statuses(job);
    job.abort();
    await job.done;
    expect(online).toEqual(["paused", "paused", "queued"]);
  });

  it("pauses at once a job that starts while the page is offline, and sends nothing until online", async () => {
    const { xhr, client } = setup(1);
    const connectivity = pageEvents();
    vi.stubGlobal("navigator", { onLine: false });
    const job = client.start("files", fileOf("a.bin"));
    const paused = (await until(job, (snapshot) => snapshot.files[0]?.status !== "queued")).files[0]?.status;
    await everyMicrotask();
    const sentWhileOffline = [...xhr.sent];
    connectivity.fire("online");
    await (await xhr.next()).finish();
    const { data } = await job.done;
    expect({ paused, sentWhileOffline, outcome: data?.files[0]?.status }).toEqual({
      paused: "paused",
      sentWhileOffline: [],
      outcome: "done",
    });
  });

  it("listens from the first file's run until the last one ends, not while /upload is on its way", async () => {
    const { xhr, client } = setup(2);
    const connectivity = pageEvents();
    const job = client.start("files", [fileOf("a.bin"), fileOf("b.bin")]);
    const duringUpload = connectivity.listening();
    const [first, second] = await Promise.all([xhr.next(), xhr.next()]);
    const running = connectivity.listening();
    const firstDone = until(job, (snapshot) => snapshot.files[0]?.status === "done");
    await first.finish();
    await firstDone;
    // The first file's run ends a few microtasks after its snapshot says done.
    await everyMicrotask();
    const oneRunning = connectivity.listening();
    await second.finish();
    await job.done;
    expect({ duringUpload, running, oneRunning, after: connectivity.listening() }).toEqual({
      duringUpload: [],
      running: ["offline", "online"],
      oneRunning: ["offline", "online"],
      after: [],
    });
  });

  it("never pauses where the global has no addEventListener, even when navigator says offline", async () => {
    const { client } = setup(1);
    vi.stubGlobal("navigator", { onLine: false });
    const job = client.start("files", fileOf("a.bin"));
    // Without an `online` event to resume it, a file paused here would wait forever.
    const status = (await until(job, (snapshot) => snapshot.files[0]?.status !== "queued")).files[0]?.status;
    job.abort();
    await job.done;
    expect(status).toBe("uploading");
  });
});
