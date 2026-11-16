import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedPart } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { complete, files } from "../testing/complete-fixture.ts";
import { serverFixture, tokenPayload } from "../testing/server-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";

const BIG = { name: "big.bin", size: 8 * MiB + 5, type: "application/octet-stream" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /complete: multipart", () => {
  const partOne = new Uint8Array(8 * MiB);
  const partTwo = new Uint8Array(5).fill(7);

  it("lists the missing parts, then completes once they arrive", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", BIG);
    expect((await fixture.send(ticket.parts[0] as SignedPart, partOne)).status).toBe(200);
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "PARTS_MISSING",
      message: "1 of 2 parts are missing or have the wrong size. Upload them again, then complete the upload.",
      retryable: false,
      parts: [2],
    });
    expect((await fixture.send(ticket.parts[1] as SignedPart, partTwo)).status).toBe(200);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    expect((await fixture.storage.head(ticket.key)).data).toMatchObject({
      size: 8 * MiB + 5,
      type: "application/octet-stream",
      metadata: { "cloudrop-id": ticket.id },
    });
    expect((await fixture.storage.getRange(ticket.key, 8 * MiB, 8 * MiB + 4)).data).toEqual(partTwo);
  });

  it("asks again for a part stored at the wrong size instead of letting completion fail", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", BIG);
    // The token carries the storage's upload id, readable by any client.
    const uploadId = String(tokenPayload(ticket.token).uploadId);
    await fixture.send(ticket.parts[0] as SignedPart, partOne);
    // Signed for 4 bytes by someone holding the storage credentials: the plan says 5.
    const wrong = await fixture.storage.presignPart(ticket.key, uploadId, 2, { size: 4, expiresIn: 60 });
    if (wrong.error) throw wrong.error;
    await fixture.send(wrong.data, new Uint8Array(4));
    expect((await complete(fixture, ticket.token)).body.error?.parts).toEqual([2]);
  });

  it("completes again when retried after the upload finished, by checking the stored object", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", BIG);
    await fixture.send(ticket.parts[0] as SignedPart, partOne);
    await fixture.send(ticket.parts[1] as SignedPart, partTwo);
    const first = await complete(fixture, ticket.token);
    const retried = await complete(fixture, ticket.token);
    expect([first.status, retried.status, retried.body.file.id]).toEqual([200, 200, ticket.id]);
  });

  it("answers 410 NO_SUCH_UPLOAD for an aborted upload", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", BIG);
    await fixture.post("abort", { token: ticket.token });
    expect(await complete(fixture, ticket.token)).toEqual({
      status: 410,
      body: {
        error: {
          code: "NO_SUCH_UPLOAD",
          message: "This upload was aborted or has expired. Start it again.",
          retryable: false,
        },
      },
    });
  });

  it("never claims another writer's object for an upload that no longer exists", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", { name: "a.bin", size: 5, type: "application/octet-stream" });
    await fixture.post("abort", { token: ticket.token });
    // Same key and size as the plan: only the cloudrop-id tells the objects apart.
    await fixture.storage.put(ticket.key, "hello", { metadata: { "cloudrop-id": "someone-else" } });
    expect((await complete(fixture, ticket.token)).body.error?.code).toBe("NO_SUCH_UPLOAD");
  });

  // Two /complete calls racing: when the second completion is refused with 412 rather than NoSuchUpload (R2's order
  // here is unmeasured; the fake answers 412 while the upload still exists), the object is this upload's own.
  it("completes when the object that refused completion is this upload's own", async () => {
    const aborted: string[] = [];
    const plugin: CloudropPlugin = { id: "p", server: { onAbort: ({ reason }) => void aborted.push(reason) } };
    const fixture = serverFixture({ files }, { multipartThreshold: 0, plugins: [plugin] });
    const ticket = await fixture.multipart("files", { name: "a.bin", size: 5, type: "application/octet-stream" });
    await fixture.send(ticket.parts[0] as SignedPart, new Uint8Array(5));
    await fixture.storage.put(ticket.key, "hello", { metadata: { "cloudrop-id": ticket.id } });
    const completed = await complete(fixture, ticket.token);
    expect([completed.status, completed.body.file?.id, aborted]).toEqual([200, ticket.id, []]);
  });

  it("keeps the upload and its reservation when the object that refused completion cannot be read", async () => {
    const aborted: string[] = [];
    const plugin: CloudropPlugin = { id: "p", server: { onAbort: ({ reason }) => void aborted.push(reason) } };
    const fixture = serverFixture({ files }, { multipartThreshold: 0, plugins: [plugin] });
    const ticket = await fixture.multipart("files", { name: "a.bin", size: 5, type: "application/octet-stream" });
    await fixture.send(ticket.parts[0] as SignedPart, new Uint8Array(5));
    await fixture.storage.put(ticket.key, "first");
    // The network drops every HEAD the server sends, so it cannot tell whose object refused the completion.
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) =>
      init?.method === "HEAD" ? Promise.reject(new TypeError("network down")) : fetch(input, init);
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "STORAGE_ERROR",
      message: "The storage service failed. Try again in a moment.",
      retryable: true,
    });
    expect(aborted).toEqual([]);
  });

  it("asks for a retry, keeping the upload, when a part is uploaded again while the upload is being completed", async () => {
    const aborted: string[] = [];
    const plugin: CloudropPlugin = { id: "p", server: { onAbort: ({ reason }) => void aborted.push(reason) } };
    const fixture = serverFixture({ files }, { multipartThreshold: 0, plugins: [plugin] });
    const ticket = await fixture.multipart("files", BIG);
    await fixture.send(ticket.parts[0] as SignedPart, partOne);
    await fixture.send(ticket.parts[1] as SignedPart, partTwo);
    // Part 2 is sent again, with other bytes of the same size, after ListParts and before the completion: the ETag
    // the server listed is stale by the time the bucket checks it.
    const { fetch } = fixture.fake;
    let replaced = false;
    fixture.fake.fetch = async (input, init) => {
      const completing = init?.method === "POST" && String(input).includes("uploadId=");
      if (completing && !replaced) {
        replaced = true;
        await fixture.send(ticket.parts[1] as SignedPart, new Uint8Array(5).fill(9));
      }
      return fetch(input, init);
    };
    expect(await complete(fixture, ticket.token)).toEqual({
      status: 502,
      body: {
        error: {
          code: "STORAGE_ERROR",
          message: "A part of the file changed while the upload was being completed. Complete the upload again.",
          retryable: true,
        },
      },
    });
    expect([fixture.fake.pendingUploads(), aborted]).toEqual([1, []]);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    expect((await fixture.storage.getRange(ticket.key, 8 * MiB, 8 * MiB + 4)).data).toEqual(new Uint8Array(5).fill(9));
  });

  it("refuses to complete over an object that appeared at the key, and keeps that object", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", BIG);
    await fixture.send(ticket.parts[0] as SignedPart, partOne);
    await fixture.send(ticket.parts[1] as SignedPart, partTwo);
    await fixture.storage.put(ticket.key, "first");
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "ALREADY_EXISTS",
      message: "Another file already has this upload's key. Start a new upload.",
      retryable: false,
    });
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
    expect(fixture.fake.pendingUploads()).toBe(0);
  });
});
