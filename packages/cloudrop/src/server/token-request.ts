import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../storage/validate.ts";
import type { RouteConfig, ServerConfig } from "./config.ts";
import type { AbortContext } from "./plugins.ts";
import { nowSeconds } from "./presign.ts";
import { type UploadTokenPayload, verifyToken } from "./token.ts";

/** The verified token of a `/sign`, `/complete` or `/abort` body. */
export async function readToken(
  body: unknown,
  config: ServerConfig,
  options: { allowExpired?: boolean } = {},
): Promise<Result<UploadTokenPayload>> {
  if (!isPlainObject(body)) return fail(invalidInput('Send a JSON object with the upload token: { "token": "..." }.'));
  return verifyToken(body.token, (await config.tokenKeys).all, nowSeconds(), options);
}

/**
 * The verified token of a `/sign` or `/complete` body and the route it was issued for. The route is looked up again: a
 * route removed by a deploy stops accepting its old tokens.
 */
export async function readTokenRequest(
  body: unknown,
  config: ServerConfig,
): Promise<Result<{ token: UploadTokenPayload; route: RouteConfig }>> {
  const verified = await readToken(body, config);
  if (verified.error) return verified;
  const route = config.routes.get(verified.data.route);
  if (!route) {
    return fail(
      new CloudropError("UNKNOWN_ROUTE", "The upload route of this token no longer exists. Start a new upload."),
    );
  }
  return ok({ token: verified.data, route });
}

/** The onAbort context for a token's file. */
export function abortContext(token: UploadTokenPayload, reason: AbortContext["reason"]): AbortContext {
  const { id, key, name, size, type } = token;
  return {
    route: token.route,
    file: { id, key, name, size, type },
    metadata: token.metadata,
    auth: token.owner,
    reason,
  };
}
