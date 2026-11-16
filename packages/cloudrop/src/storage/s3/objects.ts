import { type CloudropError, fail, ok, type Result } from "../../errors.ts";
import { MiB } from "../../rules.ts";
import type { ListedObject, ObjectInfo, StorageDriver } from "../driver.ts";
import {
  bodyProblem,
  checksumProblem,
  cursorProblem,
  invalidInput,
  keyListProblem,
  keyProblem,
  limitProblem,
  MAX_LIST_PAGE,
  objectOptionsProblem,
  prefixProblem,
  rangeProblem,
  sizeProblem,
} from "../validate.ts";
import { stripQuotes, xmlBlocks, xmlText } from "../xml.ts";
import { objectUrl, type S3Context } from "./context.ts";
import { META_PREFIX, orEmpty, writeHeaders } from "./options.ts";
import { allOk, etagIn, incompleteResponse, validDate, wholeNumber } from "./responses.ts";
import { REQUEST_TIMEOUT_MS, send, sendForXml } from "./transport.ts";

const encoder = new TextEncoder();
const DELETE_CONCURRENCY = 16;

function readObjectInfo(key: string, headers: Headers): Result<ObjectInfo> {
  // A missing size would read as an empty object, and a copy would then copy nothing. A missing ETag would make a
  // copy send an empty x-amz-copy-source-if-match.
  if (!headers.has("content-length")) return fail(incompleteResponse("content length"));
  const size = wholeNumber(headers.get("content-length"));
  if (size === undefined) return fail(incompleteResponse("valid content length"));
  const etag = stripQuotes(headers.get("etag") ?? "");
  if (etag === "") return fail(incompleteResponse("ETag"));
  const uploadedAt = validDate(headers.get("last-modified"));
  if (uploadedAt === undefined) return fail(incompleteResponse("valid last-modified date"));
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith(META_PREFIX)) metadata[name.slice(META_PREFIX.length)] = value;
  });
  return ok({
    key,
    size,
    type: headers.get("content-type") ?? undefined,
    disposition: headers.get("content-disposition") ?? undefined,
    etag,
    uploadedAt,
    metadata,
    checksumCrc64nvme: headers.get("x-amz-checksum-crc64nvme") ?? undefined,
  });
}

/** A string is sent as UTF-8 and an ArrayBuffer as its bytes; a Blob or byte view goes as it is. */
function toPayload(body: Uint8Array<ArrayBuffer> | ArrayBuffer | string | Blob): Uint8Array<ArrayBuffer> | Blob {
  if (typeof body === "string") return encoder.encode(body);
  return body instanceof ArrayBuffer ? new Uint8Array(body) : body;
}

function readListedObject(block: string): Result<ListedObject> {
  const key = xmlText(block, "Key");
  if (!key) return fail(incompleteResponse("object key"));
  const size = wholeNumber(xmlText(block, "Size"));
  if (size === undefined) return fail(incompleteResponse("valid object size"));
  const uploadedAt = validDate(xmlText(block, "LastModified"));
  if (uploadedAt === undefined) return fail(incompleteResponse("valid last-modified date"));
  return ok({ key, size, etag: etagIn(block), uploadedAt });
}

async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

type ObjectMethods = Pick<StorageDriver, "head" | "getRange" | "put" | "delete" | "deleteMany" | "list">;

export function objectMethods(ctx: S3Context): ObjectMethods {
  const { rules } = ctx;
  const methods: ObjectMethods = {
    async head(key) {
      const problem = keyProblem(key);
      if (problem) return fail(invalidInput(problem));
      const result = await send(ctx, "HEAD", objectUrl(ctx, key), { headers: { "x-amz-checksum-mode": "ENABLED" } });
      if (result.error) return result.error.code === "NOT_FOUND" ? ok(null) : result;
      return readObjectInfo(key, result.data.headers);
    },

    async getRange(key, start, end) {
      const problem = keyProblem(key) ?? rangeProblem(start, end);
      if (problem) return fail(invalidInput(problem));
      const result = await send(ctx, "GET", objectUrl(ctx, key), { headers: { range: `bytes=${start}-${end}` } });
      if (result.error) return result;
      return ok(result.data.body);
    },

    async put(key, body, given) {
      const options = orEmpty(given);
      const problem =
        keyProblem(key) ??
        bodyProblem(body) ??
        objectOptionsProblem(options) ??
        checksumProblem(options.checksumCrc32c);
      if (problem) return fail(invalidInput(problem));
      const payload = toPayload(body);
      const size = payload instanceof Blob ? payload.size : payload.length;
      const tooLarge = sizeProblem(size, rules.maxSinglePutSize);
      if (tooLarge) return fail(invalidInput(tooLarge));
      const result = await send(ctx, "PUT", objectUrl(ctx, key), {
        headers: writeHeaders(options),
        body: payload,
        // Assumes the link to the storage moves at least 1 MiB/s.
        timeoutMs: REQUEST_TIMEOUT_MS + Math.ceil(size / MiB) * 1000,
      });
      if (result.error) return result;
      const etag = stripQuotes(result.data.headers.get("etag") ?? "");
      return etag ? ok({ etag }) : fail(incompleteResponse("ETag"));
    },

    async delete(key) {
      const problem = keyProblem(key);
      if (problem) return fail(invalidInput(problem));
      const result = await send(ctx, "DELETE", objectUrl(ctx, key));
      if (result.error && result.error.code !== "NOT_FOUND") return result;
      return ok(undefined);
    },

    async deleteMany(keys) {
      const problem = keyListProblem(keys);
      if (problem) return fail(invalidInput(problem));
      const deleted: string[] = [];
      const failed: { key: string; error: CloudropError }[] = [];
      await forEachConcurrently(keys, DELETE_CONCURRENCY, async (key) => {
        const result = await methods.delete(key);
        if (result.error) failed.push({ key, error: result.error });
        else deleted.push(key);
      });
      return ok({ deleted, failed });
    },

    async list(prefix, given) {
      const { cursor, limit = MAX_LIST_PAGE } = orEmpty(given);
      const problem =
        prefixProblem(prefix) ?? limitProblem(limit) ?? (cursor === undefined ? null : cursorProblem(cursor));
      if (problem) return fail(invalidInput(problem));
      const url = new URL(ctx.bucketUrl);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("max-keys", String(limit));
      if (cursor !== undefined) url.searchParams.set("continuation-token", cursor);
      const result = await sendForXml(ctx, "GET", url);
      if (result.error) return result;
      const listed = allOk(xmlBlocks(result.data, "Contents").map(readListedObject));
      if (listed.error) return listed;
      const items = listed.data;
      if (xmlText(result.data, "IsTruncated") !== "true") return ok({ items, nextCursor: null });
      // Ending the listing here would silently skip the rest of the prefix.
      const nextCursor = xmlText(result.data, "NextContinuationToken");
      return nextCursor ? ok({ items, nextCursor }) : fail(incompleteResponse("continuation token"));
    },
  };
  return methods;
}
