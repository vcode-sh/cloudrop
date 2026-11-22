import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError, fail } from "../errors.ts";
import type { FileTicket, UploadResponse } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { serverFixture, tokenPayload } from "../testing/server-fixture.ts";
import { DEADLINE, NOW, owned, storeFixture } from "../testing/store-fixture.ts";
import type { AbortContext, CloudropPlugin } from "./plugins.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const png = (size: number, name = "a.png") => ({ name, size, type: "image/png" });

function recorder(calls: AbortContext[]): CloudropPlugin {
  return { id: "recorder", server: { onAbort: (context) => void calls.push(context) } };
}

async function upload(
  fixture: ReturnType<typeof storeFixture>,
  files: unknown[],
  idempotencyKey?: string,
): Promise<FileTicket[]> {
  const response = await fixture.post("upload", { route: "owned", files, idempotencyKey });
  expect(response.status).toBe(200);
  return ((await response.json()) as UploadResponse).files;
}

/** A row as /upload writes it, before anything else touches it. */
function pendingRow(ticket: FileTicket & { id: string; key: string }, file: { name: string; size: number }) {
  return {
    id: ticket.id,
    route: "owned",
    key: ticket.key,
    owner: "u1",
    status: "pending",
    name: file.name,
    type: "image/png",
    size: file.size,
    uploadId: null,
    metadata: null,
    result: null,
    claim: null,
    claimedAt: null,
    expiresAt: DEADLINE,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    endedAt: null,
    cleanedAt: null,
    requestKey: null,
  };
}

const quotaReached = {
  kind: "rejected",
  error: {
    code: "QUOTA_EXCEEDED",
    message: "Your storage limit is reached. Delete some files or ask for more space, then try again.",
    retryable: false,
  },
};

