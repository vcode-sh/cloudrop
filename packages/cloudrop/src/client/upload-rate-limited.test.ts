// Contract: spec 1.0 §2a and §2b through the real client and server (M12-E2, M12-E4, M12-E5, M12-R41). An /upload
// that `authorize` refuses with rateLimited(seconds) is asked again no sooner than its Retry-After; a wait longer than
// the client's 20-second backoff cap is not waited for: the job fails with the retryable RATE_LIMITED, and the app's
// retry() asks again. The same holds for one file a 200 refuses with the bucket's Retry-After, and for a part's /sign.
// A Retry-After HTTP date counts from the answer's Date header (M12-R43). The error the app gets carries the answer's
// wait as `retryAfter` in whole seconds, and none without the header (M12-R70). Oracle: the requests the fixture saw,
// the moment each was sent on the fake clock, and the result the job reports.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CloudropError, createCloudropClient, type UploadResult } from "../client.ts";
import { rateLimited, route } from "../server/route.ts";
import { clientFixture } from "../testing/client-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

/** A client whose route refuses its first `/upload` with rateLimited(`seconds`) and authorizes every later one. */
function setup(seconds: number) {
  let asked = 0;
  const files = route({
    accept: "application/octet-stream",
    maxSize: "100MB",
    authorize: () => (++asked === 1 ? rateLimited(seconds) : {}),
  });
  const fixture = clientFixture({ files });
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch });
  const uploadsSent = () => fixture.requests.filter((request) => request === "POST /upload").length;
  return { fixture, client, uploadsSent };
}

const file = (name = "a.bin") => new File([offsetBytes(1000)], name, { type: "application/octet-stream" });

/**
 * What the job of `files` ends with, moving the fake clock `stepMs` at a time. The in-process server answers in real
 * time, so each step also lets real I/O run: no request's deadline passes however slow a loaded lane is, and a job
 * still running after 2 real seconds (one that waits longer than the steps allow) fails the test.
 */
async function outcome(fixture: ReturnType<typeof clientFixture>, stepMs: number, files = [file()]) {
  let ended: UploadResult<unknown> | undefined;
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch });
  void client.start("files", files).done.then((result) => {
    ended = result;
  });
  const giveUpAt = performance.now() + 2000;
  while (ended === undefined && performance.now() < giveUpAt) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return ended;
}

/** The parts of an error the rows below compare. */
const waitOf = (error: CloudropError | null | undefined) => ({
  code: error?.code,
  retryable: error?.retryable,
  retryAfter: error?.retryAfter,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // The backoff's jitter is 0, so only Retry-After decides the wait.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an /upload refused with rateLimited()", () => {
  it("is asked again no sooner than its Retry-After of 3 seconds, then uploads the file", async () => {
    const { fixture, client, uploadsSent } = setup(3);
    const job = client.start("files", [file()]);
    await vi.advanceTimersByTimeAsync(2999);
    const before = uploadsSent();
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await job.done;
    expect({ before, error, requests: fixture.requests }).toEqual({
      before: 1,
      error: null,
      requests: ["POST /upload", "POST /upload", "PUT object", "POST /complete"],
    });
  });

  it("is not waited for when Retry-After is 600 seconds: the job fails retryable, and retry() asks again", async () => {
    const { client, uploadsSent } = setup(600);
    const job = client.start("files", [file()]);
    const { error } = await job.done;
    // A 20-second wait would have sent the next /upload by now.
    await vi.advanceTimersByTimeAsync(60_000);
    const sentAfterFailing = uploadsSent();
    const retried = await job.retry();
    expect({
      failed: { code: error?.code, retryable: error?.retryable, retryAfter: error?.retryAfter },
      sentAfterFailing,
      retried: retried.data?.files.map((outcome) => outcome.status),
      sentAfterRetry: uploadsSent(),
    }).toEqual({
      failed: { code: "RATE_LIMITED", retryable: true, retryAfter: 600 },
      sentAfterFailing: 1,
      retried: ["done"],
      sentAfterRetry: 2,
    });
  });
});

describe("an /upload a proxy refuses with Retry-After as an HTTP date", () => {
  it("waits the 3 seconds the proxy's own Date header gives, though the client's clock is 5 minutes behind", async () => {
    // The proxy's clock runs 5 minutes ahead of the client's; both headers are whole seconds, 3 apart.
    const proxyTime = (ms: number) => new Date(Date.now() + ms).toUTCString();
    const files = route({ accept: "application/octet-stream", maxSize: "100MB", authorize: () => ({}) });
    const busy = { code: "RATE_LIMITED", message: "Too many requests.", retryable: true };
    const headers = { date: proxyTime(300_000), "retry-after": proxyTime(303_000) };
    const fixture = clientFixture(
      { files },
      {
        fault: ({ label, nth }) =>
          label === "POST /upload" && nth === 1 ? Response.json({ error: busy }, { status: 429, headers }) : undefined,
      },
    );
    const job = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch }).start("files", [file()]);
    await vi.advanceTimersByTimeAsync(2999);
    const before = [...fixture.requests];
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await job.done;
    expect({ before, error, requests: fixture.requests }).toEqual({
      before: ["POST /upload"],
      error: null,
      requests: ["POST /upload", "POST /upload", "PUT object", "POST /complete"],
    });
  });
});

