// Contract: the `account` option (M10-A). Its value goes percent-encoded as x-cloudrop-account with every /upload,
// retries included, in place of one the headers option sets, and never with /sign, /complete, /abort or a bucket PUT. A
// function is called before each /upload, null or undefined sends no header, its failure fails that /upload unsent with
// NETWORK_ERROR, and a cancel stops its wait. A wrong option throws INVALID_CONFIG. Against a server whose route has a store and `owner`, another account ends the file
// ACCOUNT_CHANGED without a retry, and the same account, in any characters, uploads.
// Oracle: the headers each request reached the fixture with, the requests the fixture saw, literal messages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClientOptions, createCloudropClient } from "../client.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { gate } from "../testing/persist-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "*/*", maxSize: "100MB", authorize: allowAnyone });
const twoParts = () => new File([offsetBytes(8 * MiB + 5)], "two.bin", { type: "application/octet-stream" });
const note = () => new File(["hello"], "note.txt", { type: "text/plain" });

/** A browser page on a server without a store: what account header each request carried, by label. */
function page(fault?: Fault) {
  const seen: string[] = [];
  const fixture = clientFixture(
    { files },
    {
      multipartThreshold: "8MB",
      fault: (call) => {
        seen.push(`${call.label} ${new Headers(call.init.headers).get("x-cloudrop-account")}`);
        return fault?.(call);
      },
    },
  );
  const client = (options: ClientOptions) =>
    createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, ...options });
  return { fixture, seen, client };
}

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const accountFailed = [
  "NETWORK_ERROR",
  "The account option gave no account for a request to the upload server, so it was not sent. Check the function passed as account, then try again.",
  true,
];

describe("the account option", () => {
  it("goes percent-encoded with /upload only, never with /sign, /complete or a bucket PUT", async () => {
    // Part 1's first URL is refused as expired, so the client asks /sign for a new one.
    const expiredOnce: Fault = (call) =>
      call.label === "PUT part 1" && call.nth === 1
        ? errorResponse(403, "ExpiredRequest", "Request has expired")
        : undefined;
    const { seen, client } = page(expiredOnce);
    const { error } = await client({ concurrency: 1, account: "Zoë 42" }).upload("files", twoParts());

    expect({ error, seen: seen.sort() }).toEqual({
      error: null,
      seen: [
        "POST /complete null",
        "POST /sign null",
        "POST /upload Zo%C3%AB%2042",
        "PUT part 1 null",
        "PUT part 1 null",
        "PUT part 2 null",
      ],
    });
  });

  it("replaces the headers option's own account header on /upload, and leaves a cancel's /abort to it", async () => {
    const held = gate((call) => call.label === "PUT object");
    const { seen, client } = page(held.fault);
    const cancel = new AbortController();
    const result = client({ headers: { "x-cloudrop-account": "app" }, account: "u1" }).upload("files", note(), {
      signal: cancel.signal,
    });
    await held.reached;
    cancel.abort();

    expect({ code: (await result).error?.code, seen }).toEqual({
      code: "ABORTED",
      seen: ["POST /upload u1", "PUT object null", "POST /abort app"],
    });
  });

  it("calls a function before each /upload, and null sends no header", async () => {
    const busyOnce: Fault = (call) =>
      call.label === "POST /upload" && call.nth === 1 ? new Response("busy", { status: 503 }) : undefined;
    const { seen, client } = page(busyOnce);
    const answers = [null, "u2"];
    const { error } = await client({ account: () => answers.shift() }).upload("files", note());

    expect({ error, seen }).toEqual({
      error: null,
      seen: ["POST /upload null", "POST /upload u2", "PUT object null", "POST /complete null"],
    });
  });

  it.for([
    { name: "rejects", account: () => Promise.reject(new Error("No session.")) },
    { name: "returns a number", account: () => 42 },
  ])("fails an /upload unsent when the function $name", async ({ account }) => {
    const { fixture, client } = page();
    const { error } = await client({ account } as ClientOptions).upload("files", note());

    expect({ error: error && [error.code, error.message, error.retryable], requests: fixture.requests }).toEqual({
      error: accountFailed,
      requests: [],
    });
  });

  it("answers a cancel while it waits for a function with ABORTED, and sends nothing", async () => {
    const { fixture, client } = page();
    const called = Promise.withResolvers<void>();
    const hung = client({
      account: () => {
        called.resolve();
        return new Promise<string>(() => {});
      },
    });
    const cancel = new AbortController();
    const result = hung.upload("files", note(), { signal: cancel.signal });
    await called.promise;
    cancel.abort();

    expect({ code: (await result).error?.code, requests: fixture.requests }).toEqual({ code: "ABORTED", requests: [] });
  });

  it.for([
    { name: "a number", account: 42 },
    { name: "more than 255 characters", account: "u".repeat(256) },
    // A lone surrogate cannot be percent-encoded.
    { name: "a string that is not well-formed Unicode", account: "u\uD800" },
  ])("refuses $name when the client is created", ({ account }) => {
    expect(() => createCloudropClient({ account } as unknown as ClientOptions)).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          "account must be the signed-in user's id as the route's owner returns it, at most 255 characters, or a function that returns it.",
      }),
    );
  });
});

describe("the account option against a route with a store and owner", () => {
  const owner = "Zoë 42/ü";
  const owned = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone }, { owner: () => owner });

  it.for([
    {
      name: "uploads with the owner's own account",
      account: owner,
      error: null,
      requests: ["POST /upload", "PUT object", "POST /complete"],
    },
    {
      name: "ends the file ACCOUNT_CHANGED, unretried, with another account",
      account: "u2",
      error: [
        "ACCOUNT_CHANGED",
        "The account signed in on this site changed since this page was loaded, so the upload was not started. Reload the page, then upload the file again.",
        false,
      ],
      requests: ["POST /upload"],
    },
  ])("$name", async ({ account, error: expected, requests }) => {
    const fixture = clientFixture({ owned }, { store: memoryStore() });
    const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, account });
    const { error } = await client.upload("owned", note());

    expect({ error: error && [error.code, error.message, error.retryable], requests: fixture.requests }).toEqual({
      error: expected,
      requests,
    });
  });
});
