// Contract: decisions S4 (the entry's only values are createCloudropClient and CloudropError), S17 (a base path the
// handler cannot be mounted at, a fetch option that is not a function, a concurrency or an order outside spec §4.4's
// values, or a persist or a namespace outside ruling M3-U79's is a configuration error (client/persist.test.ts shows
// a namespace of exactly 256 characters accepted); null options are none, as for createCloudrop) and S18 (the default
// fetch is looked up on each request and never called as a method of another object). Oracle: S17's messages, spec
// §4.4 and the public surface listed in S4.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClientOptions, createCloudropClient } from "./client.ts";

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

  it.each([
    { name: "text", concurrency: "4" },
    { name: "0", concurrency: 0 },
    { name: "17", concurrency: 17 },
    { name: "a fraction", concurrency: 2.5 },
    { name: "NaN", concurrency: Number.NaN },
  ])('refuses a concurrency that is not "auto" or a whole number from 1 to 16: $name', ({ concurrency }) => {
    expect(() => createCloudropClient({ concurrency, fetch: vi.fn() } as unknown as ClientOptions)).toThrow(
      expect.objectContaining({
        name: "CloudropError",
        code: "INVALID_CONFIG",
        message: 'concurrency must be "auto" or a whole number from 1 to 16.',
      }),
    );
  });

  it("refuses an order it does not know", () => {
    expect(() => createCloudropClient({ order: "largest-first", fetch: vi.fn() } as unknown as ClientOptions)).toThrow(
      expect.objectContaining({
        name: "CloudropError",
        code: "INVALID_CONFIG",
        message: 'order must be "added" or "smallest-first".',
      }),
    );
  });

  it.each([
    { name: "persist as text", options: { persist: "yes" }, message: "persist must be true or false." },
    {
      name: "a namespace that is a number",
      options: { namespace: 42 },
      message: "namespace must be a string of at most 256 characters, such as the signed-in user's id.",
    },
    {
      name: "a namespace of 257 characters",
      options: { namespace: "u".repeat(257) },
      message: "namespace must be a string of at most 256 characters, such as the signed-in user's id.",
    },
  ])("refuses $name (ruling M3-U79)", ({ options, message }) => {
    expect(() => createCloudropClient({ ...options, fetch: vi.fn() } as unknown as ClientOptions)).toThrow(
      expect.objectContaining({ name: "CloudropError", code: "INVALID_CONFIG", message }),
    );
  });

  it("treats null options as none, as createCloudrop does", async () => {
    // Plain JavaScript such as createCloudropClient(settings.cloudrop ?? null).
    vi.spyOn(Math, "random").mockReturnValue(0);
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return Promise.resolve(Response.json({ files: [] }));
    });
    const client = createCloudropClient(null as unknown as ClientOptions);
    await client.upload("notes", note());
    expect(urls).toEqual(["/api/cloudrop/upload"]);
  });

  it("refuses a fetch option that is not a function", () => {
    expect(() => createCloudropClient({ fetch: "fetch" } as unknown as ClientOptions)).toThrow(
      expect.objectContaining({
        name: "CloudropError",
        code: "INVALID_CONFIG",
        message: "The fetch option must be a function.",
      }),
    );
  });

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
