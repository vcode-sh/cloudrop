// What `authorize` returns to refuse an upload, and how the handler recognises and answers it.

import { CloudropError } from "../errors.ts";
import { isPlainObject } from "../input.ts";

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
