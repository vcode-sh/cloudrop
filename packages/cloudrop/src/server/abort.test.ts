import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedPart } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { APP_ORIGIN, forgeToken, SECRET, serverFixture, tokenPayload } from "../testing/server-fixture.ts";
import { createCloudrop } from "./cloudrop.ts";
import type { AbortContext, CloudropPlugin } from "./plugins.ts";
import { allowAnyone, route } from "./route.ts";

const files = route({ accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "42" }) });
const TEXT = { name: "hello.txt", size: 5, type: "text/plain" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function recordingPlugin(calls: AbortContext[]): CloudropPlugin {
  return { id: "recorder", server: { onAbort: (context) => void calls.push(context) } };
}

describe("POST /abort", () => {
  it("aborts a multipart upload and tells the plugins, with the token's owner and file", async () => {
    const calls: AbortContext[] = [];
    const fixture = serverFixture({ files }, { multipartThreshold: 0, plugins: [recordingPlugin(calls)] });
    const ticket = await fixture.multipart("files", {
      name: "big.bin",
      size: 9 * MiB,
      type: "application/octet-stream",
    });
    const response = await fixture.post("abort", { token: ticket.token });
    expect({ status: response.status, body: await response.json(), pending: fixture.fake.pendingUploads() }).toEqual({
      status: 200,
      body: { fileId: ticket.fileId },
      pending: 0,
    });
    expect(calls).toEqual([
      {
        route: "files",
        file: { id: ticket.fileId, key: ticket.key, name: "big.bin", size: 9 * MiB, type: "application/octet-stream" },
        metadata: undefined,
        auth: { userId: "42" },
        reason: "aborted",
      },
    ]);
  });

  it("deletes a single PUT that already landed", async () => {
    const fixture = serverFixture({ files });
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, new TextEncoder().encode("hello"));
    expect((await fixture.post("abort", { token: ticket.token })).status).toBe(200);
    expect((await fixture.storage.head(ticket.key)).data).toBeNull();
  });

  it("keeps an object another writer stored under the key", async () => {
    const fixture = serverFixture({ files });
    const ticket = await fixture.single("files", TEXT);
    await fixture.storage.put(ticket.key, "other", { metadata: { "cloudrop-id": "someone-else" } });
    expect((await fixture.post("abort", { token: ticket.token })).status).toBe(200);
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
  });

  it("accepts an expired token, so a cancelled upload can always be cleaned up and its reservation released", async () => {
    const calls: AbortContext[] = [];
    const fixture = serverFixture({ files }, { multipartThreshold: 0, plugins: [recordingPlugin(calls)] });
    const ticket = await fixture.multipart("files", { name: "big.bin", size: 9 * MiB, type: "" });
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    expect((await fixture.post("abort", { token: ticket.token })).status).toBe(200);
    expect([fixture.fake.pendingUploads(), calls.map((call) => call.reason)]).toEqual([0, ["aborted"]]);
  });

  it("keeps a stored file and tells no plugin when the token has expired", async () => {
    const calls: AbortContext[] = [];
    const fixture = serverFixture({ files }, { plugins: [recordingPlugin(calls)] });
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, new TextEncoder().encode("hello"));
    // The token's exp second: expired from here on.
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    expect((await fixture.post("abort", { token: ticket.token })).status).toBe(200);
    expect([(await fixture.storage.head(ticket.key)).data?.size, calls]).toEqual([5, []]);
  });

  it("deletes a completed multipart file and releases its reservation while the token is valid", async () => {
    const calls: AbortContext[] = [];
    const fixture = serverFixture({ files }, { multipartThreshold: 0, plugins: [recordingPlugin(calls)] });
    const ticket = await fixture.multipart("files", { name: "a.bin", size: 5, type: "application/octet-stream" });
    expect((await fixture.send(ticket.parts[0] as SignedPart, new Uint8Array(5))).status).toBe(200);
    // /complete arrives in Task 11; the driver completes the upload exactly as /complete will, with the stored parts.
    const uploadId = String(tokenPayload(ticket.token).uploadId);
    const parts = (await fixture.storage.listParts(ticket.key, uploadId)).data ?? [];
    expect((await fixture.storage.completeMultipart(ticket.key, uploadId, parts)).error).toBeNull();
    expect((await fixture.post("abort", { token: ticket.token })).status).toBe(200);
    expect([(await fixture.storage.head(ticket.key)).data, calls.map((call) => call.reason)]).toEqual([
      null,
      ["aborted"],
    ]);
  });

  it("keeps a completed multipart file and its reservation when an expired token asks to abort it", async () => {
    const calls: AbortContext[] = [];
    const fixture = serverFixture({ files }, { multipartThreshold: 0, plugins: [recordingPlugin(calls)] });
    const ticket = await fixture.multipart("files", { name: "a.bin", size: 5, type: "application/octet-stream" });
    expect((await fixture.send(ticket.parts[0] as SignedPart, new Uint8Array(5))).status).toBe(200);
    // /complete arrives in Task 11; the driver completes the upload exactly as /complete will, with the stored parts.
    const uploadId = String(tokenPayload(ticket.token).uploadId);
    const parts = (await fixture.storage.listParts(ticket.key, uploadId)).data ?? [];
    expect((await fixture.storage.completeMultipart(ticket.key, uploadId, parts)).error).toBeNull();
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    expect((await fixture.post("abort", { token: ticket.token })).status).toBe(200);
    expect([(await fixture.storage.head(ticket.key)).data?.size, calls]).toEqual([5, []]);
  });

  // Abort is the cleanup path: a deploy that renamed the route must not leave the upload and its reservation behind.
  it("aborts and tells the plugins after a deploy removed the token's route", async () => {
    const calls: AbortContext[] = [];
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", { name: "big.bin", size: 9 * MiB, type: "" });
    const redeployed = createCloudrop({
      storage: fixture.storage,
      secret: SECRET,
      routes: { renamed: files },
      plugins: [recordingPlugin(calls)],
    });
    const response = await redeployed.handler(
      new Request(`${APP_ORIGIN}/api/cloudrop/abort`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: JSON.stringify({ token: ticket.token }),
      }),
    );
    expect([response.status, fixture.fake.pendingUploads(), calls.map((call) => call.reason)]).toEqual([
      200,
      0,
      ["aborted"],
    ]);
  });

  it("refuses a token rebound to another key and deletes nothing", async () => {
    const fixture = serverFixture({ files: route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone }) });
    await fixture.storage.put("victim.txt", "keep me");
    const ticket = await fixture.single("files", TEXT);
    const response = await fixture.post("abort", { token: forgeToken(ticket.token, { key: "victim.txt" }) });
    expect([response.status, (await fixture.storage.head("victim.txt")).data?.size]).toEqual([400, 7]);
  });
});
