// api.checkBucket and the development start-up warnings (spec §4, §9, §12): bucket settings are verified by code,
// never assumed from the docs.

import { fail, ok, type Result } from "../errors.ts";
import type { BucketCorsRule, BucketLifecycleRule } from "../storage/driver.ts";
import type { ServerConfig } from "./config.ts";

export interface BucketCheck {
  /** "unknown": the credentials may not read this setting (R2 object tokens cannot), or nothing was given to check. */
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

function lifecycleCheck(rules: readonly BucketLifecycleRule[]): BucketCheck {
  const rule = rules.find(
    (candidate) =>
      candidate.enabled && candidate.prefix === "" && candidate.abortIncompleteMultipartUploadDays !== undefined,
  );
  if (rule) {
    return {
      status: "ok",
      message: `Incomplete multipart uploads are aborted after ${rule.abortIncompleteMultipartUploadDays} days.`,
    };
  }
  return {
    status: "problem",
    message:
      "No enabled lifecycle rule aborts incomplete multipart uploads across the bucket, so abandoned uploads keep their parts stored. Add one (R2 creates a 7-day rule by default).",
  };
}

const unreadable = (setting: string): BucketCheck => ({
  status: "unknown",
  message: `These storage credentials may not read the bucket's ${setting} (R2 object tokens cannot). Check it with an admin read token or in the dashboard.`,
});

/** `origins` must be exact origins: the caller checks them, since they are echoed in the report. */
export async function checkBucket(config: ServerConfig, origins: readonly string[]): Promise<Result<BucketReport>> {
  const { storage } = config;
  const [cors, lifecycle] = await Promise.all([storage.getBucketCors(), storage.getBucketLifecycle()]);
  for (const result of [cors, lifecycle]) {
    if (result.error && result.error.code !== "STORAGE_DENIED") return fail(result.error);
  }
  const privateRoutes = [...config.routes.values()].filter((route) => route.visibility === "private");
  const publicAccess: BucketCheck =
    privateRoutes.length > 0 && storage.publicUrl
      ? {
          status: "problem",
          message: `Private routes (${privateRoutes.map((route) => route.name).join(", ")}) store files on a bucket with a public URL: anyone who learns a key can read the file.`,
        }
      : { status: "ok", message: "No private route stores files on a public bucket." };
  return ok({
    cors: cors.data ? corsCheck(cors.data, origins) : unreadable("CORS rules"),
    lifecycle: lifecycle.data ? lifecycleCheck(lifecycle.data) : unreadable("lifecycle rules"),
    publicAccess,
  });
}
