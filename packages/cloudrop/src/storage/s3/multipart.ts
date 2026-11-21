import { fail, ok, type Result } from "../../errors.ts";
import { invalidInput } from "../../input.ts";
import type { ObjectOptions, PartInfo, StorageDriver } from "../driver.ts";
import { keyProblem, MAX_LIST_PAGE, objectOptionsProblem, partsProblem, uploadIdProblem } from "../validate.ts";
import { escapeXml, stripQuotes, xmlBlocks, xmlText, xmlValue } from "../xml.ts";
import { objectUrl, type S3Context } from "./context.ts";
import { objectHeaders, orEmpty } from "./options.ts";
import { allOk, etagIn, incompleteResponse, wholeNumber } from "./responses.ts";
import { SLOW_REQUEST_TIMEOUT_MS, send, sendForXml } from "./transport.ts";

const encoder = new TextEncoder();

function readPart(block: string, maxParts: number): Result<PartInfo> {
  const partNumber = wholeNumber(xmlValue(block, "PartNumber"));
  if (partNumber === undefined || partNumber < 1 || partNumber > maxParts) {
    return fail(incompleteResponse("valid part number"));
  }
  const size = wholeNumber(xmlValue(block, "Size"));
  if (size === undefined) return fail(incompleteResponse("valid part size"));
  const etag = etagIn(block);
  if (etag === "") return fail(incompleteResponse("part ETag"));
  return ok({ partNumber, size, etag, checksumCrc32c: xmlValue(block, "ChecksumCRC32C") });
}

/** One page of ListParts: its parts, and the marker of the next page, or null after the last one. */
async function partsPage(
  ctx: S3Context,
  key: string,
  uploadId: string,
  marker: string,
): Promise<Result<{ parts: PartInfo[]; next: string | null }>> {
  const result = await sendForXml(
    ctx,
    "GET",
    objectUrl(ctx, key, { uploadId, "max-parts": String(MAX_LIST_PAGE), "part-number-marker": marker }),
  );
  if (result.error) return result;
  // Any other 200 would read as an upload with no parts.
  if (!result.data.includes("<ListPartsResult")) return fail(incompleteResponse("part listing"));
  const parts = allOk(xmlBlocks(result.data, "Part").map((block) => readPart(block, ctx.rules.maxParts)));
  if (parts.error) return parts;
  if (xmlValue(result.data, "IsTruncated") !== "true") return ok({ parts: parts.data, next: null });
  const next = xmlValue(result.data, "NextPartNumberMarker") ?? "";
  // A missing or non-advancing marker would loop forever, and so would one past the last possible part number.
  if (!(Number(next) > Number(marker)) || Number(next) > ctx.rules.maxParts) {
    return fail(incompleteResponse("valid next part marker"));
  }
  return ok({ parts: parts.data, next });
}

/**
 * Not validated: createMultipart checks caller input first; a copy passes headers the storage itself returned, which
 * the signer signs as the bytes they are (M11-R25).
 */
export async function startMultipart(
  ctx: S3Context,
  key: string,
  options: ObjectOptions,
): Promise<Result<{ uploadId: string }>> {
  const result = await sendForXml(ctx, "POST", objectUrl(ctx, key, { uploads: "" }), {
    headers: objectHeaders(options),
  });
  if (result.error) return result;
  const uploadId = xmlText(result.data, "UploadId");
  return uploadId ? ok({ uploadId }) : fail(incompleteResponse("upload ID"));
}

export function multipartMethods(
  ctx: S3Context,
): Pick<StorageDriver, "createMultipart" | "listParts" | "completeMultipart" | "abortMultipart"> {
  const { rules } = ctx;
  return {
    async createMultipart(key, given) {
      const options = orEmpty(given);
      const problem = keyProblem(key) ?? objectOptionsProblem(options);
      if (problem) return fail(invalidInput(problem));
      return startMultipart(ctx, key, options);
    },

    async listParts(key, uploadId) {
      const problem = keyProblem(key) ?? uploadIdProblem(uploadId);
      if (problem) return fail(invalidInput(problem));
      const parts: PartInfo[] = [];
      let marker: string | null = "0";
      while (marker !== null) {
        const page = await partsPage(ctx, key, uploadId, marker);
        if (page.error) return page;
        parts.push(...page.data.parts);
        marker = page.data.next;
      }
      return ok(parts);
    },

    async completeMultipart(key, uploadId, parts, given) {
      const options = orEmpty(given);
      const problem = keyProblem(key) ?? uploadIdProblem(uploadId) ?? partsProblem(parts, rules.maxParts);
      if (problem) return fail(invalidInput(problem));
      const xml = parts
        .toSorted((a, b) => a.partNumber - b.partNumber)
        // A browser reads the part's ETag header with its quotes; quoting it again would name another ETag.
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${escapeXml(stripQuotes(part.etag))}"</ETag></Part>`,
        )
        .join("");
      const result = await sendForXml(ctx, "POST", objectUrl(ctx, key, { uploadId }), {
        headers: options.ifNoneMatch ? { "if-none-match": "*" } : {},
        body: encoder.encode(`<CompleteMultipartUpload>${xml}</CompleteMultipartUpload>`),
        timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
      });
      if (result.error) return result;
      const etag = etagIn(result.data);
      return etag ? ok({ etag }) : fail(incompleteResponse("ETag"));
    },

    async abortMultipart(key, uploadId) {
      const problem = keyProblem(key) ?? uploadIdProblem(uploadId);
      if (problem) return fail(invalidInput(problem));
      const result = await send(ctx, "DELETE", objectUrl(ctx, key, { uploadId }));
      if (result.error && result.error.code !== "NO_SUCH_UPLOAD") return result;
      return ok(undefined);
    },
  };
}
