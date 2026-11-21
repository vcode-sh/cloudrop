import { describe, expect, it } from "vitest";
import { outcome, request, setup, TRUSTED } from "../testing/handler-fixture.ts";
import { APP_ORIGIN } from "../testing/server-fixture.ts";

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

  // x-cloudrop-account is the client's account option (M10-A), sent with /upload only.
  it("answers a trusted preflight with POST and the requested headers, the account header among them", async () => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", {
        method: "OPTIONS",
        body: null,
        headers: {
          origin: TRUSTED,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, authorization, x-cloudrop-account",
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
      headers: "content-type, authorization, x-cloudrop-account",
      credentials: "true",
      cache: "no-store",
    });
  });

  // A header name is an RFC 9110 token: "_" and "." are as valid as "-", and a list answered short blocks the request.
  it("allows every valid header name a trusted preflight asks for", async () => {
    const asked = "content-type,x_api_key ,\tx.trace-id, x-a!#$%&'*+^`|~";
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", {
        method: "OPTIONS",
        body: null,
        headers: {
          origin: TRUSTED,
          "access-control-request-method": "POST",
          "access-control-request-headers": asked,
        },
      }),
    );
    expect([response.status, response.headers.get("access-control-allow-headers")]).toEqual([204, asked]);
  });

  it("answers content-type alone when the asked header list is not a list of header names", async () => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", {
        method: "OPTIONS",
        body: null,
        headers: {
          origin: TRUSTED,
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-a, x b",
        },
      }),
    );
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  it("refuses a preflight from an untrusted origin without CORS headers", async () => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", {
        method: "OPTIONS",
        body: null,
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      }),
    );
    expect({ ...(await outcome(response)), cors: response.headers.get("access-control-allow-origin") }).toEqual({
      status: 403,
      code: "ORIGIN_NOT_ALLOWED",
      cors: null,
    });
  });

  // The origin is allowed, so the answer must not blame it (M11-R46).
  it.for<{ name: string; headers: Record<string, string> }>([
    { name: "an OPTIONS that is no preflight", headers: {} },
    { name: "a preflight for PUT", headers: { "access-control-request-method": "PUT" } },
  ])("tells $name from a trusted origin to ask for POST", async ({ headers }) => {
    const response = await setup().cloudrop.handler(
      request("/api/cloudrop/upload", { method: "OPTIONS", body: null, headers: { origin: TRUSTED, ...headers } }),
    );
    expect({
      status: response.status,
      allow: response.headers.get("allow"),
      cors: response.headers.get("access-control-allow-origin"),
      error: ((await response.json()) as { error: unknown }).error,
    }).toEqual({
      status: 405,
      allow: "POST, OPTIONS",
      cors: null,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "This OPTIONS request is not a CORS preflight for POST. Send the request as POST.",
        retryable: false,
      },
    });
  });
});
