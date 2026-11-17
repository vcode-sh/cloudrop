// Contract: spec §3.5 and rulings M3-U69, M3-U73 and M3-U88. lockUpload asks for the Web Lock `cloudrop:upload:<id>`
// without waiting and holds it until release() is called, which may come before the answer; it answers false when
// another holder has that lock, this page included, and undefined, holding nothing, where the page has no
// navigator.locks or the browser refuses the request.
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
  it("holds cloudrop:upload:<id> until it is released, refusing this page meanwhile, then lets it go", async () => {
    const fake = setup();

    const lock = lockUpload("7");
    const taken = await lock.taken;
    const whileHeld = fake.held();
    const again = await lockUpload("7").taken;
    lock.release();
    await everyMicrotask();

    expect({ taken, whileHeld, again, afterwards: fake.held() }).toEqual({
      taken: true,
      whileHeld: ["cloudrop:upload:7"],
      again: false,
      afterwards: [],
    });
  });

  it("lets the lock go once granted when it was released before the answer", async () => {
    const fake = setup();

    const lock = lockUpload("7");
    lock.release();
    const taken = await lock.taken;
    await everyMicrotask();

    expect({ taken, held: fake.held() }).toEqual({ taken: true, held: [] });
  });

  it("answers false while another holder has the upload, without holding it, and true once it lets go", async () => {
    const fake = setup();
    const elsewhere = fake.holdElsewhere("cloudrop:upload:7");

    const refused = lockUpload("7");
    const answer = await refused.taken;
    const heldAfterRefusal = fake.held();
    const otherUpload = await lockUpload("8").taken;
    elsewhere();
    const retried = await lockUpload("7").taken;
    // Releasing the refused request changes nothing for the holder that came after it.
    refused.release();
    await everyMicrotask();

    expect({ answer, heldAfterRefusal, otherUpload, retried, held: fake.held() }).toEqual({
      answer: false,
      heldAfterRefusal: [],
      otherUpload: true,
      retried: true,
      held: ["cloudrop:upload:7", "cloudrop:upload:8"],
    });
  });

  it.each([
    { name: "a navigator without locks (a page over plain HTTP)", navigator: {} },
    { name: "no navigator at all", navigator: undefined },
  ])("answers undefined with $name", async ({ navigator }) => {
    vi.stubGlobal("navigator", navigator);

    expect(await lockUpload("7").taken).toBeUndefined();
  });

  it("answers undefined when the browser refuses the request (a document that is no longer active)", async () => {
    const fake = setup();
    fake.refuse();

    expect(await lockUpload("7").taken).toBeUndefined();
  });
});
