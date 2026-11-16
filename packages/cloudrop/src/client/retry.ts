// The retry budget every client request shares (spec §6.2's first row, decision S9).

import { type CloudropError, fail, type Result } from "../errors.ts";
import { aborted } from "./failures.ts";

/** Attempts per request, the first one included. */
export const MAX_ATTEMPTS: number = 6;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 20_000;

/** Full jitter: a random wait up to 0.5 s, 1 s, 2 s… (at most 20 s), never shorter than the answer's Retry-After. */
export function retryDelay(failedAttempts: number, retryAfterMs = 0): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failedAttempts - 1));
  return Math.min(MAX_DELAY_MS, Math.max(retryAfterMs, Math.random() * ceiling));
}

/** A Retry-After header in milliseconds: delay seconds or an HTTP date. 0 when absent, past or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number {
  if (value === null) return 0;
  const waitMs = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(waitMs) ? Math.max(waitMs, 0) : 0;
}

// Kept beside the error rather than as a field of CloudropError, which is public and would promise it.
const retryAfters = new WeakMap<CloudropError, number>();

/** The Retry-After recorded for `error`'s answer, 0 when none. */
export const retryAfterOf = (error: CloudropError): number => retryAfters.get(error) ?? 0;

/** Records that `error`'s request must not be tried again before `retryAfterMs` (its answer's Retry-After). */
export function waitAtLeast(error: CloudropError, retryAfterMs: number): CloudropError {
  retryAfters.set(error, retryAfterMs);
  return error;
}

/** Waits `ms`, or less when the signal fires. Never rejects: the caller checks `signal.aborted` afterwards. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Calls `run` until it succeeds, fails with an error that is not retryable, or has used MAX_ATTEMPTS. A cancel before
 * an attempt or during a pause returns ABORTED; an answer that arrives after a cancel is returned as it is, since a
 * request that finished must not be reported as cancelled.
 */
export async function withRetry<T>(run: () => Promise<Result<T>>, signal: AbortSignal): Promise<Result<T>> {
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) return fail(aborted());
    const result = await run();
    const { error } = result;
    if (!error?.retryable || attempt === MAX_ATTEMPTS) return result;
    await pause(retryDelay(attempt, retryAfterOf(error)), signal);
  }
}
