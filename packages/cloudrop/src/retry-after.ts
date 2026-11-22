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
 * unreadable: NaN or a negative number would reach setTimeout, which reads both as 0 only by accident.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number {
  if (value === null) return 0;
  const waitMs = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(waitMs) ? Math.max(waitMs, 0) : 0;
}
