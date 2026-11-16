// POST /abort (spec §5.5): the user cancelled. An expired token still aborts what never finished, but never deletes a
// stored file: /abort keeps no state and cannot tell an upload that landed from one /complete accepted.

import { fail, ok, type Result } from "../errors.ts";
import type { AbortResponse } from "../protocol/types.ts";
import type { EndpointInput } from "./config.ts";
import { storageFailure } from "./http.ts";
import { runOnAbort } from "./plugins.ts";
import { nowSeconds } from "./presign.ts";
import { isMultipart } from "./token.ts";
import { abortContext, readToken } from "./token-request.ts";

export async function handleAbort({ body, config }: EndpointInput): Promise<Result<AbortResponse>> {
  // No route lookup: cleaning up must still work after a deploy removed or renamed the token's route.
  const verified = await readToken(body, config, { allowExpired: true });
  if (verified.error) return verified;
  const token = verified.data;
  const { storage, logger } = config;
  if (isMultipart(token)) {
    const aborted = await storage.abortMultipart(token.key, token.uploadId);
    if (aborted.error) return fail(storageFailure(aborted.error, logger));
  }
  // A single PUT may have landed, and a multipart upload may have completed: this upload's own object (never another
  // writer's) is deleted while the token is valid, and kept, with every reservation, once it has expired.
  const head = await storage.head(token.key);
  if (head.error) return fail(storageFailure(head.error, logger));
  if (head.data?.metadata["cloudrop-id"] === token.id) {
    if (nowSeconds() >= token.exp) return ok({ id: token.id });
    const removed = await storage.delete(token.key);
    if (removed.error) return fail(storageFailure(removed.error, logger));
  }
  await runOnAbort(config.plugins, [abortContext(token, "aborted")], logger);
  return ok({ id: token.id });
}
