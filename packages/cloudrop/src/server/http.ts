// What crosses the wire between the handler and the browser: response bodies, status codes, the origin and CORS rules
// (spec §7.2) and the body cap (spec §7.3).

import { type ClientErrorCode, CloudropError, type CloudropErrorCode, fail, ok, type Result } from "../errors.ts";
import { invalidInput } from "../input.ts";
import { type ErrorBody, isRefusedKind, MAX_BODY_BYTES } from "../protocol/types.ts";
import { retryAfterOf, waitAtLeast } from "../retry-after.ts";
import type { Logger } from "./plugins.ts";

type ServerErrorCode = Exclude<CloudropErrorCode, ClientErrorCode>;

const STATUS = {
  INVALID_INPUT: 400,
  INVALID_CONFIG: 500,
  STORAGE_UNREACHABLE: 502,
  STORAGE_DENIED: 502,
  STORAGE_ERROR: 502,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  NO_SUCH_UPLOAD: 410,
  INVALID_PART: 400,
  CHECKSUM_MISMATCH: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  ORIGIN_NOT_ALLOWED: 403,
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  BODY_TOO_LARGE: 413,
  UNKNOWN_ROUTE: 404,
  INVALID_METADATA: 400,
  TOO_MANY_FILES: 400,
  FILE_TOO_LARGE: 400,
  FILE_TYPE_NOT_ALLOWED: 400,
  ACCOUNT_CHANGED: 409,
  QUOTA_EXCEEDED: 403,
  INVALID_TOKEN: 400,
  UPLOAD_EXPIRED: 410,
  NOT_UPLOADED: 409,
  PARTS_MISSING: 409,
  VERIFICATION_FAILED: 422,
  SERVER_ERROR: 500,
} satisfies Record<ServerErrorCode, number>;

export type ResponseHeaders = Record<string, string>;

/** A MIME type's longest form: RFC 6838 §4.2 allows the type and the subtype 127 characters each. */
const MAX_TYPE_LENGTH = 255;
const REASONS = ["mismatch", "refused", "not-accepted"] as const;
const isType = (value: unknown): boolean => typeof value === "string" && value.length <= MAX_TYPE_LENGTH;

/**
 * Only the code, message, retryable flag, part numbers and a type refusal's `content` leave the server: never a cause,
 * stack or storage code. `retryable` is sent as a boolean and the part numbers only with PARTS_MISSING, or the client
 * could not read the body (M12-R34, M12-R31). `content` is sent as two MIME types, one of three reasons and, with
 * "refused", a kind of the closed set, copied field by field, or not at all: a plugin in plain JavaScript can put a
 * file's key or a whole object there (M11-K3, M11-R137, M12-E6). A kind alone that does not fit is dropped and the
 * rest kept.
 */
export function errorBody(error: CloudropError): ErrorBody {
  const body: ErrorBody = { code: error.code, message: error.message, retryable: error.retryable === true };
  if (error.code === "PARTS_MISSING" && Array.isArray(error.parts))
    body.parts = error.parts.filter((part) => Number.isSafeInteger(part) && part > 0);
  const { content } = error;
  // The types say what these fields are; a plugin in plain JavaScript is not held to them.
  const typed = content && isType(content.declared) && (content.detected === undefined || isType(content.detected));
  if (typed && REASONS.includes(content.reason)) {
    const { declared, detected, reason, kind } = content;
    body.content = { declared, detected, reason };
    if (reason === "refused" && isRefusedKind(kind)) body.content.kind = kind;
  }
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

/**
 * Another `/complete` is running this file's onComplete. Retryable SERVER_ERROR, the one retryable server answer
 * after which the client never sends /abort for a file that may be complete (M3-H16), with `Retry-After: 2`.
 */
export const busy = (): CloudropError =>
  waitAtLeast(
    new CloudropError("SERVER_ERROR", "Another request is completing this upload. Try again in a moment.", {
      retryable: true,
    }),
    2000,
  );

/** A day: no wait longer is sent, so a mistaken one cannot park the client for good (M12-E3). */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * Retry-After for the wait recorded on `answer`, in whole seconds and at most a day, or nothing when there is none. The
 * cap also keeps the value a plain integer: String() writes 1e21 and above in exponent form, which RFC 9110 forbids.
 */
export function retryAfterHeaders(answer: object, cors: ResponseHeaders): ResponseHeaders {
  const waitMs = retryAfterOf(answer);
  if (waitMs === 0) return {};
  // A cross-origin page reads Retry-After only when CORS exposes it.
  const exposed: ResponseHeaders = cors["access-control-allow-origin"]
    ? { "access-control-expose-headers": "Retry-After" }
    : {};
  const seconds = Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(waitMs / 1000));
  return { ...exposed, "retry-after": String(seconds) };
}

export function errorResponse(error: CloudropError, headers: ResponseHeaders = {}): Response {
  // An unknown code would otherwise answer 200.
  if (!hasKnownCode(error)) return errorResponse(serverError(), headers);
  return jsonResponse({ error: errorBody(error) }, STATUS[error.code], {
    ...headers,
    ...retryAfterHeaders(error, headers),
  });
}

/**
 * A storage failure as the browser may see it: no storage code, no endpoint, no advice meant for the operator. The
 * full error goes to the logger.
 */
export function storageFailure(error: CloudropError, logger: Logger): CloudropError {
  logger.error("cloudrop: a storage request failed.", error);
  // The wait the storage asked for is kept: the client honours it before it tries again (M12-E3).
  if (error.code === "RATE_LIMITED") {
    const throttled = new CloudropError("RATE_LIMITED", "The storage service is busy. Try again in a moment.", {
      retryable: true,
    });
    return waitAtLeast(throttled, retryAfterOf(error));
  }
  return error.retryable
    ? waitAtLeast(
        new CloudropError("STORAGE_ERROR", "The storage service failed. Try again in a moment.", { retryable: true }),
        retryAfterOf(error),
      )
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

/** Header names, each an RFC 9110 token (section 5.6.2), separated by commas with optional spaces and tabs. */
const HEADER_LIST = /^[\w!#$%&'*+.^`|~-]+([ \t]*,[ \t]*[\w!#$%&'*+.^`|~-]+)*$/;

/** Answers a CORS preflight. A trusted origin may send the headers it asks for (an app's own auth header, say). */
export function preflight(request: Request, trustedOrigins: ReadonlySet<string>): Response {
  const verdict = checkOrigin(request, trustedOrigins);
  if (!verdict.allowed) return errorResponse(originNotAllowed());
  if (request.headers.get("access-control-request-method") !== "POST") {
    return errorResponse(
      new CloudropError(
        "METHOD_NOT_ALLOWED",
        "This OPTIONS request is not a CORS preflight for POST. Send the request as POST.",
      ),
      { allow: "POST, OPTIONS" },
    );
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
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    // Leaving the loop early cancels the stream.
    for await (const chunk of request.body ?? []) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) return fail(bodyTooLarge());
      chunks.push(chunk);
    }
  } catch {
    return fail(invalidInput("The request body could not be read. Send the request again."));
  }
  try {
    // Decoded chunk by chunk, not joined through a Blob: jsdom 26's Blob has no arrayBuffer() (M11-R2). The last call
    // refuses a body that ends inside a character.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
    return ok(JSON.parse(text + decoder.decode()));
  } catch {
    return fail(invalidInput("The request body is not valid JSON. Send a JSON object."));
  }
}
