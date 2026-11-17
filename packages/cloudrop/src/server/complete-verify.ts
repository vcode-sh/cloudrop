// What /complete checks in the bucket (spec §5.4, §7.6): the stored object against the token, or the multipart upload
// against the server's own part plan, finished with the server's part list. The client's word is never taken for
// anything. A check only judges; the caller decides when a refusal may delete, so a store can take the row first.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { countParts, sizeOfPart } from "../plan.ts";
import type { ServerConfig } from "./config.ts";
import { storageFailure } from "./http.ts";
import { runOnAbort } from "./plugins.ts";
import { isMultipart, type MultipartToken, type UploadTokenPayload } from "./token.ts";
import { tokenAbortContexts } from "./token-request.ts";

const DISCARDED = "The uploaded file does not match what was declared, so it was discarded. Upload it again.";

/** What a refusal leaves behind: "delete" the object, "abort" the multipart upload, or "keep" another writer's object. */
export type Cleanup = "delete" | "abort" | "keep";

export type Verdict =
  | { kind: "verified" }
  /** Nothing to clean up: the client retries, uploads again, or is told why. */
  | { kind: "failed"; error: CloudropError }
  /** The upload is over: clean up after it, then tell the plugins. */
  | { kind: "refused"; error: CloudropError; cleanup: Cleanup };

const VERIFIED: Verdict = { kind: "verified" };
const failed = (error: CloudropError): Verdict => ({ kind: "failed", error });

const partChanged = (): CloudropError =>
  new CloudropError(
    "STORAGE_ERROR",
    "A part of the file changed while the upload was being completed. Complete the upload again.",
    { retryable: true },
  );

/** Single PUT: the object must exist with this upload's id, size and type (spec §7.6). */
async function verifyObject(config: ServerConfig, token: UploadTokenPayload): Promise<Verdict> {
  const head = await config.storage.head(token.key);
  if (head.error) return failed(storageFailure(head.error, config.logger));
  const object = head.data;
  if (object === null) {
    return failed(
      new CloudropError("NOT_UPLOADED", "The file has not been uploaded yet. Upload it, then complete the upload."),
    );
  }
  // Another writer's object: never delete it.
  if (object.metadata["cloudrop-id"] !== token.id) {
    const error = new CloudropError(
      "VERIFICATION_FAILED",
      "Another file is stored under this upload's key. Start a new upload.",
    );
    return { kind: "refused", error, cleanup: "keep" };
  }
  if (object.size !== token.size || object.type !== token.type) {
    return { kind: "refused", error: new CloudropError("VERIFICATION_FAILED", DISCARDED), cleanup: "delete" };
  }
  return VERIFIED;
}

/** A multipart upload that no longer exists counts as complete only when HEAD shows its own object (spec §5.4). */
async function completedBefore(config: ServerConfig, token: MultipartToken): Promise<Result<void>> {
  const head = await config.storage.head(token.key);
  if (head.error) return fail(storageFailure(head.error, config.logger));
  if (head.data?.metadata["cloudrop-id"] === token.id && head.data.size === token.size) return ok(undefined);
  return fail(new CloudropError("NO_SUCH_UPLOAD", "This upload was aborted or has expired. Start it again."));
}

const fromResult = (result: Result<void>): Verdict => (result.error ? failed(result.error) : VERIFIED);

