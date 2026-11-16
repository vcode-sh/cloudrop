import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import { complete, files } from "../testing/complete-fixture.ts";
import { PUBLIC_URL, serverFixture } from "../testing/server-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { allowAnyone, route } from "./route.ts";

const TEXT = { name: "hello.txt", size: 5, type: "text/plain" };
const hello = new TextEncoder().encode("hello");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /complete: single PUT", () => {
  it("verifies the stored object and returns the file and onComplete's JSON result", async () => {
    const received: unknown[] = [];
    const profile = route({
      accept: "text/plain",
      maxSize: "1KB",
      authorize: () => ({ userId: "42", since: new Date("2026-01-01T00:00:00Z") }),
      onComplete: ({ userId, since, file, metadata }) => {
        received.push({ userId, since, metadata });
        return { stored: file.key, at: new Date("2026-11-15T12:00:01Z") };
      },
    });
    const fixture = serverFixture({ profile });
    const ticket = await fixture.single("profile", TEXT);
    expect((await fixture.send(ticket.put, hello)).status).toBe(200);
    expect(await complete(fixture, ticket.token)).toEqual({
      status: 200,
      body: {
        file: { id: ticket.id, key: ticket.key, name: "hello.txt", size: 5, type: "text/plain", url: null },
        data: { stored: ticket.key, at: "2026-11-15T12:00:01.000Z" },
      },
    });
    // The authorize result came back from the token: its Date is now the JSON string, as the types say.
    expect(received).toEqual([{ userId: "42", since: "2026-01-01T00:00:00.000Z", metadata: undefined }]);
  });

  it("gives a public route's file its percent-encoded public URL", async () => {
    const shared = route({
      accept: "*/*",
      maxSize: "1GB",
      authorize: allowAnyone,
      visibility: "public",
      prefix: () => "team files",
    });
    const fixture = serverFixture({ shared }, { publicUrl: true });
    const ticket = await fixture.single("shared", TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).body.file.url).toBe(`${PUBLIC_URL}/team%20files/${ticket.id}.txt`);
  });

  it("answers 409 NOT_UPLOADED before the bytes are there", async () => {
    const fixture = serverFixture({ files });
    const ticket = await fixture.single("files", TEXT);
    expect(await complete(fixture, ticket.token)).toEqual({
      status: 409,
      body: {
        error: {
          code: "NOT_UPLOADED",
          message: "The file has not been uploaded yet. Upload it, then complete the upload.",
          retryable: false,
        },
      },
    });
  });

  it("completes again when retried, running onComplete each time (at-least-once)", async () => {
    let calls = 0;
    const counted = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone, onComplete: () => ++calls });
    const fixture = serverFixture({ counted });
    const ticket = await fixture.single("counted", TEXT);
    await fixture.send(ticket.put, hello);
    const first = await complete(fixture, ticket.token);
    const second = await complete(fixture, ticket.token);
    expect([first.body.data, second.body.data, second.body.file.id]).toEqual([1, 2, ticket.id]);
  });

  // A backend that did not enforce the signed headers (R2 does: spike rows 1 and 2) stored the wrong object under the
  // upload's own id. Both checks are needed: either one alone lets the other mismatch through.
  it.for([
    { name: "a different type", body: "<svg>", type: "text/html" },
    { name: "a different size", body: "hello!", type: "text/plain" },
  ])("discards an object with $name and answers VERIFICATION_FAILED", async ({ body, type }) => {
    const aborted: string[] = [];
    const plugin: CloudropPlugin = { id: "p", server: { onAbort: ({ reason }) => void aborted.push(reason) } };
    const fixture = serverFixture({ files }, { plugins: [plugin] });
    const ticket = await fixture.single("files", TEXT);
    await fixture.storage.put(ticket.key, body, { type, metadata: { "cloudrop-id": ticket.id } });
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "VERIFICATION_FAILED",
      message: "The uploaded file does not match what was declared, so it was discarded. Upload it again.",
      retryable: false,
    });
    expect([(await fixture.storage.head(ticket.key)).data, aborted]).toEqual([null, ["rejected"]]);
  });

  it("keeps a rejected object and its reservation, and asks for a retry, when the delete fails", async () => {
    const aborted: string[] = [];
    const plugin: CloudropPlugin = { id: "p", server: { onAbort: ({ reason }) => void aborted.push(reason) } };
    const fixture = serverFixture({ files }, { plugins: [plugin] });
    const ticket = await fixture.single("files", TEXT);
    await fixture.storage.put(ticket.key, "<svg>", { type: "text/html", metadata: { "cloudrop-id": ticket.id } });
    // The network drops every DELETE the server sends; every other request reaches the bucket.
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) =>
      init?.method === "DELETE" ? Promise.reject(new TypeError("network down")) : fetch(input, init);
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "STORAGE_ERROR",
      message: "The storage service failed. Try again in a moment.",
      retryable: true,
    });
    expect([(await fixture.storage.head(ticket.key)).data?.type, aborted]).toEqual(["text/html", []]);
  });

  it("never deletes an object another writer stored under the key, but releases this upload's reservation", async () => {
    const aborted: string[] = [];
    const plugin: CloudropPlugin = { id: "p", server: { onAbort: ({ reason }) => void aborted.push(reason) } };
    const fixture = serverFixture({ files }, { plugins: [plugin] });
    const ticket = await fixture.single("files", TEXT);
    await fixture.storage.put(ticket.key, "hello", { type: "text/plain", metadata: { "cloudrop-id": "someone-else" } });
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "VERIFICATION_FAILED",
      message: "Another file is stored under this upload's key. Start a new upload.",
      retryable: false,
    });
    expect((await fixture.storage.head(ticket.key)).data?.metadata).toEqual({ "cloudrop-id": "someone-else" });
    expect(aborted).toEqual(["rejected"]);
  });
});

