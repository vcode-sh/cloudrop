import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedPart } from "../protocol/types.ts";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { tokenPayload } from "../testing/server-fixture.ts";
import { leaseStore, NOW, owned, storeFixture } from "../testing/store-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const LEASE_MS = 60_000;
const FIVE = { name: "a.bin", size: 5, type: "application/octet-stream" };
const gone = { code: "NO_SUCH_UPLOAD", message: "This upload was aborted or has expired. Start it again." };

/** A server with a quota of 8 bytes holding one 5-byte multipart upload, so a second one fits only once the first is released. */
async function fivePending(store: ReturnType<typeof leaseStore>) {
  const heard: { id: string; reason: string }[] = [];
  const plugin: CloudropPlugin = {
    id: "p",
    server: { onAbort: ({ file, reason }) => void heard.push({ id: file.id, reason }) },
  };
  const fixture = storeFixture(
    { files: owned },
    { store, plugins: [plugin], quota: () => 8, multipartThreshold: 0, completionLeaseMs: LEASE_MS },
  );
  const ticket = await fixture.multipart("files", FIVE);
  const uploadId = String(tokenPayload(ticket.token).uploadId);
  const state = async () => ({
    status: (await fixture.store.raw.files())[0]?.status,
    reserved: (await fixture.store.usage("u1")).reservedBytes,
    // What onAbort heard of this upload; an /upload refused for the quota is heard too, under its own id.
    reasons: heard.filter(({ id }) => id === ticket.id).map(({ reason }) => reason),
  });
  const nextUpload = async () => {
    const response = await fixture.post("upload", { route: "files", files: [FIVE] });
    const [file] = ((await response.json()) as { files: { kind: string; error?: { code: string } }[] }).files;
    return file?.error?.code ?? file?.kind;
  };
  return { fixture, ticket, uploadId, state, nextUpload };
}

describe.for([
  { mode: "under a lease", store: () => leaseStore() },
  { mode: "in a transaction", store: () => memoryStore() },
])("POST /complete with a store, $mode: the bucket no longer has the multipart upload (M11-R200)", ({ store }) => {
  it("ends the row, so the room it held is free for the owner's next upload", async () => {
    const { fixture, ticket, uploadId, state, nextUpload } = await fivePending(store());
    expect(await nextUpload()).toBe("QUOTA_EXCEEDED");
    // Aborted behind the server: the lifecycle rule, or someone with the bucket's credentials.
    await fixture.storage.abortMultipart(ticket.key, uploadId);

    expect(await complete(fixture, ticket.token)).toEqual({
      status: 410,
      body: { error: { ...gone, retryable: false } },
    });
    expect(await state()).toEqual({ status: "rejected", reserved: 0, reasons: ["rejected"] });
    expect(await nextUpload()).toBe("multipart");
    // The row has ended: a second /complete says so, and the plugins are told once.
    expect((await complete(fixture, ticket.token)).body.error?.code).toBe("UPLOAD_EXPIRED");
    expect((await state()).reasons).toEqual(["rejected"]);
  });

  it("leaves a completion in flight alone, and ends a row a stopped request left completing", async () => {
    const { fixture, ticket, uploadId, state } = await fivePending(store());
    await fixture.storage.abortMultipart(ticket.key, uploadId);
    await fixture.store.claim(ticket.id, "the-crashed-request", NOW, LEASE_MS);

    vi.setSystemTime(new Date(NOW.getTime() + LEASE_MS));
    expect((await complete(fixture, ticket.token)).body.error?.message).toBe(
      "Another request is completing this upload. Try again in a moment.",
    );
    expect(await state()).toEqual({ status: "completing", reserved: 5, reasons: [] });

    vi.setSystemTime(new Date(NOW.getTime() + LEASE_MS + 1));
    expect((await complete(fixture, ticket.token)).body.error?.code).toBe("NO_SUCH_UPLOAD");
    expect(await state()).toEqual({ status: "rejected", reserved: 0, reasons: ["rejected"] });
  });

  // R2 answers NoSuchUpload to a second Complete (r2-spike-findings.md, Q11): the stored object decides.
  it("completes an upload another request finished in the bucket before it recorded anything", async () => {
    const { fixture, ticket, uploadId, state } = await fivePending(store());
    const sent = await fixture.send(ticket.parts[0] as SignedPart, new Uint8Array(5));
    const etag = sent.headers.get("etag") ?? "";
    await fixture.storage.completeMultipart(ticket.key, uploadId, [{ partNumber: 1, etag }]);

    const answer = await complete(fixture, ticket.token);
    expect([answer.status, answer.body.file?.id]).toEqual([200, ticket.id]);
    expect(await state()).toEqual({ status: "completed", reserved: 0, reasons: [] });
  });
});
