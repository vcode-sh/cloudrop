// Contract: spec §4.1 and decision S10: in a browser without a fetch option, a bucket PUT goes through XMLHttpRequest,
// reports its bytes while they are sent, and its answer is classified exactly as the fetch path classifies it: the
// rows below hold what XMLHttpRequest hands the classifier (the status, the body, Retry-After) and its own 412;
// bucket.test.ts holds every answer's verdict. Oracle: bucket.test.ts's rows for the same statuses, and the bytes the
// fake bucket stored.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import type { CloudropErrorCode } from "../errors.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { fakeXhr, type XhrCall } from "../testing/fake-xhr.ts";
import { offsetBytes } from "../testing/storage-contract.ts";
import { files } from "../testing/upload-fixture.ts";
import { createPut } from "./transport.ts";

const withCode = (code: CloudropErrorCode) => expect.objectContaining({ code });

/** A presigned single PUT for a file of `size` bytes, a fake XHR stubbed over the fixture, and the bytes it reports. */
async function setup({ fault, hold = false, size = 1000 }: { fault?: Fault; hold?: boolean; size?: number } = {}) {
  const fixture = clientFixture({ files }, { fault });
  const xhr = fakeXhr(fixture.fetch, { hold });
  vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
  const ticket = await fixture.server.single("files", { name: "a.bin", size, type: "application/octet-stream" });
  const reported: number[] = [];
  const onBytes = (sent: number) => reported.push(sent);
  // The XHR path: no fetch option. Server calls, which these tests make none of, would go to the fixture.
  const put = createPut(undefined, fixture.fetch);
  return { fixture, xhr, put, target: ticket.put, body: new Blob([offsetBytes(size)]), reported, onBytes };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a client with only basePath, in a browser", () => {
  it("sends the PUT through XMLHttpRequest and the server calls through fetch", async () => {
    const fixture = clientFixture({ files });
    const xhr = fakeXhr(fixture.fetch);
    vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
    vi.stubGlobal("fetch", fixture.fetch);
    const bytes = offsetBytes(1000);
    const client = createCloudropClient({ basePath: fixture.basePath });
    const result = await client.upload("files", new File([bytes], "a.bin", { type: "application/octet-stream" }));
    const key = result.data?.file.key ?? "";
    expect({
      result,
      xhr: xhr.sent,
      requests: fixture.requests,
      stored: (await fixture.server.storage.getRange(key, 0, 999)).data,
    }).toEqual({
      result: {
        data: {
          file: { id: expect.any(String), key, name: "a.bin", size: 1000, type: "application/octet-stream", url: null },
          data: null,
        },
        error: null,
      },
      xhr: ["PUT object"],
      requests: ["POST /upload", "PUT object", "POST /complete"],
      stored: bytes,
    });
  });

  it("settles a job whose XMLHttpRequest throws on send: that file fails, the other uploads", async () => {
    // Every backoff wait becomes 0 ms.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fixture = clientFixture({ files });
    const xhr = fakeXhr(fixture.fetch);
    const Base = xhr.XMLHttpRequest as new () => { send(body: Blob): void };
    vi.stubGlobal(
      "XMLHttpRequest",
      class extends Base {
        override send(body: Blob) {
          if (body.size === 6) throw new TypeError("Failed to execute 'send'.");
          super.send(body);
        }
      },
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const client = createCloudropClient({ basePath: fixture.basePath });
    const picked = [
      new File(["alpha"], "a.txt", { type: "text/plain" }),
      new File(["bravo!"], "b.txt", { type: "text/plain" }),
    ];
    const { data } = await client.start("files", picked).done;
    expect(
      data?.files.map((outcome) => [outcome.status, outcome.status === "done" ? null : outcome.error.code]),
    ).toEqual([
      ["done", null],
      ["failed", "NETWORK_ERROR"],
    ]);
  });
});

