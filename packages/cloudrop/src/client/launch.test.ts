// Contract: every /upload ask carries an idempotencyKey of its own, and every automatic retry of that ask sends the same
// one (M5-T102), so a server with a store can tell a retry after a lost answer from a new request. Oracle: the bodies of
// the /upload requests the fixture saw.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCloudropClient } from "../client.ts";
import { allowAnyone, route } from "../server/route.ts";
import { clientFixture, type Fault, storageBusy } from "../testing/client-fixture.ts";
import { offsetBytes } from "../testing/storage-contract.ts";

const files = route({ accept: "application/octet-stream", maxSize: "100MB", authorize: allowAnyone });

/** A client on the fake bucket; `fault` answers /upload in place of the server, and `keys` lists each one's key. */
function setup(fault: Fault) {
  const keys: unknown[] = [];
  const fixture = clientFixture(
    { files },
    {
      fault: (call) => {
        if (call.label !== "POST /upload") return undefined;
        keys.push(JSON.parse(String(call.init.body)).idempotencyKey);
        return fault(call);
      },
    },
  );
  return { keys, client: createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch }) };
}

const fileOf = (name: string) => new File([offsetBytes(1000)], name, { type: "application/octet-stream" });

/** The keys in order as letters, a for the first distinct key: the shape the assertions compare. */
const shape = (keys: unknown[]) => keys.map((key) => String.fromCharCode(97 + [...new Set(keys)].indexOf(key)));

const refusedForNow = () =>
  Response.json({
    files: [
      {
        kind: "rejected",
        error: {
          code: "STORAGE_ERROR",
          message: "The storage service failed. Try again in a moment.",
          retryable: true,
        },
      },
    ],
  });

beforeEach(() => {
  // Every backoff wait is 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("sends one key on every retry of an ask, and a new key when a refused file asks again", async () => {
  // 1: the server is busy, and the job's /upload is retried. 2: the file is refused for now, and asks again alone.
  // 3: busy again, the re-ask is retried. 4: through.
  const { keys, client } = setup(({ nth }) =>
    nth === 1 || nth === 3 ? storageBusy() : nth === 2 ? refusedForNow() : undefined,
  );
  const { data } = await client.start("files", [fileOf("a.bin")]).done;
  expect(data?.files.map((file) => file.status)).toEqual(["done"]);
  expect(shape(keys)).toEqual(["a", "a", "b", "b"]);
});

it("sends one key through all six attempts, and retry() asks with a new one", async () => {
  const { keys, client } = setup(({ nth }) => (nth <= 6 ? storageBusy() : undefined));
  const job = client.start("files", [fileOf("a.bin"), fileOf("b.bin")]);
  expect((await job.done).error?.code).toBe("RATE_LIMITED");
  const { data } = await job.retry();
  expect(data?.files.map((file) => file.status)).toEqual(["done", "done"]);
  expect(shape(keys)).toEqual(["a", "a", "a", "a", "a", "a", "b"]);
});
