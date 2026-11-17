// POST /complete (spec §5.4, §7.6): verify what the bucket holds against the token, finish a multipart upload with
// the server's own part list, run afterVerify and onComplete. With a store and a stored token, the file's row decides
// instead (store-complete.ts).

import { fail, ok, type Result } from "../errors.ts";
import type { CompleteResponse } from "../protocol/types.ts";
import { checkAfterVerify, completeContext, encodeResult, unfinished, uploadedFile } from "./complete-steps.ts";
import { cleanUpRefused, verifyUpload } from "./complete-verify.ts";
import type { EndpointInput } from "./config.ts";
import { nowSeconds } from "./presign.ts";
import { completeStored } from "./store-complete.ts";
import { uploadExpired } from "./token.ts";
import { readTokenRequest } from "./token-request.ts";

export async function handleComplete(input: EndpointInput): Promise<Result<CompleteResponse>> {
  const { request, body, config } = input;
  // A store may answer an expired token's retry with the stored result, so the row decides about expiry there.
  const verified = await readTokenRequest(body, config, { allowExpired: config.store !== undefined });
  if (verified.error) return verified;
  const { token, route } = verified.data;
  if (config.store && token.stored) return completeStored(input, config.store, token, route);
  if (nowSeconds() >= token.exp) return fail(uploadExpired());
  const { logger } = config;
  const stored = await verifyUpload(config, token);
  if (stored.kind === "failed") return fail(stored.error);
  if (stored.kind === "refused") return cleanUpRefused(config, token, stored);
  const file = uploadedFile(config, token, route);
  const checked = await checkAfterVerify(request, config, token, file);
  if (checked.kind === "failed") return fail(checked.error);
  if (checked.kind === "refused") return cleanUpRefused(config, token, checked);
  const { onComplete } = route.definition;
  if (!onComplete) return ok({ file, data: null });
  let data: unknown;
  try {
    data = await onComplete(completeContext(request, token, file));
  } catch (error) {
    logger.error(`cloudrop: onComplete failed for route "${route.name}".`, error);
    return fail(unfinished());
  }
  const encoded = encodeResult(logger, route.name, data);
  if (encoded.error) return encoded;
  return ok({ file, data: data === undefined ? null : data });
}
