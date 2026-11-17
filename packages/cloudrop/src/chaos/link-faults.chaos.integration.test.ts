// Chaos rows 10 and 12 (design spec §4): a single PUT the bucket never answers, and one whose answer is lost after the
// bucket stored the bytes. Both reach the fetch transport as the opaque outcome: the client renews the URL through
// /sign and sends again (M3-S10, M3-S11). Run with `bun run test:chaos`.
import { expect, test } from "vitest";
import { chaosFile, SINGLE_FILE_SIZE, useChaosFixture } from "../testing/chaos-fixture.ts";

const chaos = useChaosFixture();

/**
 * 64 KiB, so a fetch PUT's allowance is 30 000 ms + 65 536 B at 102.4 B/ms = 30 640 ms (M3-U27): the size's share
 * (640 ms) is wide enough to tell from a bare 30 s, and the row stays near 31 s (plan audit C2).
 */
const STALL_FILE_SIZE = 64 * 1024;

// Row 10 in the Node lane proves the fetch allowance; the browser's progress watchdog is the browser lane's.
test("a PUT the bucket never answers is given up after 30 s plus its size at 100 KiB/s, renewed and sent again", {
  timeout: 45_000,
}, async () => {
  chaos.proxy.set([{ match: { kind: "presigned", operation: "PutObject" }, fault: { kind: "blackhole" } }]);
  const file = chaosFile(STALL_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  // "aborted": the client closed the connection; a black hole never forwards, so RustFS saw the second PUT only.
  expect(chaos.bucketRequests()).toEqual(["PUT object aborted", "PUT object 200", "HeadObject 200"]);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /sign 200", "POST /complete 200"]);
  const [stalled] = chaos.proxy.log();
  const heldMs = (stalled?.endMs ?? 0) - (stalled?.startMs ?? 0);
  // The client's timer starts just before the request reaches the proxy, and fires a little late under load.
  expect(heldMs).toBeGreaterThan(30_500);
  expect(heldMs).toBeLessThan(31_200);
});

// Row 12, audit C1: the cut comes before the status line, after RustFS stored the object, so the retry's create-only
// PUT (If-None-Match: *) is refused with 412, which the client counts as stored (design spec §5.4).
test("a PUT whose answer is lost after the bucket stored it is sent again, and the bucket's 412 counts as stored", async () => {
  chaos.proxy.set([
    { match: { kind: "presigned", operation: "PutObject" }, fault: { kind: "truncate", at: "beforeHeaders" } },
  ]);
  const file = chaosFile(SINGLE_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  const key = data?.file.key ?? "";
  await chaos.expectStored(key, file);
  expect(await chaos.objectsLeft()).toEqual([key]);
  expect(chaos.bucketRequests()).toEqual(["PUT object reset", "PUT object 412", "HeadObject 200"]);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /sign 200", "POST /complete 200"]);
});
