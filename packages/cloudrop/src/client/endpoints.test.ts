// Contract: decisions S16 (every server answer is validated; one that cannot be read is SERVER_ERROR, retryable from
// 500 on; a proxy's 429 page is a retryable RATE_LIMITED, rulings S-4 and S-7), S9 (a Retry-After is waited at least)
// and S8 (endpoint POSTs send JSON with the page's credentials). Oracle: the server's real answers through the client
// fixture, and the fetch rules of S8.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MiB } from "../rules.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { files } from "../testing/upload-fixture.ts";
import { createEndpoints } from "./endpoints.ts";
import { withRetry } from "./retry.ts";

const unreadable = (status: number) =>
  `The upload server sent an answer this client cannot read (HTTP ${status}). Check that basePath points at the cloudrop handler and that the server runs the same cloudrop version.`;

const png = new File([new Uint8Array(10)], "a.png", { type: "image/png" });
// One byte past 8 MiB would do; five keep the last part clearly distinct from the first.
const twoParts = new File([new Uint8Array(8 * MiB + 5)], "video.bin", { type: "application/octet-stream" });

function setup(options: { fault?: Fault } = {}) {
  const fixture = clientFixture({ files }, { multipartThreshold: "8MB", ...options });
  return { fixture, endpoints: createEndpoints(fixture.basePath, fixture.fetch) };
}

const live = () => new AbortController().signal;
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
    const { data } = await endpoints.start("files", png, undefined, live());
    expect(data).toEqual(
      expect.objectContaining({
        kind: "single",
        id: expect.any(String),
        put: expect.objectContaining({ headers: expect.objectContaining({ "if-none-match": "*" }) }),
      }),
    );
  });

  it("reads a multipart ticket and its first URLs", async () => {
    const { endpoints } = setup();
    const { data } = await endpoints.start("files", twoParts, undefined, live());
    expect(data).toEqual(
      expect.objectContaining({
        kind: "multipart",
        partSize: 8_388_608,
        partCount: 2,
        parts: [expect.objectContaining({ partNumber: 1 }), expect.objectContaining({ partNumber: 2 })],
      }),
    );
  });

  it.each([
    { name: "answers a page that is not JSON as an unreadable answer", status: 502, retryable: true },
    { name: "does not retry an unreadable client error", status: 404, retryable: false },
  ])("$name", async ({ status, retryable }) => {
    const { endpoints } = setup({ fault: () => page(status) });
    const result = await endpoints.start("files", png, undefined, live());
    expect(errorOf(result)).toEqual({ code: "SERVER_ERROR", message: unreadable(status), retryable });
  });

  it("refuses an error answer of another shape", async () => {
    // A gateway's own JSON error: it has an `error`, but not cloudrop's.
    const { endpoints } = setup({ fault: () => Response.json({ error: { message: "Bad gateway" } }, { status: 502 }) });
    const result = await endpoints.start("files", png, undefined, live());
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
    const result = withRetry(() => endpoints.start("files", png, undefined, live()), live());
    await vi.advanceTimersByTimeAsync(1999);
    const before = [...fixture.requests];
    await vi.advanceTimersByTimeAsync(1);
    expect({ before, after: fixture.requests, kind: (await result).data?.kind }).toEqual({
      before: ["POST /upload"],
      after: ["POST /upload", "POST /upload"],
      kind: "single",
    });
  });

  it("reports a proxy that stays rate-limited as a busy server, not a wrong basePath", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fixture, endpoints } = setup({ fault: () => page(429) });
    const result = await withRetry(() => endpoints.start("files", png, undefined, live()), live());
    expect({ error: errorOf(result), requests: fixture.requests.length }).toEqual({
      error: { code: "RATE_LIMITED", message: "The upload server is busy. Try again in a moment.", retryable: true },
      requests: 6,
    });
  });

  it("refuses JSON of another shape", async () => {
    const { endpoints } = setup({ fault: () => Response.json({ files: [] }) });
    const result = await endpoints.start("files", png, undefined, live());
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
    const result = await endpoints.start("files", twoParts, undefined, live());
    expect(errorOf(result)).toEqual({ code: "SERVER_ERROR", message: unreadable(200), retryable: false });
  });

  it("reports an unreachable server", async () => {
    const { endpoints } = setup({
      fault: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const result = await endpoints.start("files", png, undefined, live());
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
    const result = await endpoints.start("files", png, undefined, controller.signal);
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
    await endpoints.start("files", png, undefined, live());
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
    const { data: ticket } = await endpoints.start("files", twoParts, undefined, live());
    const result = await endpoints.signParts(ticket?.token ?? "", [1, 2], live());
    expect(errorOf(result)).toEqual({ code: "SERVER_ERROR", message: unreadable(200), retryable: false });
  });
});

describe("abort", () => {
  // Task 6 awaits abort() bare on the cancel path, so a rejection here would make upload() reject.
  it.each([
    {
      name: "the fetch throws synchronously",
      fetch: () => {
        throw new TypeError("Failed to fetch");
      },
      timeout: () => new AbortController().signal,
    },
    {
      name: "the browser has no AbortSignal.timeout",
      fetch: () => Promise.resolve(Response.json({ id: "x" })),
      timeout: () => {
        throw new TypeError("AbortSignal.timeout is not a function");
      },
    },
  ])("resolves when $name", async ({ fetch, timeout }) => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(timeout);
    const endpoints = createEndpoints("/api/cloudrop", fetch);
    await expect(endpoints.abort("token")).resolves.toBeUndefined();
  });
});

describe("complete", () => {
  it("keeps the part numbers PARTS_MISSING names", async () => {
    const { endpoints } = setup();
    const { data: ticket } = await endpoints.start("files", twoParts, undefined, live());
    const { error } = await endpoints.complete(ticket?.token ?? "");
    expect({ code: error?.code, message: error?.message, parts: error?.parts }).toEqual({
      code: "PARTS_MISSING",
      message: "2 of 2 parts are missing or have the wrong size. Upload them again, then complete the upload.",
      parts: [1, 2],
    });
  });
});
