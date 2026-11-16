import { describe, expect, it } from "vitest";
import { CloudropError, type CloudropErrorCode } from "../errors.ts";
import { APP_ORIGIN, serverFixture } from "../testing/server-fixture.ts";
import { createCloudrop } from "./cloudrop.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { allowAnyone, route } from "./route.ts";

const TRUSTED = "https://admin.example.com";
const avatar = route({ accept: "image/png", maxSize: "1MB", authorize: allowAnyone });
const uploadBody = { route: "avatar", files: [{ name: "a.png", size: 10, type: "image/png" }] };

function setup() {
  return serverFixture({ avatar }, { trustedOrigins: [TRUSTED] });
}

function request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify(uploadBody),
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

async function outcome(response: Response) {
  const body = (await response.json()) as { error?: { code: string } };
  return { status: response.status, code: body.error?.code };
}

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

  it("stops reading a stream without a declared length once it passes the cap", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", { body: endless, duplex: "half" } as RequestInit & {
        headers?: Record<string, string>;
      }),
    );
    expect(await outcome(response)).toEqual({ status: 413, code: "BODY_TOO_LARGE" });
    expect(pulled).toBeLessThan(70);
  });
});

describe("cloudrop.handler origins and CORS", () => {
  it("accepts a same-origin request without CORS headers", async () => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", { headers: { origin: APP_ORIGIN } }),
    );
    expect({ status: response.status, cors: response.headers.get("access-control-allow-origin") }).toEqual({
      status: 200,
      cors: null,
    });
  });

  it("accepts a request without Origin, which only a server or native app sends", async () => {
    expect((await setup().cloudrop.handler(request("/api/cloudrop/upload"))).status).toBe(200);
  });

  it("refuses a request without Origin that the browser marks as cross-site", async () => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", { headers: { "sec-fetch-site": "cross-site" } }),
    );
    expect(await outcome(response)).toEqual({ status: 403, code: "ORIGIN_NOT_ALLOWED" });
  });

  it("answers a trusted origin with its exact origin and credentials, never *", async () => {
    const response = await setup().cloudrop.handler(request("/api/cloudrop/upload", { headers: { origin: TRUSTED } }));
    expect({
      status: response.status,
      origin: response.headers.get("access-control-allow-origin"),
      credentials: response.headers.get("access-control-allow-credentials"),
      vary: response.headers.get("vary"),
    }).toEqual({ status: 200, origin: TRUSTED, credentials: "true", vary: "Origin" });
  });

  it("keeps the CORS headers on an error answer, so the trusted page can read the error", async () => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", {
        headers: { origin: TRUSTED },
        body: JSON.stringify({ route: "nope", files: [] }),
      }),
    );
    expect({ status: response.status, origin: response.headers.get("access-control-allow-origin") }).toEqual({
      status: 404,
      origin: TRUSTED,
    });
  });

  it.for([
    { name: "another site", origin: "https://evil.example" },
    // Same host, other scheme: a different origin.
    { name: "the app over http", origin: "http://app.example.com" },
    { name: "a sandboxed frame (null)", origin: "null" },
  ])("refuses $name before any storage call", async ({ origin }) => {
    const fixture = setup();
    const response = await fixture.cloudrop.handler(request("/api/cloudrop/upload", { headers: { origin } }));
    expect({ ...(await outcome(response)), cors: response.headers.get("access-control-allow-origin") }).toEqual({
      status: 403,
      code: "ORIGIN_NOT_ALLOWED",
      cors: null,
    });
    expect(fixture.storageCalls).toEqual([]);
  });

  it("answers a trusted preflight with POST and the requested headers", async () => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", {
        method: "OPTIONS",
        body: null,
        headers: {
          origin: TRUSTED,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, authorization",
        },
      }),
    );
    expect({
      status: response.status,
      origin: response.headers.get("access-control-allow-origin"),
      methods: response.headers.get("access-control-allow-methods"),
      headers: response.headers.get("access-control-allow-headers"),
      credentials: response.headers.get("access-control-allow-credentials"),
      cache: response.headers.get("cache-control"),
    }).toEqual({
      status: 204,
      origin: TRUSTED,
      methods: "POST",
      headers: "content-type, authorization",
      credentials: "true",
      cache: "no-store",
    });
  });

  it.for([
    { name: "an untrusted origin", origin: "https://evil.example", method: "POST" },
    { name: "a preflight for PUT", origin: TRUSTED, method: "PUT" },
  ])("refuses a preflight from $name without CORS headers", async ({ origin, method }) => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", {
        method: "OPTIONS",
        body: null,
        headers: { origin, "access-control-request-method": method },
      }),
    );
    expect({ status: response.status, cors: response.headers.get("access-control-allow-origin") }).toEqual({
      status: 403,
      cors: null,
    });
  });
});

