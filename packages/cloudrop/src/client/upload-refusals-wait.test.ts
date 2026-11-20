// Contract: ruling M3-U92 through the real client and server: a file's wait to ask /upload again. While it waits the
// file stays queued; its pause, offline and its cancel (its abort(), the caller's signal) end the wait after a refusal
// and the backoff of a one-file /upload (a re-ask, or a one-file retry()'s new ticket) as they end a part's (M3-U28,
// M3-U39); a cancel sends nothing more (M3-U51), and resume() asks at once with the attempt count kept. Only a pause
// that ended the backoff counts as one: an /upload answer that carries the code ABORTED is a failure like any other.
// Which files ask again and how often: upload-refusals.test.ts. Oracle: the requests the fixture saw and the statuses
// and outcomes the job reports.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type UploadJob } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, statuses, storageBusy } from "../testing/client-fixture.ts";
import { type PageEvents, pageEvents } from "../testing/page-events.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "application/octet-stream", maxSize: "100MB", authorize: allowAnyone });

/** The server's per-file answer when starting the file in storage failed (storageFailure in server/http.ts). */
const storageDownRefusal = {
  code: "STORAGE_ERROR",
  message: "The storage service failed. Try again in a moment.",
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

  // Offline reaches the backoff whatever the job's other files do: the whole one-file ask is watched (M4-F9 S9).
  const holds = [
    {
      held: "paused by the caller",
      freed: "resume()",
      hold: (h: Held) => h.job.pause(),
      free: (h: Held) => h.job.resume(),
    },
    {
      held: "paused by offline",
      freed: "online",
      hold: (h: Held) => h.page.fire("offline"),
      free: (h: Held) => h.page.fire("online"),
    },
  ];
  it.each(scenarios.flatMap((row) => holds.map((hold) => ({ ...row, ...hold }))))(
    "asks nothing while $held in the backoff of $scenario, then asks at once on $freed",
    async ({ scenario, hold, free }) => {
      const { fixture, client, page } = busyAfter(scenario);
      const job = await inBackoff[scenario](client);
      hold({ job, page });
      const paused = statuses(job);
      await vi.advanceTimersByTimeAsync(60_000);
      // Checked before the file is freed: one that was never held may be stuck behind a fake timer by now.
      expect({ paused, whilePaused: fixture.requests }).toEqual({
        paused: ["paused"],
        whilePaused: ["POST /upload", "POST /upload"],
      });
      free({ job, page });
      expect({ status: await settled(job), requests: fixture.requests }).toEqual({
        status: "done",
        requests: ["POST /upload", "POST /upload", "POST /upload", "PUT object", "POST /complete"],
      });
    },
  );
});

describe("an /upload answer that carries the code ABORTED", () => {
  it.each([
    { name: "a final one", retryable: false, requests: 2 },
    { name: "a retryable one", retryable: true, requests: 6 },
  ])(
    "ends a file asking again failed on $name, within the budget: no pause ended its backoff",
    async ({ retryable, requests }) => {
      // The 20th /upload gives a ticket, so a client that took the answer for a pause ends there instead of hanging.
      const aborted = () =>
        Response.json({ error: { code: "ABORTED", message: "Cancelled by the proxy.", retryable } }, { status: 503 });
      const { fixture, client } = setup(({ nth }) =>
        nth === 1 ? refusedAnswer(storageDownRefusal) : nth < 20 ? aborted() : undefined,
      );
      const { data } = await client.start("files", [fileOf("a.bin")]).done;
      expect({ outcomes: data?.files.map(outcomeOf), requests: fixture.requests.length }).toEqual({
        outcomes: [{ status: "failed", code: "ABORTED", retryable }],
        requests,
      });
    },
  );
});

describe("a one-file /upload on its way", () => {
  it("pauses its file on offline; a ticket it brings waits paused until online (M4-F9 S9)", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = () => {};
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const { fixture, client, page } = setup(async ({ nth }) => {
      if (nth === 1) return refusedAnswer(storageDownRefusal);
      arrived();
      await held;
      return undefined;
    });
    const job = client.start("files", [fileOf("a.bin")]);
    await reached;
    // As a browser does: navigator.onLine follows the events, and a run that starts reads it.
    vi.stubGlobal("navigator", { onLine: false });
    page.fire("offline");
    const whileAsking = statuses(job);
    release();
    await answered();
    const ticketOffline = { statuses: statuses(job), requests: [...fixture.requests] };
    vi.stubGlobal("navigator", { onLine: true });
    page.fire("online");
    const { data } = await job.done;
    expect({ whileAsking, ticketOffline, outcomes: data?.files.map(outcomeOf), requests: fixture.requests }).toEqual({
      whileAsking: ["paused"],
      ticketOffline: { statuses: ["paused"], requests: ["POST /upload", "POST /upload"] },
      outcomes: [{ status: "done" }],
      requests: ["POST /upload", "POST /upload", "PUT object", "POST /complete"],
    });
  });
});
