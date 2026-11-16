// Untrusted input: the error for it, and the plain-object check every JSON reader uses. Shared by storage, server and
// client.

import { CloudropError } from "./errors.ts";

export function invalidInput(message: string): CloudropError {
  return new CloudropError("INVALID_INPUT", message);
}

/** An object literal or Object.create(null): never an array, a Map, a Response, an Error or another class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
