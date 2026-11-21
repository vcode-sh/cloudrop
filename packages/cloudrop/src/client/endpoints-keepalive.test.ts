// Contract: M11-R87. A browser fails, unsent, every keepalive request beyond 64 KiB of bodies in flight together
// (measured in Chromium), so the client sends /abort with keepalive only while its own bodies in flight stay within
// 56 KiB, and the rest as ordinary requests: every /abort is sent, however many files are cancelled at once. The bytes
// of an /abort count until its answer was read or its request failed.
// Oracle: the keepalive flag of each request a fetch double saw, against counts worked out by hand from the body size.

import { describe, expect, it } from "vitest";
import { createEndpoints } from "./endpoints.ts";

/** A token that makes the /abort body, `{"token":"…"}`, exactly `bodyBytes` long. */
const tokenFor = (bodyBytes: number) => "t".repeat(bodyBytes - 12);

/** Endpoints on a fetch that records each request's keepalive flag and answers only when `answer()` is called. */
function setup() {
  const flags: boolean[] = [];
  const waiting: ((response: Response) => void)[] = [];
  const endpoints = createEndpoints("/api/cloudrop", (_url, init) => {
    flags.push(init.keepalive === true);
    return new Promise((resolve) => waiting.push(resolve));
  });
  const answer = () => {
    for (const resolve of waiting.splice(0)) resolve(Response.json({ id: "f" }));
  };
  return { endpoints, flags, answer };
}

const count = (flags: boolean[]) => [flags.filter(Boolean).length, flags.filter((flag) => !flag).length];

describe("the keepalive budget of /abort", () => {
  it("sends 230 cancels at once, 201 with keepalive and 29 without, and every one is answered", async () => {
    const { endpoints, flags, answer } = setup();
    // 285 bytes each: 201 bodies are 57,285 bytes, within 56 KiB (57,344); the 202nd would pass it.
    const sent = Array.from({ length: 230 }, () => endpoints.abort(tokenFor(285)));
    answer();
    const results = await Promise.all(sent);

    expect([count(flags), results.filter((result) => result.error).length]).toEqual([[201, 29], 0]);
  });

  it("counts a body until its answer was read, then gives its bytes back", async () => {
    const { endpoints, flags, answer } = setup();
    // Two bodies of 28,672 bytes fill the budget exactly; one more byte does not fit.
    const first = [endpoints.abort(tokenFor(28_672)), endpoints.abort(tokenFor(28_672)), endpoints.abort(tokenFor(13))];
    answer();
    await Promise.all(first);
    const later = endpoints.abort(tokenFor(57_344));
    answer();
    await later;

    expect(flags).toEqual([true, true, false, true]);
  });

  it("gives the bytes back when the request fails", async () => {
    const flags: boolean[] = [];
    const endpoints = createEndpoints("/api/cloudrop", (_url, init) => {
      flags.push(init.keepalive === true);
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    await endpoints.abort(tokenFor(57_344));
    await endpoints.abort(tokenFor(57_344));

    expect(flags).toEqual([true, true]);
  });

  it("never sends one body over the budget with keepalive", async () => {
    const { endpoints, flags, answer } = setup();
    const sent = endpoints.abort(tokenFor(57_345));
    answer();
    await sent;

    expect(flags).toEqual([false]);
  });
});
