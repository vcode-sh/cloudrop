// The steps both /complete paths share once the bucket holds the upload: the file the client is sent, the plugins'
// afterVerify, onComplete's context and its result as JSON.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import type { UploadedFile } from "../protocol/types.ts";
import { encodeKeyPath } from "../storage/sigv4.ts";
import type { Verdict } from "./complete-verify.ts";
import type { RouteConfig, ServerConfig } from "./config.ts";
import type { Logger } from "./plugins.ts";
import { runAfterVerify } from "./plugins.ts";
import type { UploadTokenPayload } from "./token.ts";

/** The object is verified and kept; a retried /complete verifies it again and reruns the hooks (spec §5.4). */
export const unfinished = (): CloudropError =>
  new CloudropError(
    "SERVER_ERROR",
    "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
    { retryable: true },
  );

export function uploadedFile(config: ServerConfig, token: UploadTokenPayload, route: RouteConfig): UploadedFile {
  const { id, key, name, size, type } = token;
  const url = route.visibility === "public" ? `${config.storage.publicUrl}/${encodeKeyPath(key)}` : null;
  return { id, key, name, size, type, url };
}

/** afterVerify on every plugin: a refusal discards the object; a throw keeps it and asks the client to retry. */
export async function checkAfterVerify(
  request: Request,
  config: ServerConfig,
  token: UploadTokenPayload,
  file: UploadedFile,
): Promise<Verdict> {
  const { route, metadata, owner: auth } = token;
  let refused: CloudropError | undefined;
  try {
    refused = await runAfterVerify(config.plugins, { request, route, file, metadata, auth, storage: config.storage });
  } catch (error) {
    config.logger.error(`cloudrop: a plugin's afterVerify failed for route "${route}".`, error);
    return { kind: "failed", error: unfinished() };
  }
  return refused ? { kind: "refused", error: refused, cleanup: "delete" } : { kind: "verified" };
}

/** The fields cloudrop sets on every completion context; the authorize JSON's own fields sit beside them. */
export interface CompletionFields {
  request: Request;
  file: UploadedFile;
  metadata: unknown;
}

export function completeContext(request: Request, token: UploadTokenPayload, file: UploadedFile): CompletionFields {
  // /upload checked that authorize returned a plain object; the token carries its JSON snapshot.
  return { ...(token.owner as object), request, file, metadata: token.metadata };
}

/**
 * onComplete's result as JSON, undefined for a result JSON leaves out (undefined, a function), or why it cannot be
 * sent: encoded here, not when the answer is sent, so the failure is reported as onComplete's.
 */
export function encodeResult(logger: Logger, route: string, data: unknown): Result<string | undefined> {
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch (error) {
    logger.error(
      `cloudrop: onComplete for route "${route}" returned a value JSON cannot encode (a BigInt or a cycle).`,
      error,
    );
    return fail(unfinished());
  }
  return ok(json);
}
