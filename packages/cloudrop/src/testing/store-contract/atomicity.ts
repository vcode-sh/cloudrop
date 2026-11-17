// Atomicity of the two-table writes: when the usage write fails, the files row the method already changed rolls back.
// The failure is the target's one-shot `injectFailure` (a trigger on SQL backends); reserve's duplicate-id case in
// reserve.ts proves its atomicity without one.

import { expect, it } from "vitest";
import type { CloudropStore } from "../../server/store.ts";
import { at, EXPIRES, MINUTE, newFile, type StoreSuite } from "./suite.ts";

export function atomicityCases(suite: StoreSuite): void {
  const { seed, advance, failNextUsageWrite } = suite;

  it.for<{ method: string; act: (store: CloudropStore<unknown>) => Promise<unknown> }>([
    {
      method: "reserve, with a quota",
      act: (store) =>
        store.reserve({ owner: "u-1", limit: 1000, expiresAt: EXPIRES, files: [newFile("f-4", 1)] }, at(MINUTE)),
    },
    { method: "complete", act: (store) => store.complete("f-1", "claim-f-1", "{}", at(MINUTE)) },
    { method: "end from completed to deleted", act: (store) => store.end("f-2", "completed", "deleted", at(MINUTE)) },
    { method: "revoke", act: (store) => store.revoke("u-1", at(MINUTE)) },
  ])("$method that fails at its usage write changes neither table", async ({ act }, ctx) => {
    const { store, raw } = suite;
    await seed("u-1", [newFile("f-1", 100), newFile("f-2", 30), newFile("f-3", 10)]);
    await advance("f-1", "completing", at(0));
    await advance("f-2", "completed", at(0));
    const tables = async () => ({ files: await raw.files(), usage: await raw.usage() });
    const before = await tables();
    await failNextUsageWrite(ctx);
    await expect(act(store)).rejects.toBeInstanceOf(Error);
    expect(await tables()).toEqual(before);
    // The failure was armed once: the same call now goes through.
    await act(store);
    expect(await tables()).not.toEqual(before);
  });
}