describe("POST /upload with a store", () => {
  it("writes a pending row per accepted file, reserves its bytes for the owner and marks the token stored", async () => {
    const fixture = storeFixture({ owned });
    const [first, refused, second] = await upload(fixture, [png(10), { name: "x", size: 1, type: "bad" }, png(20)]);
    if (first?.kind !== "single" || second?.kind !== "single") throw new Error("expected two single tickets");
    expect(refused?.kind).toBe("rejected");
    expect(await fixture.store.raw.files()).toEqual(
      [pendingRow(first, png(10)), pendingRow(second, png(20))].toSorted((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(await fixture.store.raw.usage()).toEqual([
      {
        owner: "u1",
        reservedBytes: 30,
        activeBytes: 0,
        files: 0,
        eraseRequestedAt: null,
        erasedAt: null,
        updatedAt: NOW,
      },
    ]);
    expect(tokenPayload(first.token).stored).toBe(true);
  });

  it("lets a retry with the same idempotencyKey replace an attempt whose answer was lost, near the quota", async () => {
    const fixture = storeFixture({ owned }, { quota: () => 15 * MiB, multipartThreshold: 0 });
    const key = "0f8e3c2a-5b7d-4e1f-9a6c-2d4b8e0f1a3c";
    // The client never read this answer: its deadline passed, or the connection dropped on the way back.
    const [lost] = await upload(fixture, [png(9 * MiB, "big.png")], key);
    const [retried] = await upload(fixture, [png(9 * MiB, "big.png")], key);
    const [other] = await upload(fixture, [png(9 * MiB, "big.png")], "another-key-0000000000");
    if (lost?.kind !== "multipart" || retried?.kind !== "multipart") throw new Error("expected two multipart tickets");
    expect(other).toEqual(quotaReached);
    expect(
      (await fixture.store.raw.files()).map(({ id, status, endedAt, cleanedAt, requestKey }) => ({
        id,
        status,
        endedAt,
        cleanedAt,
        requestKey,
      })),
    ).toEqual(
      [
        { id: lost.id, status: "aborted", endedAt: NOW, cleanedAt: null, requestKey: key },
        { id: retried.id, status: "pending", endedAt: null, cleanedAt: null, requestKey: key },
      ].toSorted((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect((await fixture.cloudrop.api.usage("u1")).data).toEqual({
      reservedBytes: 9 * MiB,
      activeBytes: 0,
      files: 0,
      erasure: null,
    });
    // The lost attempt's multipart upload is the sweep's cleanup work, past the grace.
    expect(fixture.fake.pendingUploads()).toBe(2);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 60 * 60_000));
    expect((await fixture.cloudrop.api.sweep()).data?.cleaned).toBe(1);
    expect(fixture.fake.pendingUploads()).toBe(1);
  });

  it("stores the multipart upload id on the row right after the upload is created", async () => {
    const fixture = storeFixture({ owned }, { multipartThreshold: 0 });
    const [ticket] = await upload(fixture, [png(9 * MiB, "big.png")]);
    if (ticket?.kind !== "multipart") throw new Error("expected a multipart ticket");
    const [row] = await fixture.store.raw.files();
    expect(row?.uploadId).toBe(tokenPayload(ticket.token).uploadId);
  });

  it("refuses each file over the owner's quota, exact to the byte, and tells only the plugins of refused files", async () => {
    const calls: AbortContext[] = [];
    const asked: string[] = [];
    const fixture = storeFixture(
      { owned },
      {
        plugins: [recorder(calls)],
        quota: (owner) => {
          asked.push(owner);
          return 1500;
        },
      },
    );
    const [first, second, third] = await upload(fixture, [png(1000), png(501), png(500)]);
    expect([first?.kind, second, third?.kind]).toEqual(["single", quotaReached, "single"]);
    expect(asked).toEqual(["u1"]);
    expect((await fixture.store.raw.files()).map((row) => row.size).toSorted()).toEqual([1000, 500]);
    expect(await fixture.cloudrop.api.usage("u1")).toEqual({
      data: { reservedBytes: 1500, activeBytes: 0, files: 0, erasure: null },
      error: null,
    });
    expect(calls.map(({ file, reason }) => ({ size: file.size, reason }))).toEqual([{ size: 501, reason: "rejected" }]);
  });

  it.for([
    {
      name: "the quota lookup throws",
      quota: () => Promise.reject(new Error("plans service down")),
      logged: new Error("plans service down"),
    },
    {
      name: "the quota lookup returns something other than bytes",
      quota: () => -1,
      logged: new TypeError("quota must return null or a whole number of bytes, got -1."),
    },
  ])("refuses every file, retryably, signs nothing and logs why when $name", async ({ quota, logged }) => {
    const calls: AbortContext[] = [];
    const fixture = storeFixture({ owned }, { plugins: [recorder(calls)], quota, multipartThreshold: 0 });
    const tickets = await upload(fixture, [png(10), png(9 * MiB)]);
    const message = "The server could not check your storage limit. Try again in a moment.";
    const refusal = { kind: "rejected", error: { code: "SERVER_ERROR", message, retryable: true } };
    expect(tickets).toEqual([refusal, refusal]);
    expect([await fixture.store.raw.files(), fixture.fake.pendingUploads()]).toEqual([[], 0]);
    expect(calls.map((call) => call.reason)).toEqual(["failed", "failed"]);
    expect(fixture.logger.errors).toEqual([
      { message: 'cloudrop: the quota lookup failed for an upload on route "owned".', error: logged },
    ]);
  });

  it("refuses every file, retryably, and creates no upload when the store cannot write the rows", async () => {
    const calls: AbortContext[] = [];
    const store = memoryStore();
    const fixture = storeFixture({ owned }, { store, plugins: [recorder(calls)], multipartThreshold: 0 });
    store.injectFailure("reserve", 1);
    const tickets = await upload(fixture, [png(9 * MiB), png(10)]);
    const refusal = {
      kind: "rejected",
      error: {
        code: "SERVER_ERROR",
        message: "The server could not reach its upload records. Try again in a moment.",
        retryable: true,
      },
    };
    expect(tickets).toEqual([refusal, refusal]);
    expect([await store.raw.files(), await store.raw.usage(), fixture.fake.pendingUploads()]).toEqual([[], [], 0]);
    expect(calls.map((call) => call.reason)).toEqual(["failed", "failed"]);
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      'cloudrop: the store failed to reserve the files of an upload on route "owned".',
    ]);
  });

  it("writes rows without an owner, counts no usage and asks no quota when the route defines no owner", async () => {
    const anyone = route({ accept: "*/*", maxSize: "1GB", authorize: () => ({}) });
    const quota = vi.fn(() => 0);
    const fixture = storeFixture({ anyone }, { quota });
    const response = await fixture.post("upload", { route: "anyone", files: [png(10)] });
    expect(((await response.json()) as UploadResponse).files[0]?.kind).toBe("single");
    expect([(await fixture.store.raw.files())[0]?.owner, await fixture.store.raw.usage(), quota.mock.calls]).toEqual([
      null,
      [],
      [],
    ]);
  });

  it("leaves the first attempt pending when /upload reuses its idempotencyKey on a route without owner", async () => {
    const anyone = route({ accept: "*/*", maxSize: "1GB", authorize: () => ({}) });
    const fixture = storeFixture({ anyone });
    // On such a route every row is owner-less, so a reused key could otherwise end other users' uploads.
    const ask = { route: "anyone", files: [png(10)], idempotencyKey: "app-upload-request" };
    await fixture.post("upload", ask);
    await fixture.post("upload", ask);
    expect((await fixture.store.raw.files()).map(({ status }) => status)).toEqual(["pending", "pending"]);
  });

  it.for([
    { name: "an empty owner", owner: "" },
    { name: "an owner over 255 characters", owner: "x".repeat(256) },
    { name: "a number", owner: 42 },
    { name: "a NUL character, which Postgres text cannot hold", owner: "u\u0000" },
    // Postgres and SQLite store it as U+FFFD, so two owners that differ only there would share one quota (M11-R60).
    { name: "a lone surrogate, which a database stores as another character", owner: "u\ud800" },
  ])("answers 500, writes nothing and logs the route's bug when owner returns $name", async ({ owner }) => {
    const broken = route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({}) },
      { owner: () => owner as unknown as string },
    );
    const fixture = storeFixture({ broken });
    const response = await fixture.post("upload", { route: "broken", files: [png(10)] });
    expect(response.status).toBe(500);
    expect(await fixture.store.raw.files()).toEqual([]);
    expect(String(fixture.logger.errors[0]?.error)).toBe(
      'TypeError: Route "broken": owner must return null or a string of 1 to 255 characters without NUL (U+0000) or a lone surrogate.',
    );
  });

  it("answers 255 characters, the longest owner, with a reserved row", async () => {
    const longest = route({ accept: "*/*", maxSize: "1GB", authorize: () => ({}) }, { owner: () => "x".repeat(255) });
    const fixture = storeFixture({ longest });
    await fixture.post("upload", { route: "longest", files: [png(10)] });
    expect((await fixture.store.raw.files())[0]?.owner).toBe("x".repeat(255));
  });
});

