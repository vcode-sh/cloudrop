import { CloudropError, fail, ok, type Result } from "../../errors.ts";
import { invalidInput } from "../../input.ts";
import type { CompletedPart, ObjectInfo, StorageDriver } from "../driver.ts";
import { encodeKeyPath, encodeRfc3986 } from "../sigv4.ts";
import { keyProblem } from "../validate.ts";
import { objectUrl, type S3Context } from "./context.ts";
import { startMultipart } from "./multipart.ts";
import { etagIn, incompleteResponse } from "./responses.ts";
import { SLOW_REQUEST_TIMEOUT_MS, sendForXml } from "./transport.ts";

/** The driver calls a copy makes besides its own requests. */
type CopySteps = Pick<StorageDriver, "head" | "abortMultipart" | "completeMultipart">;

/** Every copy request names the ETag HEAD read, so a 412 means the source was overwritten after that. */
function copyError(error: CloudropError): CloudropError {
  if (error.status !== 412) return error;
  return new CloudropError("STORAGE_ERROR", "The object to copy changed during the copy. Retry the copy.", {
    status: 412,
    storageCode: error.storageCode,
    retryable: true,
  });
}

async function copyInParts(
  ctx: S3Context,
  steps: CopySteps,
  source: ObjectInfo,
  copyHeaders: Record<string, string>,
  to: string,
): Promise<Result<{ etag: string }>> {
  // The largest part one request may carry: a server-side copy streams nothing through us, so fewer requests win.
  // Equal parts with a smaller last one also satisfy R2's equal-part rule by construction.
  const partSize = ctx.rules.maxSinglePutSize;
  const partCount = Math.ceil(source.size / partSize);
  const created = await startMultipart(ctx, to, source);
  if (created.error) return created;
  const { uploadId } = created.data;
  const abortWith = async (error: CloudropError): Promise<Result<never>> => {
    await steps.abortMultipart(to, uploadId);
    return fail(error);
  };
  const parts: CompletedPart[] = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, source.size) - 1;
    const result = await sendForXml(ctx, "PUT", objectUrl(ctx, to, { partNumber: String(partNumber), uploadId }), {
      headers: { ...copyHeaders, "x-amz-copy-source-range": `bytes=${start}-${end}` },
      timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
    });
    if (result.error) return abortWith(copyError(result.error));
    const etag = etagIn(result.data);
    if (!etag) return abortWith(incompleteResponse("ETag"));
    parts.push({ partNumber, etag });
  }
  const completed = await steps.completeMultipart(to, uploadId, parts);
  return completed.error ? abortWith(completed.error) : completed;
}

export function copyMethods(ctx: S3Context, steps: CopySteps): Pick<StorageDriver, "copy"> {
  return {
    async copy(from, to) {
      const problem = keyProblem(from) ?? keyProblem(to);
      if (problem) return fail(invalidInput(problem));
      const source = await steps.head(from);
      if (source.error) return source;
      if (!source.data) {
        return fail(new CloudropError("NOT_FOUND", "The object to copy does not exist. Check the source key."));
      }
      // `/bucket/key` without the endpoint's path prefix: the source is named inside the storage service.
      const copyHeaders = {
        "x-amz-copy-source": `/${encodeRfc3986(ctx.bucket)}/${encodeKeyPath(from)}`,
        // Without it, a source overwritten during a multipart copy would leave parts of both versions in the copy.
        "x-amz-copy-source-if-match": `"${source.data.etag}"`,
      };
      if (source.data.size > ctx.rules.maxSinglePutSize) return copyInParts(ctx, steps, source.data, copyHeaders, to);
      const result = await sendForXml(ctx, "PUT", objectUrl(ctx, to), {
        headers: copyHeaders,
        timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
      });
      if (result.error) return fail(copyError(result.error));
      const etag = etagIn(result.data);
      return etag ? ok({ etag }) : fail(incompleteResponse("ETag"));
    },
  };
}
