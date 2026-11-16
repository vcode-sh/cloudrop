// What crosses the wire between the handler and the browser: response bodies, status codes, the origin and CORS rules
// (spec §7.2) and the body cap (spec §7.3).

import { type ClientErrorCode, CloudropError, type CloudropErrorCode, fail, ok, type Result } from "../errors.ts";
import { invalidInput } from "../input.ts";
import { type ErrorBody, MAX_BODY_BYTES } from "../protocol/types.ts";
import type { Logger } from "./plugins.ts";

type ServerErrorCode = Exclude<CloudropErrorCode, ClientErrorCode>;

const STATUS = {
  INVALID_INPUT: 400,
  INVALID_CONFIG: 500,
  STORAGE_UNREACHABLE: 502,
  STORAGE_DENIED: 502,
  STORAGE_ERROR: 502,
  RATE_LIMITED: 503,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  NO_SUCH_UPLOAD: 410,
  INVALID_PART: 400,
  CHECKSUM_MISMATCH: 400,
  UNAUTHORIZED: 401,
  ORIGIN_NOT_ALLOWED: 403,
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  BODY_TOO_LARGE: 413,
  UNKNOWN_ROUTE: 404,
  INVALID_METADATA: 400,
  TOO_MANY_FILES: 400,
  FILE_TOO_LARGE: 400,
  FILE_TYPE_NOT_ALLOWED: 400,
  INVALID_TOKEN: 400,
  UPLOAD_EXPIRED: 410,
  NOT_UPLOADED: 409,
  PARTS_MISSING: 409,
  VERIFICATION_FAILED: 422,
  SERVER_ERROR: 500,
} satisfies Record<ServerErrorCode, number>;

export type ResponseHeaders = Record<string, string>;

/** Only the code, message, retryable flag and part numbers leave the server: never a cause, stack or storage code. */
export function errorBody(error: CloudropError): ErrorBody {
  const body: ErrorBody = { code: error.code, message: error.message, retryable: error.retryable };
  if (error.parts) body.parts = [...error.parts];
  return body;
}

export function jsonResponse(body: unknown, status: number, headers: ResponseHeaders = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    // Tokens and presigned URLs must never sit in a shared cache.
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export const serverError = (): CloudropError =>
  new CloudropError(
    "SERVER_ERROR",
    "The server could not handle the upload. Contact the site owner if this keeps happening.",
  );

/**
 * Whether the server may send this code. CloudropError does not check its code: one from plain JavaScript may have
 * none of ours, and the client's own codes (ClientErrorCode) have no HTTP status either.
 */
export const hasKnownCode = (error: CloudropError): error is CloudropError & { code: ServerErrorCode } =>
  Object.hasOwn(STATUS, error.code);

export function errorResponse(error: CloudropError, headers: ResponseHeaders = {}): Response {
  // An unknown code would otherwise answer 200.
  if (!hasKnownCode(error)) return errorResponse(serverError(), headers);
  return jsonResponse({ error: errorBody(error) }, STATUS[error.code], headers);
}

/**
 * A storage failure as the browser may see it: no storage code, no endpoint, no advice meant for the operator. The
 * full error goes to the logger.
 */
export function storageFailure(error: CloudropError, logger: Logger): CloudropError {
  logger.error("cloudrop: a storage request failed.", error);
  if (error.code === "RATE_LIMITED") {
    return new CloudropError("RATE_LIMITED", "The storage service is busy. Try again in a moment.", {
      retryable: true,
    });
  }
  return error.retryable
    ? new CloudropError("STORAGE_ERROR", "The storage service failed. Try again in a moment.", {
        retryable: true,
      })
    : new CloudropError(
        "STORAGE_ERROR",
        "The storage service refused the request. Contact the site owner if this keeps happening.",
      );
}

export type OriginCheck = { allowed: false } | { allowed: true; cors: ResponseHeaders };

/**
 * Same-origin requests and trustedOrigins pass. A request without Origin passes too: every browser sends Origin on a
 * POST, so its absence means a server or a native app, where cross-site request forgery does not apply. "null" (a
 * sandboxed frame or a file: page) never matches.
 */
export function checkOrigin(request: Request, trustedOrigins: ReadonlySet<string>): OriginCheck {
  const origin = request.headers.get("origin");
  if (origin === null) {
    // A browser that strips Origin still sends Sec-Fetch-Site; servers and native apps send neither.
    return request.headers.get("sec-fetch-site") === "cross-site" ? { allowed: false } : { allowed: true, cors: {} };
  }
  if (origin === new URL(request.url).origin) return { allowed: true, cors: {} };
  if (!trustedOrigins.has(origin)) return { allowed: false };
  // The exact origin, never "*": the browser refuses "*" with credentials, and "*" would open the handler to every site.
  return {
    allowed: true,
    cors: { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" },
  };
}

export const originNotAllowed = (): CloudropError =>
  new CloudropError(
    "ORIGIN_NOT_ALLOWED",
    "This site may not upload here. Add its origin to trustedOrigins in createCloudrop.",
  );

const HEADER_LIST = /^[A-Za-z0-9-]+(\s*,\s*[A-Za-z0-9-]+)*$/;

/** Answers a CORS preflight. A trusted origin may send the headers it asks for (an app's own auth header, say). */
export function preflight(request: Request, trustedOrigins: ReadonlySet<string>): Response {
  const verdict = checkOrigin(request, trustedOrigins);
  if (!verdict.allowed || request.headers.get("access-control-request-method") !== "POST") {
    return errorResponse(originNotAllowed());
  }
  const requested = request.headers.get("access-control-request-headers") ?? "";
  return new Response(null, {
    status: 204,
    headers: {
      ...verdict.cors,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": HEADER_LIST.test(requested) ? requested : "content-type",
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin, Access-Control-Request-Headers",
    },
  });
}

/** application/json is not a CORS-safelisted type, so a cross-origin page must preflight before it can post here. */
export function isJsonRequest(request: Request): boolean {
  return /^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "");
}

const bodyTooLarge = (): CloudropError =>
  new CloudropError("BODY_TOO_LARGE", "The request is larger than 64 KiB. Send fewer files at once.");

/** The parsed JSON body, read up to MAX_BODY_BYTES; a longer body is cancelled, not read to the end. */
export async function readJson(request: Request): Promise<Result<unknown>> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return fail(bodyTooLarge());
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const reader = request.body?.getReader();
    for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) {
      length += chunk.value.length;
      if (length > MAX_BODY_BYTES) {
        await reader?.cancel();
        return fail(bodyTooLarge());
      }
      chunks.push(chunk.value);
    }
  } catch {
    return fail(invalidInput("The request body could not be read. Send the request again."));
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return ok(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return fail(invalidInput("The request body is not valid JSON. Send a JSON object."));
  }
}
