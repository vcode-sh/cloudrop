// A fault-injecting HTTP proxy for the chaos lanes, between the server's s3() storage and RustFS. The server's S3
// endpoint is the proxy, so presigned URLs name it and stay valid through it; rules fault single requests, either
// presigned ones from the client or the server's own storage calls. Test-only: it needs node:http, so the library's
// tsconfig.json excludes it and tsconfig.test.json types it. Design: docs/superpowers/specs/2026-11-17-chaos-design.md §2.

import { Agent, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { close, listen, startControl } from "./chaos-proxy-control.ts";
import { type Exchange, runFault } from "./chaos-proxy-faults.ts";
import { type CountedRule, identify, randomFault, ruleFault, seededRandom } from "./chaos-proxy-request.ts";

export type ChaosOperation =
  | "PutObject"
  | "UploadPart"
  | "CreateMultipartUpload"
  | "CompleteMultipartUpload"
  | "AbortMultipartUpload"
  | "ListParts"
  | "HeadObject"
  | "GetObject"
  | "DeleteObject"
  | "ListObjectsV2"
  | "ListMultipartUploads"
  | "Options"
  | "Other";

export interface ChaosMatch {
  /** presigned: X-Amz-Signature in the query; server: anything else but a preflight (its calls carry Authorization). */
  kind?: "presigned" | "server";
  /** A preflight matches only a rule naming "Options", so it never counts as the nth PUT. */
  operation?: ChaosOperation;
  /** UploadPart's partNumber. */
  part?: number;
  /** 1-based among this rule's matches, or every match; default 1. */
  nth?: number | "every";
}

export type ChaosFault =
  | { kind: "reset"; afterBytes: number }
  | { kind: "close" }
  | { kind: "blackhole" }
  | { kind: "delay"; ms: number; when: "before" | "after" }
  | { kind: "throttle"; bytesPerSecond: number }
  | {
      kind: "answer";
      status: number;
      body?: string;
      headers?: Record<string, string>;
      /**
       * Default true: when the request has an Origin, echo it in Access-Control-Allow-Origin, as a bucket's CORS rule
       * would. false: no CORS headers, an opaque refusal in a browser.
       */
      cors?: boolean;
      /** With the CORS headers, Access-Control-Expose-Headers: Retry-After. */
      exposeRetryAfter?: boolean;
    }
  /** beforeHeaders: the target answers in full, the client gets a reset; inBody: status and headers, then a cut. */
  | { kind: "truncate"; at: "beforeHeaders" | "inBody" }
  | { kind: "stripCors" };

export interface ChaosRule {
  match: ChaosMatch;
  fault: ChaosFault;
}

export interface ChaosEntry {
  /** "PUT part 2", "PUT object", "OPTIONS", or the server's operation name such as "ListParts". */
  label: string;
  kind: "presigned" | "server" | "preflight";
  fault: ChaosFault["kind"] | null;
  /**
   * The status the client got; "reset" or "closed" by the proxy; "held" by a black hole, until release() or stop();
   * "aborted" when the client closed the connection first, black-holed or not; "error" when the target failed.
   */
  outcome: number | "reset" | "closed" | "held" | "aborted" | "error";
  /** Request-body bytes the proxy read from the client. */
  bytesIn: number;
  /** Milliseconds since the proxy started. */
  startMs: number;
  endMs: number | null;
  /** Presigned PUTs in flight when this request started. */
  inFlightAtStart: number;
}

/**
 * Faults requests no rule claims, one draw each, preflights excepted; for the soak. It draws from its own generator
 * seeded with `seed`, never Math.random, which the chaos lanes stub to 0.
 */
export interface ChaosRandom {
  seed: number;
  resetRate: number;
  busyRate: number;
  latencyMs: [number, number];
}

export interface ChaosProxy {
  /** http://127.0.0.1:<port> */
  readonly url: string;
  /** Replaces the rules and their nth counters. */
  set(rules: readonly ChaosRule[]): void;
  random(options: ChaosRandom | null): void;
  /** Answers every black-holed request with a reset. */
  release(): void;
  /** In start order; only requests that have ended or are held. */
  log(): readonly ChaosEntry[];
  clearLog(): void;
  /** Closes the server and every open socket. */
  stop(): Promise<void>;
}

/** `control: true` adds a JSON control endpoint on a second loopback port, for tests in another process. */
export async function startChaosProxy(
  target: string,
  options: { port?: number; control?: boolean } = {},
): Promise<ChaosProxy & { controlUrl?: string }> {
  const targetUrl = new URL(target);
  const agent = new Agent({ keepAlive: true });
  const started = performance.now();
  const now = () => performance.now() - started;
  let rules: CountedRule[] = [];
  let chaos: { options: ChaosRandom; next: () => number } | null = null;
  let entries: ChaosEntry[] = [];
  const held = new Map<ChaosEntry, () => void>();
  let inFlight = 0;

  function faultFor(req: IncomingMessage, request: ReturnType<typeof identify>) {
    const fromRule = ruleFault(rules, request);
    if (fromRule || !chaos || request.kind === "preflight") return fromRule;
    return randomFault(chaos.options, chaos.next, Number(req.headers["content-length"]) || 0);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = identify(req);
    const countsInFlight = request.kind === "presigned" && req.method === "PUT";
    const fault = faultFor(req, request);
    const entry: ChaosEntry = {
      label: request.label,
      kind: request.kind,
      fault: fault?.kind ?? null,
      outcome: "error",
      bytesIn: 0,
      startMs: now(),
      endMs: null,
      inFlightAtStart: inFlight,
    };
    if (countsInFlight) inFlight += 1;
    const abort = new AbortController();
    let logged = false;
    const finish = (outcome: ChaosEntry["outcome"]) => {
      if (entry.endMs !== null) return;
      Object.assign(entry, { outcome, endMs: now() });
      if (!logged) entries.push(entry);
      if (countsInFlight) inFlight -= 1;
      held.delete(entry);
    };
    const hold = () => {
      entry.outcome = "held";
      entries.push(entry);
      logged = true;
      held.set(entry, () => {
        finish("reset");
        req.socket.resetAndDestroy();
      });
    };
    res.on("close", () => {
      if (res.writableFinished) return;
      abort.abort();
      finish("aborted");
    });
    const exchange: Exchange = { req, res, entry, target: targetUrl, agent, signal: abort.signal, finish, hold };
    try {
      await runFault(exchange, fault);
    } catch {
      // A client that left was already logged as aborted by the "close" handler, which runs first.
      finish("error");
      if (res.headersSent || res.destroyed) res.destroy();
      else res.writeHead(502, { "content-type": "text/plain" }).end("The chaos proxy could not reach its target.");
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  const proxy: ChaosProxy = {
    url: await listen(server, options.port ?? 0),
    set(list) {
      rules = list.map((rule) => ({ rule, seen: 0 }));
    },
    random(given) {
      chaos = given && { options: given, next: seededRandom(given.seed) };
    },
    release() {
      for (const reset of held.values()) reset();
    },
    log: () => entries.toSorted((a, b) => a.startMs - b.startMs).map((entry) => ({ ...entry })),
    clearLog() {
      entries = [];
    },
    stop: async () => {
      proxy.release();
      agent.destroy();
      await Promise.all([close(server), control && close(control.server)]);
    },
  };
  const control = options.control ? await startControl(proxy) : undefined;
  return control ? { ...proxy, controlUrl: control.url } : proxy;
}
