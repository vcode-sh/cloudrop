// cloudrop's own bucket rules and how they merge into what the bucket has. A rule is cloudrop's when it carries
// cloudrop's ID; every other rule is kept exactly as read, and in its order (M9-C6). The storage service answers a
// request with the first CORS rule that matches it, so where cloudrop's rule stands is part of the merge (M11-R171).

import { answeringRule, answers, hidden, ruleLabel, UPLOAD_HEADERS, uploadAnswer } from "../server/bucket-cors.ts";
import type { BucketCorsRule, BucketLifecycleRule } from "../storage/driver.ts";
import { plural, ruleName } from "./report.ts";

export const CORS_RULE_ID = "cloudrop-uploads";
export const LIFECYCLE_RULE_ID = "cloudrop-abort-incomplete";
export const ABORT_DAYS = 1;

/** The headers the server signs into a PUT (bucket-cors.ts) and the ones the client reads (bucket-setup.md). */
export function corsRule(origins: readonly string[]): BucketCorsRule & { id: string } {
  return {
    id: CORS_RULE_ID,
    allowedOrigins: [...origins],
    allowedMethods: ["PUT", "GET", "HEAD"],
    allowedHeaders: [...UPLOAD_HEADERS],
    exposeHeaders: ["ETag", "Retry-After"],
    maxAgeSeconds: 3600,
  };
}

export const LIFECYCLE_RULE: BucketLifecycleRule & { id: string } = {
  id: LIFECYCLE_RULE_ID,
  enabled: true,
  prefix: "",
  abortIncompleteMultipartUploadDays: ABORT_DAYS,
};

export interface Merged<Rule> {
  /** What to write: the bucket's rules with cloudrop's added or grown in place. */
  rules: Rule[];
  /**
   * "none" when the bucket's rules already do what cloudrop's would; "blocked" when cloudrop's rule exists in a form
   * setup will not change.
   */
  change: "add" | "update" | "none" | "blocked";
  /** The bucket's other rules, all of which `rules` keeps unchanged. */
  kept: Rule[];
  /** Why nothing changes, or why setup will not change it. */
  reason?: string;
  /** For an update: what cloudrop's rule gains, such as "origins http://localhost:5173"; "" when it only moves. */
  added?: string;
  /** Set when cloudrop's rule had to go before another rule, which would have answered its uploads in its place. */
  placement?: Placement;
}

export interface Placement {
  /** The name of the rule cloudrop's rule now stands before. */
  before: string;
  /** Why it has to, as a sentence. */
  why: string;
}

/** `wanted` values missing from `existing`; methods and header names compare without case, as HTTP does. */
function missing(existing: readonly string[], wanted: readonly string[], ignoreCase: boolean): string[] {
  const normal = (value: string) => (ignoreCase ? value.toLowerCase() : value);
  const have = new Set(existing.map(normal));
  return wanted.filter((value) => !have.has(normal(value)));
}

const CORS_LISTS = [
  ["allowedOrigins", "origins", false],
  ["allowedMethods", "methods", true],
  ["allowedHeaders", "headers", true],
  ["exposeHeaders", "exposed headers", true],
] as const;

/** `existing` grown by what `wanted` allows beyond it. Nothing `existing` allows is removed (M9-C6). */
function grow(existing: BucketCorsRule, wanted: BucketCorsRule): { rule: BucketCorsRule; added: string } {
  const rule: BucketCorsRule = { ...existing };
  const added: string[] = [];
  for (const [field, name, ignoreCase] of CORS_LISTS) {
    const extra = missing(existing[field], wanted[field], ignoreCase);
    rule[field] = [...existing[field], ...extra];
    if (extra.length > 0) added.push(`${name} ${extra.join(", ")}`);
  }
  if (existing.maxAgeSeconds === undefined && wanted.maxAgeSeconds !== undefined) {
    rule.maxAgeSeconds = wanted.maxAgeSeconds;
    added.push(`a max age of ${wanted.maxAgeSeconds} seconds`);
  }
  return { rule, added: added.join("; ") };
}

const alreadyAllows = (names: string, ours: BucketCorsRule): string =>
  `${names} uploads from ${ours.allowedOrigins.join(", ")} as cloudrop's rule does`;

/**
 * The rules that answer the uploads of every origin of `ours`, when the bucket already answers each request `ours`
 * exists for as `ours` would: every preflight of a PUT, the PUT with ETag and Retry-After exposed, and GET and HEAD.
 * Undefined when it does not.
 */
