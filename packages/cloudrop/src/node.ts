// cloudrop/node: `http.createServer(toNodeHandler(cloudrop))`, or mount it in Express with
// `app.use(toNodeHandler(cloudrop))` before any body parser: a parser that reads the body first leaves nothing to read.
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
  socket: object;
}

/** The parts of Node's ServerResponse this adapter writes. */
export interface NodeResponse {
  /** True once the status line and headers have gone out: no other answer can be sent then. */
  readonly headersSent: boolean;
  /** `headers` alternates names and values, so a repeated header such as set-cookie keeps every value. */
  writeHead(status: number, headers: string[]): unknown;
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
 * iterator, so the rest is read and dropped here; without that the socket waits paused until Node times it out.
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

function toUrl(request: NodeRequest): URL {
  // No X-Forwarded-* header is trusted: behind a proxy, list the public origin in trustedOrigins instead.
  const scheme = "encrypted" in request.socket && request.socket.encrypted === true ? "https" : "http";
  const host = [request.headers.host].flat()[0] ?? "localhost";
  const base = URL.canParse(`${scheme}://${host}`) ? `${scheme}://${host}` : `${scheme}://localhost`;
  return new URL(request.originalUrl ?? request.url ?? "/", base);
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
    message: "The server could not handle the upload. Try again later.",
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
  response.writeHead(answer.status, [...answer.headers].flat());
  response.end(body);
}

/**
 * Never rejects: Node ignores the listener's promise, so a rejection would be an unhandled rejection that stops the
 * process. Node accepts requests a fetch Request cannot hold (TRACE, an absolute URL with port 99999) and clients that
 * hang up mid-body; those get a 400, or nothing once the socket is gone. A handler that throws, or answers with
 * something that cannot be sent, gets the client a 500 and is logged to the console.
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
