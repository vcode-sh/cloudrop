import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import type { FileTicket, MultipartTicket, SingleTicket, UploadResponse } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import type { FetchLike } from "../storage/driver.ts";
import { r2 } from "../storage/presets.ts";
import { serverFixture, tokenPayload } from "../testing/server-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
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
      log: 'TypeError: Route "files": authorize must return a plain object or unauthorized().',
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

describe("POST /upload: policy", () => {
  it("accepts a file of exactly maxSize and refuses one byte more, per file", async () => {
    const fixture = serverFixture({ avatar });
    const { body } = await upload(fixture, {
      route: "avatar",
      files: [png(MiB, "exact.png"), png(MiB + 1, "over.png")],
      metadata: { albumId: "a1" },
    });
    expect(body.files.map((ticket: FileTicket) => (ticket.kind === "rejected" ? ticket.error : ticket.kind))).toEqual([
      "single",
      {
        code: "FILE_TOO_LARGE",
        message: "This file is over the 1 MiB limit. Pick a smaller file.",
        retryable: false,
      },
    ]);
  });

  it.for([
    {
      name: "a type the route does not accept",
      file: { name: "a.gif", size: 1, type: "image/gif" },
      message: "This upload does not accept image/gif files.",
    },
    {
      name: "an extension that contradicts the type",
      file: { name: "a.html", size: 1, type: "image/png" },
      message: "The file name ends in .html, which does not match its type image/png. Rename the file or pick another.",
    },
    {
      name: "a type with parameters",
      file: { name: "a.png", size: 1, type: "image/png; x=1" },
      message: "The file's type is not a valid MIME type. Pick another file.",
    },
  ])("refuses $name", async ({ file, message }) => {
    const { body } = await upload(serverFixture({ avatar }), {
      route: "avatar",
      files: [file],
      metadata: { albumId: "a1" },
    });
    expect(body.files[0]).toEqual({
      kind: "rejected",
      error: { code: "FILE_TYPE_NOT_ALLOWED", message, retryable: false },
    });
  });

  it("takes maxFiles files and refuses one more", async () => {
    const fixture = serverFixture({ avatar });
    const two = await upload(fixture, { route: "avatar", files: [png(), png()], metadata: { albumId: "a1" } });
    const three = await upload(fixture, { route: "avatar", files: [png(), png(), png()], metadata: { albumId: "a1" } });
    expect([two.status, three.status, three.body.error]).toEqual([
      200,
      400,
      { code: "TOO_MANY_FILES", message: "This upload takes at most 2 files at once. Send fewer.", retryable: false },
    ]);
  });
});

