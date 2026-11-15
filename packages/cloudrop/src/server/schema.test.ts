import { describe, expect, it } from "vitest";
import { type StandardSchema, validateMetadata } from "./schema.ts";

// A hand-written Standard Schema, shaped as the specification defines it, so the test depends on no schema library.
function albumSchema(): StandardSchema<{ albumId: string }, { albumId: string; tags: string[] }> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: async (value) => {
        const albumId = (value as { albumId?: unknown } | null)?.albumId;
        if (typeof albumId !== "string")
          return { issues: [{ message: "Expected a string", path: [{ key: "albumId" }] }] };
        return { value: { albumId, tags: [] } };
      },
    },
  };
}

describe("validateMetadata", () => {
  it("returns the schema's output, not the input", async () => {
    expect(await validateMetadata(albumSchema(), { albumId: "a1", extra: "dropped" })).toEqual({
      data: { albumId: "a1", tags: [] },
      error: null,
    });
  });

  it("explains the first issue with its path", async () => {
    expect((await validateMetadata(albumSchema(), { albumId: 7 })).error).toMatchObject({
      code: "INVALID_METADATA",
      status: 400,
      message: "The metadata is not valid: Expected a string (at albumId). Correct it and try again.",
    });
  });

  it("refuses metadata on a route without a schema", async () => {
    expect((await validateMetadata(undefined, { albumId: "a1" })).error).toMatchObject({
      code: "INVALID_METADATA",
      message: "This upload takes no metadata. Remove it.",
    });
  });

  it("accepts no metadata on a route without a schema", async () => {
    expect(await validateMetadata(undefined, undefined)).toEqual({ data: undefined, error: null });
  });

  it.for([
    // {"albumId":"…"} is 14 bytes of JSON around the value: 2034 ASCII characters make exactly 2048 bytes.
    { name: "exactly 2048 bytes", value: "a".repeat(2034), error: null },
    {
      name: "2049 bytes",
      value: "a".repeat(2035),
      error: "The metadata is larger than 2 KiB. Send less, and keep large values in your database.",
    },
    // 1017 "é" are 2034 bytes but 1017 characters: counting characters would accept these 2049 bytes.
    {
      name: "2049 bytes of mostly two-byte characters",
      value: `${"é".repeat(1017)}a`,
      error: "The metadata is larger than 2 KiB. Send less, and keep large values in your database.",
    },
  ])("checks the JSON size of the output: $name", async ({ value, error }) => {
    const passthrough: StandardSchema = {
      "~standard": { version: 1, vendor: "test", validate: (input) => ({ value: input }) },
    };
    const result = await validateMetadata(passthrough, { albumId: value });
    expect(result.error?.message ?? null).toBe(error);
  });

  it("cuts a long schema message to 200 characters", async () => {
    const verbose: StandardSchema = {
      "~standard": { version: 1, vendor: "test", validate: () => ({ issues: [{ message: "x".repeat(500) }] }) },
    };
    expect((await validateMetadata(verbose, {})).error?.message).toBe(
      `The metadata is not valid: ${"x".repeat(200)}. Correct it and try again.`,
    );
  });

  it("cuts a path built from the client's keys to 200 characters and drops its line breaks", async () => {
    const echoing: StandardSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [{ message: "Bad", path: [`a\nERROR forged ${"k".repeat(300)}`] }] }),
      },
    };
    // "Bad (at a ERROR forged " is 23 characters, so 177 of the 300 k's fit.
    expect((await validateMetadata(echoing, {})).error?.message).toBe(
      `The metadata is not valid: Bad (at a ERROR forged ${"k".repeat(177)}. Correct it and try again.`,
    );
  });
});
