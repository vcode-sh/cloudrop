// What `authorize` returns to refuse an upload, and how the handler recognises and answers it.

import { CloudropError, type CloudropErrorCode } from "../errors.ts";
import { isPlainObject } from "../input.ts";
import { retryAfterOf, waitAtLeast } from "../retry-after.ts";
import { serverError } from "./http.ts";
import type { Logger } from "./plugins.ts";

// Symbol.for, not Symbol(): two copies of cloudrop in one app must recognise each other's refusals, or one would read
// as a signed-in user.
const DENIED: unique symbol = Symbol.for("cloudrop.unauthorized");

/**
 * Returned by `authorize` to refuse an upload: `unauthorized()` answers UNAUTHORIZED (401), `forbidden()` FORBIDDEN
 * (403), with `message`.
 */
export interface Refusal {
  readonly [DENIED]: true;
  /** Absent on a refusal from a copy of cloudrop that predates forbidden(): it means UNAUTHORIZED. */
  readonly code?: "UNAUTHORIZED" | "FORBIDDEN";
  readonly message: string;
}

const SIGN_IN_MESSAGE = "Sign in to upload files here.";
const NOT_ALLOWED_MESSAGE =
  "You are not allowed to upload files here. Ask the site owner for access if you think this is wrong.";

/** For a caller who is not signed in. */
export function unauthorized(message: string = SIGN_IN_MESSAGE): Refusal {
  return { [DENIED]: true, code: "UNAUTHORIZED", message };
}

/** For a signed-in caller who may not upload this: a quota, a plan or a role. */
export function forbidden(message: string = NOT_ALLOWED_MESSAGE): Refusal {
  return { [DENIED]: true, code: "FORBIDDEN", message };
}

/** Only a plain object carrying the brand refuses: a Response or an Error is never read as a refusal or as a user. */
export function isRefusal(value: unknown): value is Refusal {
  return isPlainObject(value) && (value as Partial<Refusal>)[DENIED] === true;
}

/** A refusal built by plain JavaScript or another copy of cloudrop may lack a code or a message; it still refuses. */
export function refusalError(refusal: Refusal): CloudropError {
  const forbids = refusal.code === "FORBIDDEN";
  const fallback = forbids ? NOT_ALLOWED_MESSAGE : SIGN_IN_MESSAGE;
  const message = typeof refusal.message === "string" && refusal.message !== "" ? refusal.message : fallback;
  return new CloudropError(forbids ? "FORBIDDEN" : "UNAUTHORIZED", message);
}

/**
 * For a caller who sends too many uploads: RATE_LIMITED, retryable, answered 429 with `Retry-After` of `seconds`
 * rounded up, at least 1. The client waits that long before it asks again, or, past its own 20-second cap, leaves the
 * file failed and retryable for the app's `retry()` (M12-E2, M12-E4).
 */
export function rateLimited(seconds: number, message?: string): CloudropError {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new TypeError(
      `rateLimited(seconds) takes a number of seconds of 0 or more, such as 30. It got ${String(seconds)}.`,
    );
  }
  const wait = Math.max(1, Math.ceil(seconds));
  const text = message ?? `Too many upload requests. Try again in ${wait} ${wait === 1 ? "second" : "seconds"}.`;
  return waitAtLeast(new CloudropError("RATE_LIMITED", text, { retryable: true }), wait * 1000);
}

/** The codes `authorize` and `beforeUpload` may refuse an /upload with (spec 1.0 §2a, M12-E1). */
const UPLOAD_REFUSALS: readonly CloudropErrorCode[] = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "FILE_TOO_LARGE",
  "FILE_TYPE_NOT_ALLOWED",
  "TOO_MANY_FILES",
  "INVALID_METADATA",
  "INVALID_INPUT",
  "SERVER_ERROR",
];

/**
 * The answer to an /upload that `source` refused with `error`: rebuilt from its code, message, retryable flag, content
 * and wait, so its parts, file and cause stay on the server. RATE_LIMITED is always retryable. Any other code is a bug of the app's, answered as the
 * generic 500 and logged with the codes it may use.
 */
export function uploadRefusal(error: CloudropError, source: string, logger: Logger): CloudropError {
  if (!UPLOAD_REFUSALS.includes(error.code)) {
    logger.error(
      `cloudrop: ${source} returned ${error.code}, which /upload cannot send. Return one of ${UPLOAD_REFUSALS.join(", ")}.`,
      error,
    );
    return serverError();
  }
  const { code, message, content } = error;
  // RATE_LIMITED always says "try again later": a hand-built one without retryable would never be retried (M12-E1).
  const retryable = error.retryable || code === "RATE_LIMITED";
  return waitAtLeast(new CloudropError(code, message, { retryable, content }), retryAfterOf(error));
}
