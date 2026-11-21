// cloudrop's own bucket rules and how they merge into what the bucket has. A rule is cloudrop's when it carries
// cloudrop's ID; every other rule is kept exactly as read (M9-C6).

import type { BucketCorsRule, BucketLifecycleRule } from "../storage/driver.ts";

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
  /** What to write: the bucket's rules with cloudrop's added or replaced in place. */
  rules: Rule[];
  /** "none" when the bucket's rules already do what cloudrop's would. */
  change: "add" | "update" | "none";
  /** The bucket's other rules, all of which `rules` keeps. */
  kept: Rule[];
  /** Another rule that already does the job, when that is why nothing changes. */
  coveredBy?: Rule;
}

const sameCors = (a: BucketCorsRule, b: BucketCorsRule): boolean =>
  JSON.stringify([a.allowedOrigins, a.allowedMethods, a.allowedHeaders, a.exposeHeaders, a.maxAgeSeconds]) ===
  JSON.stringify([b.allowedOrigins, b.allowedMethods, b.allowedHeaders, b.exposeHeaders, b.maxAgeSeconds]);

const sameLifecycle = (a: BucketLifecycleRule, b: BucketLifecycleRule): boolean =>
  a.enabled === b.enabled &&
  a.prefix === b.prefix &&
  a.abortIncompleteMultipartUploadDays === b.abortIncompleteMultipartUploadDays;

/** Replaces every rule with `ours.id` by one copy of `ours`, where the first stood, or appends it. */
function replaceOrAppend<Rule extends { id?: string }>(
  current: readonly Rule[],
  ours: Rule,
  same: (a: Rule, b: Rule) => boolean,
): Merged<Rule> {
  const kept = current.filter((rule) => rule.id !== ours.id);
  const first = current.findIndex((rule) => rule.id === ours.id);
  if (first === -1) return { rules: [...current, ours], change: "add", kept };
  const existing = current[first] as Rule;
  const unchanged = kept.length === current.length - 1 && same(existing, ours);
  const rules = current.flatMap((rule, index) => (rule.id !== ours.id ? [rule] : index === first ? [ours] : []));
  return unchanged ? { rules: [...current], change: "none", kept } : { rules, change: "update", kept };
}

export function mergeCors(current: readonly BucketCorsRule[], ours: BucketCorsRule): Merged<BucketCorsRule> {
  // R2's answer to a reader allowed to see the rules is unmeasured; if it drops IDs, a rule equal to ours is ours, so
  // a second run does not append a copy.
  const twin = current.find((rule) => rule.id !== ours.id && sameCors(rule, ours));
  if (twin && !current.some((rule) => rule.id === ours.id)) {
    return { rules: [...current], change: "none", kept: [...current], coveredBy: twin };
  }
  return replaceOrAppend(current, ours, sameCors);
}

/** A bucket-wide abort rule of any ID already does the job, so none is added beside it (M9-C7). */
export function mergeLifecycle(
  current: readonly BucketLifecycleRule[],
  ours: BucketLifecycleRule,
): Merged<BucketLifecycleRule> {
  const covering = current.find(
    (rule) => rule.enabled && rule.prefix === "" && rule.abortIncompleteMultipartUploadDays !== undefined,
  );
  if (covering && covering.id !== ours.id && !current.some((rule) => rule.id === ours.id)) {
    return { rules: [...current], change: "none", kept: [...current], coveredBy: covering };
  }
  return replaceOrAppend(current, ours, sameLifecycle);
}