function serving(current: readonly BucketCorsRule[], ours: BucketCorsRule): BucketCorsRule[] | undefined {
  const rules = new Set<BucketCorsRule>();
  for (const origin of ours.allowedOrigins) {
    const { allowed, index } = uploadAnswer(current, origin);
    const rule = current[index];
    const everyMethod = ours.allowedMethods.every((method) => answeringRule(current, { origin, method }) >= 0);
    if (!allowed || !rule || hidden(rule).length > 0 || !everyMethod) return undefined;
    rules.add(rule);
  }
  return [...rules];
}

/**
 * `kept` with `rule` at `position`, or earlier: before the first rule that answers a PUT from one of `origins` and
 * keeps ETag or Retry-After from the page. The service would answer with that rule and never reach cloudrop's. A rule
 * that answers no upload of these origins, or answers it in full, stays in front.
 */
function place(
  kept: readonly BucketCorsRule[],
  rule: BucketCorsRule,
  position: number,
  { origins, current }: { origins: readonly string[]; current: readonly BucketCorsRule[] },
): { rules: BucketCorsRule[]; placement?: Placement } {
  const answered = (each: BucketCorsRule) => origins.filter((origin) => answers(each, { origin, method: "PUT" }));
  const first = kept.findIndex((each) => hidden(each).length > 0 && answered(each).length > 0);
  const inFront = kept[first];
  if (!inFront || first >= position) return { rules: [...kept.slice(0, position), rule, ...kept.slice(position)] };
  const before = ruleLabel(inFront, current.indexOf(inFront));
  const why = `The storage service answers a request with the first rule that matches it, and ${before} matches uploads from ${answered(inFront).join(", ")} without exposing ${hidden(inFront).join(" and ")}.`;
  return { rules: [...kept.slice(0, first), rule, ...kept.slice(first)], placement: { before, why } };
}

/**
 * Adds cloudrop's rule, or grows it so it also allows what `ours` does, and puts it where the service answers with it
 * (`place`). Copies of it are folded into the first, so nothing any of them allowed is lost.
 */
export function mergeCors(current: readonly BucketCorsRule[], ours: BucketCorsRule): Merged<BucketCorsRule> {
  const kept = current.filter((rule) => rule.id !== ours.id);
  const [first, ...others] = current.filter((rule) => rule.id === ours.id);
  const where = { origins: ours.allowedOrigins, current };
  if (first === undefined) {
    // Nothing to add when other rules already answer as cloudrop's would. That also covers a service that drops
    // rule IDs (R2's answer to a reader allowed to see the rules is unmeasured): a second run finds its own rule.
    const rules = serving(current, ours);
    if (rules) {
      const [only] = rules;
      const names =
        only && rules.length === 1 ? `${ruleName(only)} already allows` : "the bucket's rules already allow";
      return { rules: [...current], change: "none", kept, reason: alreadyAllows(names, ours) };
    }
    return { ...place(kept, ours, kept.length, where), change: "add", kept };
  }
  const folded = others.reduce((rule, copy) => grow(rule, copy).rule, first);
  const { rule, added } = grow(folded, ours);
  const placed = place(kept, rule, current.indexOf(first), where);
  if (added === "" && others.length === 0 && !placed.placement) {
    return {
      rules: [...current],
      change: "none",
      kept,
      reason: alreadyAllows(`${ruleName(first)} already allows`, ours),
    };
  }
  const folding = others.length > 0 ? "its copies folded into one" : "";
  return { ...placed, change: "update", kept, added: added || folding };
}

const abortsEverywhere = (rule: BucketLifecycleRule): boolean =>
  rule.enabled && rule.prefix === "" && rule.abortIncompleteMultipartUploadDays !== undefined;

/**
 * Adds cloudrop's rule unless any rule already aborts incomplete uploads across the bucket (M9-C7). A rule with
 * cloudrop's ID that does not is left alone: it was edited, and rewriting it from fields would lose what was added.
 */
export function mergeLifecycle(
  current: readonly BucketLifecycleRule[],
  ours: BucketLifecycleRule,
): Merged<BucketLifecycleRule> {
  const kept = current.filter((rule) => rule.id !== ours.id);
  const covering = current.find(abortsEverywhere);
  if (covering) {
    const days = plural(covering.abortIncompleteMultipartUploadDays ?? 0, "day");
    const reason = `${ruleName(covering)} already aborts incomplete multipart uploads after ${days}`;
    return { rules: [...current], change: "none", kept, reason };
  }
  if (kept.length < current.length) {
    const reason = `rule "${ours.id}" exists but does not abort incomplete multipart uploads across the whole bucket, so someone changed it (disabled it, or gave it a prefix). setup does not change an edited rule: fix or delete it by hand, then run setup again.`;
    return { rules: [...current], change: "blocked", kept, reason };
  }
  return { rules: [...current, ours], change: "add", kept };
}
