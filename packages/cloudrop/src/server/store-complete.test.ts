import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import { MiB } from "../rules.ts";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { SECRET, serverFixture } from "../testing/server-fixture.ts";
import { gate, hello, leaseStore, NOW, recordCalls, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const authorize = () => ({ userId: "u1" });
const owner = ({ userId }: { userId: string }) => userId;

/** A route whose onComplete counts its runs and returns the count; `hook` replaces its body. */
function counted(hook?: (run: number) => unknown) {
  const runs = { count: 0 };
  const definition = route(
    { accept: "*/*", maxSize: "1GB", authorize },
    {
      owner,
      onComplete: () => {
        runs.count += 1;
        return hook ? hook(runs.count) : { run: runs.count };
      },
    },
  );
  return { definition, runs };
}

/** A lease-mode server with one uploaded single-PUT file, ready to complete. */
async function uploaded(definition: ReturnType<typeof counted>["definition"], options = {}) {
  const fixture = storeFixture({ files: definition }, { store: leaseStore(), ...options });
  const ticket = await fixture.single("files", TEXT);
  await fixture.send(ticket.put, hello);
  return { fixture, ticket };
}

const busy = {
  code: "SERVER_ERROR",
  message: "Another request is completing this upload. Try again in a moment.",
  retryable: true,
};
const unfinished = {
  code: "SERVER_ERROR",
  message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
  retryable: true,
};
const cancelled = {
  code: "UPLOAD_EXPIRED",
  message: "This upload was cancelled or has expired. Start it again.",
  retryable: false,
};

describe("POST /complete with a store: once", () => {
  it("runs onComplete once, completes the row and moves the owner's bytes from reserved to active", async () => {
    const { definition, runs } = counted();
    const { fixture, ticket } = await uploaded(definition);
    const first = await complete(fixture, ticket.token);
    expect(first).toEqual({
      status: 200,
      body: {
        file: { id: ticket.id, key: ticket.key, name: "hello.txt", size: 5, type: "text/plain", url: null },
        data: { run: 1 },
      },
    });
    const [row] = await fixture.store.raw.files();
    expect([row?.status, row?.result, row?.completedAt]).toEqual(["completed", '{"run":1}', NOW]);
    expect(await fixture.store.usage("u1")).toEqual({ reservedBytes: 0, activeBytes: 5, files: 1 });
    expect(runs.count).toBe(1);
  });

  it("replays the stored answer to a retry without touching storage or running any hook again", async () => {
    let verified = 0;
    const counter: CloudropPlugin = { id: "counter", server: { afterVerify: () => void verified++ } };
    const { definition, runs } = counted();
    const { fixture, ticket } = await uploaded(definition, { plugins: [counter] });
    const first = await complete(fixture, ticket.token);
    const callsBefore = fixture.storageCalls.length;
    expect(await complete(fixture, ticket.token)).toEqual(first);
    expect([fixture.storageCalls.length - callsBefore, runs.count, verified]).toEqual([0, 1, 1]);
  });

  it("replays the stored answer after the token has expired, but refuses an expired upload that never completed", async () => {
    const { definition } = counted();
    const { fixture, ticket } = await uploaded(definition);
    const unfinishedTicket = await fixture.single("files", TEXT);
    const first = await complete(fixture, ticket.token);
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    expect(await complete(fixture, ticket.token)).toEqual(first);
    expect(await complete(fixture, unfinishedTicket.token)).toEqual({
      status: 410,
      body: {
        error: {
          code: "UPLOAD_EXPIRED",
          message: "This upload expired. Start it again to upload the file.",
          retryable: false,
        },
      },
    });
  });

  it("refuses a revoked upload and one whose row is missing, without touching storage", async () => {
    const { definition, runs } = counted();
    const { fixture, ticket } = await uploaded(definition);
    await fixture.cloudrop.api.revokeUploads({ owner: "u1" });
    // A server with the same secret but another database: the token verifies, the row is not there.
    const elsewhere = storeFixture({ files: definition }, { store: leaseStore() });
    const callsBefore = fixture.storageCalls.length;
    expect((await complete(fixture, ticket.token)).body.error).toEqual(cancelled);
    expect((await complete(elsewhere, ticket.token)).body.error).toEqual(cancelled);
    expect([fixture.storageCalls.length - callsBefore, elsewhere.storageCalls, runs.count]).toEqual([0, [], 0]);
  });

  it("completes the row with a null result on a route without onComplete", async () => {
    const plain = route({ accept: "*/*", maxSize: "1GB", authorize }, { owner });
    const fixture = storeFixture({ plain }, { store: leaseStore() });
    const ticket = await fixture.single("plain", TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).body.data).toBeNull();
    const [row] = await fixture.store.raw.files();
    expect([row?.status, row?.result]).toEqual(["completed", null]);
  });
});

