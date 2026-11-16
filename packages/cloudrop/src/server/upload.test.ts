import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MultipartTicket, SingleTicket, UploadResponse } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { serverFixture, tokenPayload } from "../testing/server-fixture.ts";
import { allowAnyone, route, unauthorized } from "./route.ts";
import type { StandardSchema } from "./schema.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const NOW_SECONDS = 1_794_744_000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const albumSchema: StandardSchema<{ albumId: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const albumId = (value as { albumId?: unknown } | null)?.albumId;
      return typeof albumId === "string"
        ? { value: { albumId } }
        : { issues: [{ message: "Expected a string", path: ["albumId"] }] };
    },
  },
};

const avatar = route({
  accept: ["image/png", "image/jpeg"],
  maxSize: "1MB",
  maxFiles: 2,
  metadata: albumSchema,
  authorize: ({ request, metadata }) =>
    request.headers.get("x-user")
      ? { userId: request.headers.get("x-user") as string, albumId: metadata.albumId }
      : unauthorized(),
  prefix: ({ userId, metadata }) => `users/${userId}/${metadata.albumId}`,
});
const files = route({ accept: "*/*", maxSize: "100GB", authorize: allowAnyone });

const signedIn = { "x-user": "42" };
const png = (size = 1024, name = "me.png") => ({ name, size, type: "image/png" });

async function upload(fixture: ReturnType<typeof serverFixture>, body: unknown, headers = signedIn) {
  const response = await fixture.post("upload", body, headers);
  return {
    status: response.status,
    body: (await response.json()) as UploadResponse & { error?: { code: string; message: string } },
  };
}

describe("POST /upload: a single PUT ticket", () => {
  it("signs exactly the headers the bucket must store, with no Content-Length, and a token bound to the file", async () => {
    const fixture = serverFixture({ avatar });
    const { status, body } = await upload(fixture, { route: "avatar", files: [png()], metadata: { albumId: "a1" } });
    const ticket = body.files[0] as SingleTicket;
    expect(status).toBe(200);
    expect(ticket.fileId).toMatch(ULID);
    expect(ticket).toEqual({
      kind: "single",
      fileId: ticket.fileId,
      key: `users/42/a1/${ticket.fileId}.png`,
      token: ticket.token,
      expiresAt: "2026-11-16T12:00:00.000Z",
      put: {
        url: ticket.put.url,
        headers: {
          "content-type": "image/png",
          "content-disposition": "inline; filename=\"me.png\"; filename*=UTF-8''me.png",
          "if-none-match": "*",
          "x-amz-meta-cloudrop-id": ticket.fileId,
        },
        expiresAt: "2026-11-15T12:15:00.000Z",
      },
    });
    expect(tokenPayload(ticket.token)).toEqual({
      v: 1,
      route: "avatar",
      fileId: ticket.fileId,
      key: ticket.key,
      name: "me.png",
      size: 1024,
      type: "image/png",
      owner: { userId: "42", albumId: "a1" },
      metadata: { albumId: "a1" },
      exp: NOW_SECONDS + 86_400,
    });
  });

  it("gives a URL the bucket accepts for exactly the declared bytes and headers, and nothing else", async () => {
    const fixture = serverFixture({ avatar });
    const { body } = await upload(fixture, { route: "avatar", files: [png()], metadata: { albumId: "a1" } });
    const { put } = body.files[0] as SingleTicket;
    // Each refusal is R2's (spike rows 1, 2 and 18), reproduced by the fake.
    expect((await fixture.send(put, new Uint8Array(1023))).status).toBe(403);
    expect(
      (await fixture.send({ ...put, headers: { ...put.headers, "content-type": "text/html" } }, new Uint8Array(1024)))
        .status,
    ).toBe(403);
    expect(
      (await fixture.send({ ...put, headers: { ...put.headers, "x-amz-meta-owner": "me" } }, new Uint8Array(1024)))
        .status,
    ).toBe(403);
    expect((await fixture.send(put, new Uint8Array(1024))).status).toBe(200);
    // Create-only: the same URL cannot overwrite what it wrote.
    expect((await fixture.send(put, new Uint8Array(1024))).status).toBe(412);
  });

  it("ignores a key or upload ID the client adds beside the descriptor", async () => {
    const fixture = serverFixture({ files });
    const { body } = await upload(fixture, {
      route: "files",
      files: [{ name: "a.txt", size: 5, type: "text/plain", key: "../admin/a.txt", uploadId: "x" }],
    });
    const ticket = body.files[0] as SingleTicket;
    expect({ key: ticket.key, uploadId: tokenPayload(ticket.token).uploadId }).toEqual({
      key: `${ticket.fileId}.txt`,
      uploadId: undefined,
    });
  });

  // The policy and the stored headers must read the same normalized type: a mixed-case SVG must still download.
  it("stores a mixed-case SVG type in lower case, as an attachment", async () => {
    const fixture = serverFixture({ files });
    const { body } = await upload(fixture, {
      route: "files",
      files: [{ name: "logo.svg", size: 10, type: "IMAGE/SVG+XML" }],
    });
    const ticket = body.files[0] as SingleTicket;
    expect({ key: ticket.key, headers: ticket.put.headers }).toMatchObject({
      key: `${ticket.fileId}.svg`,
      headers: {
        "content-type": "image/svg+xml",
        "content-disposition": "attachment; filename=\"logo.svg\"; filename*=UTF-8''logo.svg",
      },
    });
  });

  it("keeps a Unicode file name, in NFC, in the stored Content-Disposition", async () => {
    const fixture = serverFixture({ files });
    // "Zoe" plus a combining diaeresis: NFC turns it into one "ë".
    const { body } = await upload(fixture, { route: "files", files: [png(10, "Zoe\u0308.png")] });
    expect((body.files[0] as SingleTicket).put.headers["content-disposition"]).toBe(
      "inline; filename=\"Zo_.png\"; filename*=UTF-8''Zo%C3%AB.png",
    );
  });

  it("stores a file the browser could not type as application/octet-stream, as an attachment", async () => {
    const fixture = serverFixture({ files });
    const { body } = await upload(fixture, { route: "files", files: [{ name: "data", size: 0, type: "" }] });
    expect((body.files[0] as SingleTicket).put.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename=\"data\"; filename*=UTF-8''data",
    });
  });
});