describe("POST /upload: malformed requests from plain JavaScript", () => {
  const fileRule =
    'needs a name of 1 to 255 characters, a size in bytes and a type, such as { "name": "a.png", "size": 1024, "type": "image/png" }.';
  it.for<{ name: string; body: unknown; code: string; message: string }>([
    {
      name: "an array body",
      body: [],
      code: "INVALID_INPUT",
      message: "Send a JSON object: { route, files, metadata }.",
    },
    {
      name: "a numeric route",
      body: { route: 1, files: [png()] },
      code: "INVALID_INPUT",
      message: 'Name the upload route, such as { "route": "avatar" }.',
    },
    {
      name: "an unknown route",
      body: { route: "banner", files: [png()] },
      code: "UNKNOWN_ROUTE",
      message: 'There is no upload route named "banner". Check the route name.',
    },
    // A route name with a line break would forge a line in whatever logs the message.
    {
      name: "an unknown route with a line break",
      body: { route: "x\nERROR", files: [png()] },
      code: "UNKNOWN_ROUTE",
      message: "There is no upload route with that name. Check the route name.",
    },
    // A plain-object lookup would find Object.prototype here.
    {
      name: "an inherited property as route",
      body: { route: "__proto__", files: [png()] },
      code: "UNKNOWN_ROUTE",
      message: 'There is no upload route named "__proto__". Check the route name.',
    },
    {
      name: "no files",
      body: { route: "files", files: [] },
      code: "INVALID_INPUT",
      message: 'Send at least one file as { "name", "size", "type" }.',
    },
    {
      name: "files as an object",
      body: { route: "files", files: { 0: png() } },
      code: "INVALID_INPUT",
      message: 'Send at least one file as { "name", "size", "type" }.',
    },
    {
      name: "a null file",
      body: { route: "files", files: [png(), null] },
      code: "INVALID_INPUT",
      message: `File 2 ${fileRule}`,
    },
    {
      name: "a negative size",
      body: { route: "files", files: [png(-1)] },
      code: "INVALID_INPUT",
      message: `File 1 ${fileRule}`,
    },
    {
      name: "a fractional size",
      body: { route: "files", files: [png(1.5)] },
      code: "INVALID_INPUT",
      message: `File 1 ${fileRule}`,
    },
    {
      name: "a size as text",
      body: { route: "files", files: [{ name: "a", size: "10", type: "" }] },
      code: "INVALID_INPUT",
      message: `File 1 ${fileRule}`,
    },
    {
      name: "an empty name",
      body: { route: "files", files: [png(1, "")] },
      code: "INVALID_INPUT",
      message: `File 1 ${fileRule}`,
    },
    {
      name: "a 256-character name",
      body: { route: "files", files: [png(1, "a".repeat(256))] },
      code: "INVALID_INPUT",
      message: `File 1 ${fileRule}`,
    },
    {
      name: "a name with a lone surrogate",
      body: { route: "files", files: [png(1, "a\ud800.png")] },
      code: "INVALID_INPUT",
      message: `File 1 ${fileRule}`,
    },
    // U+0344 is two code points in NFC: 255 of them are 510 once normalized.
    {
      name: "a name over 255 characters once normalized",
      body: { route: "files", files: [png(1, "\u0344".repeat(255))] },
      code: "INVALID_INPUT",
      message: `File 1 ${fileRule}`,
    },
    {
      name: "a numeric type",
      body: { route: "files", files: [{ name: "a", size: 1, type: 5 }] },
      code: "INVALID_INPUT",
      message: `File 1 ${fileRule}`,
    },
  ])("refuses $name", async ({ body, code, message }) => {
    const result = await upload(serverFixture({ files }), body);
    expect(result.body.error).toEqual({ code, message, retryable: false });
  });

  it("counts a name's length in characters, so 255 emoji pass", async () => {
    // 255 code points are 510 UTF-16 code units: a .length check would refuse this name.
    const { status } = await upload(serverFixture({ files }), { route: "files", files: [png(1, "😀".repeat(255))] });
    expect(status).toBe(200);
  });
});

describe("POST /upload: keys", () => {
  it("normalizes the key the prefix built to NFC", async () => {
    const decomposed = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone, prefix: () => "cafe\u0301" });
    const { body } = await upload(serverFixture({ files: decomposed }), { route: "files", files: [png()] });
    const ticket = body.files[0] as SingleTicket;
    expect(ticket.key).toBe(`café/${ticket.fileId}.png`);
  });

  it.for([
    { name: "a relative folder with a trailing slash", prefix: "users/42/", folder: "users/42/" },
    { name: "an empty folder (the bucket root)", prefix: "", folder: "" },
  ])("stores under $name", async ({ prefix, folder }) => {
    const rooted = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone, prefix: () => prefix });
    const { body } = await upload(serverFixture({ files: rooted }), { route: "files", files: [png()] });
    const ticket = body.files[0] as SingleTicket;
    expect(ticket.key).toBe(`${folder}${ticket.fileId}.png`);
  });

  it.for<{ name: string; prefix: unknown; log: string }>([
    // A prefix is often a tenant folder: falling back to the bucket root would mix tenants silently.
    {
      name: "returns no string",
      prefix: undefined,
      log: 'TypeError: Route "files": prefix must return a string, got undefined.',
    },
    // Trimming the trailing slashes of "/" would leave "", the bucket root.
    {
      name: "is an absolute path",
      prefix: "/",
      log: 'TypeError: Route "files": prefix must be a relative folder such as "users/42", without a leading slash.',
    },
  ])("answers a prefix that $name with a generic 500 instead of using the bucket root", async ({ prefix, log }) => {
    const broken = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone, prefix: () => prefix as string });
    const fixture = serverFixture({ files: broken });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, code: body.error?.code, logged: String(fixture.logger.errors[0]?.error) }).toEqual({
      status: 500,
      code: "SERVER_ERROR",
      logged: log,
    });
  });

  it("answers a prefix that would escape its folder with a generic 500 and logs why", async () => {
    // The prefix often holds user data (an id, a team name); a traversal there is a server bug, never a user's key.
    const escaping = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone, prefix: () => "users/../admin" });
    const fixture = serverFixture({ files: escaping });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, code: body.error?.code }).toEqual({ status: 500, code: "SERVER_ERROR" });
    expect(String(fixture.logger.errors[0]?.error)).toBe(
      "TypeError: Route \"files\" built an unusable key: The object key contains a '.' or '..' segment. Use plain path segments.",
    );
  });
});

