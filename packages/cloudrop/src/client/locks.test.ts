// Contract: spec §3.5 and ruling R4 of the resume plan. lockUpload takes the Web Lock `cloudrop:upload:<id>` without
// waiting and holds it until the run's promise settles, either way; it answers false when another tab holds that lock,
// and true, holding nothing, where the page has no navigator.locks or may not use it.
// Oracle: the lock names the fake LockManager says this page holds, and the literal name the ruling fixes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeLocks } from "../testing/fake-locks.ts";
import { lockUpload } from "./locks.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const fake = fakeLocks();
  vi.stubGlobal("navigator", { locks: fake.locks });
  return fake;
}

/** A macrotask: every microtask queued before it, the lock's release included, has run. */
const everyMicrotask = () => new Promise((resolve) => setImmediate(resolve));

describe("lockUpload", () => {
  it.each([
    { name: "finishes", settle: (run: PromiseWithResolvers<string>) => run.resolve("done") },
    { name: "fails", settle: (run: PromiseWithResolvers<string>) => run.reject(new Error("the run failed")) },
  ])("holds cloudrop:upload:<id> until the run $name, then lets it go", async ({ settle }) => {
    const fake = setup();
    const run = Promise.withResolvers<string>();

    const taken = await lockUpload("7", run.promise);
    const whileRunning = fake.held();
    settle(run);
    await everyMicrotask();

    expect({ taken, whileRunning, afterwards: fake.held() }).toEqual({
      taken: true,
      whileRunning: ["cloudrop:upload:7"],
      afterwards: [],
    });
  });

  it("answers false while another tab holds the upload, without holding it, and true once that tab lets go", async () => {
    const fake = setup();
    const release = fake.holdElsewhere("cloudrop:upload:7");
    const run = Promise.withResolvers<void>();

    const refused = await lockUpload("7", run.promise);
    const heldAfterRefusal = fake.held();
    const otherUpload = await lockUpload("8", run.promise);
    release();
    const retried = await lockUpload("7", run.promise);

    expect({ refused, heldAfterRefusal, otherUpload, retried, held: fake.held() }).toEqual({
      refused: false,
      heldAfterRefusal: [],
      otherUpload: true,
      retried: true,
      held: ["cloudrop:upload:7", "cloudrop:upload:8"],
    });
    run.resolve();
  });

  it.each([
    { name: "a navigator without locks (a page over plain HTTP)", navigator: {} },
    { name: "no navigator at all", navigator: undefined },
  ])("answers true with $name", async ({ navigator }) => {
    vi.stubGlobal("navigator", navigator);

    expect(await lockUpload("7", new Promise(() => {}))).toBe(true);
  });

  it("answers true when the browser refuses the request (a document that is no longer active)", async () => {
    const request = () => Promise.reject(new DOMException("The document is not fully active.", "InvalidStateError"));
    vi.stubGlobal("navigator", { locks: { request } });

    expect(await lockUpload("7", new Promise(() => {}))).toBe(true);
  });
});
