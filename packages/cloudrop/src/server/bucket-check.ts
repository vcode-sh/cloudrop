// api.checkBucket and the development start-up warnings (spec §4, §9, §12): bucket settings are verified by code,
// never assumed from the docs.

import { fail, ok, type Result } from "../errors.ts";
import { R2_RULES } from "../rules.ts";
import type { BucketCorsRule, BucketLifecycleRule } from "../storage/driver.ts";
import { answers, hidesRetryAfter, RETRY_AFTER, ruleLabel, UPLOAD_HEADERS, uploadAnswer } from "./bucket-cors.ts";
import type { ServerConfig } from "./config.ts";

export interface BucketCheck {
  /**
   * "unknown": the credentials may not read this setting (R2 object tokens cannot), the storage cannot report it
   * (Wrangler's local R2), or nothing was given to check.
   */
  status: "ok" | "problem" | "unknown";
  message: string;
  /** With "ok", what would still make the setting better; `message` ends with it. Left out when there is nothing. */
  advice?: string;
}

export interface BucketReport {
  cors: BucketCheck;
  lifecycle: BucketCheck;
  publicAccess: BucketCheck;
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A rule that answers the PUT of some origins, by its place among the bucket's rules. */
interface Answering {
  rule: BucketCorsRule;
  index: number;
  origins: string[];
}

/**
 * The advice for an answering rule that keeps Retry-After from a page. A later rule that would expose it is named:
 * the service never gets to it.
 */
function hiding(rules: readonly BucketCorsRule[], { rule, index, origins }: Answering): string {
  const later = rules.findIndex(
    (each, at) =>
      at > index && !hidesRetryAfter(each) && origins.some((origin) => answers(each, { origin, method: "PUT" })),
  );
  const laterRule = rules[later];
  const passedOver = laterRule
    ? ` It stands before ${ruleLabel(laterRule, later)}, which exposes it: the storage service answers a request with the first rule that matches it, never a later one.`
    : "";
  return `${sentence(ruleLabel(rule, index))} answers uploads from ${origins.join(", ")} and does not expose ${RETRY_AFTER}, so after a 429 or 503 a page cannot wait as long as the bucket asks.${passedOver} Add ${RETRY_AFTER} to its exposed headers, or put a rule that exposes it before it.`;
}

/** `origins` are exact origins (checked by the caller), so they are safe to echo. */
function corsCheck(rules: readonly BucketCorsRule[], origins: readonly string[]): BucketCheck {
  if (origins.length === 0) {
    return {
      status: "unknown",
      message: 'Name the origins your pages upload from: api.checkBucket({ origins: ["https://app.example.com"] }).',
    };
  }
  const blocked: string[] = [];
  const answering = new Map<number, Answering>();
  for (const origin of origins) {
    const { allowed, index } = uploadAnswer(rules, origin);
    const rule = rules[index];
    if (!allowed || !rule) blocked.push(origin);
    else answering.set(index, { rule, index, origins: [...(answering.get(index)?.origins ?? []), origin] });
  }
  if (blocked.length > 0) {
    return {
      status: "problem",
      message: `The bucket's CORS rules do not let ${blocked.join(", ")} upload: a browser there blocks every upload. Add a rule that allows PUT from there with the headers ${UPLOAD_HEADERS.join(", ")}, and expose ${RETRY_AFTER} in it.`,
    };
  }
  // The preflights are all an upload needs. A rule that hides Retry-After only makes retries after a 429 or 503 come
  // sooner than the bucket asks (bucket-setup.md), so it is advice in an `ok` message.
  const advice = [...answering.values()]
    .filter(({ rule }) => hidesRetryAfter(rule))
    .map((each) => hiding(rules, each))
    .join(" ");
  const browsers = `Browsers on ${origins.join(", ")} can upload`;
  return advice
    ? { status: "ok", message: `${browsers}. ${advice}`, advice }
    : { status: "ok", message: `${browsers} and read ${RETRY_AFTER}.` };
}

function lifecycleCheck(rules: readonly BucketLifecycleRule[], hasStore: boolean, isR2: boolean): BucketCheck {
  const rule = rules.find(
    (candidate) =>
      candidate.enabled && candidate.prefix === "" && candidate.abortIncompleteMultipartUploadDays !== undefined,
  );
  if (rule) {
    const days = rule.abortIncompleteMultipartUploadDays;
    return {
      status: "ok",
      message: `Incomplete multipart uploads are aborted after ${days} day${days === 1 ? "" : "s"}.`,
    };
  }
  // With a store the rule is the only cleanup for an upload created just before a crash, before its row recorded it.
  const required = hasStore
    ? " With a store it is required: an upload created just before a crash has no row to clean it up."
    : "";
  return {
    status: "problem",
    message: `No enabled lifecycle rule aborts incomplete multipart uploads across the bucket, so abandoned uploads keep their parts stored.${required} Add one${isR2 ? " (R2 creates a 7-day rule by default)" : ""}.`,
  };
}

// A read the credentials may not make (403) or the storage does not implement (501, Wrangler's local R2, measured
// 2026-11-16) says nothing about the setting itself, so it is reported as unknown. Any other failure fails the check.
function settingCheck<T>(
  read: Result<T>,
  setting: string,
  isR2: boolean,
  check: (rules: T) => BucketCheck,
): Result<BucketCheck> {
  if (read.error === null) return ok(check(read.data));
  if (read.error.code === "STORAGE_DENIED") {
    const advice = isR2
      ? " (R2 object tokens cannot). Check it with an admin read token or in the dashboard."
      : ". Check them with credentials that may read bucket settings, or in the service's console.";
    return ok({
      status: "unknown",
      message: `These storage credentials may not read the bucket's ${setting}${advice}`,
    });
  }
  if (read.error.status === 501) {
    return ok({
      status: "unknown",
      message: `This storage service cannot report the bucket's ${setting}. Check them where the bucket is configured (for R2, the dashboard).`,
    });
  }
  return fail(read.error);
}

/** `origins` must be exact origins: the caller checks them, since they are echoed in the report. */
export async function checkBucket(
  config: Pick<ServerConfig, "storage" | "routes" | "store">,
  origins: readonly string[],
): Promise<Result<BucketReport>> {
  const { storage } = config;
  // The r2() preset's limits are this very object; any other storage gets words that name no service (M11-R116).
  const isR2 = storage.rules === R2_RULES;
  const [corsRules, lifecycleRules] = await Promise.all([storage.getBucketCors(), storage.getBucketLifecycle()]);
  const cors = settingCheck(corsRules, "CORS rules", isR2, (rules) => corsCheck(rules, origins));
  if (cors.error) return cors;
  const lifecycle = settingCheck(lifecycleRules, "lifecycle rules", isR2, (rules) =>
    lifecycleCheck(rules, config.store !== undefined, isR2),
  );
  if (lifecycle.error) return lifecycle;
  const privateRoutes = [...config.routes.values()].filter((route) => route.visibility === "private");
  const publicAccess: BucketCheck =
    privateRoutes.length > 0 && storage.publicUrl
      ? {
          status: "problem",
          message: `Private routes (${privateRoutes.map((route) => route.name).join(", ")}) store files on a bucket with a public URL: anyone who learns a key can read the file.`,
        }
      : { status: "ok", message: "No private route stores files on a public bucket." };
  return ok({ cors: cors.data, lifecycle: lifecycle.data, publicAccess });
}
