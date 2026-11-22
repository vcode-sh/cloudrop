// Contract: RFC 9110 §10.2.3's Retry-After, delay seconds or an HTTP date, read as the wait in milliseconds that the
// server's driver and the client both honour. Oracle: the RFC's two forms worked by hand against a fixed clock.

import { describe, expect, it } from "vitest";
import { parseRetryAfter } from "./retry-after.ts";

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
