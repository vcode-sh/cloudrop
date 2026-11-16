import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MultipartTicket, SingleTicket } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { serverFixture, tokenPayload } from "../testing/server-fixture.ts";
import { albumSchema, files, NOW, png, upload } from "../testing/upload-fixture.ts";
import { route, unauthorized } from "./route.ts";

const NOW_SECONDS = 1_794_744_000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

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
