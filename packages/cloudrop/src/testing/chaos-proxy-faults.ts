// How the chaos proxy carries out one fault on one request. Requests are forwarded with every header verbatim, `Host`
// included, and none added or changed: SigV4 signs `host`, `x-amz-date`, `x-amz-content-sha256` and a presigned PUT's
// `content-length`, so a URL presigned for the proxy is only valid when the target sees exactly what the client sent
// (measured on RustFS 1.0.5, research-chaos.md §3.1).

import { type Agent, type ClientRequest, type IncomingMessage, request, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChaosEntry, ChaosFault } from "./chaos-proxy.ts";

export interface Exchange {
  req: IncomingMessage;
  res: ServerResponse;
  entry: ChaosEntry;
  target: URL;
  agent: Agent;
  /** Aborted when the client goes away. */
  signal: AbortSignal;
  /** Ends the log entry; only the first call counts. */
  finish(outcome: ChaosEntry["outcome"]): void;
  /** Logs the request as held until release() or stop() resets it. */
  hold(): void;
}

// Answers are not signed, so their hop-by-hop headers are dropped and Node frames the client's side itself.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding"]);

function write(stream: ClientRequest, chunk: Uint8Array): Promise<void> {
  // The callback fires once the bytes are handed to the socket, so a reset right after it leaves them delivered.
  return new Promise((resolve, reject) => stream.write(chunk, (error) => (error ? reject(error) : resolve())));
}

async function drain(ex: Exchange): Promise<void> {
  for await (const chunk of ex.req) ex.entry.bytesIn += (chunk as Buffer).length;
}

function reset(ex: Exchange, upstream: ClientRequest): false {
  ex.finish("reset");
  upstream.destroy();
  ex.req.socket.resetAndDestroy();
  return false;
}

/**
 * Forwards the body until `afterBytes` of it are read or it ends, whichever comes first, then resets both connections;
 * the answer is never forwarded. A request without a body therefore never reaches the target.
 */
async function cutBody(ex: Exchange, upstream: ClientRequest, afterBytes: number): Promise<false> {
  let left = afterBytes;
  if (left > 0) {
    for await (const chunk of ex.req) {
      ex.entry.bytesIn += (chunk as Buffer).length;
      const piece = (chunk as Buffer).subarray(0, left);
      left -= piece.length;
      // The reset follows either way, so a target that is down changes nothing for the client.
      await write(upstream, piece).catch(() => {});
      // Reset inside the loop: leaving it first destroys the request, which closes the connection instead.
      if (left === 0) return reset(ex, upstream);
    }
  }
  return reset(ex, upstream);
}

/** Forwards the body at most `bytesPerSecond` fast, in slices of a twentieth of a second, so progress stays smooth. */
async function paceBody(ex: Exchange, upstream: ClientRequest, bytesPerSecond: number): Promise<true> {
  const started = performance.now();
  const sliceSize = Number.isFinite(bytesPerSecond) ? Math.max(1, Math.floor(bytesPerSecond / 20)) : Infinity;
  let sent = 0;
  let failure: unknown;
  for await (const chunk of ex.req) {
    const bytes = chunk as Buffer;
    ex.entry.bytesIn += bytes.length;
    // After a failed write, keep reading: throwing inside the loop would destroy the request and its connection, and
    // the client would never get the 502.
    for (let at = 0; failure === undefined && at < bytes.length; at += sliceSize) {
      const piece = bytes.subarray(at, at + sliceSize);
      sent += piece.length;
      const due = started + (sent / bytesPerSecond) * 1000 - performance.now();
      if (due > 0) await sleep(due, undefined, { signal: ex.signal });
      failure = await write(upstream, piece).catch((error: unknown) => error ?? new Error("The write failed."));
    }
  }
  if (failure !== undefined) throw failure;
  upstream.end();
  return true;
}

function sendBody(ex: Exchange, upstream: ClientRequest, fault: ChaosFault | null): Promise<boolean> {
  if (fault?.kind === "reset") return cutBody(ex, upstream, fault.afterBytes);
  return paceBody(ex, upstream, fault?.kind === "throttle" ? fault.bytesPerSecond : Infinity);
}

/** Sends the target's answer to the client, cut or stripped as the fault says. */
async function relay(ex: Exchange, reply: IncomingMessage, fault: ChaosFault | null): Promise<void> {
  const status = reply.statusCode ?? 502;
  if (fault?.kind === "truncate" && fault.at === "beforeHeaders") {
    // The whole answer first, so the bucket has finished with the request; then no byte of it reaches the client.
    for await (const _ of reply);
    ex.finish("reset");
    ex.req.socket.resetAndDestroy();
    return;
  }
  const inBody = fault?.kind === "truncate";
  const strip = fault?.kind === "stripCors";
  const headers = Object.entries(reply.headers).filter(
    ([name]) =>
      !HOP_BY_HOP.has(name) &&
      !(strip && name.startsWith("access-control-")) &&
      // Without a length the answer is chunked, so a cut after the headers leaves even an empty body incomplete.
      !(inBody && name === "content-length"),
  );
  ex.res.writeHead(status, Object.fromEntries(headers));
  if (inBody) {
    ex.res.flushHeaders();
    ex.finish(status);
    reply.destroy();
    ex.req.socket.end();
    return;
  }
  await pipeline(reply, ex.res);
  ex.finish(status);
}

async function forward(ex: Exchange, fault: ChaosFault | null): Promise<void> {
  if (fault?.kind === "delay" && fault.when === "before") await sleep(fault.ms, undefined, { signal: ex.signal });
  const { req } = ex;
  const upstream = request(ex.target, {
    method: req.method,
    path: req.url,
    headers: req.rawHeaders,
    agent: ex.agent,
    signal: ex.signal,
  });
  const answered = new Promise<IncomingMessage>((resolve, reject) => {
    upstream.once("response", resolve);
    upstream.on("error", reject);
  });
  // A reset or the client's departure destroys the upstream on purpose; that rejection is expected, not a failure.
  answered.catch(() => {});
  if (!(await sendBody(ex, upstream, fault))) return;
  const reply = await answered;
  if (fault?.kind === "delay" && fault.when === "after") await sleep(fault.ms, undefined, { signal: ex.signal });
  await relay(ex, reply, fault);
}

function answer(ex: Exchange, fault: Extract<ChaosFault, { kind: "answer" }>): void {
  const headers: Record<string, string> = { ...fault.headers };
  const origin = ex.req.headers.origin;
  if (fault.cors !== false && origin !== undefined) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
    if (fault.exposeRetryAfter) headers["access-control-expose-headers"] = "Retry-After";
  }
  ex.finish(fault.status);
  ex.res.writeHead(fault.status, headers).end(fault.body);
}

/** Carries out the fault, or forwards untouched when there is none; resolves once the request is answered or held. */
export async function runFault(ex: Exchange, fault: ChaosFault | null): Promise<void> {
  switch (fault?.kind) {
    case "close":
      await drain(ex);
      ex.finish("closed");
      ex.req.socket.destroy();
      return;
    case "blackhole":
      // Never forwarded: the target does not learn of the request.
      ex.hold();
      return drain(ex);
    case "answer":
      // Read the whole body first, as a bucket does, so the client's request completes before the answer.
      await drain(ex);
      return answer(ex, fault);
    default:
      return forward(ex, fault);
  }
}
