import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MiB } from "../rules.ts";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { gate, hello, leaseStore, NOW, owned, recordCalls, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { AbortContext, CloudropPlugin } from "./plugins.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const AFTER_DEADLINE = new Date("2026-11-19T12:00:00Z");

function recorder(calls: AbortContext["reason"][]): CloudropPlugin {
  return { id: "recorder", server: { onAbort: ({ reason }) => void calls.push(reason) } };
}

async function abort(fixture: ReturnType<typeof storeFixture>, token: string) {
  const response = await fixture.post("abort", { token });
  return { status: response.status, body: await response.json() };
}

describe("POST /abort with a store", () => {
  it("ends a pending row as aborted, releases its bytes, aborts the upload and tells the plugins", async () => {
    const reasons: AbortContext["reason"][] = [];
    const fixture = storeFixture({ owned }, { multipartThreshold: 0, plugins: [recorder(reasons)] });
    const ticket = await fixture.multipart("owned", { name: "big.bin", size: 9 * MiB, type: "" });
    expect(await abort(fixture, ticket.token)).toEqual({ status: 200, body: { id: ticket.id } });
    const [row] = await fixture.store.raw.files();
    expect([row?.status, row?.endedAt, fixture.fake.pendingUploads(), reasons]).toEqual([
      "aborted",
      NOW,
      0,
      ["aborted"],
    ]);
    expect(await fixture.store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
  });

  it.for([
    { name: "a live token", time: NOW },
    { name: "an expired token", time: AFTER_DEADLINE },
  ])("keeps a completed file and tells no plugin, with $name", async ({ time }) => {
    const reasons: AbortContext["reason"][] = [];
    const fixture = storeFixture({ owned }, { plugins: [recorder(reasons)] });
    const ticket = await fixture.single("owned", TEXT);
    await fixture.send(ticket.put, hello);
    await complete(fixture, ticket.token);
    vi.setSystemTime(time);
    expect(await abort(fixture, ticket.token)).toEqual({ status: 200, body: { id: ticket.id } });
    expect([(await fixture.storage.head(ticket.key)).data?.size, reasons]).toEqual([5, []]);
    expect((await fixture.store.raw.files())[0]?.status).toBe("completed");
  });

  it("keeps a file whose completion is running", async () => {
    const paused = gate();
    const slow = route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      { owner: ({ userId }) => userId, onComplete: () => paused.pass() },
    );
    const fixture = storeFixture({ slow }, { store: leaseStore() });
    const ticket = await fixture.single("slow", TEXT);
    await fixture.send(ticket.put, hello);
    const completing = complete(fixture, ticket.token);
    await paused.arrived;
    expect((await abort(fixture, ticket.token)).status).toBe(200);
    paused.open();
    expect((await completing).status).toBe(200);
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
  });

  it("deletes a late PUT of a revoked upload even after the token expired, because the row decides", async () => {
    const reasons: AbortContext["reason"][] = [];
    const fixture = storeFixture({ owned }, { plugins: [recorder(reasons)] });
    const ticket = await fixture.single("owned", TEXT);
    await fixture.cloudrop.api.revokeUploads({ owner: "u1" });
    // The PUT was signed before the revoke and lands after it.
    await fixture.send(ticket.put, hello);
    vi.setSystemTime(AFTER_DEADLINE);
    expect((await abort(fixture, ticket.token)).status).toBe(200);
    expect([(await fixture.storage.head(ticket.key)).data, reasons]).toEqual([null, ["aborted"]]);
    expect((await fixture.store.raw.files())[0]?.status).toBe("aborted");
  });

  it("does nothing for a stored token whose row is missing", async () => {
    const fixture = storeFixture({ owned });
    const ticket = await fixture.single("owned", TEXT);
    await fixture.send(ticket.put, hello);
    // Another server with the same secret and bucket, but its own database.
    const elsewhere = storeFixture({ owned }, { storage: fixture.storage });
    expect((await abort(elsewhere, ticket.token)).status).toBe(200);
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
  });

  it("answers a retryable error and deletes nothing when the store fails", async () => {
    const store = memoryStore();
    const fixture = storeFixture({ owned }, { store });
    const ticket = await fixture.single("owned", TEXT);
    await fixture.send(ticket.put, hello);
    store.injectFailure("end", 0);
    expect(await abort(fixture, ticket.token)).toEqual({
      status: 500,
      body: {
        error: {
          code: "SERVER_ERROR",
          message: "The server could not reach its upload records. Try again in a moment.",
          retryable: true,
        },
      },
    });
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
  });
});

describe("POST /sign with a store", () => {
  const cancelled = {
    code: "UPLOAD_EXPIRED",
    message: "This upload was cancelled or has expired. Start it again.",
    retryable: false,
  };

  it("signs a pending upload as before", async () => {
    const fixture = storeFixture({ owned });
    const ticket = await fixture.single("owned", TEXT);
    const response = await fixture.post("sign", { token: ticket.token });
    expect([response.status, (await fixture.send((await response.json()).put, hello)).status]).toEqual([200, 200]);
  });

  it("refuses a revoked upload, a completed one and one whose row is missing", async () => {
    const fixture = storeFixture({ owned });
    const revoked = await fixture.single("owned", TEXT);
    await fixture.cloudrop.api.revokeUploads({ owner: "u1" });
    const done = await fixture.single("owned", TEXT);
    await fixture.send(done.put, hello);
    await complete(fixture, done.token);
    const elsewhere = storeFixture({ owned });
    const answers = await Promise.all([
      fixture.post("sign", { token: revoked.token }),
      fixture.post("sign", { token: done.token }),
      elsewhere.post("sign", { token: done.token }),
    ]);
    expect(await Promise.all(answers.map(async (answer) => [answer.status, await answer.json()]))).toEqual([
      [410, { error: cancelled }],
      [410, { error: cancelled }],
      [410, { error: cancelled }],
    ]);
  });

  it("checks the token before it reads the store", async () => {
    const { store, calls } = recordCalls(memoryStore());
    const fixture = storeFixture({ owned }, { store });
    const response = await fixture.post("sign", { token: "not-a-token" });
    expect([(await response.json()).error.code, calls]).toEqual(["INVALID_TOKEN", []]);
  });

  it("answers a retryable error when the store cannot be read", async () => {
    const store = memoryStore();
    const fixture = storeFixture({ owned }, { store });
    const ticket = await fixture.single("owned", TEXT);
    store.get = () => Promise.reject(new Error("connection reset"));
    const response = await fixture.post("sign", { token: ticket.token });
    expect([response.status, (await response.json()).error.retryable]).toEqual([500, true]);
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      `cloudrop: the store failed to get file ${ticket.id} on route "owned".`,
    ]);
  });
});