describe("POST /upload: multipart tickets", () => {
  it("creates the upload with the object's headers and returns the plan and the first part URLs", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const { body } = await upload(fixture, {
      route: "files",
      files: [{ name: "big.bin", size: 8 * MiB + 1, type: "application/octet-stream" }],
    });
    const ticket = body.files[0] as MultipartTicket;
    expect({
      kind: ticket.kind,
      partSize: ticket.partSize,
      partCount: ticket.partCount,
      parts: ticket.parts.map(({ partNumber, headers, expiresAt }) => ({ partNumber, headers, expiresAt })),
    }).toEqual({
      kind: "multipart",
      partSize: 8 * MiB,
      partCount: 2,
      parts: [
        { partNumber: 1, headers: {}, expiresAt: "2026-11-15T12:15:00.000Z" },
        { partNumber: 2, headers: {}, expiresAt: "2026-11-15T12:15:00.000Z" },
      ],
    });
    expect(tokenPayload(ticket.token)).toMatchObject({ uploadId: "fake/upload+1==", partSize: 8 * MiB });
    expect(fixture.storageCalls).toEqual([`POST /uploads/${ticket.key}?uploads`]);
  });

  it("signs only the first 20 parts of a 25-part file", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const { body } = await upload(fixture, {
      route: "files",
      files: [{ name: "big.bin", size: 24 * 8 * MiB + 1, type: "application/octet-stream" }],
    });
    const ticket = body.files[0] as MultipartTicket;
    expect({ partCount: ticket.partCount, signed: ticket.parts.map((part) => part.partNumber) }).toEqual({
      partCount: 25,
      signed: Array.from({ length: 20 }, (_, index) => index + 1),
    });
  });
});

