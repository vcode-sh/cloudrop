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

  it("leaves metadata out of the request when the caller gives none", async () => {
    // The server refuses any metadata on a route without a schema (ruling M2-D28), null included.
    const { client } = setup();
    const result = await client.upload("notes", note(10));
    expect({ error: result.error, data: result.data?.data }).toEqual({ error: null, data: null });
  });
});
