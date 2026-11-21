import { describe, expect, it } from "vitest";
import type { BucketCorsRule } from "../storage/driver.ts";
import { answeringRule, hidesRetryAfter, ruleLabel, uploadAnswer } from "./bucket-cors.ts";

const ORIGIN = "https://app.example.com";
const rule = (fields: Partial<BucketCorsRule>): BucketCorsRule => ({
  allowedOrigins: [ORIGIN],
  allowedMethods: ["PUT"],
  allowedHeaders: [],
  exposeHeaders: [],
  ...fields,
});

// The two rules and the four orders measured on R2 on 2026-11-21 (r2-spike-findings.md, "Which CORS rule answers when
// several match"). Each expected position is that table's cell: A or B by where it stood.
const A = rule({ allowedMethods: ["GET", "PUT", "HEAD"], allowedHeaders: ["*"], exposeHeaders: ["x-rule-a"] });
const B = rule({ allowedMethods: ["GET", "PUT"], allowedHeaders: ["content-type"], exposeHeaders: ["ETag"] });
const anyOrigin = { ...A, allowedOrigins: ["*"] };

describe("the rule that answers a request", () => {
  it.each([
    { name: "A, B", rules: [A, B], answer: [0, 0, 0, 0] },
    { name: "B, A", rules: [B, A], answer: [0, 1, 1, 0] },
    { name: "A for any origin, B", rules: [anyOrigin, B], answer: [0, 0, 0, 0] },
    { name: "B, A for any origin", rules: [B, anyOrigin], answer: [0, 1, 1, 0] },
  ])("is the first that matches the whole request, stored as $name", ({ rules, answer }) => {
    expect([
      answeringRule(rules, { origin: ORIGIN, method: "PUT", headers: ["content-type"] }),
      answeringRule(rules, { origin: ORIGIN, method: "PUT", headers: ["x-other"] }),
      answeringRule(rules, { origin: ORIGIN, method: "HEAD" }),
      answeringRule(rules, { origin: ORIGIN, method: "GET" }),
    ]).toEqual(answer);
  });

  // R2's documentation: "https://*.example.com matches both https://api.example.com and https://a.b.example.com, but
  // not https://example.com", and an origin without a wildcard "must match the request's Origin header exactly".
  it.each([
    { name: "a pattern over one label", pattern: "https://*.example.com", origin: "https://api.example.com", at: 0 },
    { name: "a pattern over two labels", pattern: "https://*.example.com", origin: "https://a.b.example.com", at: 0 },
    { name: "a pattern and the bare domain", pattern: "https://*.example.com", origin: "https://example.com", at: -1 },
    { name: "an origin written in another case", pattern: "https://App.example.com", origin: ORIGIN, at: -1 },
    { name: "another port", pattern: "http://localhost:3000", origin: "http://localhost:5173", at: -1 },
  ])("matches the origin as written: $name", ({ pattern, origin, at }) => {
    expect(answeringRule([rule({ allowedOrigins: [pattern] })], { origin, method: "PUT" })).toBe(at);
  });

  it("matches header names without case, and a pattern for the rest of a name", () => {
    const rules = [rule({ allowedHeaders: ["Content-Type", "x-amz-meta-*"] })];
    const preflight = (headers: string[]) => answeringRule(rules, { origin: ORIGIN, method: "PUT", headers });
    expect([
      preflight(["content-type", "x-amz-meta-cloudrop-id"]),
      preflight(["content-type", "if-none-match"]),
    ]).toEqual([0, -1]);
  });
});

describe("how a bucket answers cloudrop's uploads", () => {
  const signed = ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"];

  it("needs a rule for the PUT of a part, which lists no header, and for a single PUT's four", () => {
    const partsOnly = rule({ id: "parts" });
    const single = rule({ id: "single", allowedHeaders: signed });
    expect([
      uploadAnswer([partsOnly], ORIGIN),
      uploadAnswer([partsOnly, single], ORIGIN),
      uploadAnswer([single], "https://other.example.com"),
    ]).toEqual([
      { allowed: false, index: 0 },
      // The first rule still answers the PUT itself, which is matched without its headers.
      { allowed: true, index: 0 },
      { allowed: false, index: -1 },
    ]);
  });

  // A browser lists content-type in a preflight unless the file's type is one a form can send, so both must pass.
  it("is blocked by a rule that allows three of the four signed headers", () => {
    const withoutType = rule({ allowedHeaders: signed.filter((header) => header !== "content-type") });
    expect(uploadAnswer([withoutType], ORIGIN).allowed).toBe(false);
  });
});

describe("whether a rule keeps Retry-After from a page", () => {
  it.each([
    { name: "nothing exposed", expose: [], hides: true },
    { name: "ETag alone", expose: ["ETag"], hides: true },
    { name: "Retry-After in another case", expose: ["retry-after"], hides: false },
    { name: "every header", expose: ["*"], hides: false },
  ])("$name", ({ expose, hides }) => {
    expect(hidesRetryAfter(rule({ exposeHeaders: expose }))).toBe(hides);
  });
});

describe("a rule's name in a message", () => {
  it("is its ID with control characters escaped, or its place when it has none", () => {
    expect([ruleLabel({ id: "legacy\u001b[2J\n" }, 0), ruleLabel({}, 1)]).toEqual([
      'rule "legacy\\u001b[2J\\u000a"',
      "rule 2 (no ID)",
    ]);
  });
});
