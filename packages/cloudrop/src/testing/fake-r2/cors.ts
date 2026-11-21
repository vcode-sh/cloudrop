// How the fake answers a browser: preflights, and the CORS headers of a request it answers, as measured on R2
// (docs/research/r2-spike-findings.md: Q8, "Bad checksum, gone upload and throttling from a browser" and "Which CORS
// rule answers when several match", 2026-11-21). The first stored rule that matches the whole request answers, alone.
// It shares no code with src/server/bucket-cors.ts on purpose: a test that sends a browser's requests here checks
// that file against the measurement, not against itself.

import { xmlBlocks, xmlValue, xmlValues } from "../../storage/xml.ts";
import type { FakeBucket } from "./bucket.ts";
import { errorResponse } from "./responses.ts";

/** A stored origin or header name as a pattern: "*" stands for any text. */
const pattern = (written: string, flags = ""): RegExp =>
  new RegExp(
    `^${written
      .split("*")
      .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    flags,
  );

/** The XML of the rule that answers: the first that allows the origin, the method and every listed header. */
function ruleFor(bucket: FakeBucket, origin: string, method: string, headers: string[]): string | undefined {
  return xmlBlocks(bucket.config?.cors ?? "", "CORSRule").find(
    (rule) =>
      xmlValues(rule, "AllowedOrigin").some((allowed) => pattern(allowed).test(origin)) &&
      xmlValues(rule, "AllowedMethod").includes(method) &&
      headers.every((header) => xmlValues(rule, "AllowedHeader").some((allowed) => pattern(allowed, "i").test(header))),
  );
}

/** R2 answers "*" for a rule that allows any origin, and the request's origin otherwise. */
const allowOrigin = (rule: string, origin: string): string =>
  xmlValues(rule, "AllowedOrigin").includes("*") ? "*" : origin;

/**
 * The answer to an OPTIONS request. A match is 204 with the rule's methods and max age and the headers that were asked
 * for; anything else is 403 without a CORS header. The 403's code was read only on a bucket without rules.
 */
export function preflight(bucket: FakeBucket, request: Request): Response {
  const origin = request.headers.get("origin") ?? "";
  const asked = request.headers.get("access-control-request-headers");
  const headers = asked ? asked.split(",").map((header) => header.trim()) : [];
  const rule = ruleFor(bucket, origin, request.headers.get("access-control-request-method") ?? "", headers);
  if (rule === undefined) return errorResponse(403, "Unauthorized", "CORS not configured for this bucket");
  const maxAge = xmlValue(rule, "MaxAgeSeconds");
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": allowOrigin(rule, origin),
      "access-control-allow-methods": xmlValues(rule, "AllowedMethod").join(", "),
      ...(asked ? { "access-control-allow-headers": headers.join(", ") } : {}),
      ...(maxAge ? { "access-control-max-age": maxAge } : {}),
    },
  });
}

/**
 * The CORS headers of an answer to `request`, from the first rule that allows its origin and method; none when no
 * rule does or the request names no origin. The request's own headers play no part: a browser lists them only in the
 * preflight.
 */
export function corsHeaders(bucket: FakeBucket, request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const rule = origin === null ? undefined : ruleFor(bucket, origin, request.method, []);
  if (origin === null || rule === undefined) return {};
  const exposed = xmlValues(rule, "ExposeHeader");
  return {
    "access-control-allow-origin": allowOrigin(rule, origin),
    ...(exposed.length > 0 ? { "access-control-expose-headers": exposed.join(",") } : {}),
  };
}
