import { fail, ok } from "../../errors.ts";
import { invalidInput } from "../../input.ts";
import type { PresignedRequest, StorageDriver } from "../driver.ts";
import { presignUrl } from "../sigv4.ts";
import {
  checksumProblem,
  expiryProblem,
  keyProblem,
  objectOptionsProblem,
  partNumberProblem,
  sizeProblem,
  uploadIdProblem,
} from "../validate.ts";
import { objectUrl, type S3Context } from "./context.ts";
import { orEmpty, writeHeaders } from "./options.ts";

// X-Amz-Date takes toISOString's year, which has four digits only up to 9999. Times before 1970 are refused too: no
// presigned URL needs one, and they usually mean a seconds value was passed where milliseconds belong.
const SIGNABLE_UNTIL_MS = Date.UTC(10000, 0, 1);

/** X-Amz-Date drops the milliseconds, so the URL expires counting from the start of the signing second. */
function expiryOf(signedAt: Date, expiresIn: number): Date {
  return new Date(Math.floor(signedAt.getTime() / 1000) * 1000 + expiresIn * 1000);
}

async function presign(
  ctx: S3Context,
  url: URL,
  headers: Record<string, string>,
  size: number,
  expiresIn: number,
): Promise<PresignedRequest> {
  const { now, credentials, region } = ctx;
  const date = now();
  const signed = await presignUrl({
    method: "PUT",
    url,
    headers: { ...headers, "content-length": String(size) },
    credentials,
    region,
    date,
    expiresIn,
  });
  return { method: "PUT", url: signed.toString(), headers, expiresAt: expiryOf(date, expiresIn) };
}

export function presignMethods(ctx: S3Context): Pick<StorageDriver, "presignPut" | "presignPart" | "presignGet"> {
  const { now, credentials, region, rules } = ctx;
  return {
    async presignPut(key, given) {
      const options = orEmpty(given);
      const problem =
        keyProblem(key) ??
        objectOptionsProblem(options) ??
        checksumProblem(options.checksumCrc32c) ??
        sizeProblem(options.size, rules.maxSinglePutSize) ??
        expiryProblem(options.expiresIn, rules.maxPresignSeconds);
      if (problem) return fail(invalidInput(problem));
      return ok(await presign(ctx, objectUrl(ctx, key), writeHeaders(options), options.size, options.expiresIn));
    },

    async presignPart(key, uploadId, partNumber, given) {
      const options = orEmpty(given);
      const problem =
        keyProblem(key) ??
        uploadIdProblem(uploadId) ??
        partNumberProblem(partNumber, rules.maxParts) ??
        checksumProblem(options.checksumCrc32c) ??
        sizeProblem(options.size, rules.maxPartSize, "part") ??
        expiryProblem(options.expiresIn, rules.maxPresignSeconds);
      if (problem) return fail(invalidInput(problem));
      const headers: Record<string, string> = options.checksumCrc32c
        ? { "x-amz-checksum-crc32c": options.checksumCrc32c }
        : {};
      const url = objectUrl(ctx, key, { partNumber: String(partNumber), uploadId });
      return ok(await presign(ctx, url, headers, options.size, options.expiresIn));
    },

    async presignGet(key, given) {
      const options = orEmpty(given);
      const signedAt = options.signedAt ?? now();
      const problem =
        keyProblem(key) ??
        expiryProblem(options.expiresIn, rules.maxPresignSeconds) ??
        objectOptionsProblem({ disposition: options.disposition }) ??
        (signedAt instanceof Date &&
        signedAt.getTime() >= 0 &&
        signedAt.getTime() + options.expiresIn * 1000 < SIGNABLE_UNTIL_MS
          ? null
          : "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.");
      if (problem) return fail(invalidInput(problem));
      const query: Record<string, string> = options.disposition
        ? { "response-content-disposition": options.disposition }
        : {};
      const url = await presignUrl({
        method: "GET",
        url: objectUrl(ctx, key, query),
        credentials,
        region,
        date: signedAt,
        expiresIn: options.expiresIn,
      });
      return ok({ url: url.toString(), expiresAt: expiryOf(signedAt, options.expiresIn) });
    },
  };
}
