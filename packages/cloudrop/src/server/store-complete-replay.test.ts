// /complete with a store when another request completes the file first: a request already past its row read replays
// the winner's stored answer, from its claim or from its refusal, and runs no hook again (M5 spec §5.5, M4-F12).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import { complete } from "../testing/complete-fixture.ts";
import { gate, hello, leaseStore, NOW, storeFixture, TEXT } from "../testing/store-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { route } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * A lease-mode server whose first /complete stops in afterVerify, after its row read; `refuse` makes the plugin refuse
 * once the first request goes on. onComplete and afterComplete count their runs.
 */
async function firstRequestPaused() {
  const verifying = gate();
  const state = { checks: 0, refuse: false, onComplete: 0, afterComplete: 0, aborted: [] as string[] };
  const checker: CloudropPlugin = {
    id: "checker",
    server: {
      afterVerify: async () => {
        state.checks += 1;
        if (state.checks === 1) await verifying.pass();
        return state.refuse ? new CloudropError("VERIFICATION_FAILED", "Refused by the app.") : undefined;
      },
      onAbort: ({ reason }) => void state.aborted.push(reason),
    },
  };
  const files = route(
    { accept: "*/*", maxSize: "1GB", authorize: () => ({ userId: "u1" }) },
    {
      owner: ({ userId }) => userId,
      onComplete: () => ({ run: ++state.onComplete }),
      afterComplete: () => {
        state.afterComplete += 1;
      },
    },
  );
  const fixture = storeFixture({ files }, { store: leaseStore(), plugins: [checker] });
  const ticket = await fixture.single("files", TEXT);
  await fixture.send(ticket.put, hello);
  const first = complete(fixture, ticket.token);
  await verifying.arrived;
  const second = await complete(fixture, ticket.token);
  return {
    fixture,
    ticket,
    state,
    second,
    finishFirst: () => {
      verifying.open();
      return first;
    },
  };
}

describe("POST /complete with a store: the winner's answer for a request that read the row before", () => {
  it("replays from its claim, and afterComplete has run once", async () => {
    const { state, second, finishFirst } = await firstRequestPaused();
    expect(second.body.data).toEqual({ run: 1 });
    expect((await finishFirst()).body.data).toEqual({ run: 1 });
    expect([state.onComplete, state.afterComplete]).toEqual([1, 1]);
  });

  it("replays from its refusal, deleting nothing and telling no plugin", async () => {
    const { fixture, ticket, state, finishFirst } = await firstRequestPaused();
    state.refuse = true;
    expect((await finishFirst()).body.data).toEqual({ run: 1 });
    expect([(await fixture.storage.head(ticket.key)).data?.size, state.aborted]).toEqual([5, []]);
    expect((await fixture.store.raw.files())[0]?.status).toBe("completed");
  });
});