describe("POST /upload: storage failures and plugins", () => {
  it("rejects only the file whose upload could not start, without the storage's own message, and releases it", async () => {
    const fake = serverFixture({ files }).fake;
    // The bucket refuses to start a multipart upload, as R2 does for a token without write access.
    const refusing: FetchLike = (input, init) =>
      new URL(String(input)).searchParams.has("uploads")
        ? Promise.resolve(
            new Response("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", { status: 403 }),
          )
        : fake.fetch(input, init);
    const storage = r2({
      bucket: "uploads",
      accountId: "0123456789abcdef0123456789abcdef",
      accessKeyId: "k",
      secretAccessKey: "s",
      fetch: refusing,
    });
    const events: string[] = [];
    const quota: CloudropPlugin = {
      id: "quota",
      server: { onAbort: ({ reason, file }) => void events.push(`release ${reason} ${file.name}`) },
    };
    const fixture = serverFixture({ files }, { storage, multipartThreshold: MiB, plugins: [quota] });
    const { body } = await upload(fixture, { route: "files", files: [png(2 * MiB, "big.png"), png(10, "small.png")] });
    expect(body.files.map((ticket: FileTicket) => (ticket.kind === "rejected" ? ticket.error : ticket.kind))).toEqual([
      {
        code: "STORAGE_ERROR",
        message: "The storage service refused the request. Contact the site owner if this keeps happening.",
        retryable: false,
      },
      "single",
    ]);
    expect({
      logged: fixture.logger.errors.map(({ message, error }) => [message, (error as CloudropError).code]),
      events,
    }).toEqual({
      logged: [["cloudrop: the storage service refused a request.", "STORAGE_DENIED"]],
      events: ["release failed big.png"],
    });
  });

  it("lets a plugin refuse the request and releases what earlier plugins reserved", async () => {
    const events: string[] = [];
    const reserving: CloudropPlugin = {
      id: "reserving",
      server: {
        beforeUpload: ({ files: accepted }) => {
          events.push(`reserve ${accepted.length}`);
          return undefined;
        },
        onAbort: ({ reason, file }) => {
          events.push(`release ${reason} ${file.name}`);
        },
      },
    };
    const quota = new CloudropError("TOO_MANY_FILES", "You have no upload quota left.");
    const refusing: CloudropPlugin = {
      id: "refusing",
      server: { beforeUpload: () => quota, onAbort: () => void events.push("refusing released") },
    };
    const fixture = serverFixture({ files }, { plugins: [reserving, refusing] });
    const { status, body } = await upload(fixture, { route: "files", files: [png(1, "a.png")] });
    expect({ status, error: body.error, events }).toEqual({
      status: 400,
      error: { code: "TOO_MANY_FILES", message: "You have no upload quota left.", retryable: false },
      events: ["reserve 1", "release rejected a.png"],
    });
  });

  it("hands beforeUpload only the accepted files, with their keys", async () => {
    const seen: { name: string; key: string }[] = [];
    const recorder: CloudropPlugin = {
      id: "recorder",
      server: {
        beforeUpload: ({ files: accepted }) => void seen.push(...accepted.map(({ name, key }) => ({ name, key }))),
      },
    };
    const fixture = serverFixture({ avatar }, { plugins: [recorder] });
    const { body } = await upload(fixture, {
      route: "avatar",
      files: [png(1, "ok.png"), png(1, "bad.gif")],
      metadata: { albumId: "a1" },
    });
    expect(seen).toEqual([{ name: "ok.png", key: (body.files[0] as SingleTicket).key }]);
  });
});
