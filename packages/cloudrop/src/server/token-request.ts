import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import type { EndpointConfig, RouteConfig } from "./config.ts";
import { type AbortContext, abortContexts } from "./plugins.ts";
import { nowSeconds } from "./presign.ts";
import { type UploadTokenPayload, uploadExpired, verifyToken } from "./token.ts";

/** The verified token of a `/sign`, `/complete` or `/abort` body. */
export async function readToken(
  body: unknown,
  config: EndpointConfig,
  options: { allowExpired?: boolean } = {},
): Promise<Result<UploadTokenPayload>> {
  if (!isPlainObject(body)) return fail(invalidInput('Send a JSON object with the upload token: { "token": "..." }.'));
  return verifyToken(body.token, config.tokenKeys.all, nowSeconds(), options);
}

/**
 * The verified token of a `/sign` or `/complete` body and the route it was issued for. The route is looked up again: a
 * route removed by a deploy stops accepting its old tokens. `storedAfterExpiry`: a token whose row a store keeps passes
 * its expiry, for the row to decide (a replay); every other token is refused at expiry, before the route lookup.
 */
export async function readTokenRequest(
  body: unknown,
  config: EndpointConfig,
  options: { storedAfterExpiry?: boolean } = {},
): Promise<Result<{ token: UploadTokenPayload; route: RouteConfig }>> {
  const verified = await readToken(body, config, {
    allowExpired: options.storedAfterExpiry && config.store !== undefined,
  });
  if (verified.error) return verified;
  if (nowSeconds() >= verified.data.exp && !(config.store && verified.data.stored)) return fail(uploadExpired());
  const route = config.routes.get(verified.data.route);
  if (!route) {
    return fail(
      new CloudropError("UNKNOWN_ROUTE", "The upload route of this token no longer exists. Start a new upload."),
    );
  }
  return ok({ token: verified.data, route });
}

/** The onAbort context for a token's file, as the one-element list runOnAbort takes. */
export function tokenAbortContexts(token: UploadTokenPayload, reason: AbortContext["reason"]): AbortContext[] {
  const { id, key, name, size, type } = token;
  return abortContexts(
    { route: token.route, metadata: token.metadata, auth: token.owner },
    [{ id, key, name, size, type }],
    reason,
  );
}
