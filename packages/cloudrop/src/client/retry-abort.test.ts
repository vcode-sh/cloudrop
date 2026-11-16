// Contract: spec §4.7 and plan B's rulings Q10, Q11 and Q16 through the real client: a failed file of start() keeps its
// ticket until abort() of the file or the job, or the caller's signal, ends it aborted with its /abort (skipped when a
// /complete may have succeeded), or pagehide sends a keepalive /abort for it, after which a retry asks for a new ticket.
// The caller's signal also cancels a retry. pagehide leaves running and done files alone, and an expired ticket is let
// go without an /abort. Oracle: the requests the fixture saw, the tokens /upload issued, and the snapshot's statuses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type UploadJob } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, storageBusy } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { pageEvents } from "../testing/page-events.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });

/** One /abort as the server received it. */
interface AbortSent {
  token: string;
  keepalive: boolean;
}

/**
 * A client on the fake bucket: `fault` answers every request but /abort, which is forwarded, recorded in `aborts` and
 * its settling kept in `aborted`; the tokens /upload answered are kept in `tokens`.
 */
function setup(fault: Fault = () => undefined) {
  const seen = { tokens: [] as string[], aborts: [] as AbortSent[], aborted: Promise.resolve() };
  const fixture = clientFixture(
    { files },
    {
      fault: async (call) => {
        if (call.label === "POST /abort") {
          seen.aborts.push({ token: JSON.parse(call.init.body as string).token, keepalive: !!call.init.keepalive });
          const answer = call.forward(call.init);
          seen.aborted = answer.then(() => undefined);
          return answer;
        }
        if (call.label !== "POST /upload") return fault(call);
        const answer = (await fault(call)) ?? (await call.forward(call.init));
        const tickets: { token: string }[] = (await answer.clone().json()).files ?? [];
        seen.tokens.push(...tickets.map((ticket) => ticket.token));
        return answer;
      },
    },
  );
  const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch });
  return { fixture, seen, client };
}

const fileOf = (size: number, name: string) =>
  new File([offsetBytes(size)], name, { type: "application/octet-stream" });
const storageDown = () => errorResponse(500, "InternalError", "We encountered an internal error. Please try again.");
const statuses = (job: UploadJob<unknown>) => job.getSnapshot().files.map((file) => file.status);