describe("createPut through XMLHttpRequest", () => {
  it("reports the bytes as they are sent, then the whole body when it is stored", async () => {
    const { xhr, put, target, body, reported, onBytes } = await setup({ hold: true });
    const outcome = put(target, body, new AbortController().signal, onBytes);
    const call = await xhr.next();
    call.progress(500);
    call.progress(1000);
    await call.finish();
    expect({ outcome: await outcome, reported }).toEqual({ outcome: { kind: "stored" }, reported: [500, 1000, 1000] });
  });

  const answer =
    (status: number, text = "", headers: Record<string, string> = {}): Fault =>
    ({ label }) =>
      label === "PUT object" ? new Response(text, { status, headers }) : undefined;

  it.each([
    { name: "counts 412 as already stored", fault: answer(412), expected: { kind: "stored" } },
    {
      name: "never retries a signature mismatch",
      fault: answer(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>"),
      expected: { kind: "rejected", error: withCode("UPLOAD_REJECTED") },
    },
    {
      name: "waits as long as a busy bucket asks",
      fault: answer(503, "", { "retry-after": "7" }),
      expected: { kind: "retry", error: withCode("RATE_LIMITED"), retryAfterMs: 7000 },
    },
  ])("$name", async ({ fault, expected }) => {
    const { put, target, body, onBytes } = await setup({ fault });
    expect(await put(target, body, new AbortController().signal, onBytes)).toEqual(expected);
  });

  // An error before any byte left is the browser's own refusal, such as a failed preflight (M12-E7).
  it.each([
    { name: "after a byte was sent", sent: 1, expected: {} },
    { name: "before any byte was sent, marked blocked", sent: 0, expected: { blocked: true } },
  ])("reports a network or CORS failure as opaque $name", async ({ sent, expected }) => {
    const { xhr, put, target, body, onBytes } = await setup({ hold: true });
    const outcome = put(target, body, new AbortController().signal, onBytes);
    const call = await xhr.next();
    call.progress(sent);
    call.fail();
    expect(await outcome).toStrictEqual({
      kind: "opaque",
      error: withCode("NETWORK_ERROR"),
      retryAfterMs: 0,
      ...expected,
    });
  });

  it("reports an XMLHttpRequest that throws before sending as opaque, as fetch's throw is", async () => {
    const { xhr, put, target, body, onBytes } = await setup();
    // A browser's open() throws SyntaxError on a URL it cannot parse.
    vi.stubGlobal(
      "XMLHttpRequest",
      class extends (xhr.XMLHttpRequest as new () => object) {
        open() {
          throw new SyntaxError("The URL is invalid.");
        }
      },
    );
    expect(await put(target, body, new AbortController().signal, onBytes)).toEqual({
      kind: "opaque",
      error: withCode("NETWORK_ERROR"),
      retryAfterMs: 0,
    });
  });

  it("leaves nothing on the caller's signal when the XMLHttpRequest fails inside send()", async () => {
    const { put, target, body, onBytes } = await setup();
    // Browsers report a failure later, but an XMLHttpRequest that calls onerror inside send() must settle just as
    // cleanly: the caller's signal outlives the PUT, and a listener left on it would abort a finished request.
    const aborts: string[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        upload = {};
        onerror: (() => void) | null = null;
        open() {}
        setRequestHeader() {}
        send() {
          this.onerror?.();
        }
        abort() {
          aborts.push("abort");
        }
      },
    );
    const controller = new AbortController();
    const outcome = await put(target, body, controller.signal, onBytes);
    controller.abort();
    expect({ kind: outcome.kind, aborts }).toEqual({ kind: "opaque", aborts: [] });
  });

  it("stops the request when the signal fires", async () => {
    const { xhr, put, target, body, onBytes } = await setup({ hold: true });
    const controller = new AbortController();
    const outcome = put(target, body, controller.signal, onBytes);
    await xhr.next();
    controller.abort();
    expect({ outcome: await outcome, open: xhr.open }).toEqual({
      outcome: { kind: "aborted", error: withCode("ABORTED") },
      open: [],
    });
  });

  it("sends nothing for a signal that already fired", async () => {
    const { fixture, xhr, put, target, body, onBytes } = await setup();
    const controller = new AbortController();
    controller.abort();
    expect({
      outcome: await put(target, body, controller.signal, onBytes),
      sent: xhr.sent,
      requests: fixture.requests,
    }).toEqual({ outcome: { kind: "aborted", error: withCode("ABORTED") }, sent: [], requests: [] });
  });
});

describe("createPut with a fetch option", () => {
  it("sends through that fetch even where XMLHttpRequest exists, and reports the bytes once stored", async () => {
    const { fixture, xhr, target, body, reported, onBytes } = await setup();
    const outcome = await createPut(fixture.fetch, fixture.fetch)(target, body, new AbortController().signal, onBytes);
    expect({ outcome, reported, xhr: xhr.sent, requests: fixture.requests }).toEqual({
      outcome: { kind: "stored" },
      reported: [1000],
      xhr: [],
      requests: ["PUT object"],
    });
  });
});