describe("POST /upload: authorization comes first", () => {
  it("refuses with authorize's message and starts nothing", async () => {
    const fixture = serverFixture(
      { files: route({ accept: "*/*", maxSize: "1GB", authorize: () => unauthorized("Log in first.") }) },
      { multipartThreshold: 0 },
    );
    const { status, body } = await upload(fixture, {
      route: "files",
      files: [{ name: "a.bin", size: 9 * MiB, type: "" }],
    });
    expect({ status, error: body.error }).toEqual({
      status: 401,
      error: { code: "UNAUTHORIZED", message: "Log in first.", retryable: false },
    });
    expect(fixture.storageCalls).toEqual([]);
  });

  // The authorize result rides in every token, which the browser can read: it must be a small JSON object.
  it.for<{ name: string; auth: unknown; log: string }>([
    {
      name: "null",
      auth: null,
      log: 'TypeError: Route "files": authorize must return a plain object or unauthorized().',
    },
    // A Next.js habit: a 401 Response is an object, so a typeof check alone would sign for it.
    {
      name: "a Response",
      auth: new Response(null, { status: 401 }),
      log: 'TypeError: Route "files": authorize must return a plain object or unauthorized().',
    },
    {
      name: "an Error",
      auth: new Error("Not signed in"),
      log: 'TypeError: Route "files": authorize must return a plain object or unauthorized().',
    },
    // A refusal brand on a class instance is neither a refusal nor a user.
    {
      name: "a branded class instance",
      auth: Object.assign(new (class Denied {})(), { [Symbol.for("cloudrop.unauthorized")]: true, message: "No." }),
      log: 'TypeError: Route "files": authorize must return a plain object or unauthorized().',
    },
    // Its JSON is the text "x": the token would carry an owner that is not an object.
    {
      name: "a plain object whose JSON is not an object",
      auth: { toJSON: () => "x" },
      log: 'TypeError: Route "files": authorize returned an object whose toJSON does not give a JSON object. Return plain data or unauthorized().',
    },
    {
      name: "more than 2 KiB of JSON",
      auth: { record: "x".repeat(2048) },
      log: 'TypeError: Route "files": authorize returned more than 2 KiB of JSON. Return ids, not records.',
    },
  ])("answers 500 when authorize returns $name, and logs why", async ({ auth, log }) => {
    const fixture = serverFixture({ files: route({ accept: "*/*", maxSize: "1GB", authorize: () => auth as object }) });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, code: body.error?.code, logged: String(fixture.logger.errors[0]?.error) }).toEqual({
      status: 500,
      code: "SERVER_ERROR",
      logged: log,
    });
  });

  // A plain-JS or foreign refusal without a usable message is still a refusal, with unauthorized()'s default text.
  it.for([
    { name: "no message", refusal: { [Symbol.for("cloudrop.unauthorized")]: true } },
    { name: "a numeric message", refusal: { [Symbol.for("cloudrop.unauthorized")]: true, message: 5 } },
  ])("refuses a branded refusal with $name with the default message", async ({ refusal }) => {
    const fixture = serverFixture({
      files: route({ accept: "*/*", maxSize: "1GB", authorize: () => refusal as object }),
    });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, error: body.error }).toEqual({
      status: 401,
      error: { code: "UNAUTHORIZED", message: "Sign in to upload files here.", retryable: false },
    });
  });

  // The cap and the token must read one serialization: a toJSON may answer differently for each key it is asked.
  it("signs the same owner JSON it measured, while prefix sees the live authorize result", async () => {
    const live = {
      userId: "42",
      toJSON: (key: string) => (key === "" ? { userId: "42" } : "x".repeat(5000)),
    };
    const fixture = serverFixture({
      files: route({
        accept: "*/*",
        maxSize: "1GB",
        authorize: () => live,
        prefix: (context) => (typeof context.toJSON === "function" ? `users/${context.userId}` : "lost"),
      }),
    });
    const { body } = await upload(fixture, { route: "files", files: [png()] });
    const ticket = body.files[0] as SingleTicket;
    expect({ key: ticket.key, owner: tokenPayload(ticket.token).owner }).toEqual({
      key: `users/42/${ticket.fileId}.png`,
      owner: { userId: "42" },
    });
  });

  it("recognises unauthorized() from another copy of cloudrop in the same app", async () => {
    // What a second installed version's unauthorized() returns: its own module, the same registered symbol.
    const foreign = { [Symbol.for("cloudrop.unauthorized")]: true, message: "Sign in first." };
    const fixture = serverFixture({
      files: route({ accept: "*/*", maxSize: "1GB", authorize: () => foreign as object }),
    });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, error: body.error }).toEqual({
      status: 401,
      error: { code: "UNAUTHORIZED", message: "Sign in first.", retryable: false },
    });
  });

  it("validates metadata before authorize sees it", async () => {
    const authorize = vi.fn(allowAnyone);
    const fixture = serverFixture({
      avatar: route({ accept: "image/png", maxSize: "1MB", metadata: albumSchema, authorize }),
    });
    const { status, body } = await upload(fixture, { route: "avatar", files: [png()], metadata: { albumId: 7 } });
    expect({ status, code: body.error?.code, calls: authorize.mock.calls.length }).toEqual({
      status: 400,
      code: "INVALID_METADATA",
      calls: 0,
    });
  });
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
});
