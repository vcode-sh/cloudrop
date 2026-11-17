// With a store configured, a token without the stored mark (signed before the store was enabled, or by an instance
// of a rolling deploy without one) takes the stateless path: the same answers as a server without a store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { SECRET, serverFixture } from "../testing/server-fixture.ts";
import { hello, NOW, owned, recordCalls, storeFixture, TEXT } from "../testing/store-fixture.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const authorize = () => ({ userId: "u1" });

/** A file uploaded through a server without a store, whose route answers `result`; same secret, same bucket. */
async function signedWithoutStore(result: unknown) {
  const files = route({ accept: "*/*", maxSize: "1GB", authorize }, { onComplete: () => result });
  const before = serverFixture({ files }, { secret: SECRET });
  const ticket = await before.single("files", TEXT);
  await before.send(ticket.put, hello);
  return { files, before, ticket };
}

describe("POST /complete with a store: tokens without the stored mark", () => {
  it("completes the stateless way, again on every retry, with no store call", async () => {
    let runs = 0;
    const counted = route({ accept: "*/*", maxSize: "1GB", authorize }, { onComplete: () => ({ run: ++runs }) });
    const { before, ticket } = await signedWithoutStore(null);
    const { store, calls } = recordCalls(memoryStore());
    const after = storeFixture({ files: counted }, { store, storage: before.storage });
    expect((await complete(after, ticket.token)).body.data).toEqual({ run: 1 });
    expect((await complete(after, ticket.token)).body.data).toEqual({ run: 2 });
    expect(calls).toEqual([]);
  });

  it("accepts a result over 16 KiB, which only a stored row is capped at", async () => {
    const large = "x".repeat(20_000);
    const { files, before, ticket } = await signedWithoutStore(large);
    const after = storeFixture({ files }, { storage: before.storage });
    expect((await complete(after, ticket.token)).body.data).toBe(large);
  });

  it("answers an expired token whose route a deploy removed with UPLOAD_EXPIRED, as without a store", async () => {
    const { before, ticket } = await signedWithoutStore(null);
    const after = storeFixture({ owned }, { storage: before.storage });
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    const answers = await Promise.all([complete(before, ticket.token), complete(after, ticket.token)]);
    expect(answers.map(({ status, body }) => [status, body.error?.code])).toEqual([
      [410, "UPLOAD_EXPIRED"],
      [410, "UPLOAD_EXPIRED"],
    ]);
  });
});
