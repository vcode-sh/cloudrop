// Contract: decisions S4 (the entry's only values are createCloudropClient and CloudropError), S17 (a base path the
// handler cannot be mounted at is a configuration error) and S18 (the default fetch is looked up on each request and
// never called as a method of another object). Oracle: S17's message and the public surface listed in S4.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "./client.ts";

const basePathMessage =
  'basePath must be where the cloudrop handler is mounted, such as "/api/cloudrop" or "https://api.example.com/api/cloudrop": no trailing slash, query or fragment.';

const note = () => new File(["hi"], "note.txt", { type: "text/plain" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createCloudropClient", () => {
  it.each([
    { basePath: "/api/cloudrop", url: "/api/cloudrop/upload" },
    { basePath: "https://api.example.com/api/cloudrop", url: "https://api.example.com/api/cloudrop/upload" },
  ])("sends /upload under a path or an absolute URL: $basePath", async ({ basePath, url }) => {
    const urls: string[] = [];
    const client = createCloudropClient({
      basePath,
      fetch: (requested) => {
        urls.push(requested);
        return Promise.resolve(Response.json({ files: [] }));
      },
    });
    await client.upload("notes", note());
    expect(urls).toEqual([url]);
  });

  it.each([{ basePath: "api/cloudrop" }, { basePath: "/api/cloudrop/" }, { basePath: "/api?x=1" }, { basePath: "" }])(
    "refuses a base path the handler cannot be at: '$basePath'",
    ({ basePath }) => {
      expect(() => createCloudropClient({ basePath, fetch: vi.fn() })).toThrow(
        expect.objectContaining({ name: "CloudropError", code: "INVALID_CONFIG", message: basePathMessage }),
      );
    },
  );

  it("calls the global fetch at request time, not as a method", async () => {
    // A fetch captured at creation would fail on the relative URL and retry; no backoff makes that a failed assertion.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = createCloudropClient();
    const calls: { self: unknown; url: string }[] = [];
    vi.stubGlobal("fetch", function (this: unknown, url: string) {
      calls.push({ self: this, url });
      return Promise.resolve(Response.json({ files: [] }));
    });
    await client.upload("notes", note());
    expect(calls).toEqual([{ self: globalThis, url: "/api/cloudrop/upload" }]);
  });

  it("exports only the two values of the public surface", async () => {
    // The other 29 are types (S4); client/types.test.ts imports the ones a caller annotates with.
    expect(Object.keys(await import("./client.ts")).sort()).toEqual(["CloudropError", "createCloudropClient"]);
  });
});