// Contract: spec §4.6 and ruling M3-U27: a PUT that stalls is given up and reported as the network-error outcome, so
// the caller retries it; a caller's cancel stays a cancel, and a settled PUT leaves no timer behind. Oracle: 30 s
// without progress for XHR; for fetch, 30 s plus the body at 100 KiB/s (1 MiB: 30 000 + 10 240 ms).
describe("a stalled PUT", () => {
  const opaque = { kind: "opaque", error: withCode("NETWORK_ERROR"), retryAfterMs: 0 };
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  it("aborts an XHR after 30 s without progress", async () => {
    const { xhr, put, target, body, onBytes } = await setup({ hold: true });
    fakeClock();
    const outcome = put(target, body, new AbortController().signal, onBytes);
    await xhr.next();
    vi.advanceTimersByTime(29_999);
    const openAt29999 = xhr.open.length;
    vi.advanceTimersByTime(1);
    expect({ openAt29999, outcome: await outcome, open: xhr.open }).toEqual({
      openAt29999: 1,
      outcome: opaque,
      open: [],
    });
  });

  it("counts the 30 s again from each progress event", async () => {
    const { xhr, put, target, body, onBytes } = await setup({ hold: true });
    fakeClock();
    const outcome = put(target, body, new AbortController().signal, onBytes);
    const call = await xhr.next();
    vi.advanceTimersByTime(20_000);
    call.progress(500);
    vi.advanceTimersByTime(29_999);
    const openAt49999 = xhr.open.length;
    vi.advanceTimersByTime(1);
    expect({ openAt49999, outcome: await outcome }).toEqual({ openAt49999: 1, outcome: opaque });
  });

  it.each([
    {
      name: "a stored XHR",
      end: (call: XhrCall) => call.finish(),
      expected: { kind: "stored" },
    },
    {
      name: "an XHR the caller cancels",
      end: (_call: XhrCall, controller: AbortController) => controller.abort(),
      expected: { kind: "aborted", error: withCode("ABORTED") },
    },
  ])("leaves no timer after $name", async ({ end, expected }) => {
    const { xhr, put, target, body, onBytes } = await setup({ hold: true });
    fakeClock();
    const controller = new AbortController();
    const outcome = put(target, body, controller.signal, onBytes);
    await end(await xhr.next(), controller);
    expect({ outcome: await outcome, timers: vi.getTimerCount() }).toEqual({ outcome: expected, timers: 0 });
  });

  /** A bucket that never answers: its request fails only when the request's own signal fires. */
  const silent: Fault = ({ label, init }) =>
    label === "PUT object"
      ? new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
      : undefined;

  it("gives a fetch PUT 30 s plus its size at 100 KiB/s", async () => {
    const { fixture, target, body, onBytes } = await setup({ fault: silent, size: 1024 * 1024 });
    fakeClock();
    let settled = false;
    const outcome = createPut(fixture.fetch, fixture.fetch)(target, body, new AbortController().signal, onBytes);
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(40_239);
    const settledAt40239 = settled;
    await vi.advanceTimersByTimeAsync(1);
    expect({ settledAt40239, outcome: await outcome, timers: vi.getTimerCount() }).toEqual({
      settledAt40239: false,
      outcome: opaque,
      timers: 0,
    });
  });

  it("reports a fetch PUT the caller cancels as aborted, not as a stall", async () => {
    const { fixture, target, body, onBytes } = await setup({ fault: silent });
    fakeClock();
    const controller = new AbortController();
    const outcome = createPut(fixture.fetch, fixture.fetch)(target, body, controller.signal, onBytes);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect({ outcome: await outcome, timers: vi.getTimerCount() }).toEqual({
      outcome: { kind: "aborted", error: withCode("ABORTED") },
      timers: 0,
    });
  });

  it("sends no fetch PUT for a signal that already fired", async () => {
    const { fixture, target, body, onBytes } = await setup();
    const controller = new AbortController();
    controller.abort();
    expect({
      outcome: await createPut(fixture.fetch, fixture.fetch)(target, body, controller.signal, onBytes),
      requests: fixture.requests,
    }).toEqual({ outcome: { kind: "aborted", error: withCode("ABORTED") }, requests: [] });
  });
});
