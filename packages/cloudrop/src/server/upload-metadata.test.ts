import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SingleTicket } from "../protocol/types.ts";
import { APP_ORIGIN, serverFixture, tokenPayload } from "../testing/server-fixture.ts";
import { files, NOW, png, upload } from "../testing/upload-fixture.ts";
import { allowAnyone, route } from "./route.ts";
import type { StandardSchema } from "./schema.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /upload: metadata", () => {
  // JSON has no undefined: null is metadata the client sent, and a route without a schema takes none.
  it("refuses metadata: null on a route without a schema", async () => {
    const { status, body } = await upload(serverFixture({ files }), { route: "files", files: [png()], metadata: null });
    expect({ status, error: body.error }).toEqual({
      status: 400,
      error: { code: "INVALID_METADATA", message: "This upload takes no metadata. Remove it.", retryable: false },
    });
  });

  it("signs the same metadata JSON it measured, while authorize sees the schema's output", async () => {
    const output = { albumId: "a1", toJSON: (key: string) => (key === "" ? { albumId: "a1" } : "x".repeat(5000)) };
    const schema = {
      "~standard": { version: 1, vendor: "test", validate: () => ({ value: output }) },
    } as StandardSchema;
    const fixture = serverFixture({
      files: route({
        accept: "*/*",
        maxSize: "1GB",
        metadata: schema,
        authorize: ({ metadata }) => ({ live: metadata === output }),
      }),
    });
    const { body } = await upload(fixture, { route: "files", files: [png()], metadata: {} });
    const payload = tokenPayload((body.files[0] as SingleTicket).token);
    expect({ owner: payload.owner, metadata: payload.metadata }).toEqual({
      owner: { live: true },
      metadata: { albumId: "a1" },
    });
  });

  it.for<{ name: string; validate: () => unknown; log: string }>([
    {
      name: "throws",
      validate: () => {
        throw new Error("schema bug");
      },
      log: "Error: schema bug",
    },
    {
      name: "returns a function as metadata",
      validate: () => ({ value: () => 1 }),
      log: "TypeError: The metadata schema returned a value with no JSON form, such as a function. Return plain data from the schema.",
    },
  ])("answers a generic 500 when the schema $name, and logs why", async ({ validate, log }) => {
    const schema = { "~standard": { version: 1, vendor: "test", validate } } as StandardSchema;
    const fixture = serverFixture({
      files: route({ accept: "*/*", maxSize: "1GB", metadata: schema, authorize: allowAnyone }),
    });
    const { status, body } = await upload(fixture, { route: "files", files: [png()], metadata: {} });
    expect({ status, code: body.error?.code, logged: String(fixture.logger.errors[0]?.error) }).toEqual({
      status: 500,
      code: "SERVER_ERROR",
      logged: log,
    });
  });

  // JSON.parse reads any depth, but JSON.stringify and a schema's own walk recurse: 5,000 levels in a 10 KB body
  // overflowed the stack before authorize ran, an error log line for any anonymous caller (M11-R42).
  describe("nested deeply, on a schema that passes any value through", () => {
    const passThrough = {
      "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
    } as StandardSchema;

    /** Posts metadata of `depth` arrays around a 1, written as text: the test's own JSON.stringify would overflow. */
    async function uploadNested(depth: number) {
      const authorize = vi.fn(allowAnyone);
      const fixture = serverFixture({
        files: route({ accept: "*/*", maxSize: "1GB", metadata: passThrough, authorize }),
      });
      const response = await fixture.cloudrop.handler(
        new Request(`${APP_ORIGIN}/api/cloudrop/upload`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"route":"files","files":[${JSON.stringify(png())}],"metadata":${"[".repeat(depth)}1${"]".repeat(depth)}}`,
        }),
      );
      const { error } = (await response.json()) as { error?: unknown };
      return { status: response.status, error, authorized: authorize.mock.calls.length, logged: fixture.logger.errors };
    }

    it.for([5000, 33])("refuses %d levels before authorize runs, without an error log", async (depth) => {
      expect(await uploadNested(depth)).toEqual({
        status: 400,
        error: {
          code: "INVALID_METADATA",
          message: "The metadata is nested more than 32 levels deep. Send a flatter value.",
          retryable: false,
        },
        authorized: 0,
        logged: [],
      });
    });

    it("accepts 32 levels", async () => {
      expect(await uploadNested(32)).toEqual({ status: 200, error: undefined, authorized: 1, logged: [] });
    });
  });
});
