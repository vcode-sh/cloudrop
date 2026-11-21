// Which of a bucket's CORS rules answers a browser's request, decided as the storage service decides it: the first
// rule, in stored order, that matches the whole request, and that rule alone (measured on R2, 2026-11-21:
// docs/research/r2-spike-findings.md, "Which CORS rule answers when several match"; S3 documents the same).
// api.checkBucket and the cloudrop command share this file, so they can never disagree (M11-R170).

import type { BucketCorsRule } from "../storage/driver.ts";

/** The headers the server signs into a single PUT (presign.ts, spec §7.5). A part's PUT carries none. */
export const UPLOAD_HEADERS: readonly string[] = [
  "content-type",
  "content-disposition",
  "if-none-match",
  "x-amz-meta-cloudrop-id",
];

/** The answer headers a page reads, or that checkBucket promises it can: a rule that answers uploads exposes them. */
export const READ_HEADERS: readonly string[] = ["ETag", "Retry-After"];

/**
 * The preflights a browser sends before cloudrop's PUTs. A preflight lists the request's headers that are not
 * CORS-safelisted (Fetch standard), so `content-type` is listed unless the file's type is one a form can send, such as
 * text/plain, and `content-length` never is: the browser sets it. A part's body is a slice of the file, which has no
 * type, so its preflight lists nothing. The server signs no checksum header into either PUT.
 */
const PREFLIGHTS: readonly (readonly string[])[] = [
  UPLOAD_HEADERS,
  UPLOAD_HEADERS.filter((header) => header !== "content-type"),
  [],
];

export interface CorsRequest {
  /** The page's origin, as the browser sends it. */
  origin: string;
  method: string;
  /** What a preflight lists in Access-Control-Request-Headers. The request itself is matched without any. */
  headers?: readonly string[];
}

/** A pattern holds at most one "*", which stands for any text: "https://*.example.com", "x-amz-meta-*", "*". */
function matches(pattern: string, value: string): boolean {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === value;
  const head = pattern.slice(0, star);
  const tail = pattern.slice(star + 1);
  return value.length >= head.length + tail.length && value.startsWith(head) && value.endsWith(tail);
}

/**
 * Whether `rule` matches the whole request: its origin exactly as written or by pattern (R2: "Origin values without a
 * wildcard must match the request's Origin header exactly"), its method, and every listed header, whose names compare
 * without case as HTTP's do.
 */
export function answers(rule: BucketCorsRule, { origin, method, headers = [] }: CorsRequest): boolean {
  const allowed = rule.allowedHeaders.map((header) => header.toLowerCase());
  return (
    rule.allowedOrigins.some((pattern) => matches(pattern, origin)) &&
    rule.allowedMethods.some((each) => each.toUpperCase() === method) &&
    headers.every((header) => allowed.some((pattern) => matches(pattern, header.toLowerCase())))
  );
}

/** The position of the rule the service answers `request` with, or -1 when no rule matches it. */
export const answeringRule = (rules: readonly BucketCorsRule[], request: CorsRequest): number =>
  rules.findIndex((rule) => answers(rule, request));

/**
 * Those of `headers` a page cannot read from an answer of `rule`. A rule that exposes "*" hides none: cloudrop's PUTs
 * carry no credentials, and for such a request the Fetch standard reads "*" as every header.
 */
export function hidden(rule: BucketCorsRule, headers: readonly string[] = READ_HEADERS): string[] {
  const exposed = new Set(rule.exposeHeaders.map((header) => header.toLowerCase()));
  return exposed.has("*") ? [] : headers.filter((header) => !exposed.has(header.toLowerCase()));
}

export interface UploadAnswer {
  /** True when a rule answers every preflight of cloudrop's PUTs; otherwise the browser blocks an upload. */
  allowed: boolean;
  /** The position of the rule that answers the PUT itself, whose exposed headers a page gets; -1 when none does. */
  index: number;
}

/** How the bucket answers a page on `origin` that uploads with cloudrop. */
export function uploadAnswer(rules: readonly BucketCorsRule[], origin: string): UploadAnswer {
  return {
    allowed: PREFLIGHTS.every((headers) => answeringRule(rules, { origin, method: "PUT", headers }) >= 0),
    index: answeringRule(rules, { origin, method: "PUT" }),
  };
}

// A rule ID comes from the bucket. Control characters in it could drive a terminal (escape sequences) or split a log
// line in two, so they are written as \u escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A rule's ID in double quotes, safe to print. */
export const quotedId = (id: string): string =>
  `"${id.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;

/** `rule "a"`, or `rule 2 (no ID)` by its place among the bucket's rules, counted from 1. */
export const ruleLabel = (rule: { id?: string }, index: number): string =>
  rule.id ? `rule ${quotedId(rule.id)}` : `rule ${index + 1} (no ID)`;
