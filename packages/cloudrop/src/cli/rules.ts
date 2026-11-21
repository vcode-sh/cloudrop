// cloudrop's own bucket rules and how they merge into what the bucket has. A rule is cloudrop's when it carries
// cloudrop's ID; every other rule is kept exactly as read (M9-C6).

import type { BucketCorsRule, BucketLifecycleRule } from "../storage/driver.ts";
import { plural, ruleName } from "./report.ts";

export const CORS_RULE_ID = "cloudrop-uploads";
export const LIFECYCLE_RULE_ID = "cloudrop-abort-incomplete";
export const ABORT_DAYS = 1;

/** The headers the server signs into a PUT (bucket-check.ts) and the ones the client reads (bucket-setup.md). */
export function corsRule(origins: readonly string[]): BucketCorsRule & { id: string } {
  return {
    id: CORS_RULE_ID,
    allowedOrigins: [...origins],
    allowedMethods: ["PUT", "GET", "HEAD"],
    allowedHeaders: ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"],
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
  /** For an update: what cloudrop's rule gains, such as "origins http://localhost:5173". */
  added?: string;
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

const allowsAll = (rule: BucketCorsRule, ours: BucketCorsRule): string =>
  `${ruleName(rule)} already allows uploads from ${ours.allowedOrigins.join(", ")} as cloudrop's rule does`;

/**
 * Adds cloudrop's rule, or grows it where it stands so it also allows what `ours` does. Copies of it are folded into
 * the first, so nothing any of them allowed is lost.
 */
export function mergeCors(current: readonly BucketCorsRule[], ours: BucketCorsRule): Merged<BucketCorsRule> {
  const kept = current.filter((rule) => rule.id !== ours.id);
  const copies = current.filter((rule) => rule.id === ours.id);
  const [first, ...others] = copies;
  if (first === undefined) {
    // R2's answer to a reader allowed to see the rules is unmeasured; if it drops IDs, a rule without one that already
    // allows everything ours does is ours, so a second run does not append a copy.
    const twin = current.find((rule) => rule.id === undefined && grow(rule, ours).added === "");
    if (twin) return { rules: [...current], change: "none", kept, reason: allowsAll(twin, ours) };
    return { rules: [...current, ours], change: "add", kept };
  }
  const folded = others.reduce((rule, copy) => grow(rule, copy).rule, first);
  const { rule, added } = grow(folded, ours);
  if (added === "" && others.length === 0) {
    return { rules: [...current], change: "none", kept, reason: allowsAll(first, ours) };
  }
  const rules = current.flatMap((each) => (each.id !== ours.id ? [each] : each === first ? [rule] : []));
  return { rules, change: "update", kept, added: added || "its copies folded into one" };
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
