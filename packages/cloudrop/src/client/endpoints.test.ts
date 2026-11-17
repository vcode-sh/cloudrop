// Contract: decisions S16 (every server answer is validated; one that cannot be read is SERVER_ERROR, retryable from
// 500 on; a proxy's 429 page is a retryable RATE_LIMITED, rulings S-4 and S-7), S9 (a Retry-After is waited at least)
// and S8 (endpoint POSTs send JSON with the page's credentials). Oracle: the server's real answers through the client
// fixture, and the fetch rules of S8.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { files } from "../testing/upload-fixture.ts";
import { type ClientFetch, createEndpoints, type Endpoints } from "./endpoints.ts";
import { withRetry } from "./retry.ts";

const unreadable = (status: number) =>
  `The upload server sent an answer this client cannot read (HTTP ${status}). Check that basePath points at the cloudrop handler and that the server runs the same cloudrop version.`;

const png = new File([new Uint8Array(10)], "a.png", { type: "image/png" });
// One byte past 8 MiB would do; five keep the last part clearly distinct from the first.
const twoParts = new File([new Uint8Array(8 * MiB + 5)], "video.bin", { type: "application/octet-stream" });

const notes = route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone });

function setup(options: { fault?: Fault } = {}) {
  const fixture = clientFixture({ files, notes }, { multipartThreshold: "8MB", ...options });
  return { fixture, endpoints: createEndpoints(fixture.basePath, fixture.fetch) };
}

const live = () => new AbortController().signal;

/** The token of a one-file /upload's ticket, for the calls that follow it. */
async function startOne(endpoints: Endpoints, file: File): Promise<string> {
  const [ticket] = (await endpoints.start("files", [file], undefined, live())).data ?? [];
  return ticket instanceof CloudropError ? "" : (ticket?.token ?? "");
}
const page = (status: number) =>
  new Response("<html>Bad gateway</html>", { status, headers: { "content-type": "text/html" } });
