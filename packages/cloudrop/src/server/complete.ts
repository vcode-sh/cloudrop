// POST /complete (spec §5.4, §7.6): verify what the bucket holds against the token, finish a multipart upload with
// the server's own part list, run afterVerify and onComplete. The client's word is never taken for anything.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { countParts, sizeOfPart } from "../plan.ts";
import type { CompleteResponse, UploadedFile } from "../protocol/types.ts";
import type { ObjectInfo } from "../storage/driver.ts";
import { encodeKeyPath } from "../storage/sigv4.ts";
import type { EndpointInput, ServerConfig } from "./config.ts";
import { storageFailure } from "./http.ts";
import { runAfterVerify, runOnAbort } from "./plugins.ts";
import { isMultipart, type MultipartToken, type UploadTokenPayload } from "./token.ts";
import { abortContext, readTokenRequest } from "./token-request.ts";

const DISCARDED = "The uploaded file does not match what was declared, so it was discarded. Upload it again.";

/** The object is verified and kept; a retried /complete verifies it again and reruns the hooks (spec §5.4). */
const unfinished = (): CloudropError =>
  new CloudropError(
    "SERVER_ERROR",
    "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
    { retryable: true },
  );

const partChanged = (): CloudropError =>
  new CloudropError(
    "STORAGE_ERROR",
    "A part of the file changed while the upload was being completed. Complete the upload again.",
    { retryable: true },
  );

/** This upload is over: plugins release what they reserved for it. */
const release = (config: ServerConfig, token: UploadTokenPayload): Promise<void> =>
  runOnAbort(config.plugins, [abortContext(token, "rejected")], config.logger);

/**
 * Deletes a rejected object, then releases its reservation. When the delete fails, the object is kept with its
 * reservation and the client retries: the retry checks the object again and discards it then.
 */
async function discard(config: ServerConfig, token: UploadTokenPayload, error: CloudropError): Promise<Result<never>> {
  const removed = await config.storage.delete(token.key);
  if (removed.error) return fail(storageFailure(removed.error, config.logger));
  await release(config, token);
  return fail(error);
}

/** Single PUT: the object must exist with this upload's id, size and type (spec §7.6). */
async function verifyObject(
  config: ServerConfig,
  token: UploadTokenPayload,
  object: ObjectInfo | null,
): Promise<Result<void>> {
  if (object === null) {
    return fail(
      new CloudropError("NOT_UPLOADED", "The file has not been uploaded yet. Upload it, then complete the upload."),
    );
  }
  // Another writer's object: never delete it.
  if (object.metadata["cloudrop-id"] !== token.fileId) {
    await release(config, token);
    return fail(
      new CloudropError("VERIFICATION_FAILED", "Another file is stored under this upload's key. Start a new upload."),
    );
  }
  if (object.size !== token.size || object.type !== token.type) {
    return discard(config, token, new CloudropError("VERIFICATION_FAILED", DISCARDED));
  }
  return ok(undefined);
}

/** A multipart upload that no longer exists counts as complete only when HEAD shows its own object (spec §5.4). */
async function completedBefore(config: ServerConfig, token: MultipartToken): Promise<Result<void>> {
  const head = await config.storage.head(token.key);
  if (head.error) return fail(storageFailure(head.error, config.logger));
  if (head.data?.metadata["cloudrop-id"] === token.fileId && head.data.size === token.size) return ok(undefined);
  return fail(new CloudropError("NO_SUCH_UPLOAD", "This upload was aborted or has expired. Start it again."));
}

