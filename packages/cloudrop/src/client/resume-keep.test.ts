// Contract: M11-R260. A page that resumes an upload cannot know whether an earlier page's /complete finished it until
// its probe is answered, so every /abort it sends for that ticket until then asks the server to keep an object that
// landed. A tab closed while /complete was in flight, the server finishing the file and running onComplete: after the
// reload neither a cancel before the probe was sent nor a cancel after the probe failed without an answer of the
// server's deletes the finished file.
// Oracle: the object the fake bucket holds under the finished upload's key, how often onComplete ran, and the body of
// each /abort the fixture saw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { fakeIndexedDb } from "../testing/fake-indexeddb.ts";
import { fakeLocks } from "../testing/fake-locks.ts";
import { bodiesOf, firstOf, lockOf } from "../testing/persist-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const SIZE = 1000;
const file = () => new File([offsetBytes(SIZE)], "a.bin", { type: "application/octet-stream", lastModified: 1 });

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A stateless server whose every file goes in parts, and a page that closed while its /complete was in flight: the
 * server finished the file and ran onComplete, and the answer reached nobody. `afterReload` answers the new page's
 * requests.
 */
async function finishedUnheard(afterReload: Fault = () => undefined) {
  const db = fakeIndexedDb();
  const locks = fakeLocks();
  vi.stubGlobal("indexedDB", db.indexedDB);
  vi.stubGlobal("navigator", { locks: locks.locks });
  const completed: string[] = [];
  const files = route(
    { accept: "*/*", maxSize: "1MB", authorize: allowAnyone },
    {
      onComplete: ({ file }) => {
        completed.push(file.key);
        return null;
      },
    },
  );
  const aborts = bodiesOf("POST /abort");
  let reloaded = false;
  const beforeReload: Fault = (call) =>
    call.label === "POST /complete" ? call.forward(call.init).then(() => new Promise<never>(() => {})) : undefined;
  const fixture = clientFixture(
    { files },
    { multipartThreshold: 0, fault: (call) => (reloaded ? firstOf(aborts.fault, afterReload) : beforeReload)(call) },
  );
  const page = () => createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch });
  page().start("files", file());
  // The server has finished the completion, and the page has saved its record under the upload's lock.
  await vi.waitFor(() => expect([completed.length, Object.keys(db.stored()).length]).toEqual([1, 1]), { interval: 1 });
  locks.releaseAll();
  reloaded = true;
  const client = page();
  const [upload] = (await client.resumable()).data ?? [];
  if (!upload) throw new Error("The page before the reload left no record.");
  const record = db.stored()[upload.id] as { token: string };
  return {
    client,
    upload,
    locks,
    /** What is left once every /abort was answered: the finished object's size, onComplete's runs, each /abort. */
    async left() {
      await client.close();
      const head = await fixture.server.storage.head(completed[0] ?? "");
      return { stored: head.data?.size, onComplete: completed.length, aborts: aborts.bodies };
    },
    kept: { stored: SIZE, onComplete: 1, aborts: [{ token: record.token, keep: true }] },
  };
}

describe("a resumed upload whose /complete an earlier page sent and the server finished", () => {
  it("keeps the file when it is paused, then cancelled, before its probe is sent", async () => {
    const { client, upload, locks, left, kept } = await finishedUnheard();
    const job = client.resume(upload, file());
    job.pause();
    // The checks passed: the upload holds its lock, and waits for resume() before it asks the server anything.
    await vi.waitFor(() => expect(locks.held()).toEqual([lockOf(upload.id)]), { interval: 1 });
    job.abort();
    const { error } = await job.done;

    expect({ error: error?.code, ...(await left()) }).toEqual({ error: "ABORTED", ...kept });
  });

  it("keeps the file when a proxy answered every probe with its own 429 page, and the failed file is dismissed", async () => {
    const { client, upload, left, kept } = await finishedUnheard(({ label }) =>
      label === "POST /complete" ? new Response("Too many requests", { status: 429 }) : undefined,
    );
    const job = client.resume(upload, file());
    const { error } = await job.done;
    job.files[0]?.abort();

    expect({ error: error?.code, ...(await left()) }).toEqual({ error: "RATE_LIMITED", ...kept });
  });
});
