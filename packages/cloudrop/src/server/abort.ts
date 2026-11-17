// POST /abort (spec §5.5): the user cancelled, or the client cleans up a failed upload (M3-S15). An expired token
// still aborts what never finished. Without a store it never deletes a stored file once the token has expired: it
// cannot tell an upload that landed from one /complete accepted. With a store, the file's row decides (M5 spec §5.6).

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import type { AbortResponse } from "../protocol/types.ts";
import type { EndpointConfig, EndpointInput } from "./config.ts";
import { storageFailure } from "./http.ts";
import { runOnAbort } from "./plugins.ts";
import { nowSeconds } from "./presign.ts";
import type { FileStatus } from "./store.ts";
import { fileCalls } from "./store-calls.ts";
import { isMultipart, type UploadTokenPayload } from "./token.ts";
import { readToken, tokenAbortContexts } from "./token-request.ts";

/** Ended rows whose upload may have left something in the bucket: cleaning up again is harmless. */
const UNFINISHED: ReadonlySet<FileStatus> = new Set(["aborted", "rejected", "failed", "expired"]);

/**
 * Aborts the multipart upload and deletes this upload's own object (never another writer's), then tells the plugins.
 * `keepStored`: an object that landed is kept with every reservation instead.
 */
async function abortAndDelete(
  config: EndpointConfig,
  token: UploadTokenPayload,
  keepStored: boolean,
): Promise<Result<AbortResponse>> {
  const { storage, logger } = config;
  if (isMultipart(token)) {
    const aborted = await storage.abortMultipart(token.key, token.uploadId);
    if (aborted.error) return fail(storageFailure(aborted.error, logger));
  }
  const head = await storage.head(token.key);
  if (head.error) return fail(storageFailure(head.error, logger));
  if (head.data?.metadata["cloudrop-id"] === token.id) {
    if (keepStored) return ok({ id: token.id });
    const removed = await storage.delete(token.key);
    if (removed.error) return fail(storageFailure(removed.error, logger));
  }
  await runOnAbort(config.plugins, tokenAbortContexts(token, "aborted"), logger);
  return ok({ id: token.id });
}

export async function handleAbort({ body, config }: EndpointInput): Promise<Result<AbortResponse>> {
  // No route lookup: cleaning up must still work after a deploy removed or renamed the token's route.
  const verified = await readToken(body, config, { allowExpired: true });
  if (verified.error) return verified;
  const token = verified.data;
  // `keep` can only narrow what the token allows: an object that landed is never deleted (M3-U94).
  const keep = isPlainObject(body) ? body.keep : undefined;
  if (keep !== undefined && typeof keep !== "boolean") {
    return fail(invalidInput('keep must be true or false. Send { "token": "...", "keep": true }, or leave keep out.'));
  }
  // A single PUT may have landed, and a multipart upload may have completed: without a row, this upload's own object
  // is deleted only while the token is valid, and never when the client asked to keep it.
  if (!config.store || !token.stored) return abortAndDelete(config, token, keep === true || nowSeconds() >= token.exp);
  const ended = await fileCalls(config.store, config.logger, token).end("pending", "aborted");
  if (ended.error) return ended;
  const { changed, record } = ended.data;
  // A completed or completing file is kept, and so is anything the sweep has already settled (cleaned_at): a
  // completion it ended as failed keeps its object, which its onComplete may have recorded.
  const unfinished = changed || (record !== null && UNFINISHED.has(record.status) && record.cleanedAt === null);
  return unfinished ? abortAndDelete(config, token, keep === true) : ok({ id: token.id });
}
