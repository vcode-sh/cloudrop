// Contract: spec 1.0 §2a and §2b through the real client and server (M12-E2, M12-E4, M12-E5, M12-R41). An /upload
// that `authorize` refuses with rateLimited(seconds) is asked again no sooner than its Retry-After; a wait longer than
// the client's 20-second backoff cap is not waited for: the job fails with the retryable RATE_LIMITED, and the app's
// retry() asks again. The same holds for one file a 200 refuses with the bucket's Retry-After, and for a part's /sign.
// A Retry-After HTTP date counts from the answer's Date header (M12-R43). Oracle: the requests the fixture saw, the
// moment each was sent on the fake clock, and the result the job reports.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CloudropError, createCloudropClient } from "../client.ts";
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

const file = () => new File([offsetBytes(1000)], "a.bin", { type: "application/octet-stream" });

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
      failed: { code: error?.code, retryable: error?.retryable },
      sentAfterFailing,
      retried: retried.data?.files.map((outcome) => outcome.status),
      sentAfterRetry: uploadsSent(),
    }).toEqual({
      failed: { code: "RATE_LIMITED", retryable: true },
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
    expect({ failed: { code: error?.code, retryable: error?.retryable }, requests: fixture.requests }).toEqual({
      failed: { code: "RATE_LIMITED", retryable: true },
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

  it("fails at once, retryable, when the wait is 600 seconds, instead of asking again every 20 seconds", async () => {
    const { basePath, fetch, requests } = fixture();
    const client = createCloudropClient({ basePath, fetch });
    let error: CloudropError | null | undefined;
    void client.start("files", [file()]).done.then((result) => {
      error = result.error;
    });
    // Two minutes in steps of a second, each followed by a turn of the real event loop for the file's hashing. Waits of
    // 20 seconds would have sent a /sign every 20 seconds by then.
    for (let second = 0; second < 120; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect({ failed: { code: error?.code, retryable: error?.retryable }, requests }).toEqual({
      failed: { code: "RATE_LIMITED", retryable: true },
      requests: ["POST /upload", "PUT object", "POST /sign"],
    });
  });
});
