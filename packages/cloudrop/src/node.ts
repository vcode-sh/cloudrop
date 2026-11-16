// cloudrop/node: `http.createServer(toNodeHandler(cloudrop))`, or mount it in Express with
// `app.use("/api/cloudrop", toNodeHandler(cloudrop))` before any body parser: a parser that reads the body first leaves
// nothing to read.
// The library compiles without Node's types (tsconfig `types: []`), so the two Node objects are described by the
// members used here; node.test.ts proves real IncomingMessage and ServerResponse values fit them.

import { configError } from "./errors.ts";
import { type ErrorResponse, MAX_BODY_BYTES, type RequestHandler } from "./protocol/types.ts";

export type { RequestHandler } from "./protocol/types.ts";

/** The parts of Node's IncomingMessage this adapter reads. */
export interface NodeRequest extends AsyncIterable<Uint8Array> {
  method?: string;
  url?: string;
  /** Express and Connect move the mount path out of `url` into this. */
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Names and values in the order they arrived; the only place a second Host header still shows. */
  rawHeaders: string[];
  socket: object;
}

/** The parts of Node's ServerResponse this adapter writes. */
export interface NodeResponse {
  /** True once the status line and headers have gone out: no other answer can be sent then. */
  readonly headersSent: boolean;
  /** An object of headers is the form every `writeHead` wrapper understands; set-cookie carries a list of values. */
  writeHead(status: number, headers: Record<string, string | string[]>): unknown;
  end(body: Uint8Array): unknown;
}

/** Reads and drops whatever is left, so the connection is free for the next request. */
async function discardRest(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  let chunk = await iterator.next();
  while (!chunk.done) chunk = await iterator.next();
}

/**
 * Reads at most one chunk past the cap, so the handler sees an oversized body and answers 413. The iterator is not
 * closed, since that would destroy the socket before the answer is sent. Node does not drop a body that has an
 * iterator, so the rest is read and dropped here; without that the socket waits paused until Node times it out. A
 * client that never stops sending is cut off by the server's own `requestTimeout` (300 seconds by default in Node).
 */
async function readBody(request: NodeRequest): Promise<Uint8Array<ArrayBuffer>> {
  const iterator = request[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length <= MAX_BODY_BYTES) {
    const chunk = await iterator.next();
    if (chunk.done) break;
    chunks.push(chunk.value);
    length += chunk.value.length;
  }
  // A client that hangs up mid-way rejects the iterator: nothing is left to drop then.
  if (length > MAX_BODY_BYTES) discardRest(iterator).catch(() => undefined);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

// The origin a Host or ":authority" value names, or null unless the value is just a host and an optional port.
function hostOrigin(scheme: string, value: string | string[] | undefined): string | null {
  // The URL parser would read userinfo as credentials and "/", "\", "?" or "#" as the start of a path.
  if (typeof value !== "string" || /[@/\\?#]/.test(value)) return null;
  return URL.parse(`${scheme}://${value}`)?.origin ?? null;
}

// The origin of the host the request names: Host, or HTTP/2's ":authority" pseudo-header. Null, so the request is
// refused, when there is none, when Host is sent twice (RFC 9112 §3.2), when the two name different hosts (RFC 9113
// §8.3.1), or when either is more than a host and port. No origin is invented for a request that names none.
// (Line comments: the build keeps doc blocks in the published file, and these functions are private.)
function requestOrigin(request: NodeRequest, scheme: string): string | null {
  // rawHeaders alternates names and values.
  const hosts = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "host");
  if (hosts.length > 1) return null;
  const { host, ":authority": authority } = request.headers;
  const named = [host, authority].filter((value) => value !== undefined);
  const origins = new Set(named.map((value) => hostOrigin(scheme, value)));
  return origins.size === 1 ? ([...origins][0] ?? null) : null;
}

function toUrl(request: NodeRequest): URL {
  // No X-Forwarded-* header is trusted: behind a proxy, list the public origin in trustedOrigins instead.
  const scheme = "encrypted" in request.socket && request.socket.encrypted === true ? "https" : "http";
  const base = requestOrigin(request, scheme);
  if (base === null) throw new TypeError("The request names no single valid host.");
  const target = request.originalUrl ?? request.url ?? "/";
  // Only a path may follow the Host header's origin: "//other.host/…" or an absolute URL would replace that origin,
  // and a caller could then make any Origin look same-origin.
  if (!target.startsWith("/")) throw new TypeError("The request target is not a path.");
  return new URL(`${base}${target}`);
}

async function toRequest(request: NodeRequest): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    // HTTP/2 pseudo-headers (":authority") are not header names a Request accepts.
    if (name.startsWith(":") || value === undefined) continue;
    for (const item of [value].flat()) headers.append(name, item);
  }
  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
  return new Request(toUrl(request), { method, headers, body });
}

const UNREADABLE: ErrorResponse = {
  error: {
    code: "INVALID_INPUT",
    message: "The request could not be read. Check its method and URL, then send it again.",
    retryable: false,
  },
};

// The same words cloudrop's own handler uses for SERVER_ERROR, so a client sees one message for it.
const FAILED: ErrorResponse = {
  error: {
    code: "SERVER_ERROR",
    message: "The server could not handle the upload. Contact the site owner if this keeps happening.",
    retryable: false,
  },
};

function json(body: ErrorResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** The body is read in full before anything is written, so an answer that fails mid-read can still become a 500. */
async function send(response: NodeResponse, answer: Response): Promise<void> {
  const body = new Uint8Array(await answer.arrayBuffer());
  const headers: Record<string, string | string[]> = Object.fromEntries(answer.headers);
  // Headers joins repeated values with a comma, which breaks cookies: they are sent one by one.
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  response.writeHead(answer.status, headers);
  response.end(body);
}

/**
 * Never rejects: Node ignores the listener's promise, so a rejection would be an unhandled rejection that stops the
 * process. Node accepts requests a fetch Request cannot hold (TRACE, an absolute URL with port 99999), requests that
 * name no single valid host, and clients that hang up mid-body; those get a 400, or nothing once the socket is gone. A
 * handler that throws, or answers with something that cannot be sent, gets the client a 500 and is logged to the
 * console.
 */
export function toNodeHandler(
  cloudrop: RequestHandler,
): (request: NodeRequest, response: NodeResponse) => Promise<void> {
  // Plain JavaScript can pass anything here.
  if (typeof (cloudrop as Partial<RequestHandler> | null)?.handler !== "function") {
    throw configError(
      "toNodeHandler needs the cloudrop server, an object with a handler function: pass what createCloudrop returned.",
    );
  }
  return async (request, response) => {
    try {
      const incoming = await toRequest(request).catch(() => null);
      await send(response, incoming ? await cloudrop.handler(incoming) : json(UNREADABLE, 400));
    } catch (error) {
      console.error(
        "cloudrop/node: the handler threw or gave an answer that could not be sent; answering 500 instead.",
        error,
      );
      // When even this fails, the socket is gone and nobody is left to answer.
      if (!response.headersSent) await send(response, json(FAILED, 500)).catch(() => undefined);
    }
  };
}
