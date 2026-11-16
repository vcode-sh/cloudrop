// The URL toNodeHandler builds decides the same-origin check and the endpoint the handler matches, so it is pinned here
// as one table. The rule every row follows: the origin is `<scheme>://<the origin of Host or :authority>`; nothing in
// the request target or the Host value changes that host, adds a path in front of the target, or makes the listener
// reject; a malformed host answers 400 (RFC 9112 §3.2, RFC 9113 §8.3.1).
// The handler is a stub that answers with the origin and path it was given: the adapter is the boundary under test.

import { once } from "node:events";
import { createServer } from "node:http";
import { connect as connectHttp2, createServer as createHttp2Server, type OutgoingHttpHeaders } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, connect, type Server, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { toNodeHandler } from "./node.ts";

const seen = toNodeHandler({
  handler: async (request) => {
    const { origin, pathname } = new URL(request.url);
    const text = `${origin} ${pathname}`;
    // A length keeps the raw reply unchunked, so the body is the text itself.
    return new Response(text, { headers: { "content-length": String(text.length) } });
  },
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** Serves the listener for one test. */
async function serveOnce(server: Server): Promise<number> {
  onTestFinished(() => void server.close());
  return listen(server);
}

/** Writes raw HTTP, which fetch would refuse to send, and answers "200 <origin> <path>" or the refusal's status. */
function exchange(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    let reply = "";
    socket.on("data", (chunk) => {
      reply += String(chunk);
    });
    socket.on("close", () => {
      const status = reply.split(" ")[1] ?? "";
      resolve(status === "200" ? `200 ${reply.split("\r\n\r\n")[1]}` : status);
    });
    socket.write(text);
  });
}

function request(target: string, hosts: string[], version = "1.1"): string {
  const lines = [`GET ${target} HTTP/${version}`, ...hosts.map((host) => `Host: ${host}`), "Connection: close"];
  return `${lines.join("\r\n")}\r\n\r\n`;
}

const APP = "app.example";

describe("toNodeHandler's request URL over HTTP/1.1", () => {
  let port = 0;
  beforeAll(async () => {
    const server = createServer(seen);
    port = await listen(server);
    return () => void server.close();
  });
  const send = async (text: string): Promise<string> => {
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    return exchange(socket, text);
  };

  it.for([
    { name: "a path", target: "/api/cloudrop/upload", answer: "200 http://app.example /api/cloudrop/upload" },
    {
      name: "a query",
      target: "/api/cloudrop/upload?route=a",
      answer: "200 http://app.example /api/cloudrop/upload",
    },
    {
      name: "a fragment",
      target: "/api/cloudrop/upload#x",
      answer: "200 http://app.example /api/cloudrop/upload",
    },
    {
      name: "encoded slashes",
      target: "/%2F%2Fevil.example/api/cloudrop/upload",
      answer: "200 http://app.example /%2F%2Fevil.example/api/cloudrop/upload",
    },
    {
      name: "a .. segment",
      target: "/api/cloudrop/x/../upload",
      answer: "200 http://app.example /api/cloudrop/upload",
    },
    {
      name: "an encoded .. segment",
      target: "/api/cloudrop/x/%2e%2e/upload",
      answer: "200 http://app.example /api/cloudrop/upload",
    },
    {
      name: ".. past the root",
      target: "/../../api/cloudrop/upload",
      answer: "200 http://app.example /api/cloudrop/upload",
    },
    {
      name: "backslashes",
      target: "/api\\cloudrop\\upload",
      answer: "200 http://app.example /api/cloudrop/upload",
    },
    {
      name: "an @ in the path",
      target: "/@evil.example/api",
      answer: "200 http://app.example /@evil.example/api",
    },
    {
      name: "a protocol-relative target",
      target: "//evil.example/api/cloudrop/upload",
      answer: "200 http://app.example //evil.example/api/cloudrop/upload",
    },
    {
      name: "a backslash after the first slash",
      target: "/\\evil.example/api/cloudrop/upload",
      answer: "200 http://app.example //evil.example/api/cloudrop/upload",
    },
    { name: "an absolute http URL", target: "http://evil.example/api/cloudrop/upload", answer: "400" },
    {
      name: "an absolute URL naming the Host itself",
      target: "http://app.example/api/cloudrop/upload",
      answer: "400",
    },
    {
      name: "an absolute https URL with a port",
      target: "https://evil.example:8443/api/cloudrop/upload",
      answer: "400",
    },
    { name: "an absolute URL with an invalid port", target: "http://a:99999/api/cloudrop/upload", answer: "400" },
    { name: "an empty target", target: "", answer: "400" },
  ])("takes the host from Host, never from a target with $name", async ({ target, answer }) => {
    expect(await send(request(target, [APP]))).toBe(answer);
  });

  it("answers 400 to OPTIONS *, which names no path", async () => {
    expect(await send(`OPTIONS * HTTP/1.1\r\nHost: ${APP}\r\nConnection: close\r\n\r\n`)).toBe("400");
  });

  it.for([
    { name: "no port", hosts: ["app.example"], answer: "200 http://app.example /api/cloudrop/upload" },
    { name: "the default port", hosts: ["app.example:80"], answer: "200 http://app.example /api/cloudrop/upload" },
    { name: "capitals", hosts: ["APP.Example:8080"], answer: "200 http://app.example:8080 /api/cloudrop/upload" },
    { name: "an IPv6 literal and a port", hosts: ["[::1]:8080"], answer: "200 http://[::1]:8080 /api/cloudrop/upload" },
    { name: "userinfo", hosts: ["evil@app.example:8080"], answer: "400" },
    { name: "a path", hosts: ["app.example:8080/api/cloudrop"], answer: "400" },
    { name: "a backslash", hosts: ["app.example:8080\\api"], answer: "400" },
    { name: "a space", hosts: ["app example"], answer: "400" },
    { name: "an invalid port", hosts: ["app.example:99999"], answer: "400" },
    { name: "an empty value", hosts: [""], answer: "400" },
    { name: "two values", hosts: ["app.example:8080", "evil.example"], answer: "400" },
    { name: "no value at all", hosts: [], answer: "400" },
  ])("reads a Host header with $name", async ({ hosts, answer }) => {
    expect(await send(request("/api/cloudrop/upload", hosts))).toBe(answer);
  });

  // HTTP/1.0 may omit Host and Node lets it through: no origin was named, and none is invented.
  it("answers 400 to an HTTP/1.0 request without Host", async () => {
    expect(await send(request("/api/cloudrop/upload", [], "1.0"))).toBe("400");
  });

  it("reads the full path from originalUrl when a framework strips the mount path from url", async () => {
    const server = createServer((incoming, response) => {
      // What Express's app.use("/api/cloudrop", …) does to the request.
      Object.assign(incoming, { originalUrl: incoming.url, url: incoming.url?.replace("/api/cloudrop", "") });
      void seen(incoming, response);
    });
    const socket = connect(await serveOnce(server), "127.0.0.1");
    await once(socket, "connect");
    expect(await exchange(socket, request("/api/cloudrop/upload", [APP]))).toBe(
      "200 http://app.example /api/cloudrop/upload",
    );
  });
});

