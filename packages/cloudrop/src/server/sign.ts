// POST /sign (spec §5.2): new URLs for an upload in progress, at most PARTS_PER_SIGN per call. The token decides the
// key, the sizes and the part count; the request only says which parts.

import { type CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput } from "../input.ts";
import { countParts } from "../plan.ts";
import { PARTS_PER_SIGN, type SignResponse } from "../protocol/types.ts";
import type { EndpointInput } from "./config.ts";
import { storageFailure } from "./http.ts";
import { presignParts, presignSingle } from "./presign.ts";
import { isMultipart } from "./token.ts";
import { readTokenRequest } from "./token-request.ts";

const isPartList = (parts: unknown, count: number): parts is number[] =>
  Array.isArray(parts) &&
  parts.length >= 1 &&
  parts.length <= PARTS_PER_SIGN &&
  new Set(parts).size === parts.length &&
  parts.every((part) => Number.isInteger(part) && part >= 1 && part <= count);

export async function handleSign({ body, config }: EndpointInput): Promise<Result<SignResponse>> {
  // An expiry reached while signing is the client's to handle; anything else is a storage failure.
  const failure = (error: CloudropError) =>
    fail(error.code === "UPLOAD_EXPIRED" ? error : storageFailure(error, config.logger));
  const request = await readTokenRequest(body, config);
  if (request.error) return request;
  const { token } = request.data;
  // After the token verifies, never before: only a pending row may get new URLs (M5 spec §5.4).
  const { store, paths } = config;
  if (store && paths && token.stored) {
    const row = await paths.calls.fileCalls(store, config.logger, token).get();
    if (row.error) return row;
    if (row.data?.status !== "pending") return fail(paths.calls.cancelled());
  }
  // readTokenRequest has checked that the body is an object.
  const { parts } = body as { parts?: unknown };
  if (!isMultipart(token)) {
    if (parts !== undefined) return fail(invalidInput("This upload is a single PUT: send { token } without parts."));
    const put = await presignSingle(config.storage, token);
    return put.error ? failure(put.error) : ok({ put: put.data });
  }
  const count = countParts(token.size, token.partSize);
  if (!isPartList(parts, count)) {
    return fail(invalidInput(`Ask for 1 to ${PARTS_PER_SIGN} different part numbers, each from 1 to ${count}.`));
  }
  const signed = await presignParts(config.storage, token, parts);
  return signed.error ? failure(signed.error) : ok({ parts: signed.data });
}
