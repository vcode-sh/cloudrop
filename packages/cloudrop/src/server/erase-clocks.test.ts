import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../testing/memory-store.ts";
import { hello, NOW, owned, storeFixture, TEXT } from "../testing/store-fixture.ts";

// Contract: M11-R215. eraseOwner reports done only when the store proves nothing of the owner is left or can arrive,
// also when the servers that take uploads read another clock than the one that runs the erasure. Each server stamps a
// row with its own clock, so a row's created_at says when the upload began only to within the difference.
// Oracle: the object in the fake bucket, which a run that says done must have removed.

const MINUTE = 60_000;
/** eraseOwner's default grace: how far apart the store's times allow two servers' clocks to be. */
const GRACE = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Fixture = ReturnType<typeof storeFixture>;

/**
 * A run during which another server, whose clock differs by `skewMs`, takes an upload of the owner's and its cancel.
 * Both happen just after the run read the aborted files, so the upload is never live when the run reads the live
 * statuses, and its PUT lands after the cancel.
 */
async function eraseWhileAnotherServerUploads(skewMs: number) {
  const base = memoryStore();
  let key = "";
  const fixture: Fixture = storeFixture(
    { owned },
    {
      store: {
        ...base,
        list: async (input) => {
          const page = await base.list(input);
          if (input.statuses.includes("aborted") && key === "") {
            vi.setSystemTime(NOW.getTime() + skewMs);
            const ticket = await fixture.single("owned", TEXT);
            key = ticket.key;
            expect((await fixture.post("abort", { token: ticket.token })).status).toBe(200);
            await fixture.send(ticket.put, hello);
            vi.setSystemTime(NOW);
          }
          return page;
        },
      },
    },
  );
  const { data } = await fixture.cloudrop.api.eraseOwner("u1");
  return { done: data?.done, waiting: data?.waiting, left: (await fixture.storage.head(key)).data?.size ?? null };
}

describe("cloudrop.api.eraseOwner beside a server whose clock differs", () => {
  // A clock that agrees is erase.test.ts's "an upload starts and is cancelled while it runs"; one that runs ahead
  // stamps a later time still, which the same comparison reads the same way.
  it.for([
    { name: "lags by two minutes", skewMs: -2 * MINUTE },
    { name: "lags by exactly the grace, the most that is allowed for", skewMs: -GRACE },
  ])("is not done when an upload starts and is cancelled on a server whose clock $name", async ({ skewMs }) => {
    // The cancelled upload's object is still in the bucket: a run that said done would have left it there.
    expect(await eraseWhileAnotherServerUploads(skewMs)).toEqual({ done: false, waiting: 1, left: 5 });
  });
});
