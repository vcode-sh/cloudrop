import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import type { FileTicket, SingleTicket } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { avatar, files, NOW, png, upload } from "../testing/upload-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { allowAnyone, route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
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
      name: "a type that is not a MIME type",
      file: { name: "a.png", size: 1, type: "png" },
      message: "The file's type is not a valid MIME type. Pick another file.",
    },
    {
      // Parameters are dropped (M9-H1); the essence still has to pass the policy.
      name: "a type whose essence the route does not accept",
      file: { name: "a.gif", size: 1, type: "image/gif; x=1" },
      message: "This upload does not accept image/gif files.",
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
    ...[
      { name: "a 15-character idempotencyKey", idempotencyKey: "a".repeat(15) },
      { name: "a 129-character idempotencyKey", idempotencyKey: "a".repeat(129) },
      { name: "an idempotencyKey with a dot", idempotencyKey: "0123456789abcdef.0" },
      { name: "a null idempotencyKey", idempotencyKey: null },
      { name: "a numeric idempotencyKey", idempotencyKey: 1234567890123456 },
    ].map(({ name, idempotencyKey }) => ({
      name,
      body: { route: "files", files: [png()], idempotencyKey },
      code: "INVALID_INPUT",
      message: 'Send idempotencyKey as 16 to 128 letters, digits, "-" or "_", such as a UUID, or leave it out.',
    })),
  ])("refuses $name", async ({ body, code, message }) => {
    const result = await upload(serverFixture({ files }), body);
    expect(result.body.error).toEqual({ code, message, retryable: false });
  });

  it("takes an idempotencyKey of 16 and of 128 characters, and without a store answers the same key twice", async () => {
    const fixture = serverFixture({ files });
    const shortest = "A-_0".repeat(4);
    const longest = "z".repeat(128);
    const answers = await Promise.all(
      [shortest, shortest, longest].map((idempotencyKey) =>
        upload(fixture, { route: "files", files: [png()], idempotencyKey }),
      ),
    );
    expect(answers.map(({ status, body }) => [status, body.files?.[0]?.kind])).toEqual([
      [200, "single"],
      [200, "single"],
      [200, "single"],
    ]);
  });

  it("counts a name's length in characters, so 255 emoji pass", async () => {
    // 255 code points are 510 UTF-16 code units: a .length check would refuse this name.
    const { status } = await upload(serverFixture({ files }), { route: "files", files: [png(1, "😀".repeat(255))] });
    expect(status).toBe(200);
  });
});

describe("POST /upload: keys", () => {
  it("normalizes the key the prefix built to NFC", async () => {
    const decomposed = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone }, { prefix: () => "cafe\u0301" });
    const { body } = await upload(serverFixture({ files: decomposed }), { route: "files", files: [png()] });
    const ticket = body.files[0] as SingleTicket;
    expect(ticket.key).toBe(`café/${ticket.id}.png`);
  });

  it.for([
    { name: "a relative folder with a trailing slash", prefix: "users/42/", folder: "users/42/" },
    { name: "an empty folder (the bucket root)", prefix: "", folder: "" },
  ])("stores under $name", async ({ prefix, folder }) => {
    const rooted = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone }, { prefix: () => prefix });
    const { body } = await upload(serverFixture({ files: rooted }), { route: "files", files: [png()] });
    const ticket = body.files[0] as SingleTicket;
    expect(ticket.key).toBe(`${folder}${ticket.id}.png`);
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
    const broken = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone }, { prefix: () => prefix as string });
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
    const escaping = route(
      { accept: "*/*", maxSize: "1GB", authorize: allowAnyone },
      { prefix: () => "users/../admin" },
    );
    const fixture = serverFixture({ files: escaping });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, code: body.error?.code }).toEqual({ status: 500, code: "SERVER_ERROR" });
    expect(String(fixture.logger.errors[0]?.error)).toBe(
      "TypeError: Route \"files\" built an unusable key: The object key contains a '.' or '..' segment. Use plain path segments.",
    );
  });
});

describe("POST /upload: storage failures and plugins", () => {
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
