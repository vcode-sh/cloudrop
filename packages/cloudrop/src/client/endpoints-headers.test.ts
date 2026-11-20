// Contract: the `headers` option (M7-P4, M8-L5, M8-L6). Its headers go with every request to the upload server
// (/upload, /sign, /complete, /abort) and never with a bucket PUT, which keeps XMLHttpRequest and its byte progress. A
// function is called before each request, so each carries the value of its moment; its failure fails that request
// unsent with NETWORK_ERROR. The client's own content-type wins, and a wrong option throws INVALID_CONFIG.
// Oracle: the headers each request reached the fixture with, the requests XMLHttpRequest sent, literal messages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClientOptions, createCloudropClient } from "../client.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the headers option", () => {
  it("is called before each request to the server, never for a bucket PUT, which keeps XMLHttpRequest", async () => {
    const { xhr, seen, client } = page();
    let issued = 0;
    const tokens = client({ concurrency: 1, headers: async () => ({ authorization: `Bearer ${++issued}` }) });
    const { error } = await tokens.upload("files", twoParts());

    expect({ error, seen, xhr: xhr.sent }).toEqual({
      error: null,
      seen: ["POST /upload Bearer 1", "PUT part 1 null", "PUT part 2 null", "POST /complete Bearer 2"],
      xhr: ["PUT part 1", "PUT part 2"],
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

    expect({ error: error && [error.code, error.message, error.retryable], requests: fixture.requests }).toEqual({
      error: [
        "NETWORK_ERROR",
        "The headers option gave no headers for a request to the upload server, so it was not sent. Check the function passed as headers, then try again.",
        true,
      ],
      requests: [],
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