/** Multipart: ListParts against the plan, then completion with the server's part list and ETags (spec §7.6, §12). */
async function completeParts(config: ServerConfig, token: MultipartToken): Promise<Result<void>> {
  const { storage, logger } = config;
  const listed = await storage.listParts(token.key, token.uploadId);
  if (listed.error) {
    return listed.error.code === "NO_SUCH_UPLOAD"
      ? completedBefore(config, token)
      : fail(storageFailure(listed.error, logger));
  }
  const byNumber = new Map(listed.data.map((part) => [part.partNumber, part]));
  const numbers = Array.from({ length: countParts(token.size, token.partSize) }, (_, index) => index + 1);
  // A wrong-sized part is re-sent like a missing one: R2 accepts it at UploadPart and rejects it only at completion.
  const missing = numbers.filter(
    (partNumber) => byNumber.get(partNumber)?.size !== sizeOfPart(token.size, token.partSize, partNumber),
  );
  if (missing.length > 0) {
    return fail(
      new CloudropError(
        "PARTS_MISSING",
        `${missing.length} of ${numbers.length} parts are missing or have the wrong size. Upload them again, then complete the upload.`,
        { parts: missing },
      ),
    );
  }
  const parts = numbers.map((partNumber) => ({ partNumber, etag: byNumber.get(partNumber)?.etag ?? "" }));
  // Keys are unique, so a 412 here is this upload completed by a concurrent call, or another writer's object.
  const completed = await storage.completeMultipart(token.key, token.uploadId, parts, { ifNoneMatch: true });
  if (!completed.error) return ok(undefined);
  if (completed.error.code === "NO_SUCH_UPLOAD") return completedBefore(config, token);
  if (completed.error.code === "INVALID_PART") {
    // The parts and ETags were listed a moment ago, so a stale one is a part uploaded again in between. The upload
    // stays open: a retry lists the parts again.
    logger.error(
      `cloudrop: a part of file ${token.fileId} on route "${token.route}" changed while its upload was being completed.`,
      completed.error,
    );
    return fail(partChanged());
  }
  if (completed.error.code === "ALREADY_EXISTS") {
    // A concurrent /complete of this same upload may have won the race: its object carries this upload's id. Only an
    // object shown not to be this upload's is a collision; an unanswered HEAD keeps the reservation for a retry.
    const own = await completedBefore(config, token);
    if (own.error?.code !== "NO_SUCH_UPLOAD") return own;
    const aborted = await storage.abortMultipart(token.key, token.uploadId);
    if (aborted.error) {
      logger.error(
        `cloudrop: could not abort the collided upload of file ${token.fileId} on route "${token.route}".`,
        aborted.error,
      );
    }
    await release(config, token);
    return fail(new CloudropError("ALREADY_EXISTS", "Another file already has this upload's key. Start a new upload."));
  }
  return fail(storageFailure(completed.error, logger));
}

export async function handleComplete({ request, body, config }: EndpointInput): Promise<Result<CompleteResponse>> {
  const verified = await readTokenRequest(body, config);
  if (verified.error) return verified;
  const { token, route } = verified.data;
  const { storage, logger } = config;
  let stored: Result<void>;
  if (isMultipart(token)) {
    stored = await completeParts(config, token);
  } else {
    const head = await storage.head(token.key);
    stored = head.error ? fail(storageFailure(head.error, logger)) : await verifyObject(config, token, head.data);
  }
  if (stored.error) return stored;
  const file: UploadedFile = {
    id: token.fileId,
    key: token.key,
    name: token.name,
    size: token.size,
    type: token.type,
    url: route.visibility === "public" ? `${storage.publicUrl}/${encodeKeyPath(token.key)}` : null,
  };
  const context = { request, route: route.name, file, metadata: token.metadata, auth: token.owner, storage };
  let refused: CloudropError | undefined;
  try {
    refused = await runAfterVerify(config.plugins, context);
  } catch (error) {
    logger.error(`cloudrop: a plugin's afterVerify failed for route "${route.name}".`, error);
    return fail(unfinished());
  }
  if (refused) return discard(config, token, refused);
  const { onComplete } = route.definition;
  if (!onComplete) return ok({ file, data: null });
  let data: unknown;
  try {
    // /upload checked that authorize returned a plain object; the token carries its JSON snapshot.
    data = await onComplete({ ...(token.owner as object), request, file, metadata: token.metadata });
  } catch (error) {
    logger.error(`cloudrop: onComplete failed for route "${route.name}".`, error);
    return fail(unfinished());
  }
  try {
    // Encoded here, not when the answer is sent, so the failure is reported as onComplete's.
    JSON.stringify(data);
  } catch (error) {
    logger.error(
      `cloudrop: onComplete for route "${route.name}" returned a value JSON cannot encode (a BigInt or a cycle).`,
      error,
    );
    return fail(unfinished());
  }
  return ok({ file, data: data === undefined ? null : data });
}