/** A PUT of `size` bytes held until `release()`; `reached` resolves when it arrives. */
function heldPut(size: number) {
  let release = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = () => {};
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const hold = async (body: Blob) => {
    if (body.size !== size) return;
    arrived();
    await open;
  };
  return { release, reached, hold };
}

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("abort of a failed file", () => {
  it.each([
    { name: "the file's abort()", cancel: (job: UploadJob<unknown>) => job.files[0]?.abort() },
    { name: "the job's abort()", cancel: (job: UploadJob<unknown>) => job.abort() },
    {
      name: "the caller's signal, after done settled",
      cancel: (_: UploadJob<unknown>, signal: AbortController) => signal.abort(),
    },
  ])("ends it aborted and sends the /abort it kept: $name", async (row) => {
    const { seen, client } = setup(({ label }) => (label === "PUT object" ? storageDown() : undefined));
    const signal = new AbortController();
    const job = client.start("files", fileOf(1000, "a.bin"), { signal: signal.signal });
    const { data } = await job.done;
    const abortsAfterFailure = seen.aborts.length;
    row.cancel(job, signal);
    await seen.aborted;
    // Read before the retry, which would hear an aborted signal itself.
    const status = statuses(job);
    const retried = await job.files[0]?.retry();
    expect({
      first: data?.files[0]?.status,
      abortsAfterFailure,
      aborts: seen.aborts.map((sent) => sent.token),
      status,
      retried: retried?.status,
    }).toEqual({
      first: "failed",
      abortsAfterFailure: 0,
      aborts: seen.tokens,
      status: ["aborted"],
      retried: "aborted",
    });
  });

  it("ends a file whose /complete may have succeeded aborted without an /abort (M8)", async () => {
    const { seen, client } = setup((call) =>
      call.label === "POST /complete"
        ? call.forward(call.init).then(() => Promise.reject(new TypeError("Failed to fetch")))
        : undefined,
    );
    const job = client.start("files", fileOf(1000, "a.bin"));
    const { error } = await job.done;
    job.abort();
    expect({ first: error?.code, status: statuses(job), aborts: seen.aborts }).toEqual({
      first: "NETWORK_ERROR",
      status: ["aborted"],
      aborts: [],
    });
  });

  it("cancels a retry when the caller's signal fires during it, and tells the server", async () => {
    let failing = true;
    const put = heldPut(1000);
    const { seen, client } = setup(async ({ label, init }) => {
      if (label !== "PUT object") return undefined;
      if (failing) return storageDown();
      await put.hold(init.body as Blob);
      return undefined;
    });
    const signal = new AbortController();
    const job = client.start("files", fileOf(1000, "a.bin"), { signal: signal.signal });
    await job.done;
    failing = false;
    const retried = job.files[0]?.retry();
    await put.reached;
    signal.abort();
    put.release();
    const outcome = await retried;
    await seen.aborted;
    expect({
      outcome: [outcome?.status, outcome?.status === "done" ? null : outcome?.error.code],
      aborts: seen.aborts.map((sent) => sent.token),
    }).toEqual({ outcome: ["aborted", "ABORTED"], aborts: seen.tokens });
  });
  it("hears the caller's signal again for a retry of a job /upload refused, and stops its /upload", async () => {
    let busy = true;
    let reached = () => {};
    const atUpload = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { seen, client } = setup(async ({ label, init }) => {
      if (label !== "POST /upload") return undefined;
      if (busy) return storageBusy();
      reached();
      // Held until the signal fires: the fixture then answers it as a browser does a cancelled fetch.
      await new Promise((resolve) => init.signal?.addEventListener("abort", resolve));
      return undefined;
    });
    const signal = new AbortController();
    const job = client.start("files", fileOf(1000, "a.bin"), { signal: signal.signal });
    const first = await job.done;
    busy = false;
    const retried = job.retry();
    await atUpload;
    signal.abort();
    const { data, error } = await retried;
    expect({ first: first.error?.code, retried: [data, error?.code], aborts: seen.aborts }).toEqual({
      first: "RATE_LIMITED",
      retried: [null, "ABORTED"],
      aborts: [],
    });
  });
});

describe("pagehide", () => {
  it("sends a keepalive /abort for a failed file only, and a later retry asks for a new ticket (Q11)", async () => {
    const page = pageEvents();
    let failing = true;
    const put = heldPut(3000);
    const { seen, client, fixture } = setup(async ({ label, init }) => {
      if (label !== "PUT object") return undefined;
      const { size } = init.body as Blob;
      if (failing && size === 1000) return storageDown();
      await put.hold(init.body as Blob);
      return undefined;
    });
    // a.bin fails, b.bin is done, c.bin uploads while the page hides.
    const job = client.start("files", [fileOf(1000, "a.bin"), fileOf(2000, "b.bin"), fileOf(3000, "c.bin")]);
    await put.reached;
    await vi.waitFor(() => expect(statuses(job)).toEqual(["failed", "done", "uploading"]));
    const whileHeld = page.listening();
    page.fire("pagehide");
    const aborts = [...seen.aborts];
    put.release();
    await job.done;
    failing = false;
    const uploadsBefore = seen.tokens.length;
    const retried = await job.files[0]?.retry();
    expect({
      whileHeld,
      aborts,
      retried: retried?.status,
      newTicket: seen.tokens.length === uploadsBefore + 1,
      listening: page.listening(),
      requests: fixture.requests.filter((label) => label === "POST /abort"),
    }).toEqual({
      // c.bin still runs, so connectivity is watched too.
      whileHeld: ["offline", "online", "pagehide"],
      aborts: [{ token: seen.tokens[0], keepalive: true }],
      retried: "done",
      newTicket: true,
      listening: [],
      requests: ["POST /abort"],
    });
  });

  it("lets an expired ticket go without an /abort (M7)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const page = pageEvents();
    const { seen, client } = setup(({ label }) => (label === "PUT object" ? storageDown() : undefined));
    await client.start("files", fileOf(1000, "a.bin")).done;
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    page.fire("pagehide");
    expect({ aborts: seen.aborts, listening: page.listening() }).toEqual({ aborts: [], listening: [] });
  });
});
