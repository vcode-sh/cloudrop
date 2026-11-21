import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { type MemoryStore, memoryStore } from "../testing/memory-store.ts";
import { gate, hello, leaseStore, NOW, owned, recordCalls, storeFixture, TEXT } from "../testing/store-fixture.ts";
import { route } from "./route.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => vi.setSystemTime(NOW.getTime() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const other = route(
  { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u2" }) },
  { owner: ({ userId }) => userId },
);

type Fixture = ReturnType<typeof storeFixture>;

/** Uploads one file on `routeName` and completes it unless `completeIt` is false; answers its ticket. */
async function upload(fixture: Fixture, routeName: string, completeIt = true) {
  const ticket = await fixture.single(routeName, TEXT);
  await fixture.send(ticket.put, hello);
  if (completeIt) expect((await complete(fixture, ticket.token)).status).toBe(200);
  return ticket;
}

const stored = async (fixture: Fixture, key: string) => (await fixture.storage.head(key)).data !== null;

const UNREACHABLE = {
  code: "SERVER_ERROR",
  retryable: true,
  message: "The server could not reach its upload records. Try again in a moment.",
};

describe("cloudrop.api.eraseOwner", () => {
  it("revokes, deletes and removes the owner's files, and reports done once a late PUT can no longer land", async () => {
    const fixture = storeFixture({ owned, other });
    const old = await upload(fixture, "owned");
    const theirs = await upload(fixture, "other");
    at(2 * HOUR);
    const open = await upload(fixture, "owned", false);
    const { api } = fixture.cloudrop;
    expect(await api.eraseOwner("u1")).toEqual({
      data: { revoked: 1, deleted: 1, refused: 0, cleaned: 1, failed: 0, waiting: 1, done: false },
      error: null,
    });
    expect([
      await stored(fixture, old.key),
      await stored(fixture, open.key),
      await stored(fixture, theirs.key),
    ]).toEqual([false, false, true]);
    // A PUT of the revoked upload, started with its URL before the URL ran out, lands after the first run.
    expect((await fixture.send(open.put, hello)).status).toBe(200);
    // The URL was signed when the upload was revoked, so it worked for 15 minutes more; then an hour of grace.
    at(2 * HOUR + 15 * MINUTE + HOUR - 1);
    expect((await api.eraseOwner("u1")).data?.done).toBe(false);
    at(2 * HOUR + 15 * MINUTE + HOUR);
    expect(await api.eraseOwner("u1")).toEqual({
      data: { revoked: 0, deleted: 0, refused: 0, cleaned: 1, failed: 0, waiting: 0, done: true },
      error: null,
    });
    expect(await stored(fixture, open.key)).toBe(false);
    expect((await api.eraseOwner("u1")).data).toEqual({
      revoked: 0,
      deleted: 0,
      refused: 0,
      cleaned: 0,
      failed: 0,
      waiting: 0,
      done: true,
    });
    expect((await api.usage("u1")).data).toEqual({ reservedBytes: 0, activeBytes: 0, files: 0 });
    expect((await api.file(theirs.id)).data?.status).toBe("completed");
  });

  // eraseOwner never ends a completion: one its server never finished stays until the sweep ends it, once it is past
  // its lease and the grace (1 hour) past its token's deadline (24 hours after /upload). The sweep keeps the object.
  it("waits for the sweep to end a completion its server never finished, then removes its object", async () => {
    const fixture = storeFixture({ owned });
    const stuck = await upload(fixture, "owned", false);
    await fixture.store.claim(stuck.id, "lost", new Date(), 60_000);
    const { api } = fixture.cloudrop;
    at(25 * HOUR);
    expect((await api.sweep()).data?.reported).toEqual([]);
    at(25 * HOUR + 1);
    expect((await api.eraseOwner("u1")).data).toMatchObject({ cleaned: 0, waiting: 1, done: false });
    expect(await stored(fixture, stuck.key)).toBe(true);
    expect((await api.sweep()).data?.reported.map((row) => [row.id, row.status])).toEqual([[stuck.id, "failed"]]);
    expect(await stored(fixture, stuck.key)).toBe(true);
    expect((await api.eraseOwner("u1")).data).toMatchObject({ cleaned: 1, waiting: 0, done: true });
    expect(await stored(fixture, stuck.key)).toBe(false);
  });

  it("is not done while a completion is under way, and deletes the file once it completed", async () => {
    const paused = gate();
    const hooks: string[] = [];
    const slow = route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onComplete: () => paused.pass(),
        onDelete: ({ file, reason }) => void hooks.push(`${reason} ${file.id}`),
      },
    );
    const fixture = storeFixture({ slow });
    const ticket = await upload(fixture, "slow", false);
    const completing = complete(fixture, ticket.token);
    await paused.arrived;
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ waiting: 1, done: false });
    paused.open();
    expect((await completing).status).toBe(200);
    // Kept with its object and its hook not run, until a run finds it completed.
    expect([await stored(fixture, ticket.key), hooks]).toEqual([true, []]);
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ deleted: 1, done: false });
    expect([await stored(fixture, ticket.key), hooks]).toEqual([false, [`erased ${ticket.id}`]]);
  });

  it("is not done when a failed completion hands its file back while it runs", async () => {
    const paused = gate();
    const flaky = route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onComplete: async () => {
          await paused.pass();
          throw new Error("the app's database is down");
        },
      },
    );
    const base = leaseStore();
    let completing: Promise<unknown> | undefined;
    let cancel = "";
    const fixture: Fixture = storeFixture(
      { flaky },
      {
        store: {
          ...base,
          list: async (input) => {
            const page = await base.list(input);
            // Right after the run's first read past the completed files: the completion fails and hands its file back
            // to pending. A run reading one status at a time saw it in neither status.
            if (completing && input.statuses[0] !== "completed") {
              paused.open();
              await completing;
              completing = undefined;
            }
            // Right after the run read the aborted files: the client gives up and cancels. The file is in no live
            // status from here on, so only the read that found it live keeps the run from done.
            if (cancel && input.statuses[0] === "aborted") {
              expect((await fixture.post("abort", { token: cancel })).status).toBe(200);
              cancel = "";
            }
            return page;
          },
        },
      },
    );
    const ticket = await upload(fixture, "flaky", false);
    completing = complete(fixture, ticket.token);
    await paused.arrived;
    cancel = ticket.token;
    // Later than the upload, so the file does not count as one that started during the run.
    at(1000);
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ waiting: 1, done: false });
    expect((await fixture.store.raw.files())[0]?.status).toBe("aborted");
  });

  it("is not done when an upload starts while it runs", async () => {
    const base = memoryStore();
    let started = false;
    const fixture: Fixture = storeFixture(
      { owned },
      {
        store: {
          ...base,
          // The first ended pass: the run has revoked and deleted, and the owner starts another upload.
          list: async (input) => {
            if (input.statuses.includes("aborted") && !started) {
              started = true;
              await fixture.single("owned", TEXT);
            }
            return base.list(input);
          },
        },
      },
    );
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ waiting: 1, done: false });
    expect((await fixture.store.raw.files()).map((row) => row.status)).toEqual(["pending"]);
  });

  it("is not done when an upload reserved just before the run is recorded while it runs", async () => {
    const base = memoryStore();
    let started = false;
    const fixture: Fixture = storeFixture(
      { owned },
      {
        store: {
          ...base,
          // The first ended pass, after the live statuses were read: an /upload that took its time a second before the
          // run began records its file only now. The file is older than the run, so only the last read of the live
          // statuses finds it.
          list: async (input) => {
            if (input.statuses.includes("aborted") && !started) {
              started = true;
              at(0);
              await fixture.single("owned", TEXT);
              at(1000);
            }
            return base.list(input);
          },
        },
      },
    );
    at(1000);
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ revoked: 0, waiting: 1, done: false });
    expect((await fixture.store.raw.files()).map((row) => [row.status, row.createdAt])).toEqual([["pending", NOW]]);
  });

  it("is not done when an upload starts and is cancelled while it runs", async () => {
    const base = memoryStore();
    let started = false;
    const fixture: Fixture = storeFixture(
      { owned },
      {
        store: {
          ...base,
          // Just after the run read the aborted files: an upload starts, its PUT lands, and its client cancels it. It
          // is never live when the run reads the live statuses.
          list: async (input) => {
            const page = await base.list(input);
            if (input.statuses.includes("aborted") && !started) {
              started = true;
              const ticket = await upload(fixture, "owned", false);
              expect((await fixture.post("abort", { token: ticket.token })).status).toBe(200);
              await fixture.send(ticket.put, hello);
            }
            return page;
          },
        },
      },
    );
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ waiting: 1, done: false });
    expect((await fixture.store.raw.files()).map((row) => row.status)).toEqual(["aborted"]);
  });

  it("counts a file whose key it cannot check as failed, logs it, and is not done", async () => {
    const fixture = storeFixture({ owned });
    const ticket = await upload(fixture, "owned");
    // Past the file's URLs and the grace: nothing is waiting, so the failure alone keeps the run from done.
    at(2 * HOUR);
    fixture.fake.fetch = () => Promise.reject(new TypeError("network down"));
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toEqual({
      revoked: 0,
      deleted: 1,
      refused: 0,
      cleaned: 0,
      failed: 1,
      waiting: 0,
      done: false,
    });
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      `cloudrop: eraseOwner could not remove what file ${ticket.id} left in the bucket. Run eraseOwner again.`,
    ]);
  });

  // A page is 100 rows; with `limit` 1 the store answers one row a page, so the same two files are two pages.
  it.for([
    { name: "between two files of one page", limit: 100 },
    { name: "between two pages", limit: 1 },
  ])("stops $name once its signal aborts, with no store call after", async ({ limit }) => {
    const base = memoryStore();
    const controller = new AbortController();
    const recorded = recordCalls<MemoryStore>({
      ...base,
      list: (input) => base.list({ ...input, limit: Math.min(input.limit, limit) }),
      // The signal aborts just as the first file's deletion is recorded; the calls recorded from then on follow it.
      end: async (...call) => {
        const ended = await base.end(...call);
        controller.abort();
        recorded.calls.length = 0;
        return ended;
      },
    });
    const fixture = storeFixture({ owned }, { store: recorded.store });
    await upload(fixture, "owned");
    await upload(fixture, "owned");
    const report = await fixture.cloudrop.api.eraseOwner("u1", { signal: controller.signal });
    expect(report.data).toEqual({ revoked: 0, deleted: 1, refused: 0, cleaned: 0, failed: 0, waiting: 0, done: false });
    expect(recorded.calls).toEqual([]);
    expect((await fixture.store.raw.files()).map((row) => row.status).sort()).toEqual(["completed", "deleted"]);
  });

  it("does nothing when its signal is aborted before the run, and is not done", async () => {
    const fixture = storeFixture({ owned });
    await upload(fixture, "owned");
    await upload(fixture, "owned", false);
    const report = await fixture.cloudrop.api.eraseOwner("u1", { signal: AbortSignal.abort() });
    expect(report.data).toEqual({ revoked: 0, deleted: 0, refused: 0, cleaned: 0, failed: 0, waiting: 0, done: false });
    expect((await fixture.store.raw.files()).map((row) => row.status).sort()).toEqual(["completed", "pending"]);
  });

  it("reads every page of the owner's files", async () => {
    const base = memoryStore();
    // A page is 100 rows; this store answers one row a page.
    const store = { ...base, list: (input: Parameters<MemoryStore["list"]>[0]) => base.list({ ...input, limit: 1 }) };
    const fixture = storeFixture({ owned }, { store });
    await upload(fixture, "owned");
    await upload(fixture, "owned");
    at(2 * HOUR);
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ deleted: 2, cleaned: 2, done: true });
  });

  it("waits the graceMs it is given", async () => {
    const fixture = storeFixture({ owned });
    await upload(fixture, "owned");
    const erase = () => fixture.cloudrop.api.eraseOwner("u1", { graceMs: 15 * MINUTE });
    // The file's URLs worked for 15 minutes after it completed; then the 15 minutes of grace.
    at(30 * MINUTE - 1);
    expect((await erase()).data).toMatchObject({ deleted: 1, cleaned: 0, waiting: 1, done: false });
    at(30 * MINUTE);
    expect((await erase()).data).toMatchObject({ cleaned: 1, waiting: 0, done: true });
  });

  it.for(["rejected", "expired"] as const)("removes what an upload ended as %s left under its key", async (status) => {
    const fixture = storeFixture({ owned });
    const ended = await upload(fixture, "owned", false);
    await fixture.store.end(ended.id, "pending", status, new Date());
    at(2 * HOUR);
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ cleaned: 1, done: true });
    expect(await stored(fixture, ended.key)).toBe(false);
  });

  // What 0.1's deleteFile did: the row says cleaned, from a check made while one of its URLs could still put the
  // object back.
  it("checks again a file marked cleaned before its URLs and the grace ran out", async () => {
    const fixture = storeFixture({ owned });
    const early = await upload(fixture, "owned");
    await fixture.store.end(early.id, "completed", "deleted", new Date(), { cleaned: true });
    at(2 * HOUR);
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ cleaned: 1, done: true });
    expect(await stored(fixture, early.key)).toBe(false);
  });

  it("counts a file it cannot mark cleaned as failed, and the next run finishes it", async () => {
    const fixture = storeFixture({ owned });
    await upload(fixture, "owned");
    at(2 * HOUR);
    fixture.store.injectFailure("cleaned", 0);
    const { api } = fixture.cloudrop;
    expect((await api.eraseOwner("u1")).data).toMatchObject({ deleted: 1, cleaned: 0, failed: 1, done: false });
    expect((await api.eraseOwner("u1")).data).toMatchObject({ cleaned: 1, failed: 0, done: true });
  });

  type Listing = Parameters<MemoryStore["list"]>[0];
  it.for([
    { name: "revoke the uploads", fails: (method: string) => method === "revoke" },
    { name: "list the completed files", fails: (_: string, input?: Listing) => input?.statuses.length === 1 },
    { name: "read the newest file", fails: (_: string, input?: Listing) => input?.limit === 1 },
  ])("answers the store's error when it cannot $name", async ({ fails }) => {
    const base = memoryStore();
    const down = () => Promise.reject(new Error("The database is down."));
    const store: MemoryStore = {
      ...base,
      revoke: (...call) => (fails("revoke") ? down() : base.revoke(...call)),
      list: (input) => (fails("list", input) ? down() : base.list(input)),
    };
    const fixture = storeFixture({ owned }, { store });
    expect(await fixture.cloudrop.api.eraseOwner("u1")).toEqual({
      data: null,
      error: expect.objectContaining(UNREACHABLE),
    });
  });

  it.for([
    { name: "an empty owner", owner: "", options: undefined },
    { name: "a grace under 15 minutes", owner: "u1", options: { graceMs: 899_999 } },
    { name: "a grace over 30 days", owner: "u1", options: { graceMs: 2_592_000_001 } },
    { name: "a signal that is not an AbortSignal", owner: "u1", options: { signal: {} as AbortSignal } },
    { name: "options that are not an object", owner: "u1", options: "now" as never },
  ])("refuses $name with INVALID_INPUT", async ({ owner, options }) => {
    const fixture = storeFixture({ owned });
    expect((await fixture.cloudrop.api.eraseOwner(owner, options)).error?.code).toBe("INVALID_INPUT");
  });
});
