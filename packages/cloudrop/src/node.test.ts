import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { connect as connectHttp2, createServer as createHttp2Server } from "node:http2";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { toNodeHandler } from "./node.ts";
import { allowAnyone, route } from "./server/route.ts";
import { serverFixture } from "./testing/server-fixture.ts";

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  server = undefined;
});

/** A real node:http server on a free loopback port. Passing the adapter to createServer is the type test: real
 * IncomingMessage and ServerResponse values must fit its hand-written interfaces. */
async function serve(listener: RequestListener): Promise<string> {
  server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function listen(trustedOrigins: string[] = []): Promise<string> {
  const { cloudrop } = serverFixture(
    { files: route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone }) },
    { trustedOrigins },
  );
  return serve(toNodeHandler(cloudrop));
}

/** Sends raw HTTP, which fetch would refuse to send, and resolves to the status line of the answer. */
function raw(base: string, text: string): Promise<string> {
  return new Promise((resolve) => {
    let reply = "";
    const socket = connect(Number(new URL(base).port), "127.0.0.1", () => socket.write(text));
    socket.on("data", (chunk) => {
      reply += String(chunk);
      socket.end();
    });
    socket.on("close", () => resolve(reply.split("\r\n")[0] ?? ""));
  });
}

const body = JSON.stringify({ route: "files", files: [{ name: "a.txt", size: 1, type: "text/plain" }] });