const errorOf = (result: { error: { code: string; message: string; retryable: boolean } | null }) => ({
  code: result.error?.code,
  message: result.error?.message,
  retryable: result.error?.retryable,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("start", () => {
  it("reads a single-PUT ticket from /upload", async () => {
    const { endpoints } = setup();
    const { data } = await endpoints.start("files", [png], undefined, live());
    expect(data).toEqual([
      expect.objectContaining({
        kind: "single",
        id: expect.any(String),
        put: expect.objectContaining({ headers: expect.objectContaining({ "if-none-match": "*" }) }),
      }),
    ]);
  });

  it("reads a multipart ticket and its first URLs", async () => {
    const { endpoints } = setup();
    const { data } = await endpoints.start("files", [twoParts], undefined, live());
    expect(data).toEqual([
      expect.objectContaining({
        kind: "multipart",
        partSize: 8_388_608,
        partCount: 2,
        parts: [expect.objectContaining({ partNumber: 1 }), expect.objectContaining({ partNumber: 2 })],
      }),
    ]);
  });

  it("answers one entry per file, in order, with a rejected file as its error", async () => {
    const { endpoints } = setup();
    const text = (size: number) => new File([new Uint8Array(size)], "note.txt", { type: "text/plain" });
    const { data } = await endpoints.start("notes", [text(16), text(17)], undefined, live());
    expect({ data, rejected: data?.[1] instanceof CloudropError }).toEqual({
      data: [
        expect.objectContaining({ kind: "single" }),
        expect.objectContaining({
          code: "FILE_TOO_LARGE",
          message: "This file is over the 16 bytes limit. Pick a smaller file.",
          retryable: false,
        }),
      ],
      rejected: true,
    });
  });

  it.each([
    { name: "one ticket for two files", tickets: (all: unknown[]) => all.slice(0, 1) },
    { name: "three tickets for two files", tickets: (all: unknown[]) => [...all, all[0]] },
  ])("refuses an answer whose tickets do not match the files: $name", async ({ tickets }) => {
    const { endpoints } = setup({
      fault: async ({ init, forward }) => {
        const answer = await (await forward(init)).json();
        return Response.json({ files: tickets(answer.files) });
      },
    });
    const result = await endpoints.start("files", [png, png], undefined, live());
    expect(errorOf(result)).toEqual({ code: "SERVER_ERROR", message: unreadable(200), retryable: false });
  });

  it.each([
    { name: "answers a page that is not JSON as an unreadable answer", status: 502, retryable: true },
    { name: "does not retry an unreadable client error", status: 404, retryable: false },
  ])("$name", async ({ status, retryable }) => {
    const { endpoints } = setup({ fault: () => page(status) });
    const result = await endpoints.start("files", [png], undefined, live());
    expect(errorOf(result)).toEqual({ code: "SERVER_ERROR", message: unreadable(status), retryable });
  });

  it("refuses an error answer of another shape", async () => {
    // A gateway's own JSON error: it has an `error`, but not cloudrop's.
    const { endpoints } = setup({ fault: () => Response.json({ error: { message: "Bad gateway" } }, { status: 502 }) });
    const result = await endpoints.start("files", [png], undefined, live());
    expect(errorOf(result)).toEqual({ code: "SERVER_ERROR", message: unreadable(502), retryable: true });
  });

  it("retries a proxy's rate-limit page no sooner than its Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // No jitter: without the Retry-After the second attempt would start at once.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const rateLimited = new Response("<html>Too many requests</html>", {
      status: 429,
      headers: { "retry-after": "2" },
    });
    const { fixture, endpoints } = setup({ fault: ({ nth }) => (nth === 1 ? rateLimited : undefined) });
    const result = withRetry(() => endpoints.start("files", [png], undefined, live()), live());
    await vi.advanceTimersByTimeAsync(1999);
    const before = [...fixture.requests];
    await vi.advanceTimersByTimeAsync(1);
    expect({ before, after: fixture.requests, tickets: (await result).data }).toEqual({
      before: ["POST /upload"],
      after: ["POST /upload", "POST /upload"],
      tickets: [expect.objectContaining({ kind: "single" })],
    });
  });

  it("reports a proxy that stays rate-limited as a busy server, not a wrong basePath", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fixture, endpoints } = setup({ fault: () => page(429) });
    const result = await withRetry(() => endpoints.start("files", [png], undefined, live()), live());
    expect({ error: errorOf(result), requests: fixture.requests.length }).toEqual({
      error: { code: "RATE_LIMITED", message: "The upload server is busy. Try again in a moment.", retryable: true },
      requests: 6,
    });
  });

  it("refuses JSON of another shape", async () => {
    const { endpoints } = setup({ fault: () => Response.json({ files: [] }) });
    const result = await endpoints.start("files", [png], undefined, live());
    expect(errorOf(result)).toEqual({ code: "SERVER_ERROR", message: unreadable(200), retryable: false });
  });

  it("refuses a multipart ticket whose part count disagrees with the file", async () => {
    // Another cloudrop version could cut the file differently: uploading its byte ranges would corrupt the file (S7).
    const { endpoints } = setup({
      fault: async ({ init, forward }) => {
        const answer = await (await forward(init)).json();
        answer.files[0].partCount = 3;
        return Response.json(answer);
      },
    });
    const result = await endpoints.start("files", [twoParts], undefined, live());
    expect(errorOf(result)).toEqual({ code: "SERVER_ERROR", message: unreadable(200), retryable: false });
  });

  it("reports an unreachable server", async () => {
    const { endpoints } = setup({
      fault: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const result = await endpoints.start("files", [png], undefined, live());
    expect(errorOf(result)).toEqual({
      code: "NETWORK_ERROR",
      message: "The upload server could not be reached. Check the connection, then try again.",
      retryable: true,
    });
  });

  it("reports a cancelled call as aborted", async () => {
    const { endpoints } = setup();
    const controller = new AbortController();
    controller.abort();
    const result = await endpoints.start("files", [png], undefined, controller.signal);
    expect(errorOf(result)).toEqual({
      code: "ABORTED",
      message: "The upload was cancelled. Start it again to upload the file.",
      retryable: false,
    });
  });

  it("sends JSON with the page's credentials", async () => {
    const sent: RequestInit[] = [];
    const { endpoints } = setup({
      fault: ({ init }) => {
        sent.push(init);
        return undefined;
      },
    });
    await endpoints.start("files", [png], undefined, live());
    expect(
      sent.map((init) => ({
        method: init.method,
        headers: init.headers,
        credentials: init.credentials,
        body: JSON.parse(String(init.body)),
      })),
    ).toEqual([
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        // No metadata key: the route takes none, and the call was given none.
        body: { route: "files", files: [{ name: "a.png", size: 10, type: "image/png" }] },
      },
    ]);
  });
});

