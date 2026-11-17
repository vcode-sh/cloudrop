// The whole protocol on the in-process fake R2, driven the way M3's client will drive it: JSON POSTs to the four
// endpoints, and PUTs that send exactly the URL and headers the server returned.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompleteResponse,
  ErrorResponse,
  MultipartTicket,
  SignedPart,
  SingleTicket,
  UploadResponse,
} from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const albums = route(
  {
    accept: ["image/png", "application/octet-stream"],
    maxSize: "100MB",
    authorize: ({ request }) => ({ userId: request.headers.get("x-user") ?? "anonymous" }),
  },
  {
    prefix: ({ userId }) => `users/${userId}`,
    onComplete: ({ userId, file }) => ({ owner: userId, bytes: file.size }),
  },
);

function client() {
  const fixture = serverFixture({ albums }, { multipartThreshold: "8MB" });
  async function call<T>(
    endpoint: string,
    body: unknown,
  ): Promise<{ status: number; body: T & Partial<ErrorResponse> }> {
    const response = await fixture.post(endpoint, body, { "x-user": "42" });
    return { status: response.status, body: (await response.json()) as T & Partial<ErrorResponse> };
  }
  async function put(signed: { url: string; headers: Record<string, string> }, bytes: Uint8Array<ArrayBuffer>) {
    return (await fixture.send(signed, bytes)).status;
  }
  return { fixture, call, put };
}

describe("upload protocol, end to end", () => {
  it("uploads a small file in three requests: upload, PUT, complete", async () => {
    const { fixture, call, put } = client();
    const bytes = offsetBytes(1000);
    const upload = await call<UploadResponse>("upload", {
      route: "albums",
      files: [{ name: "pic.png", size: 1000, type: "image/png" }],
    });
    const ticket = upload.body.files[0] as SingleTicket;
    expect(await put(ticket.put, bytes)).toBe(200);
    const done = await call<CompleteResponse>("complete", { token: ticket.token });
    expect(done.body).toEqual({
      file: {
        id: ticket.id,
        key: `users/42/${ticket.id}.png`,
        name: "pic.png",
        size: 1000,
        type: "image/png",
        url: null,
      },
      data: { owner: "42", bytes: 1000 },
    });
    expect((await fixture.storage.getRange(ticket.key, 0, 999)).data).toEqual(bytes);
  });

  it("resumes a multipart upload: complete names the missing part, sign renews it, complete succeeds", async () => {
    const { fixture, call, put } = client();
    const size = 16 * MiB + 5;
    const bytes = offsetBytes(size);
    const upload = await call<UploadResponse>("upload", {
      route: "albums",
      files: [{ name: "video.bin", size, type: "application/octet-stream" }],
    });
    const ticket = upload.body.files[0] as MultipartTicket;
    const [first, , third] = ticket.parts as [SignedPart, SignedPart, SignedPart];
    expect(await put(first, bytes.slice(0, 8 * MiB))).toBe(200);
    expect(await put(third, bytes.slice(16 * MiB))).toBe(200);
    // The page reloads here; the client kept the token and asks the server what is missing.
    const incomplete = await call<CompleteResponse>("complete", { token: ticket.token });
    expect({ status: incomplete.status, parts: incomplete.body.error?.parts }).toEqual({ status: 409, parts: [2] });
    const renewed = await call<{ parts: SignedPart[] }>("sign", {
      token: ticket.token,
      parts: incomplete.body.error?.parts,
    });
    const [second] = renewed.body.parts;
    expect(await put(second as SignedPart, bytes.slice(8 * MiB, 16 * MiB))).toBe(200);
    const done = await call<CompleteResponse>("complete", { token: ticket.token });
    expect(done.body.data).toEqual({ owner: "42", bytes: size });
    // Bytes on both sides of each part boundary, in order.
    expect((await fixture.storage.getRange(ticket.key, 8 * MiB - 2, 8 * MiB + 1)).data).toEqual(
      bytes.slice(8 * MiB - 2, 8 * MiB + 2),
    );
    expect((await fixture.storage.getRange(ticket.key, 16 * MiB - 2, 16 * MiB + 1)).data).toEqual(
      bytes.slice(16 * MiB - 2, 16 * MiB + 2),
    );
  });

  it("renews an expired URL through /sign", async () => {
    const { call, put } = client();
    const upload = await call<UploadResponse>("upload", {
      route: "albums",
      files: [{ name: "pic.png", size: 10, type: "image/png" }],
    });
    const ticket = upload.body.files[0] as SingleTicket;
    vi.setSystemTime(new Date("2026-11-15T12:15:01Z"));
    // R2 answers an expired URL with 403 ExpiredRequest (spike row 7); the client renews once and retries.
    expect(await put(ticket.put, offsetBytes(10))).toBe(403);
    const renewed = await call<{ put: SingleTicket["put"] }>("sign", { token: ticket.token });
    expect(await put(renewed.body.put, offsetBytes(10))).toBe(200);
    expect((await call<CompleteResponse>("complete", { token: ticket.token })).status).toBe(200);
  });

  it("starts several files in one /upload call, each completing through its own ticket", async () => {
    const { call, put } = client();
    const upload = await call<UploadResponse>("upload", {
      route: "albums",
      files: [
        { name: "a.png", size: 1, type: "image/png" },
        { name: "b.png", size: 2, type: "image/png" },
      ],
    });
    const [a, b] = upload.body.files as [SingleTicket, SingleTicket];
    // Each URL signs its own file's length, so a ticket handed to the wrong file is refused here.
    expect([await put(a.put, offsetBytes(1)), await put(b.put, offsetBytes(2))]).toEqual([200, 200]);
    const first = await call<CompleteResponse>("complete", { token: a.token });
    const second = await call<CompleteResponse>("complete", { token: b.token });
    expect([first.body.file.name, first.body.data, second.body.file.name, second.body.data]).toEqual([
      "a.png",
      { owner: "42", bytes: 1 },
      "b.png",
      { owner: "42", bytes: 2 },
    ]);
  });
});
