import { CloudropError, fail, ok, type Result } from "../../errors.ts";
import type { BucketLifecycleRule, StorageDriver } from "../driver.ts";
import { xmlBlocks, xmlText, xmlTexts } from "../xml.ts";
import type { S3Context } from "./context.ts";
import { allOk, incompleteResponse } from "./responses.ts";
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

function readLifecycleRule(rule: string): Result<BucketLifecycleRule> {
  const days = xmlText(xmlBlocks(rule, "AbortIncompleteMultipartUpload")[0] ?? "", "DaysAfterInitiation");
  if (days !== undefined && !/^\d{1,9}$/.test(days)) return fail(incompleteResponse("valid multipart abort days"));
  return ok({
    id: xmlText(rule, "ID") ?? "",
    enabled: xmlText(rule, "Status") === "Enabled",
    prefix: xmlText(rule, "Prefix") ?? "",
    ...(days === undefined ? {} : { abortIncompleteMultipartUploadDays: Number(days) }),
  });
}

export function bucketSettingsMethods(ctx: S3Context): Pick<StorageDriver, "getBucketCors" | "getBucketLifecycle"> {
  return {
    async getBucketCors() {
      const result = await sendForXml(ctx, "GET", new URL(`${ctx.bucketUrl}?cors=`));
      if (result.error) return configurationReadError(result.error, "NoSuchCORSConfiguration", "CORS");
      // A 200 without the element is not "no rules" (a proxy's HTML page, say): checkBucket would report a missing rule.
      const configuration = xmlBlocks(result.data, "CORSConfiguration")[0];
      if (configuration === undefined) return fail(incompleteResponse("CORS configuration"));
      return ok(
        xmlBlocks(configuration, "CORSRule").map((rule) => ({
          allowedOrigins: xmlTexts(rule, "AllowedOrigin"),
          allowedMethods: xmlTexts(rule, "AllowedMethod"),
          allowedHeaders: xmlTexts(rule, "AllowedHeader"),
          exposeHeaders: xmlTexts(rule, "ExposeHeader"),
        })),
      );
    },

    async getBucketLifecycle() {
      const result = await sendForXml(ctx, "GET", new URL(`${ctx.bucketUrl}?lifecycle=`));
      if (result.error) return configurationReadError(result.error, "NoSuchLifecycleConfiguration", "lifecycle");
      const configuration = xmlBlocks(result.data, "LifecycleConfiguration")[0];
      if (configuration === undefined) return fail(incompleteResponse("lifecycle configuration"));
      return allOk(xmlBlocks(configuration, "Rule").map(readLifecycleRule));
    },
  };
}
