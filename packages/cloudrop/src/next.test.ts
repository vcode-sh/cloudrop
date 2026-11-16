import { describe, expect, it } from "vitest";
import { toNextHandler } from "./next.ts";
import { allowAnyone, route } from "./server/route.ts";
import { APP_ORIGIN, serverFixture } from "./testing/server-fixture.ts";

describe("toNextHandler", () => {
  it("answers uploads, preflights and wrong methods through the same handler", async () => {
    const { cloudrop } = serverFixture(
      { files: route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone }) },
      { trustedOrigins: ["https://admin.example.com"] },
    );
    const { GET, POST, OPTIONS } = toNextHandler(cloudrop);
    const url = `${APP_ORIGIN}/api/cloudrop/upload`;
    const posted = await POST(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "files", files: [{ name: "a.txt", size: 1, type: "text/plain" }] }),
      }),
    );
    const preflight = await OPTIONS(
      new Request(url, {
        method: "OPTIONS",
        headers: { origin: "https://admin.example.com", "access-control-request-method": "POST" },
      }),
    );
    expect([posted.status, preflight.status, (await GET(new Request(url))).status]).toEqual([200, 204, 405]);
  });

  it("calls handler on the object it was given, so a handler that reads `this` still works once destructured", async () => {
    const server = {
      status: 201,
      async handler(this: { status: number }) {
        return new Response(null, { status: this.status });
      },
    };
    const { POST } = toNextHandler(server);
    expect((await POST(new Request(`${APP_ORIGIN}/api/cloudrop/upload`, { method: "POST" }))).status).toBe(201);
  });

  it.each([
    { name: "null", value: null },
    { name: "an object whose handler is not a function", value: { handler: "upload" } },
  ])("refuses $name at construction with INVALID_CONFIG", ({ value }) => {
    expect(() => toNextHandler(value as never)).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          "toNextHandler needs the cloudrop server, an object with a handler function: pass what createCloudrop returned.",
      }),
    );
  });
});