describe("POST /upload with a store: files that cannot start", () => {
  it("aborts the new multipart upload and answers UPLOAD_EXPIRED when the row was revoked before attach", async () => {
    const store = memoryStore();
    // A sign-out lands between the reserve and the attach of this very upload.
    const attach = store.attach;
    store.attach = async (...args) => {
      await store.revoke("u1", new Date());
      return attach(...args);
    };
    const fixture = storeFixture({ owned }, { store, multipartThreshold: 0 });
    const [ticket] = await upload(fixture, [png(9 * MiB)]);
    expect(ticket).toEqual({
      kind: "rejected",
      error: {
        code: "UPLOAD_EXPIRED",
        message: "This upload was cancelled or has expired. Start it again.",
        retryable: false,
      },
    });
    expect(fixture.fake.pendingUploads()).toBe(0);
    expect((await store.raw.files()).map(({ status, uploadId }) => ({ status, uploadId }))).toEqual([
      { status: "aborted", uploadId: null },
    ]);
  });

  it("aborts the new multipart upload, ends the row failed and answers a retryable error when attach throws", async () => {
    const store = memoryStore();
    const fixture = storeFixture({ owned }, { store, multipartThreshold: 0 });
    store.injectFailure("attach", 0);
    const [ticket] = await upload(fixture, [png(9 * MiB)]);
    expect(ticket).toEqual({
      kind: "rejected",
      error: {
        code: "SERVER_ERROR",
        message: "The server could not reach its upload records. Try again in a moment.",
        retryable: true,
      },
    });
    expect(fixture.fake.pendingUploads()).toBe(0);
    expect((await store.raw.files()).map(({ status, endedAt }) => ({ status, endedAt }))).toEqual([
      { status: "failed", endedAt: NOW },
    ]);
    expect(await store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0, erasure: null });
  });

  it("ends the row failed and releases its bytes when the storage cannot start the upload", async () => {
    const { storage } = storeFixture({ owned });
    const store = memoryStore();
    const fixture = storeFixture(
      { owned },
      {
        store,
        multipartThreshold: 0,
        storage: {
          ...storage,
          createMultipart: async () =>
            fail(new CloudropError("STORAGE_ERROR", "R2 answered 500.", { retryable: true })),
        },
      },
    );
    const [ticket] = await upload(fixture, [png(9 * MiB)]);
    expect(ticket?.kind).toBe("rejected");
    expect((await store.raw.files()).map((row) => row.status)).toEqual(["failed"]);
    expect(await store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0, erasure: null });
  });
});

describe("POST /upload without a store", () => {
  it("signs a token without the stored mark", async () => {
    const fixture = serverFixture({ owned: route({ accept: "*/*", maxSize: "1GB", authorize: () => ({}) }) });
    const ticket = await fixture.single("owned", png(10));
    expect(Object.hasOwn(tokenPayload(ticket.token), "stored")).toBe(false);
  });
});
