// The retry budget every client request shares (spec §6.2's first row, decision S9).

import { type CloudropError, fail, type Result } from "../errors.ts";
import { retryAfterOf } from "../retry-after.ts";
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

/**
 * Whether `error` asks for a longer wait than the backoff's cap: such a request is not waited for, and the retryable
 * error goes back to the app, whose retry() asks again later (M12-E4).
 */
export const waitsTooLong = (error: CloudropError): boolean => retryAfterOf(error) > MAX_DELAY_MS;

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
 * Calls `run` until it succeeds, fails with an error that is not retryable or asks to wait too long, or has used
 * MAX_ATTEMPTS. A cancel before
 * an attempt or during a pause returns ABORTED; an answer that arrives after a cancel is returned as it is, since a
 * request that finished must not be reported as cancelled. `first` continues a budget earlier attempts used, and `run`
 * hears which attempt it makes.
 */
export async function withRetry<T>(
  run: (attempt: number) => Promise<Result<T>>,
  signal: AbortSignal,
  first = 1,
): Promise<Result<T>> {
  for (let attempt = first; ; attempt++) {
    if (signal.aborted) return fail(aborted());
    const result = await run(attempt);
    const { error } = result;
    if (!error?.retryable || attempt === MAX_ATTEMPTS || waitsTooLong(error)) return result;
    await pause(retryDelay(attempt, retryAfterOf(error)), signal);
  }
}
