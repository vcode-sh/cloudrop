// Contract: spec §5 and §5.4 through the real client: one upload() call starts the file, sends its bytes as one PUT or
// as parts cut where the server planned, completes it and returns the route's result, or the server's verdict; and it
// refuses what plain JavaScript can get wrong before any request (decision S17, ruling S-2). Oracle: the values
// server/protocol.test.ts expects from the same handler, and the bytes the fake bucket stored.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import type { Result } from "../errors.ts";
import { MiB } from "../rules.ts";
import { allowAnyone, route, unauthorized } from "../server/route.ts";
import { clientFixture } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { offsetBytes } from "../testing/storage-contract.ts";
import { albumSchema } from "../testing/upload-fixture.ts";

const albums = route({
  accept: ["image/png", "application/octet-stream"],
  maxSize: "100MB",
  metadata: albumSchema,
  authorize: ({ request }) => {
    const userId = request.headers.get("x-user");
    return userId ? { userId } : unauthorized("Sign in to upload to an album.");
  },
  prefix: ({ userId }) => `users/${userId}`,
  onComplete: ({ userId, file, metadata }) => ({ owner: userId, bytes: file.size, albumId: metadata.albumId }),
});

const notes = route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone });

/** `x-user` stands in for the session cookie a browser would send with credentials: "include". */
function setup({ signedIn = true } = {}) {
  const appHeaders = signedIn ? { "x-user": "42" } : undefined;
  const fixture = clientFixture({ albums, notes }, { multipartThreshold: "8MB", appHeaders });
  return { fixture, client: createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch }) };
}