/** Multipart: ListParts against the plan, then completion with the server's part list and ETags (spec §7.6, §12). */
async function completeParts(config: ServerConfig, token: MultipartToken): Promise<Verdict> {
  const { storage, logger } = config;
  const listed = await storage.listParts(token.key, token.uploadId);
  if (listed.error) {
    return listed.error.code === "NO_SUCH_UPLOAD"
      ? fromResult(await completedBefore(config, token))
      : failed(storageFailure(listed.error, logger));
  }
  const byNumber = new Map(listed.data.map((part) => [part.partNumber, part]));
  const numbers = Array.from({ length: countParts(token.size, token.partSize) }, (_, index) => index + 1);
  // A wrong-sized part is re-sent like a missing one: R2 accepts it at UploadPart and rejects it only at completion.
  const missing = numbers.filter(
    (partNumber) => byNumber.get(partNumber)?.size !== sizeOfPart(token.size, token.partSize, partNumber),
  );
  if (missing.length > 0) {
    return failed(
      new CloudropError(
        "PARTS_MISSING",
        `${missing.length} of ${numbers.length} parts are missing or have the wrong size. Upload them again, then complete the upload.`,
        { parts: missing },
      ),
    );
  }
  const parts = numbers.map((partNumber) => ({ partNumber, etag: byNumber.get(partNumber)?.etag ?? "" }));
  // Keys are unique, so a 412 here is another writer's object at this key. R2 answers an overlapping completion of
  // this upload with 200 or NoSuchUpload, never 412 (M4-F12).
  const completed = await storage.completeMultipart(token.key, token.uploadId, parts, { ifNoneMatch: true });
  if (!completed.error) return VERIFIED;
  if (completed.error.code === "NO_SUCH_UPLOAD") return fromResult(await completedBefore(config, token));
  if (completed.error.code === "INVALID_PART") {
    // The parts and ETags were listed a moment ago, so a stale one is a part uploaded again in between. The upload
    // stays open: a retry lists the parts again.
    logger.error(
      `cloudrop: a part of file ${token.id} on route "${token.route}" changed while its upload was being completed.`,
      completed.error,
    );
    return failed(partChanged());
  }
  if (completed.error.code === "ALREADY_EXISTS") {
    // A concurrent /complete of this same upload may have won the race: its object carries this upload's id. Only an
    // object shown not to be this upload's is a collision; an unanswered HEAD keeps the reservation for a retry.
    const own = await completedBefore(config, token);
    if (own.error?.code !== "NO_SUCH_UPLOAD") return fromResult(own);
    const error = new CloudropError(
      "ALREADY_EXISTS",
      "Another file already has this upload's key. Start a new upload.",
    );
    return { kind: "refused", error, cleanup: "abort" };
  }
  return failed(storageFailure(completed.error, logger));
}

export function verifyUpload(config: ServerConfig, token: UploadTokenPayload): Promise<Verdict> {
  return isMultipart(token) ? completeParts(config, token) : verifyObject(config, token);
}

/**
 * Ends a refused upload: cleans up after it, then plugins release what they reserved for it. When the delete fails,
 * the object is kept with its reservation and the client retries: the retry checks the object again and discards it
 * then. With `rowEnded` (a store's row already says `rejected`) no retry can reach the object, so the failure is
 * logged, the refusal stands, and the sweep's cleanup pass deletes the object later.
 */
export async function cleanUpRefused(
  config: ServerConfig,
  token: UploadTokenPayload,
  { error, cleanup }: { error: CloudropError; cleanup: Cleanup },
  { rowEnded = false }: { rowEnded?: boolean } = {},
): Promise<Result<never>> {
  const { storage, logger } = config;
  if (cleanup === "delete") {
    const removed = await storage.delete(token.key);
    if (removed.error && !rowEnded) return fail(storageFailure(removed.error, logger));
    if (removed.error) {
      logger.error(
        `cloudrop: could not delete the refused file ${token.id} on route "${token.route}". The sweep's cleanup pass will delete it.`,
        removed.error,
      );
    }
  }
  if (cleanup === "abort" && isMultipart(token)) {
    const aborted = await storage.abortMultipart(token.key, token.uploadId);
    if (aborted.error) {
      logger.error(
        `cloudrop: could not abort the collided upload of file ${token.id} on route "${token.route}".`,
        aborted.error,
      );
    }
  }
  await runOnAbort(config.plugins, tokenAbortContexts(token, "rejected"), logger);
  return fail(error);
}
