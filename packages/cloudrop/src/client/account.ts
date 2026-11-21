// The client's `account` option (M10-A): the user this page shows, sent with /upload only, so that the server can
// refuse an upload that a sign-in in another tab would make someone else's.

/** The signed-in user's id for /upload only, or a function, possibly async, that gives it; null sends none (M10-A). */
export type Account = string | (() => string | null | undefined | Promise<string | null | undefined>);

/**
 * The account as the header sends it, percent-encoded (M10-A2), or null when `value` is not one: not a string, over
 * owner()'s 255 characters (MAX_OWNER_LENGTH on the server), or with a lone surrogate, which encodeURIComponent refuses.
 * String.isWellFormed would say the same, but is newer than the browsers the client supports (M4-F6).
 */
export function encodeAccount(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 255) return null;
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}
