import { describe, expect, it } from "vitest";
import { isAcceptEntry } from "./accept-entry.ts";

describe("isAcceptEntry", () => {
  it.for(["*/*", "image/*", "image/svg+xml", "application/vnd.ms-excel"])("accepts %s", (entry) => {
    expect(isAcceptEntry(entry)).toBe(true);
  });

  it.for(["*", "*/png", "image/", ".png", "IMAGE/PNG", "image/png "])("rejects %j", (entry) => {
    expect(isAcceptEntry(entry)).toBe(false);
  });
});
