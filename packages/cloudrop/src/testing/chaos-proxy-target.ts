// The two ends of the chaos proxy's own tests: a target that records what reached it, standing in for RustFS, and a
// client that reports what it saw, the error included, instead of throwing.

import { Agent, createServer, type IncomingHttpHeaders, request } from "node:http";
import type { Socket } from "node:net";
import { onTestFinished, vi } from "vitest";
import { close, listen } from "./chaos-proxy-control.ts";

export interface Arrival {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** Names and values as they came over the wire, in order and spelling. */
  rawHeaders: string[];
  body: Buffer;
  /** The whole body arrived. */
  complete: boolean;
  /** The target has sent its whole answer. */
  answered: boolean;
  /** The proxy hung up before the target answered. */
  abandoned: boolean;
  /** When the headers arrived, from performance.now(). */
  atMs: number;
}

export interface Target {
  url: string;
  arrivals: Arrival[];
  /** Connections to the target still open. */
  connections(): number;
}

/**
 * Answers 200 with "received <n>" once the body is in, as a bucket answers a PUT, with CORS headers like RustFS's rule.
 * A path starting with /hold is never answered; one starting with /drip is answered in two writes 10 ms apart.
 */
export async function startTarget(): Promise<Target> {
  const arrivals: Arrival[] = [];
  const server = createServer((req, res) => {
    const arrival: Arrival = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      body: Buffer.alloc(0),
      complete: false,
      answered: false,
      abandoned: false,
      atMs: performance.now(),
    };
    arrivals.push(arrival);
    req.on("data", (chunk: Buffer) => {
      arrival.body = Buffer.concat([arrival.body, chunk]);
    });
    // An abandoned body ends in an "aborted" error; `complete` and `abandoned` record it.
    req.on("error", () => {});
    res.on("finish", () => {
      arrival.answered = true;
    });
    res.on("close", () => {
      arrival.abandoned = !res.writableFinished;
    });
    req.on("end", () => {
      arrival.complete = true;
      if (req.url?.startsWith("/hold")) return;
      res.writeHead(200, {
        etag: '"etag-1"',
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "ETag",
      });
      const answer = `received ${arrival.body.length}`;
      if (!req.url?.startsWith("/drip")) return void res.end(answer);
      res.write(answer.slice(0, 4));
      setTimeout(() => res.end(answer.slice(4)), 10);
    });
  });
  const url = await listen(server, 0);
  onTestFinished(() => close(server));
  const open = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
  return { url, arrivals, connections: () => open.size };
}

export interface Seen {
  status: number | null;
  headers: IncomingHttpHeaders;
  body: string;
  /** "<code>: <message>" of the error the client got, or null. */
  error: string | null;
  elapsedMs: number;
}

export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

/** A keep-alive client, as the server's fetch and browsers are; destroyed when the test finishes. */
export function client(): (url: string, options?: SendOptions) => Promise<Seen> {
  const agent = new Agent({ keepAlive: true });
  onTestFinished(() => agent.destroy());
  return (url, options = {}) =>
    new Promise((resolve) => {
      const started = performance.now();
      const seen: Seen = { status: null, headers: {}, body: "", error: null, elapsedMs: 0 };
      let settled = false;
      const done = (error?: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (error) seen.error = `${error.code}: ${error.message}`;
        seen.elapsedMs = performance.now() - started;
        resolve(seen);
      };
      const { method = "PUT", headers, body, signal } = options;
      const req = request(url, { method, headers, agent, signal }, (res) => {
        seen.status = res.statusCode ?? null;
        seen.headers = res.headers;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          seen.body += chunk;
        });
        res.on("end", () => done());
        res.on("error", done);
      });
      req.on("error", done);
      req.end(body);
    });
}

/** Deterministic bytes, so a forwarded body is compared byte for byte. */
export function bytes(size: number): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + 7) % 251));
}

/** Polls every millisecond, so a row waits for the proxy no longer than it must. */
export const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { interval: 1, timeout: 1000 });
