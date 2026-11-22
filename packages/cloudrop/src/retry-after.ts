// How long a refused request must wait before it is sent again, shared by the server, which answers it as Retry-After,
// and the client, which honours it (spec 1.0 §2a). 0 means no wait throughout.

// Kept beside the value rather than as a field of CloudropError, which is public and would promise it. An answer body
// carries one too: the 200 of /upload, with the longest wait of the files storage could not start (spec 1.0 §2b).
const waits = new WeakMap<object, number>();

/** The wait recorded for `target`, in milliseconds; 0 when none was. */
export const retryAfterOf = (target: object): number => waits.get(target) ?? 0;

/** Records that `target`'s request must not be sent again for `ms`; a wait of 0 or less records nothing. */
export function waitAtLeast<T extends object>(target: T, ms: number): T {
  if (ms > 0) waits.set(target, ms);
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
