import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { gate, hello, leaseStore, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";
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

  it("removes the object of a stuck completion the sweep kept", async () => {
    const fixture = storeFixture({ owned });
    const stuck = await upload(fixture, "owned", false);
    await fixture.store.claim(stuck.id, "lost", new Date(), 60_000);
    // The sweep ends a completion stuck past its lease and its deadline (24 hours) plus grace as failed and cleaned,
    // and keeps its object: cleaned long after its URLs ran out, yet the object is still there.
    at(26 * HOUR);
    await fixture.store.end(stuck.id, "completing", "failed", new Date(), { cleaned: true });
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ cleaned: 1, done: true });
    expect(await stored(fixture, stuck.key)).toBe(false);
  });

  it("is not done while a completion is under way, and deletes the file once it completed", async () => {
    const paused = gate();
    const slow = route(
      { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
      { owner: ({ userId }) => userId, onComplete: () => paused.pass() },
    );
    const fixture = storeFixture({ slow });
    const ticket = await upload(fixture, "slow", false);
    const completing = complete(fixture, ticket.token);
    await paused.arrived;
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ waiting: 1, done: false });
    paused.open();
    expect((await completing).status).toBe(200);
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ deleted: 1, done: false });
    expect(await stored(fixture, ticket.key)).toBe(false);
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
    const fixture = storeFixture(
      { flaky },
      {
        store: {
          ...base,
          // Right after the run reads the owner's pending files: the completion fails and hands its file back to
          // pending, and its client will retry. A run reading one status at a time saw it in neither status.
          list: async (input) => {
            const page = await base.list(input);
            if (completing && input.statuses.includes("pending")) {
              paused.open();
              await completing;
              completing = undefined;
            }
            return page;
          },
        },
      },
    );
    const ticket = await upload(fixture, "flaky", false);
    completing = complete(fixture, ticket.token);
    await paused.arrived;
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ waiting: 1, done: false });
    expect((await fixture.store.raw.files())[0]?.status).toBe("pending");
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
    fixture.fake.fetch = () => Promise.reject(new TypeError("network down"));
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toMatchObject({ deleted: 1, failed: 1, done: false });
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      `cloudrop: eraseOwner could not remove what file ${ticket.id} left in the bucket. Run eraseOwner again.`,
    ]);
  });

  it("stops before the next file once its signal is aborted, and is not done", async () => {
    const fixture = storeFixture({ owned });
    await upload(fixture, "owned");
    const report = await fixture.cloudrop.api.eraseOwner("u1", { signal: AbortSignal.abort() });
    expect(report.data).toEqual({ revoked: 0, deleted: 0, refused: 0, cleaned: 0, failed: 0, waiting: 0, done: false });
    expect((await fixture.store.raw.files())[0]?.status).toBe("completed");
  });

  it.for([
    { name: "an empty owner", owner: "", options: undefined },
    { name: "a grace under 15 minutes", owner: "u1", options: { graceMs: 899_999 } },
    { name: "a signal that is not an AbortSignal", owner: "u1", options: { signal: {} as AbortSignal } },
  ])("refuses $name with INVALID_INPUT", async ({ owner, options }) => {
    const fixture = storeFixture({ owned });
    expect((await fixture.cloudrop.api.eraseOwner(owner, options)).error?.code).toBe("INVALID_INPUT");
  });
});
