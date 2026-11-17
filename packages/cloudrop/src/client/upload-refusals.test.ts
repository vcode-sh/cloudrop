// Contract: ruling M3-U92 through the real client and server. A file /upload refuses with a retryable error (a storage
// call that failed while the server started it, M2-D13) asks /upload again for itself alone, within the six attempts
// and the backoff every request has (spec §6.2), no sooner than the answer's Retry-After; the other files start at
// once. A final refusal ends the file at once. While it waits the file stays queued, and a pause, offline, its abort()
// or the caller's signal interrupt the wait as they interrupt a part's (M3-U28, M3-U39); a cancel sends nothing
// (M3-U51). retry() after the attempts ran out asks for a new ticket (M3-U31). Oracle: the requests the fixture saw,
// the files each /upload asked for, and the outcomes and statuses the job reports.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type UploadJob } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { storageBusy as busyServer, clientFixture, type Fault } from "../testing/client-fixture.ts";
import { type PageEvents, pageEvents } from "../testing/page-events.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "application/octet-stream", maxSize: "100MB", authorize: allowAnyone });

/** The server's per-file answer when starting the file in storage failed (storageFailure in server/http.ts). */
const storageDown = {
  code: "STORAGE_ERROR",
  message: "The storage service failed. Try again in a moment.",
  retryable: true,
};
const storageBusy = {
  code: "RATE_LIMITED",
  message: "The storage service is busy. Try again in a moment.",
  retryable: true,
};

/** A 200 /upload answer whose only file is refused with `error`. */
const refusedAnswer = (error: object, headers?: Record<string, string>) =>
  Response.json({ files: [{ kind: "rejected", error }] }, { headers });

/** A client on the fake bucket; `fault` answers /upload in place of the server, and `asked` lists each one's files. */
function setup(fault: Fault) {
  const asked: string[][] = [];
  const fixture = clientFixture(
    { files },
    {
      fault: (call) => {
        if (call.label !== "POST /upload") return undefined;
        asked.push(JSON.parse(String(call.init.body)).files.map(({ name }: { name: string }) => name));
        return fault(call);
      },
    },
  );
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch });
  return { fixture, asked, client, page: pageEvents() };
}

const fileOf = (name: string, type = "application/octet-stream") => new File([offsetBytes(1000)], name, { type });

/** A macrotask, which fake timers leave alone: the answer to the /upload sent before has been read. */
const answered = () => new Promise((resolve) => setImmediate(resolve));

const statuses = (job: UploadJob<unknown>) => job.getSnapshot().files.map((file) => file.status);
const outcomeOf = ({ status, error }: { status: string; error?: { code: string; retryable: boolean } }) =>
  error ? { status, code: error.code, retryable: error.retryable } : { status };

