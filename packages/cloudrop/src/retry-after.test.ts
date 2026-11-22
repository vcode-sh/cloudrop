// Contract: RFC 9110 §10.2.3's Retry-After, delay seconds or an HTTP date, read as the wait in milliseconds that the
// server's driver and the client both honour; an HTTP date counts from the answer's Date header when there is one
// (M12-R43). Oracle: the RFC's two forms worked by hand against a fixed clock.

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRetryAfter } from "./retry-after.ts";

describe("parseRetryAfter", () => {
  const date = "Sun, 15 Nov 2026 12:00:00 GMT";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads Retry-After seconds", () => {
    expect(parseRetryAfter("3", date)).toBe(3000);
  });

  it("reads Retry-After as an HTTP date against the answer's Date header, whatever the local clock says", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("Sun, 15 Nov 2026 11:55:00 GMT"));
    expect(parseRetryAfter("Sun, 15 Nov 2026 12:00:10 GMT", date)).toBe(10_000);
  });

  it("reads Retry-After as an HTTP date against the local clock when the answer has no readable Date header", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(date));
    expect(parseRetryAfter("Sun, 15 Nov 2026 12:00:10 GMT", "garbage")).toBe(10_000);
  });

  // NaN or a negative number would reach setTimeout, which treats both as 0 only by accident.
  it.each([{ value: "Thu, 01 Jan 1970 00:00:00 GMT" }, { value: "soon" }, { value: "-1" }])(
    "treats a past date, garbage or a negative number as no Retry-After: $value",
    ({ value }) => {
      expect(parseRetryAfter(value, date)).toBe(0);
    },
  );
});