describe("toNodeHandler", () => {
  it("answers an upload with the handler's status, headers and JSON", async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/cloudrop/upload`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body,
    });
    const json = (await response.json()) as { files: { kind: string }[] };
    expect([response.status, response.headers.get("content-type"), json.files[0]?.kind]).toEqual([
      200,
      "application/json",
      "single",
    ]);
  });

  it("refuses another origin: the request URL comes from the Host header, not from the caller", async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/cloudrop/upload`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body,
    });
    expect(response.status).toBe(403);
  });

  // A target that names a host would otherwise replace the Host header's origin, and the caller's Origin would then
  // match it: the same-origin check would pass for another site.
  it.for([
    {
      name: "a protocol-relative target",
      target: "//evil.example/api/cloudrop/upload",
      status: "HTTP/1.1 404 Not Found",
    },
    { name: "a backslash target", target: "/\\evil.example/api/cloudrop/upload", status: "HTTP/1.1 404 Not Found" },
    {
      name: "an absolute target",
      target: "http://evil.example/api/cloudrop/upload",
      status: "HTTP/1.1 400 Bad Request",
    },
  ])("never takes the request's host from $name", async ({ target, status }) => {
    const base = await listen();
    const request = [
      `POST ${target} HTTP/1.1`,
      `Host: ${new URL(base).host}`,
      "Origin: http://evil.example",
      "Content-Type: application/json",
      `Content-Length: ${body.length}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n");
    expect(await raw(base, request)).toBe(status);
  });

  // The request target is appended to the Host header's origin, so a path smuggled into Host must not become a prefix
  // of the path the handler matches.
  it("ignores a path in the Host header: /upload is not the upload endpoint", async () => {
    const base = await listen();
    const request = [
      "POST /upload HTTP/1.1",
      `Host: ${new URL(base).host}/api/cloudrop`,
      "Content-Type: application/json",
      `Content-Length: ${body.length}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n");
    expect(await raw(base, request)).toBe("HTTP/1.1 404 Not Found");
  });

  // An HTTP/2 client sends the host as ":authority" and no Host header; a browser's Origin is still the same origin.
  it("accepts a same-origin upload over HTTP/2, where the host arrives as :authority", async () => {
    const { cloudrop } = serverFixture({ files: route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone }) });
    const h2 = createHttp2Server(toNodeHandler(cloudrop));
    onTestFinished(() => void h2.close());
    h2.listen(0, "127.0.0.1");
    await once(h2, "listening");
    const origin = `http://127.0.0.1:${(h2.address() as AddressInfo).port}`;
    const client = connectHttp2(origin);
    onTestFinished(() => void client.close());
    const stream = client.request({
      ":method": "POST",
      ":path": "/api/cloudrop/upload",
      origin,
      "content-type": "application/json",
    });
    stream.end(body);
    const [headers] = await once(stream, "response");
    stream.resume();
    expect(headers[":status"]).toBe(200);
  });

  it("answers 413 to a 100 KiB body and still delivers the answer", async () => {
    const base = await listen();
    // Valid JSON, so a body read in full would get 200: only the cap can answer 413.
    const large = JSON.stringify({
      route: "files",
      files: [{ name: "a.txt", size: 1, type: "text/plain" }],
      pad: "x".repeat(100 * 1024),
    });
    const response = await fetch(`${base}/api/cloudrop/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: large,
    });
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([
      413,
      "BODY_TOO_LARGE",
    ]);
  });

  it("reads at most one chunk past 64 KiB of a 4 MiB body, so a large request cannot fill memory", async () => {
    let received = 0;
    const base = await serve(
      toNodeHandler({
        handler: async (request) => {
          received = (await request.arrayBuffer()).byteLength;
          return new Response(null, { status: 413 });
        },
      }),
    );
    const response = await fetch(`${base}/api/cloudrop/upload`, {
      method: "POST",
      body: new Uint8Array(4 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    // Node delivers a request body in chunks of at most 64 KiB: past the cap, one more chunk at most.
    expect(received).toBeGreaterThan(65_536);
    expect(received).toBeLessThanOrEqual(2 * 65_536);
  });

  // A body left paused holds its socket open until Node times it out (measured: 6 s), so close() outlasts 2 s.
  it("drops the rest of an oversized body after answering, so the server can close at once", {
    timeout: 2000,
  }, async () => {
    const base = await serve(toNodeHandler({ handler: async () => new Response(null, { status: 413 }) }));
    const response = await fetch(`${base}/api/cloudrop/upload`, {
      method: "POST",
      body: new Uint8Array(4 * 1024 * 1024),
    });
    const closed = once(server as Server, "close");
    server?.close();
    expect([response.status, await closed]).toEqual([413, []]);
  });

  it("sends each of a handler's set-cookie headers on its own", async () => {
    const cookies = new Headers([
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2; Path=/"],
    ]);
    const base = await serve(toNodeHandler({ handler: async () => new Response("{}", { headers: cookies }) }));
    expect((await fetch(base)).headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("passes CORS preflights through to the handler", async () => {
    const base = await listen(["https://admin.example.com"]);
    const response = await fetch(`${base}/api/cloudrop/upload`, {
      method: "OPTIONS",
      headers: { origin: "https://admin.example.com", "access-control-request-method": "POST" },
    });
    expect([response.status, response.headers.get("access-control-allow-origin")]).toEqual([
      204,
      "https://admin.example.com",
    ]);
  });

  it("answers requests a fetch Request cannot hold, survives a client that hangs up mid-body, and keeps serving", async () => {
    const base = await listen();
    const hangUp = connect(Number(new URL(base).port), "127.0.0.1", () => {
      hangUp.write(
        "POST /api/cloudrop/upload HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{",
      );
      setTimeout(() => hangUp.destroy(), 20);
    });
    await once(hangUp, "close");
    const upload = await fetch(`${base}/api/cloudrop/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect([
      await raw(base, "TRACE /api/cloudrop/upload HTTP/1.1\r\nHost: x\r\n\r\n"),
      await raw(base, "POST http://a:99999/api/cloudrop/upload HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n"),
      upload.status,
    ]).toEqual(["HTTP/1.1 400 Bad Request", "HTTP/1.1 400 Bad Request", 200]);
  });

  it.each([
    {
      name: "the handler rejects",
      handler: async (): Promise<Response> => {
        throw new Error("handler bug");
      },
    },
    {
      name: "the answer's body fails while it is read",
      handler: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("stream bug"));
            },
          }),
        ),
    },
  ])(
    "answers 500 SERVER_ERROR and logs the failure when $name, without rejecting the listener",
    async ({ handler }) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const base = await serve(toNodeHandler({ handler }));
      const response = await fetch(`${base}/api/cloudrop/upload`, { method: "POST", body });
      expect([
        response.status,
        response.headers.get("cache-control"),
        await response.json(),
        logged.mock.calls.map(([message]) => message),
      ]).toEqual([
        500,
        "no-store",
        {
          error: {
            code: "SERVER_ERROR",
            message: "The server could not handle the upload. Contact the site owner if this keeps happening.",
            retryable: false,
          },
        },
        ["cloudrop/node: the handler threw or gave an answer that could not be sent; answering 500 instead."],
      ]);
    },
  );

  it("reads the full path from originalUrl when a framework strips the mount path from url", async () => {
    const { cloudrop } = serverFixture({ files: route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone }) });
    const handler = toNodeHandler(cloudrop);
    const base = await serve((request, response) => {
      // What Express's app.use("/api/cloudrop", …) does to the request.
      Object.assign(request, { originalUrl: request.url, url: request.url?.replace("/api/cloudrop", "") });
      void handler(request, response);
    });
    const response = await fetch(`${base}/api/cloudrop/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
  });

  it.each([
    { name: "null", value: null },
    { name: "an object whose handler is not a function", value: { handler: "upload" } },
  ])("refuses $name at construction with INVALID_CONFIG", ({ value }) => {
    expect(() => toNodeHandler(value as never)).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          "toNodeHandler needs the cloudrop server, an object with a handler function: pass what createCloudrop returned.",
      }),
    );
  });
});
