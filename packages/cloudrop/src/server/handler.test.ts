import { afterEach, describe, expect, it, vi } from "vitest";
import { outcome, request, setup, uploadBody } from "../testing/handler-fixture.ts";
import { createCloudrop } from "./cloudrop.ts";

describe("cloudrop.handler routing and request checks", () => {
  it.for<{
    name: string;
    path: string;
    init?: RequestInit & { headers?: Record<string, string> };
    status: number;
    code: string;
  }>([
    { name: "an unknown endpoint", path: "/api/cloudrop/delete", status: 404, code: "NOT_FOUND" },
    { name: "a path outside basePath", path: "/api/other/upload", status: 404, code: "NOT_FOUND" },
    // "/api/cloudropupload" starts with the base path's characters but is not under it.
    {
      name: "a path that only shares the base path's prefix",
      path: "/api/cloudropupload",
      status: 404,
      code: "NOT_FOUND",
    },
    {
      name: "an inherited property name as endpoint",
      path: "/api/cloudrop/constructor",
      status: 404,
      code: "NOT_FOUND",
    },
    {
      name: "GET",
      path: "/api/cloudrop/upload",
      init: { method: "GET", body: null },
      status: 405,
      code: "METHOD_NOT_ALLOWED",
    },
    { name: "PUT", path: "/api/cloudrop/upload", init: { method: "PUT" }, status: 405, code: "METHOD_NOT_ALLOWED" },
    // text/plain is CORS-safelisted: accepting it would let any site post here without a preflight.
    {
      name: "a text/plain body",
      path: "/api/cloudrop/upload",
      init: { headers: { "content-type": "text/plain" } },
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    },
    {
      name: "a form body",
      path: "/api/cloudrop/upload",
      init: { headers: { "content-type": "application/x-www-form-urlencoded" } },
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    },
    {
      name: "a body that is not JSON",
      path: "/api/cloudrop/upload",
      init: { body: "{route:" },
      status: 400,
      code: "INVALID_INPUT",
    },
    // A lenient decoder reads 0xFF as U+FFFD and the body parses (an unknown route, 404); only a fatal one answers 400.
    {
      name: "a body that is not UTF-8",
      path: "/api/cloudrop/upload",
      init: {
        body: new Uint8Array([
          ...new TextEncoder().encode('{"route":"avatar'),
          0xff,
          ...new TextEncoder().encode('","files":[]}'),
        ]),
      },
      status: 400,
      code: "INVALID_INPUT",
    },
    { name: "an empty body", path: "/api/cloudrop/upload", init: { body: "" }, status: 400, code: "INVALID_INPUT" },
  ])("answers $name with $status $code", async ({ path, init, status, code }) => {
    expect(await outcome(await setup().cloudrop.handler(request(path, init)))).toEqual({ status, code });
  });

  it("names the allowed methods on 405", async () => {
    const response = await setup().cloudrop.handler(request("/api/cloudrop/upload", { method: "GET", body: null }));
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("accepts application/json with a charset", async () => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", { headers: { "content-type": "application/json; charset=utf-8" } }),
    );
    expect(response.status).toBe(200);
  });
});

describe("cloudrop.handler request body", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const encoder = new TextEncoder();
  const inChunks = (...chunks: Uint8Array[]) =>
    request("/api/cloudrop/upload", { body: new Blob(chunks as BlobPart[]).stream(), duplex: "half" } as RequestInit & {
      headers?: Record<string, string>;
    });

  // jsdom 26, Vitest's jsdom environment until jsdom 27, has a Blob without arrayBuffer() (M11-R2).
  it("reads the body where the environment's Blob has no arrayBuffer()", async () => {
    const body = request("/api/cloudrop/upload");
    vi.stubGlobal("Blob", class Blob {});

    expect((await setup().cloudrop.handler(body)).status).toBe(200);
  });

  it("reads a character whose bytes arrive in two chunks", async () => {
    const [start = "", end = ""] = JSON.stringify({ ...uploadBody, pad: "é" }).split("é");
    const [first = 0, second = 0] = encoder.encode("é");
    const body = inChunks(
      new Uint8Array([...encoder.encode(start), first]),
      new Uint8Array([second, ...encoder.encode(end)]),
    );

    expect((await setup().cloudrop.handler(body)).status).toBe(200);
  });

  // Without the last byte of "é" the text before it is whole JSON: only a decoder that checks the end refuses it.
  it("answers a body that ends inside a character with 400 INVALID_INPUT", async () => {
    const body = inChunks(encoder.encode(JSON.stringify(uploadBody)), new Uint8Array([0xc3]));

    expect(await outcome(await setup().cloudrop.handler(body))).toEqual({ status: 400, code: "INVALID_INPUT" });
  });
});

describe("cloudrop.handler body cap (64 KiB)", () => {
  // Valid JSON of exactly `length` ASCII bytes, so only its size decides the answer. Unknown fields are ignored.
  const empty = JSON.stringify({ ...uploadBody, pad: "" });
  const sized = (length: number) => JSON.stringify({ ...uploadBody, pad: "x".repeat(length - empty.length) });

  it("reads a body of exactly 65,536 bytes", async () => {
    const response = await setup().cloudrop.handler(request("/api/cloudrop/upload", { body: sized(65_536) }));
    expect(response.status).toBe(200);
  });

  it("refuses 65,537 bytes", async () => {
    const response = await setup().cloudrop.handler(request("/api/cloudrop/upload", { body: sized(65_537) }));
    expect(await outcome(response)).toEqual({ status: 413, code: "BODY_TOO_LARGE" });
  });

  it("refuses a declared length over the cap without reading the body", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", {
        body: endless,
        headers: { "content-length": "1000000" },
        duplex: "half",
      } as RequestInit & { headers: Record<string, string> }),
    );
    expect(await outcome(response)).toEqual({ status: 413, code: "BODY_TOO_LARGE" });
    // A stream may pull its first chunk eagerly; reading the body would pull at least 65 chunks.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("stops reading a stream without a declared length once it passes the cap, and cancels it", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", { body: endless, duplex: "half" } as RequestInit & {
        headers?: Record<string, string>;
      }),
    );
    expect(await outcome(response)).toEqual({ status: 413, code: "BODY_TOO_LARGE" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(70);
  });
});

describe("createCloudrop from plain JavaScript", () => {
  it.for([
    { name: "null", options: null },
    { name: "a string", options: "r2" },
  ])("refuses $name as options with INVALID_CONFIG", ({ options }) => {
    expect(() => createCloudrop(options as never)).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message: "Pass at least one route: routes: { avatar: route({ ... }) }.",
      }),
    );
  });
});