describe("POST /complete with a store: failures in onComplete", () => {
  it.for([
    {
      name: "throws",
      hook: () => {
        throw new Error("database down");
      },
      log: 'cloudrop: onComplete failed for route "files".',
    },
    {
      name: "returns more than 16 KiB of JSON",
      hook: () => "x".repeat(16 * 1024),
      log: 'cloudrop: onComplete for route "files" returned more than 16 KiB of JSON. Return ids, not records.',
    },
    {
      name: "returns a value JSON cannot encode",
      hook: () => ({ n: 1n }),
      log: 'cloudrop: onComplete for route "files" returned a value JSON cannot encode (a BigInt or a cycle).',
    },
  ])("hands the row back at once when onComplete $name, so the retry runs it again", async ({ hook, log }) => {
    const { definition, runs } = counted((run) => (run === 1 ? hook() : { run }));
    const { fixture, ticket } = await uploaded(definition);
    expect((await complete(fixture, ticket.token)).body.error).toEqual(unfinished);
    const [row] = await fixture.store.raw.files();
    expect([row?.status, row?.claim, fixture.logger.errors.map((entry) => entry.message)]).toEqual([
      "pending",
      null,
      [log],
    ]);
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 2 });
    expect(runs.count).toBe(2);
  });

  it("accepts a result of exactly 16 KiB of JSON", async () => {
    // 16,382 characters plus the two quotes.
    const { definition } = counted(() => "x".repeat(16 * 1024 - 2));
    const { fixture, ticket } = await uploaded(definition);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
  });

  it.for(["claim", "complete"] as const)(
    "answers a retryable error and logs it when the store fails in %s",
    async (method) => {
      const store = memoryStore();
      const { definition } = counted();
      const { fixture, ticket } = await uploaded(definition, { store: leaseStore(store) });
      store.injectFailure(method, 0);
      expect((await complete(fixture, ticket.token)).body.error).toEqual({
        code: "SERVER_ERROR",
        message: "The server could not save the upload. Try again in a moment.",
        retryable: true,
      });
      expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
        `cloudrop: the store failed to ${method} file ${ticket.id} on route "files".`,
      ]);
    },
  );
});

