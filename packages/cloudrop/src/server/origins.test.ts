import { describe, expect, it } from "vitest";
import { originProblem } from "./origins.ts";

// The URL standard forbids only a few characters in a host (https://url.spec.whatwg.org/#forbidden-host-code-point),
// so its parser keeps the ones below. Chromium loads no page from such a host (net::ERR_INVALID_URL), nor from one
// with an empty label, so no page sends it as its origin (measured 2026-11-21, Chromium 159: M11-R176).
describe("the host of an origin", () => {
  it.each(["https://a.example$(id)", "https://a..example"])(
    "is refused when no browser loads a page from it: %s",
    (origin) => {
      expect(originProblem(origin)).toBe(
        `${JSON.stringify(origin)} is not an origin: no browser loads a page from this host. A host is an address, or a name of letters, digits, "-" and "_" in parts joined by single dots. Name the origin of the page that uploads, such as https://app.example.com.`,
      );
    },
  );

  // Each of these Chromium loaded a page from and sent as the page's origin, in the same measurement; [::1] is an
  // address as the URL standard writes one.
  it.each([
    "http://_a.localhost:5173",
    "http://-a.localhost:5173",
    "http://localhost.:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
    "https://xn--bcher-kva.example",
  ])("is accepted when a browser sends it: %s", (origin) => {
    expect(originProblem(origin)).toBeNull();
  });

  it("is checked before a correction is offered, so no refused host is named as the origin to use", () => {
    expect(originProblem("https://A.example$(id)/upload")).toBe(
      '"https://A.example$(id)/upload" is not an origin: no browser loads a page from this host. A host is an address, or a name of letters, digits, "-" and "_" in parts joined by single dots. Name the origin of the page that uploads, such as https://app.example.com.',
    );
  });
});