describe("a file the 200 of /upload refuses with the bucket's Retry-After", () => {
  const busy = {
    code: "RATE_LIMITED",
    message: "The storage service is busy. Try again in a moment.",
    retryable: true,
  };
  const files = route({ accept: "application/octet-stream", maxSize: "100MB", authorize: () => ({}) });

  it("fails at once, retryable, when the wait is 600 seconds", async () => {
    const fixture = clientFixture(
      { files },
      {
        fault: ({ label }) =>
          label === "POST /upload"
            ? Response.json({ files: [{ kind: "rejected", error: busy }] }, { headers: { "retry-after": "600" } })
            : undefined,
      },
    );
    const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch });
    const { error } = await client.start("files", [file()]).done;
    expect({
      failed: { code: error?.code, retryable: error?.retryable, retryAfter: error?.retryAfter },
      requests: fixture.requests,
    }).toEqual({
      failed: { code: "RATE_LIMITED", retryable: true, retryAfter: 600 },
      requests: ["POST /upload"],
    });
  });
});

describe("a part's /sign refused with Retry-After", () => {
  const files = route({ accept: "application/octet-stream", maxSize: "100MB", authorize: () => ({}) });
  /** The PUT is lost once, so the part renews its URL, and every /sign answers 429 with Retry-After: 600. */
  const fixture = () =>
    clientFixture(
      { files },
      {
        fault: ({ label, nth }) => {
          if (label === "PUT object" && nth === 1) throw new TypeError("Failed to fetch");
          if (label !== "POST /sign") return undefined;
          const busy = { code: "RATE_LIMITED", message: "Too many requests.", retryable: true };
          return Response.json({ error: busy }, { status: 429, headers: { "retry-after": "600" } });
        },
      },
    );

  it("fails at once, retryable, when the wait is 600 seconds, instead of waiting 20 seconds to ask again", async () => {
    const signing = fixture();
    // The fake clock stays at 0 and only timers due now fire (the backoff's are 0 ms here): a part that waits
    // 20 seconds before its next /sign never settles.
    const ended = await outcome(signing, 0);
    expect({ failed: waitOf(ended?.error), requests: signing.requests }).toEqual({
      failed: { code: "RATE_LIMITED", retryable: true, retryAfter: 600 },
      requests: ["POST /upload", "PUT object", "POST /sign"],
    });
  });
});

describe("the wait on the error the app gets (M12-R70)", () => {
  const files = route({ accept: "application/octet-stream", maxSize: "100MB", authorize: () => ({}) });
  const busy = { code: "RATE_LIMITED", message: "Too many requests.", retryable: true };

  it("has no retryAfter when the 429 carried no Retry-After, after the whole budget", async () => {
    const fixture = clientFixture(
      { files },
      {
        fault: ({ label }) => (label === "POST /upload" ? Response.json({ error: busy }, { status: 429 }) : undefined),
      },
    );
    expect({ error: waitOf((await outcome(fixture, 20_000))?.error), sent: fixture.requests }).toEqual({
      error: { code: "RATE_LIMITED", retryable: true, retryAfter: undefined },
      sent: Array(6).fill("POST /upload"),
    });
  });

  it("has the bucket's Retry-After of 30 when every PUT is throttled, after the whole budget", async () => {
    const fixture = clientFixture(
      { files },
      {
        fault: ({ label }) =>
          label === "PUT object"
            ? new Response("<Error><Code>SlowDown</Code></Error>", { status: 429, headers: { "retry-after": "30" } })
            : undefined,
      },
    );
    // Each wait is the backoff's 20-second cap.
    expect(waitOf((await outcome(fixture, 20_000))?.error)).toEqual({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfter: 30,
    });
  });

  // A final refusal says nothing about waiting, though the 200 that carried it named the throttled file's wait.
  it("gives the wait of a 200's Retry-After to its retryable refusal only", async () => {
    const tooLarge = { code: "FILE_TOO_LARGE", message: "This file is too large.", retryable: false };
    const fixture = clientFixture(
      { files },
      {
        fault: ({ label }) =>
          label === "POST /upload"
            ? Response.json(
                {
                  files: [
                    { kind: "rejected", error: tooLarge },
                    { kind: "rejected", error: busy },
                  ],
                },
                { headers: { "retry-after": "600" } },
              )
            : undefined,
      },
    );
    const ended = await outcome(fixture, 0, [file("big.bin"), file("small.bin")]);
    expect(ended?.data?.files.map((done) => ("error" in done ? waitOf(done.error) : done.status))).toEqual([
      { code: "FILE_TOO_LARGE", retryable: false, retryAfter: undefined },
      { code: "RATE_LIMITED", retryable: true, retryAfter: 600 },
    ]);
  });
});
