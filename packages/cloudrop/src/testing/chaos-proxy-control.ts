// The chaos proxy's JSON control endpoint, for tests that run in another process than the proxy (the browser lane's
// Playwright tests set rules for the proxy the lane script started). Loopback only.

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChaosProxy, ChaosRandom, ChaosRule } from "./chaos-proxy.ts";

export async function listen(server: Server, port: number): Promise<string> {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Closes the server and every connection to it, busy ones included. */
export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

class BadRequest extends Error {}

type Route = (proxy: ChaosProxy, body: unknown) => unknown;

const routes: Record<string, Route> = {
  "POST /rules": (proxy, body) => {
    if (!Array.isArray(body)) throw new BadRequest("POST /rules takes a JSON array of rules.");
    proxy.set(body as ChaosRule[]);
  },
  "POST /random": (proxy, body) => {
    if (typeof body !== "object") throw new BadRequest("POST /random takes a JSON object, or null to turn it off.");
    proxy.random(body as ChaosRandom | null);
  },
  "POST /release": (proxy) => proxy.release(),
  "GET /log": (proxy) => proxy.log(),
  "POST /clear-log": (proxy) => proxy.clearLog(),
};

function parse(text: string): unknown {
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new BadRequest("The body is not valid JSON.");
  }
}

async function serve(proxy: ChaosProxy, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = routes[`${req.method} ${new URL(req.url ?? "/", "http://control").pathname}`];
  let text = "";
  for await (const chunk of req) text += chunk;
  if (!route) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "No such control route." }));
    return;
  }
  try {
    const result = route(proxy, parse(text));
    if (result === undefined) res.writeHead(204).end();
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  } catch (error) {
    if (!(error instanceof BadRequest)) throw error;
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
  }
}

export async function startControl(proxy: ChaosProxy): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => void serve(proxy, req, res));
  return { url: await listen(server, 0), server };
}
