// Contract: ruling M3-U92 through the real client and server: which files ask /upload again and how often. A file
// /upload refuses with a retryable error (a storage call that failed while the server started it, M2-D13) asks /upload
// again for itself alone, within the six attempts and the backoff every request has (spec §6.2), counted from the
// job's own /upload and no sooner than the answer's Retry-After; the other files start at once. A final refusal ends
// the file at once. retry() after the attempts ran out asks for a new ticket (M3-U31), and retry()'s own refusal is
// asked again too. The waits themselves, and what pauses or cancels them: upload-refusals-wait.test.ts. Oracle: the
// requests the fixture saw, the files each /upload asked for, and the outcomes the job reports.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type UploadJob } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, storageBusy } from "../testing/client-fixture.ts";
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
  return { fixture, asked, client };
}

const fileOf = (name: string, type = "application/octet-stream") => new File([offsetBytes(1000)], name, { type });

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