const metadata = { albumId: "a1" };
const note = (size: number) => new File([offsetBytes(size)], "note.txt", { type: "text/plain" });
const errorOf = ({ error }: Result<unknown>) => ({
  code: error?.code,
  message: error?.message,
  retryable: error?.retryable,
});

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("upload", () => {
  it("uploads a small file in three requests and returns the route's result", async () => {
    const { fixture, client } = setup();
    const bytes = offsetBytes(1000);
    const result = await client.upload("albums", new File([bytes], "pic.png", { type: "image/png" }), { metadata });
    const key = `users/42/${result.data?.file.id}.png`;
    expect({
      result,
      requests: fixture.requests,
      stored: (await fixture.server.storage.getRange(key, 0, 999)).data,
    }).toEqual({
      result: {
        data: {
          file: { id: expect.any(String), key, name: "pic.png", size: 1000, type: "image/png", url: null },
          data: { owner: "42", bytes: 1000, albumId: "a1" },
        },
        error: null,
      },
      requests: ["POST /upload", "PUT object", "POST /complete"],
      stored: bytes,
    });
  });

  it("uploads a multipart file in two parts cut where the server planned", async () => {
    const { fixture, client } = setup();
    const bytes = offsetBytes(8 * MiB + 5);
    const file = new File([bytes], "video.bin", { type: "application/octet-stream" });
    const { data, error } = await client.upload("albums", file, { metadata });
    const boundary = await fixture.server.storage.getRange(data?.file.key ?? "", 8 * MiB - 2, 8 * MiB + 1);
    // The two parts run side by side, so their order in the list is not part of the contract.
    expect({ error, requests: [...fixture.requests].sort(), boundary: boundary.data }).toEqual({
      error: null,
      requests: ["POST /complete", "POST /upload", "PUT part 1", "PUT part 2"],
      boundary: bytes.slice(8 * MiB - 2, 8 * MiB + 2),
    });
  });

  it("returns authorize's refusal without sending bytes", async () => {
    const { fixture, client } = setup({ signedIn: false });
    const result = await client.upload("albums", new File([offsetBytes(10)], "pic.png", { type: "image/png" }), {
      metadata,
    });
    expect({ error: errorOf(result), requests: fixture.requests }).toEqual({
      error: { code: "UNAUTHORIZED", message: "Sign in to upload to an album.", retryable: false },
      requests: ["POST /upload"],
    });
  });

  it("returns the server's verdict on a file the route refuses", async () => {
    const { fixture, client } = setup();
    const result = await client.upload("notes", note(17));
    expect({ error: errorOf(result), requests: fixture.requests }).toEqual({
      error: {
        code: "FILE_TOO_LARGE",
        message: "This file is over the 16 bytes limit. Pick a smaller file.",
        retryable: false,
      },
      requests: ["POST /upload"],
    });
  });

  it.each([
    {
      name: "a route that is not text",
      args: [42, note(1)],
      message: 'Name the upload route as text, such as upload("avatar", file).',
    },
    {
      name: "a file that is not a File",
      args: ["notes", "x"],
      message: 'Pass the file as a File, such as one from <input type="file">.',
    },
    {
      name: "options that are not an object",
      args: ["notes", note(1), "fast"],
      message: "Pass the upload options as an object, such as { metadata, signal }.",
    },
    {
      name: "a signal that is not an AbortSignal",
      args: ["notes", note(1), { signal: {} }],
      message: "options.signal must be an AbortSignal, such as new AbortController().signal.",
    },
    {
      name: "metadata JSON cannot encode",
      args: ["albums", note(1), { metadata: { albumId: 1n } }],
      message:
        "options.metadata must be JSON data, such as objects, strings and numbers: it holds a value JSON cannot encode, such as a BigInt or a circular reference.",
    },
  ])("refuses arguments from plain JavaScript before any request: $name", async ({ args, message }) => {
    const { fixture, client } = setup();
    // What a caller without TypeScript can pass.
    const upload = client.upload as (...args: unknown[]) => ReturnType<typeof client.upload>;
    const result = await upload(...args);
    expect({ error: errorOf(result), requests: fixture.requests }).toEqual({
      error: { code: "INVALID_INPUT", message, retryable: false },
      requests: [],
    });
  });

  describe("the client's connection pool (spec §4.4)", () => {
    /** A client whose fixture counts the bucket PUTs in flight and keeps the highest count. */
    function counting(
      options: { concurrency?: number },
      answer: (label: string) => Response | undefined = () => undefined,
    ) {
      const seen = { inFlight: 0, most: 0 };
      const fixture = clientFixture(
        { albums },
        {
          multipartThreshold: "8MB",
          appHeaders: { "x-user": "42" },
          fault: async ({ label, init, forward }) => {
            if (!label.startsWith("PUT")) return undefined;
            const instead = answer(label);
            if (instead) return instead;
            seen.inFlight++;
            seen.most = Math.max(seen.most, seen.inFlight);
            // One turn of the event loop, so PUTs started together overlap here.
            await Promise.resolve();
            try {
              return await forward(init);
            } finally {
              seen.inFlight--;
            }
          },
        },
      );
      const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, ...options });
      const upload = (bytes: number) =>
        client.upload("albums", new File([offsetBytes(bytes)], "video.bin"), { metadata });
      return { seen, upload, fixture };
    }
    const threeParts = 16 * MiB + 1;

    it.each([
      { name: "concurrency 2", concurrency: 2, most: 2 },
      { name: "the default of 4", concurrency: undefined, most: 4 },
    ])("caps the PUTs of two uploads on one client: $name", async ({ concurrency, most }) => {
      const { seen, upload } = counting({ concurrency });
      const results = await Promise.all([upload(threeParts), upload(threeParts)]);
      expect({ errors: results.map((r) => r.error), most: seen.most }).toEqual({ errors: [null, null], most });
    });

    it.each([
      { name: "a 3-part file", bytes: threeParts, most: 3 },
      { name: "a 9-part file", bytes: 8 * 8 * MiB + 1, most: 4 },
    ])("keeps one file to 4 PUTs in flight under concurrency 16: $name", async ({ bytes, most }) => {
      const { seen, upload } = counting({ concurrency: 16 });
      const { error } = await upload(bytes);
      expect({ error, most: seen.most }).toEqual({ error: null, most });
    });

    it("starts no part that was still waiting for a slot when another part failed the file", async () => {
      const { fixture, upload } = counting({ concurrency: 1 }, (label) =>
        label === "PUT part 1" ? errorResponse(400, "BadRequest", "Rejected.") : undefined,
      );
      const result = await upload(3 * 8 * MiB + 1);
      // Part 2 is granted the slot part 1 gives back before parts.ts reads part 1's answer as a failure: the one PUT
      // that window lets through. Parts 3 and 4, still waiting, never start.
      expect({ code: result.error?.code, puts: fixture.requests.filter((r) => r.startsWith("PUT")) }).toEqual({
        code: "UPLOAD_REJECTED",
        puts: ["PUT part 1", "PUT part 2"],
      });
    });
  });

  it("leaves metadata out of the request when the caller gives none", async () => {
    // The server refuses any metadata on a route without a schema (ruling M2-D28), null included.
    const { client } = setup();
    const result = await client.upload("notes", note(10));
    expect({ error: result.error, data: result.data?.data }).toEqual({ error: null, data: null });
  });
});