beforeEach(() => {
  // Every backoff wait is 0 ms unless a test sets the jitter.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a file /upload refuses with a retryable error", () => {
  it("asks /upload again and uploads the file when the second answer gives it a ticket", async () => {
    const { fixture, client } = setup(({ nth }) => (nth === 1 ? refusedAnswer(storageDown) : undefined));
    const { data } = await client.start("files", [fileOf("a.bin")]).done;
    expect({ outcomes: data?.files.map(outcomeOf), requests: fixture.requests }).toEqual({
      outcomes: [{ status: "done" }],
      requests: ["POST /upload", "POST /upload", "PUT object", "POST /complete"],
    });
  });

  it("ends the file failed with the refusal once six /upload attempts have refused it", async () => {
    const { fixture, client } = setup(() => refusedAnswer(storageBusy));
    const result = await client.upload("files", [fileOf("a.bin")]);
    expect({
      error: { code: result.error?.code, message: result.error?.message, file: result.error?.file },
      requests: fixture.requests,
    }).toEqual({
      error: { code: "RATE_LIMITED", message: storageBusy.message, file: { id: "1", name: "a.bin" } },
      requests: Array(6).fill("POST /upload"),
    });
  });

  it("counts the attempts of an /upload that asked again and failed as a whole in the same six", async () => {
    // Refused once, then the server itself is busy (503) for every later /upload.
    const { fixture, client } = setup(({ nth }) => (nth === 1 ? refusedAnswer(storageDown) : busyServer()));
    const { data, error } = await client.start("files", [fileOf("a.bin")]).done;
    expect({ outcomes: data?.files.map(outcomeOf), file: error?.file, requests: fixture.requests }).toEqual({
      outcomes: [{ status: "failed", code: "RATE_LIMITED", retryable: true }],
      // The file's own error: the job's /upload had answered, so the job as a whole did not fail (M3-U52).
      file: { id: "1", name: "a.bin" },
      requests: Array(6).fill("POST /upload"),
    });
  });

  it("ends a file refused for good at once, after one /upload", async () => {
    const { fixture, client } = setup(() => undefined);
    const { data } = await client.start("files", [fileOf("note.txt", "text/plain")]).done;
    expect({ outcomes: data?.files.map(outcomeOf), requests: fixture.requests }).toEqual({
      outcomes: [{ status: "failed", code: "FILE_TYPE_NOT_ALLOWED", retryable: false }],
      requests: ["POST /upload"],
    });
  });

  it("asks again for the refused file alone, and the others upload without waiting for it", async () => {
    let firstDone = () => {};
    const firstStored = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    const { fixture, asked, client } = setup(async ({ nth, init, forward }) => {
      const answer = await forward(init);
      if (nth > 1) {
        // Answered only once a.bin has been completed: a client that held a.bin back for b.bin would never finish.
        await firstStored;
        return answer;
      }
      const { files: tickets } = await answer.json();
      return Response.json({ files: [tickets[0], { kind: "rejected", error: storageDown }] });
    });
    const job = client.start("files", [fileOf("a.bin"), fileOf("b.bin")]);
    // retry() on a file that has not failed sends nothing and resolves when it settles (M3-U37).
    void job.files[0]?.retry().then(firstDone);
    const { data } = await job.done;
    expect({
      asked,
      outcomes: data?.files.map(outcomeOf),
      puts: fixture.requests.filter((r) => r === "PUT object"),
    }).toEqual({
      asked: [["a.bin", "b.bin"], ["b.bin"]],
      outcomes: [{ status: "done" }, { status: "done" }],
      puts: ["PUT object", "PUT object"],
    });
  });

  it("waits for the answer's Retry-After before it asks again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The largest jitter of a first retry: 0.5 s, so only the Retry-After can hold the second /upload for 3 s.
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const { fixture, client } = setup(({ nth }) =>
      nth === 1 ? refusedAnswer(storageBusy, { "retry-after": "3" }) : undefined,
    );
    const job = client.start("files", [fileOf("a.bin")]);
    await vi.advanceTimersByTimeAsync(2999);
    const before = [...fixture.requests];
    await vi.advanceTimersByTimeAsync(1);
    const { data } = await job.done;
    expect({ before, outcomes: data?.files.map(outcomeOf), after: fixture.requests }).toEqual({
      before: ["POST /upload"],
      outcomes: [{ status: "done" }],
      after: ["POST /upload", "POST /upload", "PUT object", "POST /complete"],
    });
  });

  it("asks a new ticket on retry() after the six attempts ran out", async () => {
    const { fixture, client } = setup(({ nth }) => (nth <= 6 ? refusedAnswer(storageDown) : undefined));
    const job = client.start("files", [fileOf("a.bin")]);
    const first = await job.done;
    const retried = await job.files[0]?.retry();
    expect({
      first: first.data?.files.map(outcomeOf),
      retried: retried && outcomeOf(retried),
      afterRetry: fixture.requests.slice(6),
    }).toEqual({
      first: [{ status: "failed", code: "STORAGE_ERROR", retryable: true }],
      retried: { status: "done" },
      afterRetry: ["POST /upload", "PUT object", "POST /complete"],
    });
  });
});

describe("a file waiting to ask /upload again", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Every wait is 0.4995 s or more, so a test can act while the file waits.
    vi.spyOn(Math, "random").mockReturnValue(0.999);
  });

  it.each([
    { name: "its abort()", cancel: (job: UploadJob<unknown>) => job.files[0]?.abort() },
    {
      name: "the caller's signal",
      cancel: (_job: UploadJob<unknown>, controller: AbortController) => controller.abort(),
    },
  ])("ends aborted at once on $name, sending nothing more", async ({ cancel }) => {
    const { fixture, client } = setup(() => refusedAnswer(storageDown));
    const controller = new AbortController();
    const job = client.start("files", [fileOf("a.bin")], { signal: controller.signal });
    await answered();
    const waiting = statuses(job);
    cancel(job, controller);
    await answered();
    const ended = statuses(job);
    await vi.advanceTimersByTimeAsync(60_000);
    expect({ waiting, ended, requests: fixture.requests }).toEqual({
      waiting: ["queued"],
      ended: ["aborted"],
      requests: ["POST /upload"],
    });
  });

  type Held = { job: UploadJob<unknown>; page: PageEvents };
  it.each([
    {
      name: "paused by the caller until resume()",
      hold: ({ job }: Held) => job.pause(),
      free: ({ job }: Held) => job.resume(),
    },
    {
      name: "paused by offline until online",
      hold: ({ page }: Held) => page.fire("offline"),
      free: ({ page }: Held) => page.fire("online"),
    },
  ])("asks nothing while $name, then asks at once", async ({ hold, free }) => {
    const { fixture, client, page } = setup(({ nth }) => (nth === 1 ? refusedAnswer(storageDown) : undefined));
    const job = client.start("files", [fileOf("a.bin")]);
    await answered();
    hold({ job, page });
    const held = statuses(job);
    await vi.advanceTimersByTimeAsync(60_000);
    const whileHeld = [...fixture.requests];
    free({ job, page });
    const { data } = await job.done;
    expect({ held, whileHeld, outcomes: data?.files.map(outcomeOf), requests: fixture.requests }).toEqual({
      held: ["paused"],
      whileHeld: ["POST /upload"],
      outcomes: [{ status: "done" }],
      requests: ["POST /upload", "POST /upload", "PUT object", "POST /complete"],
    });
  });
});
