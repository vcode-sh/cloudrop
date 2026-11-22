import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadResponse } from "../protocol/types.ts";
import { complete } from "../testing/complete-fixture.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { gate, hello, NOW, owned, recordCalls, storeFixture, TEXT } from "../testing/store-fixture.ts";
import { route } from "./route.ts";

// Contract: M12-O. eraseOwner marks the owner first, so an /upload that passed authorize before the mark is refused
// (M12-O2); it empties erase.prefixes only once the rows are done, and only folders that hold the owner as a whole
// segment (M12-O3); the sweep finishes what one call could not (M12-O4); reopenOwner lets the owner in again (M12-O5).
// Oracles: the /upload answer, the fake bucket's objects and the memory store's rows and calls.

const HOUR = 3_600_000;
const at = (ms: number) => vi.setSystemTime(NOW.getTime() + ms);
const time = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const BEING_ERASED = {
  kind: "rejected",
  error: {
    code: "FORBIDDEN",
    message: "This account is being erased, so it can no longer upload files.",
    retryable: false,
  },
};

type Fixture = ReturnType<typeof storeFixture>;

async function uploadOne(fixture: Fixture, routeName = "owned") {
  const response = await fixture.post("upload", { route: routeName, files: [TEXT] });
  expect(response.status).toBe(200);
  return ((await response.json()) as UploadResponse).files[0];
}

/** Uploads one file of u1's and completes it. */
async function completed(fixture: Fixture) {
  const ticket = await fixture.single("owned", TEXT);
  await fixture.send(ticket.put, hello);
  expect((await complete(fixture, ticket.token)).status).toBe(200);
  return ticket;
}

const keys = async (fixture: Fixture) => (await fixture.storage.list("exports/")).data?.items.map((item) => item.key);

describe("eraseOwner's mark", () => {
  it("refuses with FORBIDDEN an /upload whose authorize resolved after the mark, and writes no row", async () => {
    const paused = gate();
    const slow = route(
      {
        accept: "*/*",
        maxSize: "1GB",
        authorize: async () => {
          await paused.pass();
          return { userId: "u1" };
        },
      },
      { owner: ({ userId }) => userId },
    );
    const fixture = storeFixture({ slow });
    const uploading = uploadOne(fixture, "slow");
    await paused.arrived;
    // Nothing of u1's yet: the call marks the owner and finishes the erasure at once.
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data?.done).toBe(true);
    paused.open();
    expect(await uploading).toEqual(BEING_ERASED);
    expect(await fixture.store.raw.files()).toEqual([]);
  });

  it("answers done at once, without reading rows, once an erasure has finished", async () => {
    const recorded = recordCalls(memoryStore());
    const fixture = storeFixture({ owned }, { store: recorded.store });
    await completed(fixture);
    at(2 * HOUR);
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data?.done).toBe(true);
    recorded.calls.length = 0;
    at(3 * HOUR);
    expect((await fixture.cloudrop.api.eraseOwner("u1")).data).toEqual({
      requestedAt: time(2 * HOUR),
      revoked: 0,
      deleted: 0,
      refused: 0,
      cleaned: 0,
      failed: 0,
      waiting: 0,
      prefixed: 0,
      done: true,
    });
    expect(recorded.calls).toEqual(["markErasure"]);
  });

  it("lets the owner upload again after reopenOwner, which reports whether there was a mark", async () => {
    const fixture = storeFixture({ owned });
    const { api } = fixture.cloudrop;
    await api.eraseOwner("u1");
    expect(await uploadOne(fixture)).toEqual(BEING_ERASED);
    expect(await api.reopenOwner("u1")).toEqual({ data: { reopened: true }, error: null });
    expect((await uploadOne(fixture))?.kind).toBe("single");
    expect((await api.usage("u1")).data?.erasure).toBeNull();
    expect(await api.reopenOwner("u1")).toEqual({ data: { reopened: false }, error: null });
  });
});

