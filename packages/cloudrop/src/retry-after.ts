// How long a refused request must wait before it is sent again, shared by the server, which answers it as Retry-After,
// and the client, which honours it (spec 1.0 §2a). 0 means no wait throughout.

// A hidden property, the one record of the wait: CloudropError's public `retryAfter` reads it (M12-R70). An answer body
// carries one too: the 200 of /upload, with the longest wait of the files storage could not start (spec 1.0 §2b). A
// registered symbol, so the server reads the wait of a rateLimited() from a second installed copy of cloudrop (M12-R2).
const WAIT: unique symbol = Symbol.for("cloudrop.retry-after");

/** The wait recorded for `target`, in milliseconds; 0 when none was. */
export const retryAfterOf = (target: object): number => (target as { [WAIT]?: number })[WAIT] ?? 0;

/** A day: no wait longer is sent or reported, so a mistaken one cannot park the client for good (M12-E3). */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * The wait recorded for `target` as a Retry-After value: whole seconds rounded up, at most a day, and undefined when
 * none was. The cap also keeps the header a plain integer: String() writes 1e21 and above in exponent form, which
 * RFC 9110 forbids.
 */
export function retryAfterSeconds(target: object): number | undefined {
  const waitMs = retryAfterOf(target);
  return waitMs > 0 ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(waitMs / 1000)) : undefined;
}

/** Records that `target`'s request must not be sent again for `ms`; a wait of 0 or less records nothing. */
export function waitAtLeast<T extends object>(target: T, ms: number): T {
  // Not enumerable, so the wait never reaches JSON, logs or a spread copy.
  if (ms > 0) Object.defineProperty(target, WAIT, { value: ms, configurable: true, writable: true });
  return target;
}

/**
 * A Retry-After header in milliseconds (RFC 9110 §10.2.3): delay seconds or an HTTP date. 0 when absent, past or
 * unreadable: NaN or a negative number would reach setTimeout, which reads both as 0 only by accident. An HTTP date is
 * read against the answer's own `date` header when the caller can read it, so a local clock minutes off neither
 * stretches the wait past the client's cap nor cuts it to nothing; otherwise against the local clock (M12-R43).
 */
export function parseRetryAfter(value: string | null, date: string | null = null): number {
  if (value === null) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const answeredAt = Date.parse(date ?? "");
  const waitMs = Date.parse(value) - (Number.isNaN(answeredAt) ? Date.now() : answeredAt);
  return Number.isFinite(waitMs) ? Math.max(waitMs, 0) : 0;
}