describe("cloudrop.handler failures", () => {
  it("answers a throwing callback with a generic 500 and logs the error itself", async () => {
    const secretDetail = new Error("db password=hunter2 at /srv/app/auth.ts:12");
    const failing = route({
      accept: "image/png",
      maxSize: "1MB",
      authorize: () => {
        throw secretDetail;
      },
    });
    const fixture = serverFixture({ avatar: failing });
    const response = await fixture.post("upload", uploadBody);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 500,
      body: {
        error: {
          code: "SERVER_ERROR",
          message: "The server could not handle the upload. Try again later.",
          retryable: false,
        },
      },
    });
    expect(fixture.logger.errors).toEqual([
      { message: "cloudrop: /upload failed on the server.", error: secretDetail },
    ]);
  });

  // A logger is the application's code: if it fails while reporting, the handler must still answer.
  it.for<{ name: string; log: () => unknown }>([
    {
      name: "throws",
      log: () => {
        throw new Error("log sink down");
      },
    },
    { name: "returns a rejected promise", log: () => Promise.reject(new Error("log sink down")) },
    // Not a native Promise, so only a then() call marks the rejection it forwards as handled.
    {
      name: "returns a rejecting thenable",
      log: () => {
        const rejected = Promise.reject(new Error("log sink down"));
        // biome-ignore lint/suspicious/noThenProperty: a custom thenable is exactly what this row sends.
        return { then: (resolve: () => void, reject: (error: unknown) => void) => rejected.then(resolve, reject) };
      },
    },
  ])("still answers a generic 500 when the logger $name", async ({ log }) => {
    const failing = route({
      accept: "image/png",
      maxSize: "1MB",
      authorize: () => {
        throw new Error("authorize failed");
      },
    });
    const fixture = serverFixture({ avatar: failing }, { logger: { error: log, warn: log } });
    expect(await outcome(await fixture.post("upload", uploadBody))).toEqual({ status: 500, code: "SERVER_ERROR" });
  });

  // Adapters written in plain JavaScript may pass anything; the promise still resolves to a Response.
  it.for<{ name: string; input: unknown }>([
    { name: "null", input: null },
    { name: "an object shaped like a request", input: { url: `${APP_ORIGIN}/api/cloudrop/upload`, method: "POST" } },
  ])("answers $name instead of a Request with a generic 500 and logs it", async ({ input }) => {
    const fixture = setup();
    const response = await fixture.cloudrop.handler(input as Request);
    expect({ ...(await outcome(response)), logged: fixture.logger.errors.map(({ message }) => message) }).toEqual({
      status: 500,
      code: "SERVER_ERROR",
      logged: ["cloudrop: the handler failed before any endpoint ran. Pass it a Fetch API Request."],
    });
  });

  // CloudropError does not check its code: a plain-JS plugin can return any text, which has no HTTP status.
  it("answers a plugin refusal with an unknown code as a generic 500, never 200", async () => {
    const plugin: CloudropPlugin = {
      id: "quota",
      server: { beforeUpload: () => new CloudropError("QUOTA_EXCEEDED" as CloudropErrorCode, "No quota left.") },
    };
    const fixture = serverFixture({ avatar }, { plugins: [plugin] });
    const response = await fixture.post("upload", uploadBody);
    expect({ status: response.status, body: await response.json(), logged: fixture.logger.errors }).toEqual({
      status: 500,
      body: {
        error: {
          code: "SERVER_ERROR",
          message: "The server could not handle the upload. Try again later.",
          retryable: false,
        },
      },
      logged: [
        {
          message:
            "cloudrop: /upload failed with an error code cloudrop does not know, so the client got a generic 500. Return a CloudropError with one of cloudrop's codes.",
          error: expect.objectContaining({ code: "QUOTA_EXCEEDED", message: "No quota left." }),
        },
      ],
    });
  });

  it("marks every answer as not cacheable, since it carries tokens and signed URLs", async () => {
    const response = await setup().post("upload", uploadBody);
    expect(response.headers.get("cache-control")).toBe("no-store");
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
        message: "Pass storage to createCloudrop: r2({ bucket }) or s3({ ... }).",
      }),
    );
  });
});