describe("signParts", () => {
  it("refuses a /sign answer without every asked part", async () => {
    // The real /sign answer with part 2 left out.
    const firstPartOnly = async (answer: Promise<Response>) => {
      const { parts } = await (await answer).json();
      return Response.json({ parts: parts.slice(0, 1) });
    };
    const { endpoints } = setup({
      fault: ({ label, init, forward }) => (label === "POST /sign" ? firstPartOnly(forward(init)) : undefined),
    });
    const result = await endpoints.signParts(await startOne(endpoints, twoParts), [1, 2], live());
    expect(errorOf(result)).toEqual({ code: "SERVER_ERROR", message: unreadable(200), retryable: false });
  });
});

describe("abort", () => {
  // The cancel path awaits abort() bare, so a rejection here would make upload() reject.
  it("resolves when the fetch throws synchronously", async () => {
    const endpoints = createEndpoints("/api/cloudrop", () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(endpoints.abort("token")).resolves.toBeUndefined();
  });

  it("sends /abort with keepalive, so a tab closed after a cancel or a failure still delivers it", async () => {
    const sent: RequestInit[] = [];
    const endpoints = createEndpoints("/api/cloudrop", (_, init) => {
      sent.push(init);
      return Promise.resolve(Response.json({ id: "x" }));
    });
    await endpoints.abort("token");
    expect(sent.map((init) => ({ method: init.method, keepalive: init.keepalive }))).toEqual([
      { method: "POST", keepalive: true },
    ]);
  });
});

describe("complete", () => {
  it("keeps the part numbers PARTS_MISSING names", async () => {
    const { endpoints } = setup();
    const { error } = await endpoints.complete(await startOne(endpoints, twoParts));
    expect({ code: error?.code, message: error?.message, parts: error?.parts }).toEqual({
      code: "PARTS_MISSING",
      message: "2 of 2 parts are missing or have the wrong size. Upload them again, then complete the upload.",
      parts: [1, 2],
    });
  });
});

describe("a server that never answers (M4-F3)", () => {
  /** Answers nothing until its signal aborts, then rejects as a browser's fetch does. */
  const silent: ClientFetch = (_, init) =>
    new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted.", "AbortError")));
    });
  const unreachable = {
    code: "NETWORK_ERROR",
    message: "The upload server could not be reached. Check the connection, then try again.",
    retryable: true,
  };

  /** What `promise` settled with by now, or "pending". */
  const settledNow = <T>(promise: Promise<T>) => Promise.race([promise, Promise.resolve("pending" as const)]);

  it.each([
    { name: "/upload after 30 s", ms: 30_000, call: (e: Endpoints) => e.start("files", [png], undefined, live()) },
    { name: "/sign after 30 s", ms: 30_000, call: (e: Endpoints) => e.signParts("token", [1], live()) },
    // /complete may list 10,000 parts, which the server verifies before it answers.
    { name: "/complete after 120 s", ms: 120_000, call: (e: Endpoints) => e.complete("token") },
  ])("gives $name up as a retryable NETWORK_ERROR", async ({ ms, call }) => {
    vi.useFakeTimers();
    const error = call(createEndpoints("/api/cloudrop", silent)).then(errorOf);
    await vi.advanceTimersByTimeAsync(ms - 1);
    const beforeTimeout = await settledNow(error);
    await vi.advanceTimersByTimeAsync(1);
    expect({ beforeTimeout, afterTimeout: await settledNow(error) }).toEqual({
      beforeTimeout: "pending",
      afterTimeout: unreachable,
    });
  });

  it("gives /abort up after 10 s, so a cancel waiting for it ends", async () => {
    vi.useFakeTimers();
    const result = createEndpoints("/api/cloudrop", silent)
      .abort("token")
      .then(() => "resolved");
    await vi.advanceTimersByTimeAsync(9_999);
    const beforeTimeout = await settledNow(result);
    await vi.advanceTimersByTimeAsync(1);
    expect({ beforeTimeout, afterTimeout: await settledNow(result) }).toEqual({
      beforeTimeout: "pending",
      afterTimeout: "resolved",
    });
  });

  it("answers ABORTED, not NETWORK_ERROR, when the caller cancels before the timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = createEndpoints("/api/cloudrop", silent).start("files", [png], undefined, controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect((await result).error?.code).toBe("ABORTED");
  });
});
