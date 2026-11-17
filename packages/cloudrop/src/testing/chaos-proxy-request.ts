// What the chaos proxy knows about one request: who sent it, which S3 operation it is, and which rule or random draw
// faults it. Only the method, the names of query parameters, the part number and the presence of two headers are read;
// values that carry signatures or credentials are never kept.

import type { IncomingMessage } from "node:http";
import { SLOW_DOWN } from "./chaos-bodies.ts";
import type { ChaosFault, ChaosMatch, ChaosOperation, ChaosRandom, ChaosRule } from "./chaos-proxy.ts";

export interface RequestIdentity {
  kind: "presigned" | "server" | "preflight";
  operation: ChaosOperation;
  part: number | undefined;
  label: string;
}

// Per method, the first listed query parameter the request has names its operation; null is the fallback. The server
// reads the bucket's CORS and lifecycle settings at start-up: those GETs are not object reads.
const OPERATIONS: Record<string, [string | null, ChaosOperation][]> = {
  PUT: [
    ["partNumber", "UploadPart"],
    [null, "PutObject"],
  ],
  POST: [
    ["uploads", "CreateMultipartUpload"],
    ["uploadId", "CompleteMultipartUpload"],
  ],
  GET: [
    ["uploadId", "ListParts"],
    ["uploads", "ListMultipartUploads"],
    ["list-type", "ListObjectsV2"],
    ["cors", "Other"],
    ["lifecycle", "Other"],
    [null, "GetObject"],
  ],
  HEAD: [[null, "HeadObject"]],
  DELETE: [
    ["uploadId", "AbortMultipartUpload"],
    [null, "DeleteObject"],
  ],
  OPTIONS: [[null, "Options"]],
};

function operationOf(method: string, query: URLSearchParams, copies: boolean): ChaosOperation {
  // A copy (x-amz-copy-source) is a PUT, but neither an upload nor a part of one.
  if (method === "PUT" && copies) return "Other";
  const found = OPERATIONS[method]?.find(([name]) => name === null || query.has(name));
  return found?.[1] ?? "Other";
}

function labelOf(method: string, kind: RequestIdentity["kind"], operation: ChaosOperation, part: number | undefined) {
  if (kind === "preflight") return "OPTIONS";
  if (kind === "presigned" && operation === "UploadPart") return `PUT part ${part}`;
  if (kind === "presigned" && operation === "PutObject") return "PUT object";
  return operation === "Other" ? `Other ${method}` : operation;
}

export function identify(req: IncomingMessage): RequestIdentity {
  const method = req.method ?? "GET";
  const query = new URL(req.url ?? "/", "http://proxy").searchParams;
  const operation = operationOf(method, query, req.headers["x-amz-copy-source"] !== undefined);
  // Anything not presigned is the server's: its storage calls carry an Authorization header.
  const kind = method === "OPTIONS" ? "preflight" : query.has("X-Amz-Signature") ? "presigned" : "server";
  const partNumber = Number(query.get("partNumber"));
  const part = operation === "UploadPart" && Number.isInteger(partNumber) ? partNumber : undefined;
  return { kind, operation, part, label: labelOf(method, kind, operation, part) };
}

function matches(match: ChaosMatch, request: RequestIdentity): boolean {
  // A preflight only meets a rule written for it, so it never counts as "the nth PUT".
  if (request.kind === "preflight" && match.operation !== "Options") return false;
  if (match.kind !== undefined && match.kind !== request.kind) return false;
  if (match.operation !== undefined && match.operation !== request.operation) return false;
  return match.part === undefined || match.part === request.part;
}

export interface CountedRule {
  rule: ChaosRule;
  seen: number;
}

/** Counts the request against every rule it matches and returns the first rule whose occurrence it is. */
export function ruleFault(rules: readonly CountedRule[], request: RequestIdentity): ChaosFault | null {
  let fault: ChaosFault | null = null;
  for (const counted of rules) {
    if (!matches(counted.rule.match, request)) continue;
    counted.seen += 1;
    const nth = counted.rule.match.nth ?? 1;
    if (fault === null && (nth === "every" || nth === counted.seen)) fault = counted.rule.fault;
  }
  return fault;
}

/** mulberry32: a small seeded generator, so a soak run replays from its printed seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One draw per request: a reset somewhere in the body, a 503 that browsers can read, or latency before forwarding. */
export function randomFault(options: ChaosRandom, next: () => number, bodySize: number): ChaosFault | null {
  const draw = next();
  if (draw < options.resetRate) return { kind: "reset", afterBytes: Math.floor(next() * bodySize) };
  if (draw < options.resetRate + options.busyRate) return { kind: "answer", status: 503, body: SLOW_DOWN, cors: true };
  const [min, max] = options.latencyMs;
  const ms = min + Math.floor(next() * (max - min + 1));
  return ms > 0 ? { kind: "delay", ms, when: "before" } : null;
}
