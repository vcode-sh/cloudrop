// api.checkBucket and the development start-up warnings (spec §4, §9, §12): bucket settings are verified by code,
// never assumed from the docs.

import { fail, ok, type Result } from "../errors.ts";
import { R2_RULES } from "../rules.ts";
import type { BucketCorsRule, BucketLifecycleRule } from "../storage/driver.ts";
import type { ServerConfig } from "./config.ts";

export interface BucketCheck {
  /**
   * "unknown": the credentials may not read this setting (R2 object tokens cannot), the storage cannot report it
   * (Wrangler's local R2), or nothing was given to check.
   */
  status: "ok" | "problem" | "unknown";
  message: string;
}

export interface BucketReport {
  cors: BucketCheck;
  lifecycle: BucketCheck;
  publicAccess: BucketCheck;
}

/** The headers cloudrop's signed PUTs carry (spec §7.5); a preflight fails if the bucket's CORS rule omits one. */
const UPLOAD_HEADERS = ["content-type", "content-disposition", "if-none-match", "x-amz-meta-cloudrop-id"];

/** S3 CORS patterns may hold one "*" wildcard, such as "https://*.example.com" or "x-amz-meta-*". */
function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => {
    const [head = "", tail] = pattern.toLowerCase().split("*");
    if (tail === undefined) return head === value;
    return value.length >= head.length + tail.length && value.startsWith(head) && value.endsWith(tail);
  });
}

const allowsUploads = (rule: BucketCorsRule, origin: string): boolean =>
  matchesAny(rule.allowedOrigins, origin) &&
  rule.allowedMethods.includes("PUT") &&
  UPLOAD_HEADERS.every((header) => matchesAny(rule.allowedHeaders, header)) &&
  rule.exposeHeaders.some((header) => header.toLowerCase() === "etag");

/** `origins` are exact origins (checked by the caller), so they are safe to echo. */
function corsCheck(rules: readonly BucketCorsRule[], origins: readonly string[]): BucketCheck {
  if (origins.length === 0) {
    return {
      status: "unknown",
      message: 'Name the origins your pages upload from: api.checkBucket({ origins: ["https://app.example.com"] }).',
    };
  }
  const blocked = origins.filter((origin) => !rules.some((rule) => allowsUploads(rule, origin)));
  if (blocked.length === 0)
    return { status: "ok", message: `Browsers on ${origins.join(", ")} can upload and read ETag.` };
  return {
    status: "problem",
    message: `The bucket's CORS rules do not let ${blocked.join(", ")} upload. Add a rule that allows PUT from there with the headers ${UPLOAD_HEADERS.join(", ")} and exposes ETag.`,
  };
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
