// PutBucketCors and PutBucketLifecycleConfiguration. Both replace the bucket's whole configuration, so callers that
// must keep rules read them first and pass them back; a lifecycle rule read from the bucket carries its own XML.

import { fail, ok, type Result } from "../../errors.ts";
import { invalidInput, isPlainObject } from "../../input.ts";
import type { BucketCorsRule, BucketLifecycleRule } from "../driver.ts";
import { escapeXml } from "../xml.ts";
import { configurationReadError } from "./bucket-settings.ts";
import type { S3Context } from "./context.ts";
import { send } from "./transport.ts";

const encoder = new TextEncoder();
const element = (name: string, value: string | number): string => `<${name}>${escapeXml(String(value))}</${name}>`;
const elements = (name: string, values: readonly string[]): string => values.map((v) => element(name, v)).join("");
const optional = (name: string, value: string | number | undefined): string =>
  value === undefined || value === "" ? "" : element(name, value);

function corsRuleXml(rule: BucketCorsRule): string {
  return `<CORSRule>${optional("ID", rule.id)}${elements("AllowedOrigin", rule.allowedOrigins)}${elements("AllowedMethod", rule.allowedMethods)}${elements("AllowedHeader", rule.allowedHeaders)}${elements("ExposeHeader", rule.exposeHeaders)}${optional("MaxAgeSeconds", rule.maxAgeSeconds)}</CORSRule>`;
}

function lifecycleRuleXml(rule: BucketLifecycleRule): string {
  if (rule.sourceXml !== undefined) return `<Rule>${rule.sourceXml}</Rule>`;
  const abort = element("DaysAfterInitiation", rule.abortIncompleteMultipartUploadDays ?? "");
  return `<Rule>${optional("ID", rule.id)}<Filter>${element("Prefix", rule.prefix)}</Filter><Status>${rule.enabled ? "Enabled" : "Disabled"}</Status><AbortIncompleteMultipartUpload>${abort}</AbortIncompleteMultipartUpload></Rule>`;
}

/**
 * S3 refuses an empty configuration, but a driver that sent one to a lax service would remove every rule, so the list is
 * checked here; what a rule must contain is left to the service, which answers MalformedXML.
 */
const emptyProblem = (rules: readonly unknown[], setting: string): string | null =>
  Array.isArray(rules) && rules.length > 0
    ? null
    : `Pass at least one ${setting} rule: an empty list would remove every rule.`;

const isTextList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");

// Only what writing the XML needs, so a rule from plain JavaScript answers a message instead of a TypeError, and a
// missing prefix is never written as the text "undefined".
function corsProblem(rules: readonly BucketCorsRule[]): string | null {
  const valid = rules.every(
    (rule) =>
      isPlainObject(rule) &&
      [rule.allowedOrigins, rule.allowedMethods, rule.allowedHeaders, rule.exposeHeaders].every(isTextList),
  );
  return valid
    ? null
    : "Each CORS rule must be an object with allowedOrigins, allowedMethods, allowedHeaders and exposeHeaders, each a list of text.";
}

function lifecycleProblem(rules: readonly BucketLifecycleRule[]): string | null {
  const valid = rules.every((rule) => {
    if (!isPlainObject(rule)) return false;
    if (rule.sourceXml !== undefined) return typeof rule.sourceXml === "string";
    const days = rule.abortIncompleteMultipartUploadDays;
    return typeof rule.prefix === "string" && Number.isInteger(days) && (days as number) >= 1;
  });
  return valid
    ? null
    : "Each lifecycle rule must be an object with its sourceXml as text, or with a prefix as text and abortIncompleteMultipartUploadDays as a whole number from 1.";
}

/**
 * AWS requires an integrity checksum on both calls (Content-MD5 or an x-amz-checksum-* header). Web crypto has no MD5,
 * so the body's SHA-256 is sent, which the signer already computes with crypto.subtle; a CRC32C would bring its tables
 * into every server bundle. R2's compatibility page lists neither header for these calls (M9-C3).
 */
async function putConfiguration(
  ctx: S3Context,
  subresource: string,
  xml: string,
  extraHeaders: Record<string, string> = {},
): Promise<Result<void>> {
  const body = encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const headers = {
    ...extraHeaders,
    "content-type": "application/xml",
    "x-amz-checksum-sha256": btoa(String.fromCharCode(...digest)),
  };
  const result = await send(ctx, "PUT", new URL(`${ctx.bucketUrl}?${subresource}=`), { headers, body });
  return result.error ? result : ok(undefined);
}

const NAMESPACE = ' xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';
const TRANSITION_DEFAULT = "x-amz-transition-default-minimum-object-size";

/**
 * AWS keeps a bucket-wide setting beside the lifecycle rules, which a write without its header resets to the default.
 * It is read and sent back, so a write changes only the rules. There is none to keep on a bucket without a
 * configuration, and none can be kept when the read is refused (403) or not implemented (501); any other failure fails
 * the write.
 */
async function keptLifecycleHeaders(ctx: S3Context): Promise<Result<Record<string, string>>> {
  const kept: Record<string, string> = {};
  const current = await send(ctx, "GET", new URL(`${ctx.bucketUrl}?lifecycle=`));
  if (current.error) {
    if (current.error.code === "STORAGE_DENIED" || current.error.status === 501) return ok(kept);
    // As the rule read reports it: no configuration means nothing to keep, a bare 404 a wrong endpoint.
    const read = configurationReadError(current.error, "NoSuchLifecycleConfiguration", "lifecycle");
    return read.error ? read : ok(kept);
  }
  const value = current.data.headers.get(TRANSITION_DEFAULT);
  if (value) kept[TRANSITION_DEFAULT] = value;
  return ok(kept);
}

export function bucketWriteMethods(ctx: S3Context): {
  putBucketCors(rules: readonly BucketCorsRule[]): Promise<Result<void>>;
  putBucketLifecycle(rules: readonly BucketLifecycleRule[]): Promise<Result<void>>;
} {
  return {
    async putBucketCors(rules) {
      const problem = emptyProblem(rules, "CORS") ?? corsProblem(rules);
      if (problem) return fail(invalidInput(problem));
      const xml = `<CORSConfiguration${NAMESPACE}>${rules.map(corsRuleXml).join("")}</CORSConfiguration>`;
      return putConfiguration(ctx, "cors", xml);
    },

    async putBucketLifecycle(rules) {
      const problem = emptyProblem(rules, "lifecycle") ?? lifecycleProblem(rules);
      if (problem) return fail(invalidInput(problem));
      const kept = await keptLifecycleHeaders(ctx);
      if (kept.error) return kept;
      const xml = `<LifecycleConfiguration${NAMESPACE}>${rules.map(lifecycleRuleXml).join("")}</LifecycleConfiguration>`;
      return putConfiguration(ctx, "lifecycle", xml, kept.data);
    },
  };
}