describe("eraseOwner's prefixes", () => {
  it("empties the owner's folders only once the rows are done, and no one else's", async () => {
    const fixture = storeFixture({ owned }, { erase: { prefixes: (owner) => [`exports/${owner}/`] } });
    await fixture.storage.put("exports/u1/a.txt", "theirs");
    await fixture.storage.put("exports/u2/b.txt", "someone else's");
    await completed(fixture);
    const { api } = fixture.cloudrop;
    // The completed file's URLs and the grace have not run out: the rows are not done, so the folder stays.
    expect((await api.eraseOwner("u1")).data).toMatchObject({ deleted: 1, waiting: 1, prefixed: 0, done: false });
    expect(await keys(fixture)).toEqual(["exports/u1/a.txt", "exports/u2/b.txt"]);
    at(2 * HOUR);
    expect((await api.eraseOwner("u1")).data).toMatchObject({ cleaned: 1, prefixed: 1, done: true });
    expect(await keys(fixture)).toEqual(["exports/u2/b.txt"]);
  });

  it("takes the owner URI-encoded as a segment", async () => {
    const prefixes = (owner: string) => [`exports/${encodeURIComponent(owner)}/`];
    const fixture = storeFixture({ owned }, { erase: { prefixes } });
    await fixture.storage.put("exports/team%2F7/a.txt", "theirs");
    expect((await fixture.cloudrop.api.eraseOwner("team/7")).data).toMatchObject({ prefixed: 1, done: true });
    expect(await keys(fixture)).toEqual([]);
  });

  it.for([
    { name: "a folder without the owner", prefix: "avatars/" },
    { name: "the owner inside a longer segment", prefix: "exports/u10/" },
    { name: "no trailing slash", prefix: "exports/u1" },
  ])("refuses $name with INVALID_CONFIG, before it marks the owner", async ({ prefix }) => {
    const fixture = storeFixture({ owned }, { erase: { prefixes: () => [prefix] } });
    const { api } = fixture.cloudrop;
    expect(await api.eraseOwner("u1")).toEqual({
      data: null,
      error: expect.objectContaining({
        code: "INVALID_CONFIG",
        message: `erase.prefixes answered ${JSON.stringify(prefix)}. It must answer a list of folders that end in "/" and each have the owner, as it is or URI-encoded, as one whole segment between slashes, such as "exports/<owner>/", so that no prefix reaches another owner's files.`,
      }),
    });
    expect((await api.usage("u1")).data?.erasure).toBeNull();
  });

  it.for([
    {
      name: "without a store",
      options: { erase: {} },
      message: "erase needs a database store, which erases by the owner's rows. Pass store, or remove erase.",
    },
    {
      name: "with prefixes that are not a function",
      options: { store: memoryStore(), erase: { prefixes: ["exports/"] } },
      message:
        'erase.prefixes must be a function from an owner to their folders, such as (owner) => ["exports/" + owner + "/"].',
    },
  ])("createCloudrop refuses erase $name", ({ options, message }) => {
    expect(() => serverFixture({ owned }, options as never)).toThrow(message);
  });
});

describe("the sweep's erase pass", () => {
  it("finishes an erasure its call stopped, with the sweep's grace", async () => {
    const fixture = storeFixture({ owned });
    const ticket = await completed(fixture);
    const { api } = fixture.cloudrop;
    // Stopped before its first file: the mark is set, nothing else is done.
    expect((await api.eraseOwner("u1", { signal: AbortSignal.abort() })).data).toMatchObject({ done: false });
    at(2 * HOUR);
    expect((await api.sweep()).data).toMatchObject({ erasing: 1, erased: 1, failed: 0, cursor: null });
    expect((await fixture.storage.head(ticket.key)).data).toBeNull();
    expect((await api.usage("u1")).data?.erasure).toEqual({ requestedAt: NOW, erasedAt: time(2 * HOUR) });
    // Finished: the next sweep has nobody to erase.
    expect((await api.sweep()).data).toMatchObject({ erasing: 0, erased: 0 });
  });

  it("counts an erasure it cannot finish as failed, logs it, and finishes it once storage is back", async () => {
    const fixture = storeFixture({ owned }, { erase: { prefixes: (owner) => [`exports/${owner}/`] } });
    const { api } = fixture.cloudrop;
    const { fetch } = fixture.fake;
    fixture.fake.fetch = () => Promise.reject(new TypeError("network down"));
    expect((await api.eraseOwner("u1")).data).toMatchObject({ failed: 1, done: false });
    expect((await api.sweep()).data).toMatchObject({ erasing: 1, erased: 0, failed: 1 });
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      "cloudrop: eraseOwner could not empty exports/u1/. Run eraseOwner again.",
      "cloudrop: eraseOwner could not empty exports/u1/. Run eraseOwner again.",
    ]);
    fixture.fake.fetch = fetch;
    expect((await api.sweep()).data).toMatchObject({ erasing: 1, erased: 1, failed: 0 });
  });
});
