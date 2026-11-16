// Contract: spec §6.2's first row and decision S9 (at most 6 attempts, full jitter from 0.5 s to 20 s, Retry-After
// waited at least and capped at 20 s) and S14 (a success that arrives after a cancel stays a success). Oracle: the
// full-jitter formula worked by hand with a fixed random value.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudropError, fail, ok } from "../errors.ts";
import { parseRetryAfter, retryDelay, withRetry } from "./retry.ts";

const busy = () => fail(new CloudropError("RATE_LIMITED", "Busy.", { retryable: true }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("retryDelay", () => {
  it.each([
    { name: "waits up to 0.5 s after the first failure", attempt: 1, random: 0.5, retryAfterMs: 0, expected: 250 },
    { name: "doubles the ceiling per failure", attempt: 3, random: 0.5, retryAfterMs: 0, expected: 1000 },
    { name: "never waits longer than 20 s", attempt: 7, random: 0.5, retryAfterMs: 0, expected: 10_000 },
    { name: "waits at least the answer's Retry-After", attempt: 1, random: 0, retryAfterMs: 3000, expected: 3000 },
    { name: "caps Retry-After at 20 s", attempt: 1, random: 0, retryAfterMs: 60_000, expected: 20_000 },
  ])("$name", ({ attempt, random, retryAfterMs, expected }) => {
    vi.spyOn(Math, "random").mockReturnValue(random);
    expect(retryDelay(attempt, retryAfterMs)).toBe(expected);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("Sun, 15 Nov 2026 12:00:00 GMT");

  it("reads Retry-After seconds", () => {
    expect(parseRetryAfter("3", now)).toBe(3000);
  });

  it("reads Retry-After as an HTTP date", () => {
    expect(parseRetryAfter("Sun, 15 Nov 2026 12:00:10 GMT", now)).toBe(10_000);
  });

  // NaN or a negative number would reach setTimeout, which treats both as 0 only by accident.
  it.each([{ value: "Thu, 01 Jan 1970 00:00:00 GMT" }, { value: "soon" }, { value: "-1" }])(
    "treats a past date, garbage or a negative number as no Retry-After: $value",
    ({ value }) => {
      expect(parseRetryAfter(value, now)).toBe(0);
    },
  );
});

describe("withRetry", () => {
  it("retries a retryable error until it succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const run = vi
      .fn()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(ok("stored"));
    const result = await withRetry(run, new AbortController().signal);
    expect({ result, calls: run.mock.calls.length }).toEqual({ result: ok("stored"), calls: 6 });
  });

  it("gives up after 6 attempts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    // Each failure is numbered, so the result shows which attempt it came from.
    const run = vi.fn(async () =>
      fail(new CloudropError("RATE_LIMITED", `Busy ${run.mock.calls.length}.`, { retryable: true })),
    );
    const { error } = await withRetry(run, new AbortController().signal);
    expect({ message: error?.message, calls: run.mock.calls.length }).toEqual({ message: "Busy 6.", calls: 6 });
  });

  it("does not retry an error the server marked final", async () => {
    const final = new CloudropError("FILE_TOO_LARGE", "Too large.");
    const run = vi.fn(async () => fail(final));
    const result = await withRetry(run, new AbortController().signal);
    expect({ error: result.error, calls: run.mock.calls.length }).toEqual({ error: final, calls: 1 });
  });

  it("stops waiting when the upload is cancelled", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const controller = new AbortController();
    const run = vi.fn(async () => busy());
    let settled: Awaited<ReturnType<typeof withRetry>> | undefined;
    void withRetry(run, controller.signal).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(100); // inside the 250 ms pause after the first failure
    controller.abort();
    // Time stands still from here: only the signal can end the pause.
    await vi.advanceTimersByTimeAsync(0);
    expect({ code: settled?.error?.code, calls: run.mock.calls.length, timers: vi.getTimerCount() }).toEqual({
      code: "ABORTED",
      calls: 1,
      timers: 0,
    });
  });

  it("keeps a success that arrives after a cancel", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      return ok("completed");
    });
    const result = await withRetry(run, controller.signal);
    expect({ result, calls: run.mock.calls.length }).toEqual({ result: ok("completed"), calls: 1 });
  });
});
