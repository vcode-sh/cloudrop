import { CloudropError, fail, ok, type Result } from "../../errors.ts";
import type { BucketCorsRule, BucketLifecycleRule, StorageDriver } from "../driver.ts";
import { xmlBlocks, xmlText, xmlValue, xmlValues } from "../xml.ts";
import type { S3Context } from "./context.ts";
import { allOk, incompleteResponse, wholeNumber } from "./responses.ts";
import { sendForXml } from "./transport.ts";

/**
 * A failed bucket-configuration read. Only S3's documented "no such configuration" code means no rules: a proxy or a
 * wrong endpoint path also answers 404, and reading that as no rules would report a rule nobody read. Retrying the same
 * path cannot fix that, so it is not retryable. R2's own code for a bucket without the setting is unmeasured (the test
 * token gets 403), so this follows S3.
 */
function configurationReadError(error: CloudropError, missingCode: string, setting: string): Result<never[]> {
  if (error.status === 404 && error.storageCode === missingCode) return ok([]);
  if (error.code !== "NOT_FOUND") return fail(error);
  return fail(
    new CloudropError(
      "STORAGE_ERROR",
      `The storage service answered 404 without saying that the bucket has no ${setting} configuration. Check the endpoint, then retry.`,
      { status: 404, storageCode: error.storageCode },
    ),
  );
}

// XML the tag reader would misread: CDATA and comments are read as text, prefixed elements not at all. A rule read
// wrongly could be written back wrongly, so such a configuration is not read.
const UNREADABLE_XML = /<!\[CDATA\[|<!--|<\/?[A-Za-z_][\w.-]*:/;

/** The configuration element's inner XML; "" for an empty, self-closing one. */
function readConfiguration(xml: string, root: string, setting: string): Result<string> {
  if (new RegExp(`<${root}(?:\\s[^>]*)?/>`).test(xml)) return ok("");
  // A 200 without the element is not "no rules" (a proxy's HTML page, say): checkBucket would report a missing rule.
  const configuration = xmlBlocks(xml, root)[0];
  if (configuration === undefined) return fail(incompleteResponse(`${setting} configuration`));
  if (UNREADABLE_XML.test(configuration)) {
    return fail(
      new CloudropError(
        "STORAGE_ERROR",
        `The bucket's ${setting} configuration uses XML that cloudrop does not read (CDATA, comments or namespace prefixes). Check its rules by hand.`,
      ),
    );
  }
  return ok(configuration);
}

function readCorsRule(rule: string): Result<BucketCorsRule> {
  const id = xmlText(rule, "ID");
  const maxAge = xmlValue(rule, "MaxAgeSeconds");
  const maxAgeSeconds = wholeNumber(maxAge);
  if (maxAge !== undefined && maxAgeSeconds === undefined) return fail(incompleteResponse("valid CORS max age"));
  // Optional fields only when present, so a rule read and written back is the rule the bucket had.
  return ok({
    ...(id === undefined ? {} : { id }),
    allowedOrigins: xmlValues(rule, "AllowedOrigin"),
    allowedMethods: xmlValues(rule, "AllowedMethod"),
    allowedHeaders: xmlValues(rule, "AllowedHeader"),
    exposeHeaders: xmlValues(rule, "ExposeHeader"),
    ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
  });
}

function readLifecycleRule(rule: string): Result<BucketLifecycleRule> {
  const days = xmlValue(xmlBlocks(rule, "AbortIncompleteMultipartUpload")[0] ?? "", "DaysAfterInitiation");
  if (days !== undefined && !/^\d{1,9}$/.test(days)) return fail(incompleteResponse("valid multipart abort days"));
  return ok({
    id: xmlText(rule, "ID") ?? "",
    enabled: xmlValue(rule, "Status") === "Enabled",
    prefix: xmlText(rule, "Prefix") ?? "",
    ...(days === undefined ? {} : { abortIncompleteMultipartUploadDays: Number(days) }),
    sourceXml: rule,
  });
}

export function bucketSettingsMethods(ctx: S3Context): Pick<StorageDriver, "getBucketCors" | "getBucketLifecycle"> {
  return {
    async getBucketCors() {
      const result = await sendForXml(ctx, "GET", new URL(`${ctx.bucketUrl}?cors=`));
      if (result.error) return configurationReadError(result.error, "NoSuchCORSConfiguration", "CORS");
      const configuration = readConfiguration(result.data, "CORSConfiguration", "CORS");
      if (configuration.error) return configuration;
      return allOk(xmlBlocks(configuration.data, "CORSRule").map(readCorsRule));
    },

    async getBucketLifecycle() {
      const result = await sendForXml(ctx, "GET", new URL(`${ctx.bucketUrl}?lifecycle=`));
      if (result.error) return configurationReadError(result.error, "NoSuchLifecycleConfiguration", "lifecycle");
      const configuration = readConfiguration(result.data, "LifecycleConfiguration", "lifecycle");
      if (configuration.error) return configuration;
      return allOk(xmlBlocks(configuration.data, "Rule").map(readLifecycleRule));
    },
  };
}
