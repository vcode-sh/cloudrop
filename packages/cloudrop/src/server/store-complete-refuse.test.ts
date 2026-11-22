import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { hello, leaseStore, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const LEASE_MS = 60_000;
const busy = {
  code: "SERVER_ERROR",
  message: "Another request is completing this upload. Try again in a moment.",
  retryable: true,
};
const refusal = { code: "VERIFICATION_FAILED", message: "Refused by the app.", retryable: false };

/** A server whose plugin refuses every file, holding one uploaded file whose row another request has claimed. */
async function claimedElsewhere(store: ReturnType<typeof leaseStore>) {
  const aborted: string[] = [];
  const checker: CloudropPlugin = {
    id: "checker",
    server: {
      afterVerify: () => new CloudropError("VERIFICATION_FAILED", "Refused by the app."),
      onAbort: ({ reason }) => void aborted.push(reason),
    },
  };
  const fixture = storeFixture({ files: owned }, { store, plugins: [checker], completionLeaseMs: LEASE_MS });
  const ticket = await fixture.single("files", TEXT);
  await fixture.send(ticket.put, hello);
  // The request that claimed the row stopped before it recorded anything: a crash, or a deploy.
  await fixture.store.claim(ticket.id, "the-crashed-request", NOW, LEASE_MS);
  const state = async () => ({
    status: (await fixture.store.raw.files())[0]?.status,
    stored: (await fixture.storage.head(ticket.key)).data?.size ?? null,
    aborted: [...aborted],
  });
  return { fixture, ticket, state };
}

describe("POST /complete with a store: a refusal of a row another request claimed (M11-R138)", () => {
  it.for([
    { mode: "under a lease", store: () => leaseStore() },
    { mode: "in a transaction", store: () => memoryStore() },
  ])("leaves a completion in flight alone, and ends the row once its lease has run out, $mode", async ({ store }) => {
    const { fixture, ticket, state } = await claimedElsewhere(store());
    // The claim is live through exactly the lease (M5-T19): the other request may still be running onComplete.
    vi.setSystemTime(new Date(NOW.getTime() + LEASE_MS));
    expect((await complete(fixture, ticket.token)).body.error).toEqual(busy);
    expect(await state()).toEqual({ status: "completing", stored: 5, aborted: [] });

    vi.setSystemTime(new Date(NOW.getTime() + LEASE_MS + 1));
    expect((await complete(fixture, ticket.token)).body.error).toEqual(refusal);
    expect(await state()).toEqual({ status: "rejected", stored: null, aborted: ["rejected"] });
    expect(await fixture.store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0, erasure: null });
    // The row has ended: a retry is told so, and nothing is refused twice.
    expect((await complete(fixture, ticket.token)).body.error?.code).toBe("UPLOAD_EXPIRED");
  });
});

// M12-R30: a retryable error from afterVerify is "not now", not a verdict on the file: the row stays open and the
// object stays, so the retry the answer asks for completes the file instead of being told it was never uploaded.
describe("POST /complete with a store: a retryable afterVerify error", () => {
  it.for([
    { mode: "under a lease", store: () => leaseStore() },
    { mode: "in a transaction", store: () => memoryStore() },
  ])("keeps the row pending and the object, and the retry completes it, $mode", async ({ store }) => {
    const aborted: string[] = [];
    let busyScanner = true;
    const scanner: CloudropPlugin = {
      id: "scanner",
      server: {
        afterVerify: () =>
          busyScanner ? new CloudropError("SERVER_ERROR", "The scanner is busy.", { retryable: true }) : undefined,
        onAbort: ({ reason }) => void aborted.push(reason),
      },
    };
    const fixture = storeFixture({ files: owned }, { store: store(), plugins: [scanner] });
    const ticket = await fixture.single("files", TEXT);
    await fixture.send(ticket.put, hello);
    const first = await complete(fixture, ticket.token);
    expect({
      status: first.status,
      error: first.body.error,
      row: (await fixture.store.raw.files())[0]?.status,
      stored: (await fixture.storage.head(ticket.key)).data?.size,
      aborted,
    }).toEqual({
      status: 500,
      error: { code: "SERVER_ERROR", message: "The scanner is busy.", retryable: true },
      row: "pending",
      stored: 5,
      aborted: [],
    });
    busyScanner = false;
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    expect((await fixture.store.raw.files())[0]?.status).toBe("completed");
  });
});