// TLS-PSK needs no certificate, so the encrypted socket is real and nothing is written to disk.
it("takes the https scheme from an encrypted socket", async () => {
  const psk = new Uint8Array(32).fill(7);
  const tls = { ciphers: "PSK-AES128-GCM-SHA256", maxVersion: "TLSv1.2" } as const;
  const port = await serveOnce(createHttpsServer({ ...tls, pskCallback: () => psk }, seen));
  const socket = connectTls({
    ...tls,
    port,
    host: "127.0.0.1",
    pskCallback: () => ({ psk, identity: "cloudrop" }),
    checkServerIdentity: () => undefined,
  });
  await once(socket, "secureConnect");
  expect(await exchange(socket, request("/api/cloudrop/upload", ["app.example:443"]))).toBe(
    "200 https://app.example /api/cloudrop/upload",
  );
});

/** Sends one HTTP/2 request and answers "200 <origin> <path>" or the refusal's status. */
async function sendHttp2(port: number, headers: OutgoingHttpHeaders): Promise<string> {
  const client = connectHttp2(`http://127.0.0.1:${port}`);
  onTestFinished(() => void client.close());
  const stream = client.request({ ":path": "/api/cloudrop/upload", ...headers });
  stream.end();
  const [response] = await once(stream, "response");
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  return response[":status"] === 200 ? `200 ${text}` : String(response[":status"]);
}

// Node's HTTP/2 client always sends :authority and refuses an empty one, so "neither" is the HTTP/1.0 row above.
describe("toNodeHandler's request URL over HTTP/2", () => {
  it.for([
    {
      name: ":authority alone",
      headers: { ":authority": APP },
      answer: "200 http://app.example /api/cloudrop/upload",
    },
    {
      name: "the same host in :authority and host",
      headers: { ":authority": APP, host: APP },
      answer: "200 http://app.example /api/cloudrop/upload",
    },
    {
      name: "another host in host than in :authority",
      headers: { ":authority": APP, host: "proxy.example" },
      answer: "400",
    },
  ])("reads $name", async ({ headers, answer }) => {
    const port = await serveOnce(createHttp2Server(seen));
    expect(await sendHttp2(port, headers)).toBe(answer);
  });
});
