// Contract: the `headers` option (M7-P4, M8-L5, M8-L6). Its headers go with every request to the upload server
// (/upload, /sign, /complete, /abort) and never with a bucket PUT, which keeps XMLHttpRequest and its byte progress. A
// function is called before each request, so each carries the value of its moment; its failure fails that request
// unsent with NETWORK_ERROR, and its wait ends at the request's timeout or the caller's cancel. The client's own
// content-type wins, and a wrong option throws INVALID_CONFIG.
// Oracle: the headers each request reached the fixture with, the requests XMLHttpRequest sent, literal messages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClientOptions, createCloudropClient } from "../client.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { fakeXhr } from "../testing/fake-xhr.ts";
import { gate } from "../testing/persist-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });
const twoParts = () => new File([offsetBytes(8 * MiB + 5)], "two.bin", { type: "application/octet-stream" });
const note = () => new File(["hello"], "note.txt", { type: "text/plain" });

/** A browser page: bucket PUTs through XMLHttpRequest, everything else through the global fetch, both on the fixture. */
function page(fault?: Fault) {
  const seen: string[] = [];
  const fixture = clientFixture(
    { files },
    {
      multipartThreshold: "8MB",
      fault: (call) => {
        seen.push(`${call.label} ${new Headers(call.init.headers).get("authorization")}`);
        return fault?.(call);
      },
    },
  );
  const xhr = fakeXhr(fixture.fetch);
  vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
  vi.stubGlobal("fetch", fixture.fetch);
  const client = (options: ClientOptions) => createCloudropClient({ basePath: fixture.basePath, ...options });
  return { fixture, xhr, seen, client };
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

describe("the headers option", () => {
  it("is called before each request to the server, never for a bucket PUT, which keeps XMLHttpRequest", async () => {
    // Part 1's first URL is refused as expired, so the client asks /sign for a new one.
    const expiredOnce: Fault = (call) =>
      call.label === "PUT part 1" && call.nth === 1
        ? errorResponse(403, "ExpiredRequest", "Request has expired")
        : undefined;
    const { xhr, seen, client } = page(expiredOnce);
    let issued = 0;
    const tokens = client({ concurrency: 1, headers: async () => ({ authorization: `Bearer ${++issued}` }) });
    const { error } = await tokens.upload("files", twoParts());

    // Sorted: part 2 may start while part 1 waits for its new URL.
    expect({ error, seen: seen.sort(), xhr: [...xhr.sent].sort() }).toEqual({
      error: null,
      seen: [
        "POST /complete Bearer 3",
        "POST /sign Bearer 2",
        "POST /upload Bearer 1",
        "PUT part 1 null",
        "PUT part 1 null",
        "PUT part 2 null",
      ],
      xhr: ["PUT part 1", "PUT part 1", "PUT part 2"],
    });
  });

  it("goes with a cancel's /abort too, and the client's own content-type wins", async () => {
    const held = gate((call) => call.label === "PUT object");
    const { seen, client } = page(held.fault);
    // A server reading text/plain would refuse every call with UNSUPPORTED_MEDIA_TYPE.
    const fixed = client({ headers: { authorization: "Bearer fixed", "content-type": "text/plain" } });
    const cancel = new AbortController();
    const result = fixed.upload("files", note(), { signal: cancel.signal });
    await held.reached;
    cancel.abort();

    expect({ code: (await result).error?.code, seen }).toEqual({
      code: "ABORTED",
      seen: ["POST /upload Bearer fixed", "PUT object null", "POST /abort Bearer fixed"],
    });
  });

  it("fails a request it cannot give headers for without sending it", async () => {
    const { fixture, client } = page();
    const broken = client({ headers: () => Promise.reject(new Error("The session expired.")) });
    const { error } = await broken.upload("files", note());

    expect({
      error: error && [error.code, error.message, error.retryable, (error.cause as Error).message],
      requests: fixture.requests,
    }).toEqual({
      error: [
        "NETWORK_ERROR",
        "The headers option gave no headers for a request to the upload server, so it was not sent. Check the function passed as headers, then try again.",
        true,
        "The session expired.",
      ],
      requests: [],
    });
  });

  it("stops waiting for a function that never settles at the request's timeout, and sends nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fixture, client } = page();
    const hung = client({ headers: () => new Promise<HeadersInit>(() => {}) });
    const result = hung.upload("files", note());
    // Six attempts of 30 s each; the fake clock runs each 0 ms backoff for 1 ms, so one more second covers them.
    await vi.advanceTimersByTimeAsync(6 * 30_000 + 1000);

    expect({ code: (await result).error?.code, requests: fixture.requests }).toEqual({
      code: "NETWORK_ERROR",
      requests: [],
    });
  });

  it("answers a cancel while it waits for a function with ABORTED, and sends nothing", async () => {
    const { fixture, client } = page();
    const called = Promise.withResolvers<void>();
    const hung = client({
      headers: () => {
        called.resolve();
        return new Promise<HeadersInit>(() => {});
      },
    });
    const cancel = new AbortController();
    const result = hung.upload("files", note(), { signal: cancel.signal });
    await called.promise;
    cancel.abort();

    expect({ code: (await result).error?.code, requests: fixture.requests }).toEqual({
      code: "ABORTED",
      requests: [],
    });
  });

  it("calls a function where AbortSignal has no throwIfAborted or reason, as on older React Native", async () => {
    // The abort-controller polyfill older React Native ships gives a signal only `aborted` and its events.
    class PolyfillController extends AbortController {
      constructor() {
        super();
        Object.defineProperties(this.signal, { throwIfAborted: { value: undefined }, reason: { value: undefined } });
      }
    }
    vi.stubGlobal("AbortController", PolyfillController);
    const { seen, client } = page();
    const { error } = await client({ headers: async () => ({ authorization: "Bearer rn" }) }).upload("files", note());

    expect({ error, seen }).toEqual({
      error: null,
      seen: ["POST /upload Bearer rn", "PUT object null", "POST /complete Bearer rn"],
    });
  });

  it.for([
    { name: "a number", headers: 42 },
    { name: "a header name a browser refuses", headers: { "bad name": "x" } },
  ])("refuses $name when the client is created", ({ headers }) => {
    expect(() => createCloudropClient({ headers } as unknown as ClientOptions)).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          'headers must be the headers for the upload server, such as { authorization: "Bearer …" }, or a function that returns them.',
      }),
    );
  });
});
