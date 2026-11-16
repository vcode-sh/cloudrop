// Contract: spec §4.1 and decision S10: in a browser without a fetch option, a bucket PUT goes through XMLHttpRequest,
// reports its bytes while they are sent, and its answer is classified exactly as the fetch path classifies it. Oracle:
// bucket.test.ts's rows for the same statuses, and the bytes the fake bucket stored.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import type { CloudropErrorCode } from "../errors.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { fakeXhr } from "../testing/fake-xhr.ts";
import { offsetBytes } from "../testing/storage-contract.ts";
import { files } from "../testing/upload-fixture.ts";
import { createPut } from "./transport.ts";

const withCode = (code: CloudropErrorCode) => expect.objectContaining({ code });

/** A presigned single PUT for a 1000-byte file, a fake XHR stubbed over the fixture, and the bytes it reports. */
async function setup({ fault, hold = false }: { fault?: Fault; hold?: boolean } = {}) {
  const fixture = clientFixture({ files }, { fault });
  const xhr = fakeXhr(fixture.fetch, { hold });
  vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest);
  const ticket = await fixture.server.single("files", { name: "a.bin", size: 1000, type: "application/octet-stream" });
  const reported: number[] = [];
  const onBytes = (sent: number) => reported.push(sent);
  // The XHR path: no fetch option. Server calls, which these tests make none of, would go to the fixture.
  const put = createPut(undefined, fixture.fetch);
  return { fixture, xhr, put, target: ticket.put, body: new Blob([offsetBytes(1000)]), reported, onBytes };
}

afterEach(() => {
  vi.unstubAllGlobals();
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
      name: "renews a RustFS expiry",
      fault: answer(403, "<Error><Code>AccessDenied</Code></Error>"),
      expected: { kind: "expired", error: withCode("UPLOAD_REJECTED"), retryAfterMs: 0 },
    },
    {
      name: "waits as long as a busy bucket asks",
      fault: answer(503, "", { "retry-after": "7" }),
      expected: { kind: "retry", error: withCode("RATE_LIMITED"), retryAfterMs: 7000 },
    },
    {
      name: "retries a server error",
      fault: answer(500),
      expected: { kind: "retry", error: withCode("STORAGE_ERROR"), retryAfterMs: 0 },
    },
    {
      name: "fails a bad request",
      fault: answer(400),
      expected: { kind: "rejected", error: withCode("UPLOAD_REJECTED") },
    },
  ])("$name", async ({ fault, expected }) => {
    const { put, target, body, onBytes } = await setup({ fault });
    expect(await put(target, body, new AbortController().signal, onBytes)).toEqual(expected);
  });

  it("reports a network or CORS failure as opaque", async () => {
    const { xhr, put, target, body, onBytes } = await setup({ hold: true });
    const outcome = put(target, body, new AbortController().signal, onBytes);
    (await xhr.next()).fail();
    expect(await outcome).toEqual({ kind: "opaque", error: withCode("NETWORK_ERROR"), retryAfterMs: 0 });
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
