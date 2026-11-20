import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../testing/complete-fixture.ts";
import { type MemoryStore, memoryStore } from "../testing/memory-store.ts";
import { hello, leaseStore, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";
import { route } from "./route.ts";

const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Fixture = ReturnType<typeof storeFixture>;

/** What the hooks saw: the owner's listed files during onComplete, and the previous file's row in afterComplete. */
interface Seen {
  listed: string[][];
  previous: (string | undefined)[];
}

/** An avatar route that keeps one file per owner, recording what its hooks see. */
function avatarFixture(store: MemoryStore | Omit<MemoryStore, "transaction"> = memoryStore()) {
  const seen: Seen = { listed: [], previous: [] };
  let fixture: Fixture | undefined;
  let previousId: string | undefined;
  const avatar = route(
    { accept: "*/*", maxSize: "1GB", replace: true, authorize: () => ({ userId: "u1" }) },
    {
      owner: ({ userId }) => userId,
      onComplete: async () => {
        const page = await fixture?.cloudrop.api.files({ owner: "u1", route: "avatar" });
        seen.listed.push(page?.data?.items.map((file) => file.id) ?? []);
      },
      afterComplete: async () => {
        if (previousId) seen.previous.push((await fixture?.cloudrop.api.file(previousId))?.data?.status);
      },
    },
  );
  fixture = storeFixture({ avatar, owned }, { store });
  const upload = async (routeName = "avatar") => {
    const ticket = await fixture.single(routeName, TEXT);
    await fixture.send(ticket.put, hello);
    return ticket;
  };
  const remember = (id: string) => {
    previousId = id;
  };
  return { fixture, seen, upload, remember };
}

const stored = async (fixture: Fixture, key: string) => (await fixture.storage.head(key)).data !== null;

describe("a route with replace", () => {
  it.for([
    { mode: "in a transaction", store: () => memoryStore() },
    { mode: "under a lease", store: () => leaseStore() },
  ])("keeps one file per owner: the next completion deletes the previous file, $mode", async ({ store }) => {
    const { fixture, seen, upload, remember } = avatarFixture(store());
    const first = await upload();
    // A minute apart, so the listing's newest-first order does not depend on two ids made in one millisecond.
    vi.setSystemTime(NOW.getTime() + 60_000);
    const document = await upload("owned");
    expect((await complete(fixture, first.token)).status).toBe(200);
    await complete(fixture, document.token);
    remember(first.id);
    vi.setSystemTime(NOW.getTime() + 120_000);
    const second = await upload();
    expect((await complete(fixture, second.token)).status).toBe(200);
    const { api } = fixture.cloudrop;
    expect((await api.files({ owner: "u1" })).data?.items.map((file) => file.id)).toEqual([second.id, document.id]);
    expect([(await api.file(first.id)).data?.status, await stored(fixture, first.key)]).toEqual(["deleted", false]);
    expect((await api.usage("u1")).data).toEqual({ reservedBytes: 0, activeBytes: 10, files: 2 });
    // onComplete ran before the completion was recorded, so it still listed the first avatar; afterComplete ran after.
    expect(seen).toEqual({ listed: [[], [first.id]], previous: ["deleted"] });
  });

  it("leaves the previous file's object to the sweep when its delete fails, and the sweep removes it", async () => {
    const { fixture, upload } = avatarFixture();
    const first = await upload();
    await complete(fixture, first.token);
    const second = await upload();
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) =>
      init?.method === "DELETE" ? Promise.reject(new TypeError("network down")) : fetch(input, init);
    expect((await complete(fixture, second.token)).status).toBe(200);
    fixture.fake.fetch = fetch;
    expect(fixture.logger.errors.map((entry) => entry.message)).toEqual([
      `cloudrop: could not remove the replaced file ${first.id} from the bucket. The sweep removes it later.`,
    ]);
    const previous = (await fixture.store.raw.files()).find((row) => row.id === first.id);
    expect([await stored(fixture, first.key), previous?.status, previous?.cleanedAt]).toEqual([true, "deleted", null]);
    vi.setSystemTime(NOW.getTime() + 2 * HOUR);
    expect((await fixture.cloudrop.api.sweep()).data?.cleaned).toBe(1);
    expect(await stored(fixture, first.key)).toBe(false);
  });

  it("keeps the previous file when the next completion fails", async () => {
    let fail = false;
    const avatar = route(
      { accept: "*/*", maxSize: "1GB", replace: true, authorize: () => ({ userId: "u1" }) },
      {
        owner: ({ userId }) => userId,
        onComplete: () => {
          if (fail) throw new Error("the app's database is down");
        },
      },
    );
    const fixture = storeFixture({ avatar });
    const first = await fixture.single("avatar", TEXT);
    await fixture.send(first.put, hello);
    await complete(fixture, first.token);
    fail = true;
    const second = await fixture.single("avatar", TEXT);
    await fixture.send(second.put, hello);
    expect((await complete(fixture, second.token)).status).toBe(500);
    expect((await fixture.cloudrop.api.files({ owner: "u1" })).data?.items.map((file) => file.id)).toEqual([first.id]);
    expect(await stored(fixture, first.key)).toBe(true);
  });
});
