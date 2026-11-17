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
import { clientFixture, type Fault, storageBusy } from "../testing/client-fixture.ts";
import { type PageEvents, pageEvents } from "../testing/page-events.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "application/octet-stream", maxSize: "100MB", authorize: allowAnyone });

/** The server's per-file answers when starting the file in storage failed (storageFailure in server/http.ts). */
const storageDownRefusal = {
  code: "STORAGE_ERROR",
  message: "The storage service failed. Try again in a moment.",
  retryable: true,
};
const busyRefusal = {
  code: "RATE_LIMITED",
  message: "The storage service is busy. Try again in a moment.",
  retryable: true,
};

/** The server's per-file answer when storage refused to start the file: final. */
const finalRefusal = {
  code: "STORAGE_ERROR",
  message: "The storage service refused the request. Contact the site owner if this keeps happening.",
  retryable: false,
};

/** A 200 /upload answer whose only file is refused with `error`. */
const refusedAnswer = (error: object, headers?: Record<string, string>) =>
  Response.json({ files: [{ kind: "rejected", error }] }, { headers });

/** A client on the fake bucket; `fault` answers /upload in place of the server, and `asked` lists each one's files. */
type Client = ReturnType<typeof setup>["client"];

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

/** Resolves with the first file's status once it is final. */
const settled = (job: UploadJob<unknown>) =>
  new Promise<string>((resolve) => {
    const check = () => {
      const [status = ""] = statuses(job);
      if (!["done", "failed", "aborted"].includes(status)) return;
      stop();
      resolve(status);
    };
    const stop = job.subscribe(check);
    check();
  });
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
    const { fixture, client } = setup(({ nth }) => (nth === 1 ? refusedAnswer(storageDownRefusal) : undefined));
    const { data } = await client.start("files", [fileOf("a.bin")]).done;
    expect({ outcomes: data?.files.map(outcomeOf), requests: fixture.requests }).toEqual({
      outcomes: [{ status: "done" }],
      requests: ["POST /upload", "POST /upload", "PUT object", "POST /complete"],
    });
  });

  it("ends the file failed with the refusal once six /upload attempts have refused it", async () => {
    const { fixture, client } = setup(() => refusedAnswer(busyRefusal));
    const result = await client.upload("files", [fileOf("a.bin")]);
    expect({
      error: { code: result.error?.code, message: result.error?.message, file: result.error?.file },
      requests: fixture.requests,
    }).toEqual({
      error: { code: "RATE_LIMITED", message: busyRefusal.message, file: { id: "1", name: "a.bin" } },
      requests: Array(6).fill("POST /upload"),
    });
  });

  it("counts the attempts of an /upload that asked again and failed as a whole in the same six", async () => {
    // Refused once, then the server itself is busy (503) for every later /upload.
    const { fixture, client } = setup(({ nth }) => (nth === 1 ? refusedAnswer(storageDownRefusal) : storageBusy()));
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
      return Response.json({ files: [tickets[0], { kind: "rejected", error: storageDownRefusal }] });
    });
    const job = client.start("files", [fileOf("a.bin"), fileOf("b.bin")]);
    job.subscribe(() => {
      if (statuses(job)[0] === "done") firstDone();
    });
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
      nth === 1 ? refusedAnswer(busyRefusal, { "retry-after": "3" }) : undefined,
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
    const { fixture, client } = setup(({ nth }) => (nth <= 6 ? refusedAnswer(storageDownRefusal) : undefined));
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

  it("asks again after retry()'s own /upload refuses the file with a retryable error", async () => {
    const { fixture, client } = setup(({ nth }) =>
      nth === 1 ? refusedAnswer(finalRefusal) : nth === 2 ? refusedAnswer(storageDownRefusal) : undefined,
    );
    const job = client.start("files", [fileOf("a.bin")]);
    await job.done;
    const retried = await job.files[0]?.retry();
    expect({ retried: retried && outcomeOf(retried), afterRetry: fixture.requests.slice(1) }).toEqual({
      retried: { status: "done" },
      afterRetry: ["POST /upload", "POST /upload", "PUT object", "POST /complete"],
    });
  });

  it("asks again for each of two files refused in one answer, each alone", async () => {
    const { asked, client } = setup(({ nth }) =>
      nth === 1
        ? Response.json({
            files: [
              { kind: "rejected", error: storageDownRefusal },
              { kind: "rejected", error: storageDownRefusal },
            ],
          })
        : undefined,
    );
    const { data } = await client.start("files", [fileOf("a.bin"), fileOf("b.bin")]).done;
    expect({ first: asked[0], again: asked.slice(1).sort(), outcomes: data?.files.map(outcomeOf) }).toEqual({
      first: ["a.bin", "b.bin"],
      again: [["a.bin"], ["b.bin"]],
      outcomes: [{ status: "done" }, { status: "done" }],
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
    const { fixture, client } = setup(() => refusedAnswer(storageDownRefusal));
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
    const { fixture, client, page } = setup(({ nth }) => (nth === 1 ? refusedAnswer(storageDownRefusal) : undefined));
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

  it("asks at once on resume() when it was paused before the refusal arrived", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fixture, client } = setup(async ({ nth }) => {
      if (nth > 1) return undefined;
      await held;
      return refusedAnswer(storageDownRefusal);
    });
    const job = client.start("files", [fileOf("a.bin")]);
    await answered();
    job.pause();
    release();
    await answered();
    // No timer has run: a file that waited out its backoff would not have asked yet.
    job.resume();
    await answered();
    const afterResume = [...fixture.requests];
    const { data } = await job.done;
    expect({ afterResume, outcomes: data?.files.map(outcomeOf) }).toEqual({
      afterResume: ["POST /upload", "POST /upload"],
      outcomes: [{ status: "done" }],
    });
  });

  it("keeps its attempt count across a pause: one more /upload after five, then failed", async () => {
    const { fixture, client } = setup(() => refusedAnswer(storageDownRefusal));
    const job = client.start("files", [fileOf("a.bin")]);
    // The first four waits at this jitter: 499.5 + 999 + 1998 + 3996 ms.
    await vi.advanceTimersByTimeAsync(7493);
    const beforePause = fixture.requests.length;
    job.pause();
    await answered();
    job.resume();
    const { data } = await job.done;
    expect({ beforePause, requests: fixture.requests.length, outcomes: data?.files.map(outcomeOf) }).toEqual({
      beforePause: 5,
      requests: 6,
      outcomes: [{ status: "failed", code: "STORAGE_ERROR", retryable: true }],
    });
  });

  /** Brings a one-file job to the backoff after an /upload the server answered 503 (`storageBusy`). */
  const inBackoff = {
    "a re-ask": async (client: Client) => {
      const job = client.start("files", [fileOf("a.bin")]);
      await answered();
      // Past the 499.5 ms wait after the refusal: the second /upload is answered 503.
      await vi.advanceTimersByTimeAsync(500);
      return job;
    },
    "a one-file retry()": async (client: Client) => {
      const job = client.start("files", [fileOf("a.bin")]);
      await job.done;
      void job.files[0]?.retry();
      await answered();
      return job;
    },
  };
  const firstAnswer = { "a re-ask": storageDownRefusal, "a one-file retry()": finalRefusal };
  const scenarios = [{ scenario: "a re-ask" as const }, { scenario: "a one-file retry()" as const }];
  const busyAfter = (scenario: keyof typeof inBackoff) =>
    setup(({ nth }) => (nth === 1 ? refusedAnswer(firstAnswer[scenario]) : nth === 2 ? storageBusy() : undefined));

  it.each(scenarios)(
    "ends aborted at once on abort() in the backoff of $scenario, sending nothing more",
    async ({ scenario }) => {
      const { fixture, client } = busyAfter(scenario);
      const job = await inBackoff[scenario](client);
      const waiting = statuses(job);
      job.files[0]?.abort();
      await answered();
      const ended = statuses(job);
      await vi.advanceTimersByTimeAsync(60_000);
      expect({ waiting, ended, requests: fixture.requests }).toEqual({
        waiting: ["queued"],
        ended: ["aborted"],
        requests: ["POST /upload", "POST /upload"],
      });
    },
  );

  it.each(scenarios)(
    "asks nothing while paused in the backoff of $scenario, then asks at once on resume()",
    async ({ scenario }) => {
      const { fixture, client } = busyAfter(scenario);
      const job = await inBackoff[scenario](client);
      job.pause();
      const paused = statuses(job);
      await vi.advanceTimersByTimeAsync(60_000);
      const whilePaused = [...fixture.requests];
      job.resume();
      const status = await settled(job);
      expect({ paused, whilePaused, status, requests: fixture.requests }).toEqual({
        paused: ["paused"],
        whilePaused: ["POST /upload", "POST /upload"],
        status: "done",
        requests: ["POST /upload", "POST /upload", "POST /upload", "PUT object", "POST /complete"],
      });
    },
  );
});