describe("POST /complete: plugins and onComplete", () => {
  it("deletes the object when afterVerify refuses it and returns the plugin's error", async () => {
    const refusal = new CloudropError("VERIFICATION_FAILED", "This file looks like an executable. Upload a document.");
    const checker: CloudropPlugin = { id: "checker", server: { afterVerify: () => refusal } };
    const fixture = serverFixture({ files }, { plugins: [checker] });
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "VERIFICATION_FAILED",
      message: "This file looks like an executable. Upload a document.",
      retryable: false,
    });
    expect((await fixture.storage.head(ticket.key)).data).toBeNull();
  });

  it("keeps the verified object when afterVerify throws, and asks the client to retry", async () => {
    const failure = new Error("scanner unavailable");
    const scanner: CloudropPlugin = {
      id: "scanner",
      server: {
        afterVerify: () => {
          throw failure;
        },
      },
    };
    const fixture = serverFixture({ files }, { plugins: [scanner] });
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "SERVER_ERROR",
      message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
      retryable: true,
    });
    expect(fixture.logger.errors).toEqual([
      { message: 'cloudrop: a plugin\'s afterVerify failed for route "files".', error: failure },
    ]);
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
  });

  it("keeps the verified object when onComplete throws, and asks the client to retry", async () => {
    const failure = new Error("database unavailable");
    const failing = route({
      accept: "*/*",
      maxSize: "1GB",
      authorize: allowAnyone,
      onComplete: () => {
        throw failure;
      },
    });
    const fixture = serverFixture({ failing });
    const ticket = await fixture.single("failing", TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "SERVER_ERROR",
      message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
      retryable: true,
    });
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
    expect(fixture.logger.errors).toEqual([
      { message: 'cloudrop: onComplete failed for route "failing".', error: failure },
    ]);
  });

  // Only JSON reaches the client: a BigInt or a cycle is the application's bug, reported as an onComplete problem.
  it("keeps the verified object and asks for a retry when onComplete returns a value JSON cannot encode", async () => {
    const counting = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone, onComplete: () => ({ n: 1n }) });
    const fixture = serverFixture({ counting });
    const ticket = await fixture.single("counting", TEXT);
    await fixture.send(ticket.put, hello);
    expect([(await complete(fixture, ticket.token)).body.error?.retryable, fixture.logger.errors]).toEqual([
      true,
      [
        {
          message:
            'cloudrop: onComplete for route "counting" returned a value JSON cannot encode (a BigInt or a cycle).',
          error: expect.any(TypeError),
        },
      ],
    ]);
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
  });
});