describe("POST /complete with a store: overlapping requests", () => {
  it("runs onComplete once when two completions of a multipart upload overlap (M4-F12)", async () => {
    const { definition, runs } = counted();
    const fixture = storeFixture({ files: definition }, { store: leaseStore(), multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", { name: "big.bin", size: 9 * MiB, type: "" });
    for (const part of ticket.parts) {
      const size = part.partNumber === 1 ? ticket.partSize : 9 * MiB - ticket.partSize;
      await fixture.send(part, new Uint8Array(size));
    }
    const answers = await Promise.all([complete(fixture, ticket.token), complete(fixture, ticket.token)]);
    // Depending on how the two interleave, the second is busy or replays the first one's answer (M5-T22).
    const either = expect.toBeOneOf([{ run: 1 }, busy]);
    expect(answers.map(({ body }) => body.error ?? body.data)).toEqual([either, either]);
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 1 });
    expect([runs.count, fixture.logger.errors]).toEqual([1, []]);
  });

  it("answers busy with Retry-After while another request runs onComplete, and logs no error", async () => {
    const paused = gate();
    const { definition, runs } = counted(async (run) => {
      await paused.pass();
      return { run };
    });
    const { fixture, ticket } = await uploaded(definition);
    const first = complete(fixture, ticket.token);
    await paused.arrived;
    const callsBefore = fixture.storageCalls.length;
    const second = await fixture.post("complete", { token: ticket.token });
    expect([second.status, second.headers.get("retry-after"), await second.json()]).toEqual([
      500,
      "2",
      { error: busy },
    ]);
    // The live claim answers before any storage call.
    expect(fixture.storageCalls.length).toBe(callsBefore);
    paused.open();
    expect((await first).body.data).toEqual({ run: 1 });
    expect([runs.count, fixture.logger.errors]).toEqual([1, []]);
  });

  it("deletes nothing when a refusal races a completion that has claimed the row", async () => {
    const paused = gate();
    let refuse = false;
    const aborted: string[] = [];
    const checker: CloudropPlugin = {
      id: "checker",
      server: {
        afterVerify: () => (refuse ? new CloudropError("VERIFICATION_FAILED", "Refused by the app.") : undefined),
        onAbort: ({ reason }) => void aborted.push(reason),
      },
    };
    const { definition } = counted(async (run) => {
      await paused.pass();
      return { run };
    });
    const { fixture, ticket } = await uploaded(definition, { plugins: [checker] });
    const first = complete(fixture, ticket.token);
    await paused.arrived;
    refuse = true;
    // The second request read the row while it was still pending, before the first one claimed it.
    const get = fixture.store.get;
    fixture.store.get = async (id) => {
      const row = await get(id);
      return row && { ...row, status: "pending" };
    };
    expect((await complete(fixture, ticket.token)).body.error).toEqual(busy);
    paused.open();
    await first;
    expect([(await fixture.storage.head(ticket.key)).data?.size, aborted]).toEqual([5, []]);
    expect((await fixture.store.raw.files())[0]?.status).toBe("completed");
  });

  it("replays the winner's answer when a completion lost its claim to a later one after the lease", async () => {
    const paused = gate();
    const { definition, runs } = counted(async (run) => {
      if (run === 1) await paused.pass();
      return { run };
    });
    const { fixture, ticket } = await uploaded(definition, { completionLeaseMs: 60_000 });
    const first = complete(fixture, ticket.token);
    await paused.arrived;
    vi.setSystemTime(new Date(NOW.getTime() + 60_001));
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ run: 2 });
    paused.open();
    expect((await first).body.data).toEqual({ run: 2 });
    expect(runs.count).toBe(2);
  });

  it("answers a retryable error when a completion lost its claim to one that has not finished", async () => {
    const pausedFirst = gate();
    const pausedSecond = gate();
    const { definition } = counted(async (run) => {
      await (run === 1 ? pausedFirst : pausedSecond).pass();
      return { run };
    });
    const { fixture, ticket } = await uploaded(definition, { completionLeaseMs: 60_000 });
    const first = complete(fixture, ticket.token);
    await pausedFirst.arrived;
    vi.setSystemTime(new Date(NOW.getTime() + 60_001));
    const second = complete(fixture, ticket.token);
    await pausedSecond.arrived;
    pausedFirst.open();
    expect((await first).body.error).toEqual(unfinished);
    pausedSecond.open();
    expect((await second).body.data).toEqual({ run: 2 });
  });
});

describe("POST /complete with a store: afterComplete", () => {
  it("runs afterComplete once, after the completion, with the answer's data; a throw is logged and the answer stands", async () => {
    const seen: unknown[] = [];
    const failure = new Error("mail server down");
    const store = memoryStore();
    const notified = route(
      { accept: "*/*", maxSize: "1GB", authorize },
      {
        owner,
        onComplete: () => ({ id: 7 }),
        afterComplete: async ({ userId, file, data }) => {
          seen.push({ userId, size: file.size, data, status: (await store.raw.files())[0]?.status });
          throw failure;
        },
      },
    );
    const fixture = storeFixture({ notified }, { store: leaseStore(store) });
    const ticket = await fixture.single("notified", TEXT);
    await fixture.send(ticket.put, hello);
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ id: 7 });
    expect((await complete(fixture, ticket.token)).body.data).toEqual({ id: 7 });
    expect(seen).toEqual([{ userId: "u1", size: 5, data: { id: 7 }, status: "completed" }]);
    expect(fixture.logger.errors).toEqual([
      { message: 'cloudrop: afterComplete failed for route "notified".', error: failure },
    ]);
  });
});

describe("POST /complete: tokens signed without a store", () => {
  it("completes a token without the stored mark the stateless way, with no store call", async () => {
    const { definition } = counted();
    const plain = route({ accept: "*/*", maxSize: "1GB", authorize });
    // Issued by an instance of a rolling deploy that has no store yet: same secret, same bucket.
    const before = serverFixture({ files: plain }, { secret: SECRET });
    const ticket = await before.single("files", TEXT);
    await before.send(ticket.put, hello);
    const { store, calls } = recordCalls(memoryStore());
    const after = storeFixture({ files: definition }, { store, storage: before.storage });
    expect((await complete(after, ticket.token)).body.data).toEqual({ run: 1 });
    expect((await complete(after, ticket.token)).body.data).toEqual({ run: 2 });
    expect(calls).toEqual([]);
  });
});
